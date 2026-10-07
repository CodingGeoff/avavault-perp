import { ethers } from "ethers";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. This script needs a throwaway Fuji testnet private key, ` +
      `set as an env var (see .env.example). Never use a key that holds real funds.`
    );
  }
  return v;
}


// 真实端到端验证脚本：VaultV2 的 EIP-712 签名授权结算（修复 SECURITY_REVIEW.md Finding #4）。
// 用两个已经在 Fuji 上真实向 VaultV2 deposit 过 mUSDC 的交易者账号，买方在下单时用自己的私钥
// 签署一份"最多同意转出多少"的授权，服务端撮合成交后携带这份签名调用链上 settleWithAuthorization()。
//
// ⚠️ 下面两把私钥是专门为这次演示生成的一次性测试网小号，没有真实价值，可以安全公开。
const API = process.env.API_URL || "http://localhost:4000";

const traderA = new ethers.Wallet(requireEnv("DEMO_TRADER_A_KEY")); // 卖方
const traderB = new ethers.Wallet(requireEnv("DEMO_TRADER_B_KEY")); // 买方

async function login(wallet) {
  const message = `Mini-Dex login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  console.log("login ok:", wallet.address);
}

async function getDomain() {
  const res = await fetch(`${API}/settlement/domain`);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function signAuthorization(wallet, domain, types, maxAmount, nonce, deadline) {
  const value = { from: wallet.address, maxAmount, nonce, deadline };
  const signature = await wallet.signTypedData(domain, types, value);
  return signature;
}

async function placeOrder(wallet, side, price, quantity, authorization) {
  const body = { traderId: wallet.address, side, price, quantity };
  if (authorization) body.authorization = authorization;
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log(`order [${wallet.address}] ${side} ${quantity}@${price} ->`, JSON.stringify(data));
  return { status: res.status, data };
}

async function main() {
  console.log("=== login both real, VaultV2-funded traders ===");
  await login(traderA);
  await login(traderB);

  const { domain, types } = await getDomain();
  console.log("\nEIP-712 domain from server:", domain);

  console.log("\n=== 1) reject: buy order WITHOUT any authorization ===");
  const noAuthResult = await placeOrder(traderB, "buy", "2500", "1");
  console.log("expected 400 (missing authorization):", noAuthResult.status);

  console.log("\n=== 2) real trade WITH a valid EIP-712 authorization from the buyer ===");
  const maxAmount = "50000"; // 2500 * 10 (预留一点余量给部分成交场景)
  const nonce = Date.now().toString();
  const deadline = (Math.floor(Date.now() / 1000) + 3600).toString();
  const signature = await signAuthorization(traderB, domain, types, maxAmount, nonce, deadline);

  await placeOrder(traderA, "sell", "2500", "10");
  const buyResult = await placeOrder(traderB, "buy", "2500", "10", { maxAmount, nonce, deadline, signature });
  console.log("trades:", JSON.stringify(buyResult.data.trades, null, 2));

  console.log("\nwaiting 6s for async on-chain settleWithAuthorization() to land...");
  await new Promise((r) => setTimeout(r, 6000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
