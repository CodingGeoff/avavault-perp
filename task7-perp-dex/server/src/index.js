import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { OrderBook } from "../../matching-engine/dist/orderbook.js";
import { persistOrderResult, persistOrderState, markTradeSettled, loadRecentTrades, loadOpenOrders } from "./db.js";

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
  restoredCount++;
}
const recentTrades = loadRecentTrades(1);
if (recentTrades.length) book.fastForwardTradeSeq(recentTrades[0].id);
console.log(`[startup] restored ${restoredCount} open order(s) from SQLite`);

// 简单会话存储：地址 -> 最近一次签名登录时间
const sessions = new Map();

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
  const address = url.searchParams.get("address");
  clients.set(ws, address);
  ws.send(JSON.stringify({ type: "snapshot", payload: serializeSnapshot(book.getSnapshot()) }));
  ws.on("close", () => clients.delete(ws));
});

// ---------------------------------------------------------------
// REST API
// ---------------------------------------------------------------

app.get("/health", (_req, res) =>
  res.json({ ok: true, settlementEnabled: !!vaultContract, settlementVersion: VAULT_ABI_VERSION })
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
    sessions.set(address.toLowerCase(), Date.now());
    res.json({ ok: true, address });
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

app.post("/orders", async (req, res) => {
  try {
    const { traderId, side, price, quantity, type, tif, authorization } = req.body;
    if (!sessions.has(String(traderId).toLowerCase())) {
      return res.status(401).json({ error: "please /auth/login first" });
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
      type: type || "limit",
      tif: tif || undefined,
    };
    if (price !== undefined && price !== null) input.price = toBigIntSafe(price);

    const { order, trades } = book.placeOrder(input);
    if (authorization) {
      orderAuthorizations.set(order.id, { ...authorization, from: traderId });
    }
    persistOrderResult(order, trades);
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
          markTradeSettled(t.id, receipt.hash);
          pushPrivate(t.buyTraderId, "settled", { tradeId: t.id, txHash: receipt.hash });
          pushPrivate(t.sellTraderId, "settled", { tradeId: t.id, txHash: receipt.hash });
        } catch (settleErr) {
          console.error("[settlement] failed for trade", t.id, settleErr.message);
        }
      }
    }

    res.json({ order: serializeOrder(order), trades: trades.map(serializeTrade) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/orders/:id/cancel", (req, res) => {
  const ok = book.cancelOrder(req.params.id);
  if (ok) broadcastPublic("orderbook", serializeSnapshot(book.getSnapshot(20)));
  res.json({ ok });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mini-Dex server listening on http://0.0.0.0:${PORT}`);
});
