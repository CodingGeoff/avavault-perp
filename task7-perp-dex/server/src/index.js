import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { randomBytes } from "node:crypto";
import { OrderBook } from "../../matching-engine/dist/orderbook.js";
import { PositionManager } from "../../matching-engine/dist/positions.js";
import { persistOrderResult, persistOrderState, markTradeSettled, loadRecentTrades, loadOpenOrders, persistSession, loadSessions, persistPosition, loadPositions, setClearingValue, getClearingValue } from "./db.js";
import { MarkOracle } from "./markOracle.js";
import { MarginService, parsePriceToE6 } from "./margin.js";

const PORT = process.env.PORT || 4000;
const RPC_URL = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || "";
// "v1" = 直接信任 operator 的 Vault.settle()（历史/兼容模式）；
// "v2" = VaultV2.settleWithAuthorization()，需要买方在下单时提供 EIP-712 签名授权
//        （修复 SECURITY_REVIEW.md Finding #4，见 task7-perp-dex/README.md）
const VAULT_ABI_VERSION = (process.env.VAULT_ABI_VERSION || "v1").toLowerCase();

const VAULT_ABI_V1 = [
  "function settle(address from, address to, uint256 amount, bytes32 tradeRef) external",
  "function balanceOf(address) view returns (uint256)",
];
const VAULT_ABI_V2 = [
  "function settleWithAuthorization(address from, address to, uint256 amount, bytes32 tradeRef, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes signature) external",
  "function balanceOf(address) view returns (uint256)",
];

// 必须和 VaultV2.sol 里的 EIP712("MiniDexVault", "2") 以及 AUTHORIZATION_TYPEHASH 完全一致，
// 否则 ecrecover 出来的签名人地址对不上，链上会直接 revert InvalidSignature。
const EIP712_DOMAIN_NAME = "MiniDexVault";
const EIP712_DOMAIN_VERSION = "2";
const AUTHORIZATION_TYPES = {
  SettlementAuthorization: [
    { name: "from", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

let vaultContract = null;
let provider = null;
let chainId = null;
if (VAULT_ADDRESS && OPERATOR_PRIVATE_KEY) {
  provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
  const abi = VAULT_ABI_VERSION === "v2" ? VAULT_ABI_V2 : VAULT_ABI_V1;
  vaultContract = new ethers.Contract(VAULT_ADDRESS, abi, wallet);
  console.log(`[settlement] on-chain settlement ENABLED (${VAULT_ABI_VERSION}), vault =`, VAULT_ADDRESS);
} else {
  console.log("[settlement] on-chain settlement DISABLED (set VAULT_ADDRESS + OPERATOR_PRIVATE_KEY to enable)");
}

/** 下单时买方提交的 EIP-712 签名授权，key 是这笔订单的 id，只在 v2 结算模式下使用。 */
const orderAuthorizations = new Map();
/** 每笔订单的杠杆倍数，key 是订单 id（仓位引擎记账时按订单取用） */
const orderLeverages = new Map();

// ---------------------------------------------------------------
// 保证金聚合：把 MultiCollateralVaultV2.totalAccountValue()（RWA 抵押估值）
// 接进撮合服务。默认只读展示（/account/:address/margin），设置
// MARGIN_ENFORCE=true 后，买单在撮合前要先过保证金校验：可用保证金 =
// Vault 的 mUSDC 余额 + RWA 抵押估值（配置了 MARGIN_QUOTE_USD_PRICE 换算率时）。
// 部署默认指向已部署的 MultiCollateralVaultV2，传空字符串可关闭这个来源。
// ---------------------------------------------------------------
const MULTICOLLATERAL_VAULT_ADDRESS =
  process.env.MULTICOLLATERAL_VAULT_ADDRESS === undefined
    ? "0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884"
    : process.env.MULTICOLLATERAL_VAULT_ADDRESS;
const MARGIN_ENFORCE = /^(1|true|yes)$/i.test(process.env.MARGIN_ENFORCE || "");
const MARGIN_RPC_TIMEOUT_MS = Number(process.env.MARGIN_RPC_TIMEOUT_MS || 8000);
const MULTICOLLATERAL_ABI = ["function totalAccountValue(address) view returns (uint256)"];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

let marginService = new MarginService({});
{
  // 只读 provider 与结算用的 operator 钱包相互独立：没有 operator 私钥时也能查保证金
  const readProvider = provider || new ethers.JsonRpcProvider(RPC_URL);
  const readVaultBalance = VAULT_ADDRESS
    ? async (address) => {
        const c = vaultContract || new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_V2, readProvider);
        return withTimeout(c.balanceOf(address), MARGIN_RPC_TIMEOUT_MS, "vault balanceOf");
      }
    : null;
  const readRwaAccountValue = MULTICOLLATERAL_VAULT_ADDRESS
    ? async (address) => {
        const c = new ethers.Contract(MULTICOLLATERAL_VAULT_ADDRESS, MULTICOLLATERAL_ABI, readProvider);
        return withTimeout(c.totalAccountValue(address), MARGIN_RPC_TIMEOUT_MS, "totalAccountValue");
      }
    : null;
  let quotePriceE6 = null;
  if (process.env.MARGIN_QUOTE_USD_PRICE) {
    try {
      quotePriceE6 = parsePriceToE6(process.env.MARGIN_QUOTE_USD_PRICE);
    } catch (e) {
      console.error(`[margin] ignoring invalid MARGIN_QUOTE_USD_PRICE: ${e.message}`);
    }
  }
  marginService = new MarginService({ readVaultBalance, readRwaAccountValue, quotePriceE6 });
  console.log(
    `[margin] RWA collateral source ${MULTICOLLATERAL_VAULT_ADDRESS || "disabled"}` +
      `, counted in margin: ${marginService.rwaCounted}, enforcement: ${MARGIN_ENFORCE ? "ON" : "off"}`
  );
}


// ---------------------------------------------------------------
// 撮合引擎：进程内单一订单簿（演示用，单市场 AVAX-PERP）
// 进阶功能：启动时从 SQLite 恢复所有仍未完全成交的挂单，重启后订单簿状态不丢失。
// ---------------------------------------------------------------
const book = new OrderBook();

let restoredCount = 0;
for (const row of loadOpenOrders()) {
  // IOC/FOK 订单即使标记为 partially_filled，只要 remaining 已经是 0 就代表"未成交部分已作废"，
  // 不是真正还挂在盘口上的单子，重启时不应该把它当成还活着的挂单恢复回去。
  if (BigInt(row.remaining) === 0n) continue;
  book.restoreOpenOrder({
    id: row.id,
    traderId: row.traderId,
    side: row.side,
    type: row.type,
    price: BigInt(row.price),
    quantity: BigInt(row.quantity),
    remaining: BigInt(row.remaining),
    tif: row.tif,
    timestamp: row.timestamp,
    status: row.status,
  });
  orderLeverages.set(row.id, Number(row.leverage) || 1);
  // 一并恢复这笔挂单的 EIP-712 结算授权（见 db.js 的 authorization 列），
  // 否则进程重启后挂在盘口上的买单被人吃掉时找不到授权、链上结算会静默失败。
  if (row.authorization) {
    try {
      orderAuthorizations.set(row.id, { ...JSON.parse(row.authorization), from: row.traderId });
    } catch {
      console.warn(`[startup] ignoring unparsable stored authorization for ${row.id}`);
    }
  }
  restoredCount++;
}
const recentTrades = loadRecentTrades(1);
if (recentTrades.length) book.fastForwardTradeSeq(recentTrades[0].id);
console.log(`[startup] restored ${restoredCount} open order(s) from SQLite`);

// ---------------------------------------------------------------
// 永续仓位引擎：成交记账为带杠杆的净仓位，负责保证金占用、浮盈亏与强平。
// 资金仍在链上两个金库里（mUSDC Vault + RWA 抵押金库），这里的仓位保证金
// 来源就是 margin.js 聚合出的综合保证金；仓位状态落库，重启恢复。
// ---------------------------------------------------------------
const positions = new PositionManager({
  maintenanceMarginBps: Number(process.env.MAINTENANCE_MARGIN_BPS || 500),
});
for (const row of loadPositions()) {
  positions.restore({
    traderId: row.traderId,
    sizeSigned: row.sizeSigned,
    entryPrice: row.entryPrice,
    marginAllocated: row.marginAllocated,
    leverage: row.leverage,
    realizedPnl: row.realizedPnl,
    cumulativeFunding: row.cumulativeFunding ?? "0",
  });
}
if (recentTrades.length) positions.setMarkPrice(BigInt(recentTrades[0].price));
console.log(`[startup] restored ${loadPositions().length} open position(s) from SQLite`);

// 标记价预言机：外部喂价（可选）> 成交 TWAP > 最新成交价，见 src/markOracle.js
const markOracle = new MarkOracle({
  windowMs: Number(process.env.MARK_PRICE_WINDOW_SEC || 300) * 1000,
  feedUrl: process.env.MARK_PRICE_FEED_URL || "",
  feedCacheMs: Number(process.env.MARK_PRICE_FEED_CACHE_MS || 1000),
});
for (const t of loadRecentTrades(50).reverse()) {
  markOracle.addTradeSample(BigInt(t.price), Date.now());
}

// 保险基金状态恢复与落库（强平罚金/穿仓兜底的账本，见 positions.ts）
{
  const fund = getClearingValue("insuranceFund");
  if (fund !== null) {
    positions.restoreInsuranceState({
      insuranceFund: BigInt(fund),
      totalInsuranceCovered: BigInt(getClearingValue("totalInsuranceCovered") || "0"),
      totalBadDebt: BigInt(getClearingValue("totalBadDebt") || "0"),
    });
  }
}
function persistInsuranceState() {
  const s = positions.getInsuranceState();
  setClearingValue("insuranceFund", s.insuranceFund.toString());
  setClearingValue("totalInsuranceCovered", s.totalInsuranceCovered.toString());
  setClearingValue("totalBadDebt", s.totalBadDebt.toString());
}

function serializeInsuranceState() {
  const s = positions.getInsuranceState();
  return {
    insuranceFund: s.insuranceFund.toString(),
    totalInsuranceCovered: s.totalInsuranceCovered.toString(),
    totalBadDebt: s.totalBadDebt.toString(),
  };
}

function serializePositionSnapshot(s) {
  return {
    traderId: s.traderId,
    sizeSigned: s.sizeSigned.toString(),
    entryPrice: s.entryPrice.toString(),
    marginAllocated: s.marginAllocated.toString(),
    leverage: s.leverage,
    realizedPnl: s.realizedPnl.toString(),
    cumulativeFunding: s.cumulativeFunding.toString(),
    markPrice: s.markPrice.toString(),
    unrealizedPnl: s.unrealizedPnl.toString(),
    equity: s.equity.toString(),
    maintenanceMargin: s.maintenanceMargin.toString(),
    liquidationPrice: s.liquidationPrice === null ? null : s.liquidationPrice.toString(),
    liquidatable: s.liquidatable,
  };
}

function persistSnapshot(s) {
  persistPosition(PositionManager.serialize(s));
}

// ---------------------------------------------------------------
// 资金费率：标记价（成交 TWAP）相对指数价（外部喂价）的溢价决定费率，
// 多头付空头或反之；没有独立指数喂价时费率为 0、不结算（不拿标记价和自己比）。
// 每 FUNDING_INTERVAL_MS 结算一期（默认 8 小时），状态落库，重启不重复结算同一期。
// ---------------------------------------------------------------
const FUNDING_INTERVAL_MS = Number(process.env.FUNDING_INTERVAL_MS ?? 8 * 3600 * 1000);
const FUNDING_MAX_BPS = (() => {
  const v = Number(process.env.FUNDING_MAX_BPS || 10);
  return Number.isInteger(v) && v >= 0 && v <= 100 ? v : 10;
})();
let lastFundingAt = Number(getClearingValue("lastFundingAt") || 0);
let lastFundingRateBps = Number(getClearingValue("lastFundingRateBps") || 0);

async function getFundingStatus() {
  const inputs = await markOracle.getFundingInputs();
  const oi = positions.getOpenInterest();
  const rateBps = inputs
    ? PositionManager.calculateFundingRateBps(inputs.markPrice, inputs.indexPrice, FUNDING_MAX_BPS)
    : 0;
  return {
    rateBps,
    lastRateBps: lastFundingRateBps,
    maxAbsBps: FUNDING_MAX_BPS,
    intervalMs: FUNDING_INTERVAL_MS,
    lastFundingAt: lastFundingAt || null,
    nextFundingAt: FUNDING_INTERVAL_MS > 0 ? (lastFundingAt || Date.now()) + FUNDING_INTERVAL_MS : null,
    indexPrice: inputs?.indexPrice ? inputs.indexPrice.toString() : null,
    markPrice: inputs ? inputs.markPrice.toString() : null,
    markSource: inputs?.markSource ?? null,
    longNotional: oi.longNotional.toString(),
    shortNotional: oi.shortNotional.toString(),
  };
}

function serializeFundingPayments(payments) {
  return payments.map((p) => ({
    traderId: p.traderId,
    sizeSigned: p.sizeSigned.toString(),
    rateBps: p.rateBps,
    cashflow: p.cashflow.toString(),
    marginAllocated: p.marginAllocated.toString(),
    cumulativeFunding: p.cumulativeFunding.toString(),
  }));
}

/** 到期才真正结算一期资金费；未到期/无独立指数时只返回状态不产生现金流 */
async function applyFundingIfDue() {
  const now = Date.now();
  if (FUNDING_INTERVAL_MS > 0 && lastFundingAt && now - lastFundingAt < FUNDING_INTERVAL_MS) {
    return { applied: false, reason: "not due", payments: [], ...(await getFundingStatus()) };
  }
  const inputs = await markOracle.getFundingInputs();
  if (!inputs) {
    return { applied: false, reason: "no mark/index price", payments: [], ...(await getFundingStatus()) };
  }
  const rateBps = PositionManager.calculateFundingRateBps(inputs.markPrice, inputs.indexPrice, FUNDING_MAX_BPS);
  positions.setMarkPrice(inputs.markPrice);
  const payments = positions.applyFunding(rateBps);
  for (const p of payments) {
    persistSnapshot(positions.snapshot(p.traderId));
    pushPrivate(p.traderId, "position_update", serializePositionSnapshot(positions.snapshot(p.traderId)));
  }
  lastFundingAt = now;
  lastFundingRateBps = rateBps;
  setClearingValue("lastFundingAt", String(lastFundingAt));
  setClearingValue("lastFundingRateBps", String(lastFundingRateBps));
  if (payments.length) {
    broadcastPublic("funding", { rateBps, payments: serializeFundingPayments(payments), at: now });
    console.log(`[funding] settled rate=${rateBps}bps payments=${payments.length}`);
  }
  const liquidated = runLiquidations();
  return {
    applied: true,
    rateBps,
    payments: serializeFundingPayments(payments),
    liquidated,
    ...(await getFundingStatus()),
  };
}

/** 标记价变动后全局扫描并执行强平，返回强平记录（已序列化） */
function runLiquidations() {
  const records = [];
  for (const snap of positions.checkLiquidations()) {
    const rec = positions.liquidate(snap.traderId);
    if (!rec) continue;
    persistSnapshot(positions.snapshot(snap.traderId));
    const serialized = {
      traderId: rec.traderId,
      sizeSigned: rec.sizeSigned.toString(),
      entryPrice: rec.entryPrice.toString(),
      liquidationPrice: rec.liquidationPrice.toString(),
      pnl: rec.pnl.toString(),
      returnedMargin: rec.returnedMargin.toString(),
      deficit: rec.deficit.toString(),
      insuranceCovered: rec.insuranceCovered.toString(),
      badDebt: rec.badDebt.toString(),
      penalty: rec.penalty.toString(),
    };
    records.push(serialized);
    pushPrivate(rec.traderId, "liquidated", serialized);
    console.log(`[liquidation] ${rec.traderId} liquidated at ${rec.liquidationPrice}, pnl=${rec.pnl}, deficit=${rec.deficit}`);
  }
  if (records.length) {
    persistInsuranceState();
    broadcastPublic("liquidations", records);
  }
  return records;
}

// 会话存储：地址 -> {token, createdAt}，token 反查地址的索引，以及落库恢复。
// 以前只存内存：进程一重启所有人都要重新签名登录；且 WebSocket 私有频道只凭
// 查询参数里的 address 就能订阅别人的订单/结算推送（知道地址即可偷窥）。
// 现在登录返回随机 sessionToken，私有频道必须凭 token 订阅，会话本身落库，
// 重启后 7 天内免重新登录。
const sessions = new Map();
const sessionAddressByToken = new Map();
for (const row of loadSessions()) {
  sessions.set(row.address, { token: row.token, createdAt: row.createdAt });
  sessionAddressByToken.set(row.token, row.address);
}
if (sessions.size) console.log(`[startup] restored ${sessions.size} login session(s) from SQLite`);

const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 3600 * 1000);
/** 会话是否仍在有效期内；过期顺手清理内存索引（DB 侧在下次启动 loadSessions 时清） */
function hasActiveSession(address) {
  if (!address) return false;
  const key = String(address).toLowerCase();
  const s = sessions.get(key);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) {
    sessions.delete(key);
    sessionAddressByToken.delete(s.token);
    return false;
  }
  return true;
}
function addressForSessionToken(token) {
  if (!token) return null;
  const address = sessionAddressByToken.get(token) || null;
  return address && hasActiveSession(address) ? address : null;
}

function toBigIntSafe(v) {
  return typeof v === "bigint" ? v : BigInt(v);
}

function serializeOrder(o) {
  return { ...o, price: o.price.toString(), quantity: o.quantity.toString(), remaining: o.remaining.toString() };
}
function serializeTrade(t) {
  return { ...t, price: t.price.toString(), quantity: t.quantity.toString() };
}
function serializeSnapshot(snap) {
  return {
    bids: snap.bids.map((l) => ({ price: l.price.toString(), quantity: l.quantity.toString() })),
    asks: snap.asks.map((l) => ({ price: l.price.toString(), quantity: l.quantity.toString() })),
  };
}

// ---------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// 轻量内存限流（无需额外依赖）：挡住登录签名重放刷接口与下单灌水这类低成本滥用。
// 阈值按演示/做市场景留足余量，做市机器人 8 秒一轮双边 6 单也远低于上限；
// 可用 RATE_LIMIT_ORDERS_PER_MIN / RATE_LIMIT_LOGIN_PER_MIN 覆盖，设 0 关闭。
function makeRateLimiter(limitPerMin) {
  const hits = new Map(); // ip -> number[] timestamps
  return (req, res, next) => {
    if (!limitPerMin || limitPerMin <= 0) return next();
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
    if (arr.length >= limitPerMin) {
      hits.set(key, arr);
      return res.status(429).json({ error: "rate limit exceeded, please retry later" });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
app.use("/auth/login", makeRateLimiter(Number(process.env.RATE_LIMIT_LOGIN_PER_MIN || 60)));
app.use("/orders", makeRateLimiter(Number(process.env.RATE_LIMIT_ORDERS_PER_MIN || 300)));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** clients: Map<ws, address|null> */
const clients = new Map();

function broadcastPublic(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of clients.keys()) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

/** 私有 orders 频道（进阶功能）：只把某个地址自己的订单变化推给它自己 */
function pushPrivate(traderId, type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const [client, addr] of clients.entries()) {
    if (addr && addr.toLowerCase() === traderId.toLowerCase() && client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  // 私有推送只认登录时发放的 sessionToken；只带 address 参数的连接退化为
  // 公开频道（能看订单簿快照，收不到任何人的 order_update / settled 私有事件）。
  const token = url.searchParams.get("token");
  const address = addressForSessionToken(token);
  clients.set(ws, address);
  ws.send(JSON.stringify({ type: "snapshot", payload: serializeSnapshot(book.getSnapshot()) }));
  ws.on("close", () => clients.delete(ws));
});

// ---------------------------------------------------------------
// REST API
// ---------------------------------------------------------------

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    settlementEnabled: !!vaultContract,
    settlementVersion: VAULT_ABI_VERSION,
    marginEnforce: MARGIN_ENFORCE,
    rwaCollateralCounted: marginService.rwaCounted,
    fundingIntervalMs: FUNDING_INTERVAL_MS,
    fundingMaxBps: FUNDING_MAX_BPS,
  })
);

/** v2 结算模式下，客户端需要用这份 domain 去签署 EIP-712 授权（见 README §三·2）。 */
app.get("/settlement/domain", async (_req, res) => {
  if (VAULT_ABI_VERSION !== "v2" || !vaultContract) {
    return res.status(400).json({ error: "server is not running in v2 settlement mode" });
  }
  if (chainId === null) {
    const net = await provider.getNetwork();
    chainId = Number(net.chainId);
  }
  res.json({
    domain: { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId, verifyingContract: VAULT_ADDRESS },
    types: AUTHORIZATION_TYPES,
  });
});

/** 登录：验证钱包签名（SIWE 简化版），签名内容里必须包含地址本身，防止重放到别的地址 */
app.post("/auth/login", (req, res) => {
  try {
    const { address, message, signature } = req.body;
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: "signature does not match address" });
    }
    if (!message.includes(address)) {
      return res.status(400).json({ error: "message must include your address to prevent replay" });
    }
    const key = address.toLowerCase();
    const previous = sessions.get(key);
    if (previous) sessionAddressByToken.delete(previous.token);
    const sessionToken = randomBytes(32).toString("hex");
    sessions.set(key, { token: sessionToken, createdAt: Date.now() });
    sessionAddressByToken.set(sessionToken, key);
    persistSession(key, sessionToken);
    res.json({ ok: true, address, sessionToken });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/orderbook", (_req, res) => {
  const snap = book.getSnapshot(20);
  res.json({
    bids: snap.bids.map((l) => ({ price: l.price.toString(), quantity: l.quantity.toString() })),
    asks: snap.asks.map((l) => ({ price: l.price.toString(), quantity: l.quantity.toString() })),
  });
});

app.get("/trades", (req, res) => {
  res.json(loadRecentTrades(Number(req.query.limit) || 50));
});

app.get("/orders/open", (_req, res) => {
  res.json(loadOpenOrders());
});

app.get("/balance/:address", async (req, res) => {
  if (!vaultContract) return res.json({ onchain: false, note: "settlement disabled in this deployment" });
  try {
    const bal = await vaultContract.balanceOf(req.params.address);
    res.json({ onchain: true, balance: bal.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 综合保证金视图：Vault 的 mUSDC 余额 + MultiCollateralVaultV2 的 RWA 抵押估值 */
app.get("/account/:address/margin", async (req, res) => {
  if (!ethers.isAddress(req.params.address)) {
    return res.status(400).json({ error: "invalid address" });
  }
  const m = await marginService.getMargin(req.params.address);
  res.json({
    address: m.address,
    vaultBalance: m.vaultBalance.toString(),
    rwaAccountValueQuote: m.rwaAccountValueQuote.toString(),
    rwaMarginValue: m.rwaMarginValue === null ? null : m.rwaMarginValue.toString(),
    effectiveMargin: m.effectiveMargin.toString(),
    rwaConfigured: m.rwaConfigured,
    rwaCounted: m.rwaCounted,
    enforce: MARGIN_ENFORCE,
    sourceErrors: m.sourceErrors,
  });
});

/** 单个交易者的仓位（含标记价下的浮盈亏、权益、强平价） */
app.get("/positions/:address", (req, res) => {
  if (!ethers.isAddress(req.params.address)) {
    return res.status(400).json({ error: "invalid address" });
  }
  res.json(serializePositionSnapshot(positions.snapshot(req.params.address)));
});

/** 全部未平仓位 */
app.get("/positions", (_req, res) => {
  res.json(positions.allSnapshots().map(serializePositionSnapshot));
});

/** 任何人可触发的强平检查（真实系统里这一步由清算人抢跑，这里开放触发） */
app.post("/positions/check-liquidations", async (_req, res) => {
  const mark = await markOracle.getMark();
  if (mark) positions.setMarkPrice(mark.price);
  res.json({ liquidated: runLiquidations(), mark: mark ? { price: mark.price.toString(), source: mark.source } : null });
});

/** 当前标记价及其来源（外部喂价 / 成交 TWAP / 最新成交价兜底）+ 新鲜度 */
app.get("/markprice", async (_req, res) => {
  const mark = await markOracle.getMark();
  res.json(mark
    ? { price: mark.price.toString(), source: mark.source, asOf: mark.asOf, stale: mark.stale }
    : { price: null, source: "unavailable", asOf: null, stale: true });
});

/** 资金费率状态：当前指示费率、多空名义、上次/下次结算时间 */
app.get("/funding", async (_req, res) => {
  res.json(await getFundingStatus());
});

/** 触发资金费结算（仅到期时真正结算；登录用户可调用，未到期返回 applied:false） */
app.post("/funding/apply", async (req, res) => {
  const { traderId } = req.body || {};
  if (!traderId || !hasActiveSession(traderId)) {
    return res.status(401).json({ error: "please /auth/login first" });
  }
  res.json(await applyFundingIfDue());
});

/** 保险基金状态：余额、累计兜底、累计坏账 */
app.get("/insurance", (_req, res) => {
  res.json(serializeInsuranceState());
});

/** 向保险基金注资（记账层；真实部署时这笔钱应由运营方打入链上 Vault 并在此登记） */
app.post("/insurance/fund", (req, res) => {
  const { traderId, amount } = req.body || {};
  if (!traderId || !hasActiveSession(traderId)) {
    return res.status(401).json({ error: "please /auth/login first" });
  }
  if (!ethers.isAddress(traderId)) {
    return res.status(400).json({ error: "traderId must be an address" });
  }
  try {
    const value = BigInt(amount);
    if (value <= 0n) throw new Error("amount must be > 0");
    positions.fundInsurance(value);
    persistInsuranceState();
    res.json(serializeInsuranceState());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/orders", async (req, res) => {
  try {
    const { traderId, side, price, quantity, type, tif, authorization } = req.body;
    if (!hasActiveSession(traderId)) {
      return res.status(401).json({ error: "please /auth/login first" });
    }
    if (!ethers.isAddress(traderId)) {
      return res.status(400).json({ error: "traderId must be an address" });
    }
    if (side !== "buy" && side !== "sell") {
      return res.status(400).json({ error: "side must be buy or sell" });
    }
    const orderType = type || "limit";
    if (orderType !== "limit" && orderType !== "market") {
      return res.status(400).json({ error: "type must be limit or market" });
    }
    const orderTif = tif || (orderType === "market" ? "IOC" : "GTC");
    if (!["GTC", "IOC", "FOK"].includes(orderTif)) {
      return res.status(400).json({ error: "tif must be GTC, IOC or FOK" });
    }
    if (orderType === "market" && orderTif === "GTC") {
      return res.status(400).json({ error: "market order cannot be GTC" });
    }
    let qtyForCheck;
    try {
      qtyForCheck = toBigIntSafe(quantity);
      if (qtyForCheck <= 0n) throw new Error("quantity must be > 0");
      if (orderType === "limit") {
        const p = toBigIntSafe(price);
        if (p <= 0n) throw new Error("limit order requires price > 0");
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const leverage = req.body.leverage === undefined ? 1 : Number(req.body.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > positions.maxLeverage) {
      return res.status(400).json({ error: `leverage must be an integer in [1, ${positions.maxLeverage}]` });
    }
    // 仓位保证金校验（可选开启）：新增敞口需要的保证金 = 新增名义价值 / 杠杆，
    // 可用额度 = 综合保证金（Vault mUSDC + 已计入的 RWA 抵押估值）- 已被未平
    // 仓位占用的部分。纯平仓方向不新增占用、不需要保证金。市价单用对手盘
    // 最优价（无盘口时退标记价）估算名义价值，避免市价单绕过保证金校验。
    if (MARGIN_ENFORCE) {
      const qty = qtyForCheck;
      const notionalPrice = orderType === "limit"
        ? toBigIntSafe(price)
        : ((side === "buy" ? book.getBestAsk() : book.getBestBid()) ?? positions.getMarkPrice());
      if (notionalPrice === null || notionalPrice === undefined) {
        return res.status(503).json({ error: "margin check unavailable: no reference price for market order" });
      }
      const current = positions.getPosition(traderId);
      const absSize = current.sizeSigned > 0n ? current.sizeSigned : -current.sizeSigned;
      const isReducing =
        current.sizeSigned !== 0n && (side === "sell") === (current.sizeSigned > 0n);
      const addQty = isReducing ? (qty > absSize ? qty - absSize : 0n) : qty;
      const requiredMargin = (addQty * notionalPrice + BigInt(leverage) - 1n) / BigInt(leverage);
      if (requiredMargin > 0n) {
        const margin = await marginService.getMargin(traderId);
        if (margin.sourceErrors.length) {
          return res.status(503).json({ error: `margin check unavailable: ${margin.sourceErrors.join("; ")}` });
        }
        const available = margin.effectiveMargin - positions.reservedMargin(traderId);
        if (available < requiredMargin) {
          return res.status(403).json({
            error:
              `insufficient margin for ${leverage}x position: required ${requiredMargin.toString()}, available ${available.toString()} ` +
              `(effective ${margin.effectiveMargin.toString()} = vault ${margin.vaultBalance.toString()} + RWA collateral ` +
              `${margin.rwaMarginValue === null ? "not counted" : margin.rwaMarginValue.toString()}, reserved ${positions.reservedMargin(traderId).toString()})`,
          });
        }
      }
    }
    // v2 结算模式下，买单必须携带买方自己签署的 EIP-712 授权（对应 VaultV2.settleWithAuthorization），
    // 因为撮合后由买方向卖方转账，operator 只能在这份授权圈定的额度/有效期内代为结算。
    if (VAULT_ABI_VERSION === "v2" && vaultContract && side === "buy") {
      if (!authorization || !authorization.maxAmount || !authorization.nonce || !authorization.deadline || !authorization.signature) {
        return res.status(400).json({ error: "v2 settlement mode requires a signed `authorization` on buy orders" });
      }
    }

    const input = {
      traderId,
      side,
      quantity: toBigIntSafe(quantity),
      type: orderType,
      tif: orderTif,
    };
    if (orderType === "limit" && price !== undefined && price !== null) input.price = toBigIntSafe(price);

    const { order, trades } = book.placeOrder(input);
    order.leverage = leverage;
    orderLeverages.set(order.id, leverage);
    if (authorization) {
      orderAuthorizations.set(order.id, { ...authorization, from: traderId });
    }
    persistOrderResult(order, trades, authorization || null);
    // 撮合可能改变了盘口里已存在的 maker 挂单（部分成交/完全成交），必须一并同步落库，
    // 否则重启恢复订单簿时会读到过期的"幽灵挂单"。
    const touchedOrderIds = new Set(trades.flatMap((t) => [t.buyOrderId, t.sellOrderId]));
    touchedOrderIds.delete(order.id);
    for (const id of touchedOrderIds) {
      const maker = book.getOrder(id);
      if (maker) persistOrderState(maker);
    }

    broadcastPublic("orderbook", serializeSnapshot(book.getSnapshot(20)));
    if (trades.length) broadcastPublic("trades", trades.map(serializeTrade));
    pushPrivate(traderId, "order_update", serializeOrder(order));

    // 成交记入仓位引擎：更新双方净仓位/保证金占用，标记价随最新成交移动，
    // 然后全局扫描强平（标记价移动可能危及不相关的第三方仓位）。
    if (trades.length) {
      for (const t of trades) {
        const { buyer, seller } = positions.applyTrade({
          buyTraderId: t.buyTraderId,
          sellTraderId: t.sellTraderId,
          price: t.price,
          quantity: t.quantity,
          buyLeverage: orderLeverages.get(t.buyOrderId) ?? 1,
          sellLeverage: orderLeverages.get(t.sellOrderId) ?? 1,
        });
        persistSnapshot(buyer);
        persistSnapshot(seller);
        markOracle.addTradeSample(t.price);
        pushPrivate(t.buyTraderId, "position_update", serializePositionSnapshot(buyer));
        pushPrivate(t.sellTraderId, "position_update", serializePositionSnapshot(seller));
      }
      // 标记价不直接用最新成交价：先问预言机（外部喂价 > 成交 TWAP > 兜底），
      // 再扫描强平，避免一笔小额成交把标记价砸到别人的强平线上。
      const mark = await markOracle.getMark();
      if (mark) {
        positions.setMarkPrice(mark.price);
        for (const traderId of new Set(trades.flatMap((t) => [t.buyTraderId, t.sellTraderId]))) {
          pushPrivate(traderId, "position_update", serializePositionSnapshot(positions.snapshot(traderId)));
        }
      }
      runLiquidations();
    }

    // 可选：把撮合出的成交实时结算到链上 Vault（需要配置 VAULT_ADDRESS + OPERATOR_PRIVATE_KEY）
    if (vaultContract && trades.length) {
      for (const t of trades) {
        try {
          // 演示口径：按成交金额 (price * quantity) 从买方向卖方结算保证金差额，
          // 真实永续合约的盯市盈亏结算会更复杂，这里做最小可行演示。
          const amount = t.price * t.quantity;
          const tradeRef = ethers.id(t.id);
          let tx;
          if (VAULT_ABI_VERSION === "v2") {
            const auth = orderAuthorizations.get(t.buyOrderId);
            if (!auth) throw new Error(`missing signed authorization for buy order ${t.buyOrderId}`);
            tx = await vaultContract.settleWithAuthorization(
              t.buyTraderId,
              t.sellTraderId,
              amount,
              tradeRef,
              auth.maxAmount,
              auth.nonce,
              auth.deadline,
              auth.signature
            );
          } else {
            tx = await vaultContract.settle(t.buyTraderId, t.sellTraderId, amount, tradeRef);
          }
          const receipt = await tx.wait();
          marginService.invalidate(t.buyTraderId);
          marginService.invalidate(t.sellTraderId);
          markTradeSettled(t.id, receipt.hash);
          pushPrivate(t.buyTraderId, "settled", { tradeId: t.id, txHash: receipt.hash });
          pushPrivate(t.sellTraderId, "settled", { tradeId: t.id, txHash: receipt.hash });
        } catch (settleErr) {
          console.error("[settlement] failed for trade", t.id, settleErr.message);
          // 以前这里只写服务端日志，前端会一直等不到 settled 事件、看起来像"卡住了"。
          // 现在把失败明确推给成交双方，前端可以把原因展示出来（常见如保证金余额不足）。
          pushPrivate(t.buyTraderId, "settlement_failed", { tradeId: t.id, error: settleErr.message });
          pushPrivate(t.sellTraderId, "settlement_failed", { tradeId: t.id, error: settleErr.message });
        }
      }
    }

    res.json({ order: serializeOrder(order), trades: trades.map(serializeTrade) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/orders/:id/cancel", (req, res) => {
  // 撤单必须表明身份：已登录、且只能撤自己的单。以前任何人猜到订单 id
  // （order-1、order-2… 顺序可猜）就能撤掉别人的挂单，属于未授权操作。
  const { traderId } = req.body || {};
  if (!traderId) return res.status(400).json({ error: "traderId is required to cancel an order" });
  if (!hasActiveSession(traderId)) {
    return res.status(401).json({ error: "please /auth/login first" });
  }
  const existing = book.getOrder(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: "order not found" });
  if (existing.traderId.toLowerCase() !== String(traderId).toLowerCase()) {
    return res.status(403).json({ ok: false, error: "cannot cancel another trader's order" });
  }
  const ok = book.cancelOrder(req.params.id);
  if (ok) {
    // 撤单结果必须落库：以前只改内存，进程重启后 loadOpenOrders() 会把这笔
    // 已撤订单从数据库里当成挂单恢复出来（"幽灵挂单"）。
    persistOrderState(existing);
    orderAuthorizations.delete(req.params.id);
    broadcastPublic("orderbook", serializeSnapshot(book.getSnapshot(20)));
    pushPrivate(existing.traderId, "order_update", serializeOrder(existing));
  }
  res.json({ ok });
});

// 资金费到期结算：每分钟检查一次，是否真正结算由 applyFundingIfDue 按周期判断
if (FUNDING_INTERVAL_MS >= 0) {
  const fundingTimer = setInterval(() => {
    applyFundingIfDue().catch((e) => console.error("[funding] scheduler error:", e.message));
  }, 60_000);
  fundingTimer.unref?.();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mini-Dex server listening on http://0.0.0.0:${PORT}`);
});
