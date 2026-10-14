import { ethers } from "ethers";

/**
 * 进阶功能：做市机器人。
 * 围绕一个参考中间价，买卖两侧各挂 3 档（价差递增、数量递增，模拟真实做市商的阶梯报价），
 * 每隔 N 秒撤销旧单、重新按最新参考价挂单。
 *
 * 用法： API_URL=http://localhost:4000 MID_PRICE=2500 node src/marketMaker.js
 */

const API_URL = process.env.API_URL || "http://localhost:4000";
const TICK = 1n; // 价格档位间距（最小单位）
const LEVELS = 3;
const BASE_QTY = 10n;
const REFRESH_MS = Number(process.env.REFRESH_MS || 30000); // 默认 30 秒一轮，避免无谓的 API/带宽消耗；可用 REFRESH_MS 环境变量调密

const wallet = ethers.Wallet.createRandom();
let openOrderIds = [];

async function login() {
  const message = `Mini-Dex market maker login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  if (!res.ok) throw new Error(`login failed: ${await res.text()}`);
  console.log("[mm] logged in as", wallet.address);
}

async function cancelAll() {
  for (const id of openOrderIds) {
    await fetch(`${API_URL}/orders/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traderId: wallet.address }),
    }).catch(() => {});
  }
  openOrderIds = [];
}

// v2 结算模式下买单必须附带买方自己的 EIP-712 授权，做市机器人也不例外。
// 服务端不是 v2 模式时 /settlement/domain 会返回 400，这里就退回不带授权的下单。
let settlementDomain = null;
async function loadSettlementDomain() {
  try {
    const res = await fetch(`${API_URL}/settlement/domain`);
    if (res.ok) settlementDomain = await res.json();
  } catch {
    settlementDomain = null;
  }
}

async function buildAuthorization(price, quantity) {
  if (!settlementDomain) return undefined;
  const { domain, types } = settlementDomain;
  const maxAmount = (price * quantity).toString();
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

async function placeOrder(side, price, quantity) {
  const body = {
    traderId: wallet.address,
    side,
    price: price.toString(),
    quantity: quantity.toString(),
    type: "limit",
    tif: "GTC",
  };
  if (side === "buy") {
    const authorization = await buildAuthorization(price, quantity);
    if (authorization) body.authorization = authorization;
  }
  const res = await fetch(`${API_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.order) openOrderIds.push(data.order.id);
  return data;
}

async function refreshQuotes(midPrice) {
  await cancelAll();
  for (let i = 1; i <= LEVELS; i++) {
    const bidPrice = midPrice - TICK * BigInt(i);
    const askPrice = midPrice + TICK * BigInt(i);
    const qty = BASE_QTY * BigInt(i); // 越远离中间价，挂单量越大（典型做市阶梯）
    await placeOrder("buy", bidPrice, qty);
    await placeOrder("sell", askPrice, qty);
  }
  console.log(`[mm] refreshed quotes around mid=${midPrice}, ${LEVELS * 2} orders live`);
}

async function main() {
  await login();
  await loadSettlementDomain();
  const midPrice = BigInt(process.env.MID_PRICE || 2500);
  await refreshQuotes(midPrice);
  setInterval(() => refreshQuotes(midPrice), REFRESH_MS);
}

main().catch((e) => {
  console.error("[mm] fatal error:", e);
  process.exit(1);
});
