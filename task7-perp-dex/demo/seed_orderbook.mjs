// 给 Mini Perp-Dex 演示用的订单簿灌入一批真实撮合引擎处理过的订单/成交记录，
// 纯粹是为了让截图里的订单簿和成交日志看起来是"真的有人在交易"，不是空页面。
// 所有签名都是真实的 ECDSA 签名（ethers Wallet 签出来的），服务端也会真实验证签名，
// 只是这些钱包地址是本脚本随机生成的演示账户，不代表任何真实资金。
import { ethers } from "ethers";

const API = process.env.API_URL || "http://localhost:4000";

async function login(wallet) {
  const address = wallet.address;
  const message = `Mini-Dex login for ${address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, message, signature }),
  });
  if (!res.ok) throw new Error(await res.text());
  return address;
}

// v2 结算模式下买单必须附带买方自己的 EIP-712 授权；服务端不是 v2 模式时
// /settlement/domain 返回 400，此时退回不带授权的下单（与前端行为一致）。
let settlementDomain = null;
async function loadSettlementDomain() {
  try {
    const res = await fetch(`${API}/settlement/domain`);
    if (res.ok) settlementDomain = await res.json();
  } catch {
    settlementDomain = null;
  }
}

async function buildAuthorization(wallet, price, quantity) {
  if (!settlementDomain) return undefined;
  const { domain, types } = settlementDomain;
  const maxAmount = (BigInt(price) * BigInt(quantity)).toString();
  const nonce = (Date.now() * 1000 + Math.floor(Math.random() * 1000)).toString();
  const deadline = (Math.floor(Date.now() / 1000) + 3600).toString();
  const signature = await wallet.signTypedData(domain, types, {
    from: wallet.address,
    maxAmount,
    nonce,
    deadline,
  });
  return { maxAmount, nonce, deadline, signature };
}

async function placeOrder(wallet, side, price, quantity, tif = "GTC") {
  const body = { traderId: wallet.address, side, price, quantity, tif, type: "limit" };
  if (side === "buy") {
    const authorization = await buildAuthorization(wallet, price, quantity);
    if (authorization) body.authorization = authorization;
  }
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function main() {
  const makerA = ethers.Wallet.createRandom();
  const makerB = ethers.Wallet.createRandom();
  const taker = ethers.Wallet.createRandom();

  await loadSettlementDomain();
  await login(makerA);
  await login(makerB);
  await login(taker);

  // 挂出一组买卖盘深度（价格围绕 2500 USDC 的 AVAX-PERP 市场）
  const bids = [2498, 2497, 2496, 2495, 2493];
  const asks = [2502, 2503, 2504, 2505, 2507];
  for (const p of bids) await placeOrder(makerA, "buy", p, Math.floor(Math.random() * 3 + 1));
  for (const p of asks) await placeOrder(makerB, "sell", p, Math.floor(Math.random() * 3 + 1));

  // 再挂几档更深的
  await placeOrder(makerA, "buy", 2490, 8);
  await placeOrder(makerB, "sell", 2512, 6);

  // 用一个 taker 市价吃掉几笔，制造真实成交记录
  await placeOrder(taker, "buy", 2503, 1, "IOC");
  await placeOrder(taker, "sell", 2497, 1, "IOC");

  console.log("seeded order book with", { makerA: makerA.address, makerB: makerB.address, taker: taker.address });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
