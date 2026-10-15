// 演示对手盘铺设脚本（推荐做法，开演前 3–5 分钟跑一次）。
//
// 为什么需要它：参考价链条是「外部喂价 > 成交 TWAP > 盘口最优价」。刚重置过的
// 演示环境三者全空，于是：
//   1. /hedge/quote 报 "no reference price available"，第 5 步对冲测算卡死；
//   2. 盘口没有对手单，第 6 步的对冲空单只能挂着 → 没有仓位、没有强平价；
//   3. 没有成交 → 没有链上结算 → 第 7 步拿不出 Snowtrace 凭证。
//
// 这个脚本用两个**已经在 VaultV2 里存过 mUSDC** 的演示钱包铺出真实双边盘口：
//   - A（卖方钱包）挂卖盘阶梯；
//   - B（买方钱包）挂买盘阶梯，并带上真实的 EIP-712 结算授权 —— 这一点是关键：
//     你的对冲空单吃进 B 的买单时，operator 才能在授权额度内把保证金从 B 转给你，
//     链上结算真的会成功，成交表里才会出现可点开的 Snowtrace 哈希。
//   - 可选先对敲 CROSS_TRADES 笔，让成交历史/价格走势/标记价 TWAP 一开场就有样本。
//
// 用法：
//   export DEMO_TRADER_A_KEY=0x...   # 卖盘钱包（Vault 里有 mUSDC）
//   export DEMO_TRADER_B_KEY=0x...   # 买盘钱包（Vault 里有 mUSDC，决定结算能否成功）
//   API_URL=https://avavault-perp-dex-api.onrender.com MID_PRICE=2500 node seed_counterparty.mjs
//
// 可选环境变量：LEVELS(3) QTY(100) CROSS_TRADES(2) ADMIN_RESET_TOKEN（先清空服务端演示状态）
import { ethers } from "ethers";

const API = (process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");
const MID_PRICE = BigInt(process.env.MID_PRICE || 2500);
const LEVELS = Number(process.env.LEVELS || 3);
const QTY = BigInt(process.env.QTY || 100);
const CROSS_TRADES = Number(process.env.CROSS_TRADES ?? 2);
const VAULT_V2 = process.env.VAULT_ADDRESS || "0x0425352bc3c5293D5629c27525969439Ab9C27b5";
const RPC_URL = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";

function requireEnv(name, hint) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少 ${name}。${hint}`);
  return v;
}

const seller = new ethers.Wallet(requireEnv("DEMO_TRADER_A_KEY", "卖盘钱包私钥（Vault 里需有 mUSDC）"));
const buyer = new ethers.Wallet(requireEnv("DEMO_TRADER_B_KEY", "买盘钱包私钥（成交时由它付款，Vault 里必须有 mUSDC）"));

async function jfetch(path, options) {
  const res = await fetch(`${API}${path}`, options);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function login(wallet) {
  const message = `Mini-Dex login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await jfetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  if (res.status !== 200) throw new Error(`登录失败 ${wallet.address}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
}

let settlementDomain = null;
async function loadSettlementDomain() {
  const res = await jfetch("/settlement/domain");
  settlementDomain = res.status === 200 ? res.body : null;
  if (!settlementDomain) console.warn("[seed] 服务端不是 v2 结算模式，买单将不带授权（链上结算会失败）");
}

async function buildAuthorization(wallet, price, quantity) {
  if (!settlementDomain) return undefined;
  const { domain, types } = settlementDomain;
  const maxAmount = (BigInt(price) * BigInt(quantity)).toString();
  const nonce = (Date.now() * 1000 + Math.floor(Math.random() * 1000)).toString();
  const deadline = (Math.floor(Date.now() / 1000) + 3600).toString();
  const signature = await wallet.signTypedData(domain, types, { from: wallet.address, maxAmount, nonce, deadline });
  return { maxAmount, nonce, deadline, signature };
}

async function placeOrder(wallet, { side, price, quantity, tif = "GTC", type = "limit", leverage = 1 }) {
  const body = {
    traderId: wallet.address,
    side,
    price: String(price),
    quantity: String(quantity),
    tif,
    type,
    leverage,
  };
  if (side === "buy") {
    const authorization = await buildAuthorization(wallet, price, quantity);
    if (authorization) body.authorization = authorization;
  }
  const res = await jfetch("/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`下单失败 ${side} ${price}×${quantity}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** 撤掉这两个钱包自己遗留的挂单，让脚本可以反复跑（"全部重试"友好） */
async function cancelOwnOrders() {
  const res = await jfetch("/orders/open");
  if (res.status !== 200 || !Array.isArray(res.body)) return 0;
  const mine = res.body.filter((o) =>
    [seller.address, buyer.address].some((a) => a.toLowerCase() === o.traderId.toLowerCase()) && BigInt(o.remaining) > 0n
  );
  for (const o of mine) {
    const wallet = o.traderId.toLowerCase() === seller.address.toLowerCase() ? seller : buyer;
    await jfetch(`/orders/${o.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traderId: wallet.address }),
    });
  }
  return mine.length;
}

/** 读两个钱包在 VaultV2 里的 mUSDC 余额：买方余额为 0 时链上结算必然失败，必须提前发现 */
async function checkVaultBalances() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const vault = new ethers.Contract(VAULT_V2, ["function balanceOf(address) view returns (uint256)"], provider);
  const [s, b] = await Promise.all([vault.balanceOf(seller.address), vault.balanceOf(buyer.address)]);
  return { seller: s, buyer: b };
}

async function main() {
  console.log(`[seed] API=${API} mid=${MID_PRICE} levels=${LEVELS} qty=${QTY} crosses=${CROSS_TRADES}`);
  console.log(`[seed] seller(A)=${seller.address}\n[seed] buyer(B)=${buyer.address}`);

  if (process.env.ADMIN_RESET_TOKEN) {
    const res = await jfetch("/admin/reset-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": process.env.ADMIN_RESET_TOKEN },
    });
    console.log(`[seed] 服务端演示状态重置: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }

  const balances = await checkVaultBalances().catch((e) => {
    console.warn(`[seed] 读链上余额失败（不影响挂单，但请自行确认买方有钱）: ${e.message}`);
    return null;
  });
  if (balances) {
    console.log(`[seed] Vault mUSDC 余额: seller=${ethers.formatUnits(balances.seller, 6)} buyer=${ethers.formatUnits(balances.buyer, 6)}`);
    const firstBidNeed = (MID_PRICE - 1n) * QTY;
    const fullLadderNeed = Array.from({ length: LEVELS }, (_, n) => {
      const i = BigInt(n + 1);
      return (MID_PRICE - i) * QTY * i;
    }).reduce((a, b) => a + b, 0n);
    if (balances.buyer < firstBidNeed) {
      console.error(`[seed] ⚠️ 买方余额不足：第一档成交至少需要 ${ethers.formatUnits(firstBidNeed, 6)} mUSDC，当前 ${ethers.formatUnits(balances.buyer, 6)}。`);
      console.error("[seed]    先用买方钱包在演示页领取并存入测试 mUSDC，再重跑本脚本。");
    } else if (balances.buyer < fullLadderNeed) {
      console.warn(`[seed] ⚠️ 第一档可结算，但余额不足以覆盖整组买盘（完整深度需要 ${ethers.formatUnits(fullLadderNeed, 6)} mUSDC）。小额演示仍可继续。`);
    }
  }

  await login(seller);
  await login(buyer);
  await loadSettlementDomain();

  const cancelled = await cancelOwnOrders();
  if (cancelled) console.log(`[seed] 已撤掉遗留挂单 ${cancelled} 笔`);

  // 先铺买盘（演示者的对冲空单需要买盘承接），再铺卖盘
  for (let i = 1; i <= LEVELS; i++) {
    await placeOrder(buyer, { side: "buy", price: MID_PRICE - BigInt(i), quantity: QTY * BigInt(i) });
  }
  for (let i = 1; i <= LEVELS; i++) {
    await placeOrder(seller, { side: "sell", price: MID_PRICE + BigInt(i), quantity: QTY * BigInt(i) });
  }

  // 对敲几笔真实成交：成交历史、价格走势、标记价 TWAP 一开场就有样本，
  // 而且这几笔本身就是两个有钱包之间的真实链上结算（可以在 Snowtrace 复查）。
  const crosses = [];
  for (let i = 0; i < CROSS_TRADES; i++) {
    const buyPrice = MID_PRICE + BigInt(LEVELS); // 吃掉卖方最外档
    const r = await placeOrder(buyer, { side: "buy", price: buyPrice, quantity: 1n, tif: "IOC" });
    crosses.push(...(r.trades || []));
    const sellPrice = MID_PRICE - BigInt(LEVELS); // 吃掉买方最外档
    const r2 = await placeOrder(seller, { side: "sell", price: sellPrice, quantity: 1n, tif: "IOC" });
    crosses.push(...(r2.trades || []));
  }
  console.log(`[seed] 对敲成交 ${crosses.length} 笔: ${crosses.map((t) => `${t.id}@${t.price}`).join(", ") || "无"}`);

  // 对敲吃掉了最外档，重新补一轮买盘，保证演示者的空单一定吃得到
  for (let i = 1; i <= LEVELS; i++) {
    await placeOrder(buyer, { side: "buy", price: MID_PRICE - BigInt(i), quantity: QTY * BigInt(i) });
  }

  const [bookRes, markRes, hedgeRes, statusRes] = await Promise.all([
    jfetch("/orderbook"),
    jfetch("/markprice"),
    jfetch(`/hedge/quote?assetValue=500000&hedgeRatioBps=10000&leverage=5`),
    jfetch("/demo/status"),
  ]);
  console.log(`[seed] 盘口: bids=${bookRes.body?.bids?.length ?? 0} asks=${bookRes.body?.asks?.length ?? 0} ` +
    `bestBid=${bookRes.body?.bids?.[0]?.price ?? "-"} bestAsk=${bookRes.body?.asks?.[0]?.price ?? "-"}`);
  console.log(`[seed] 标记价: ${markRes.body?.price ?? "无"}（来源 ${markRes.body?.source ?? "-"}）`);
  console.log(`[seed] 对冲测算自检: HTTP ${hedgeRes.status} ` +
    (hedgeRes.status === 200
      ? `参考价 ${hedgeRes.body.referencePrice}（${hedgeRes.body.referencePriceSource}），建议空单 ${hedgeRes.body.quantity}`
      : JSON.stringify(hedgeRes.body)));
  if (statusRes.status === 200 && Array.isArray(statusRes.body.checks)) {
    console.log("[seed] 演示自检:");
    for (const c of statusRes.body.checks) console.log(`   ${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`);
  }
  console.log("[seed] 完成。现在打开演示页：第 5 步能算出对冲仓位，第 6 步空单会立刻成交并上链结算。");
}

main().catch((e) => {
  console.error("[seed] 失败:", e.message);
  process.exit(1);
});
