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


// 真实端到端验证脚本：用两个已经在 Fuji 上真实向 Vault 合约 deposit 过 mUSDC 的交易者账号
// 下一对互相成交的订单，验证撮合引擎能触发一笔真实的链上 Vault.settle() 交易（细节见 README 3.2 节）。
//
// ⚠️ 下面两把私钥是专门为这次演示生成的一次性测试网小号，只装了 0.01 AVAX gas + 100 mUSDC 测试代币，
//    没有任何真实价值，可以安全地公开在仓库里；正式生产环境永远不要把私钥硬编码进代码。
const API = process.env.API_URL || "http://localhost:4000";

const traderA = new ethers.Wallet(requireEnv("DEMO_TRADER_A_KEY"));
const traderB = new ethers.Wallet(requireEnv("DEMO_TRADER_B_KEY"));

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

async function placeOrder(wallet, side, price, quantity) {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traderId: wallet.address, side, price, quantity }),
  });
  const data = await res.json();
  console.log(`order [${wallet.address}] ${side} ${quantity}@${price} ->`, JSON.stringify(data));
  return data;
}

async function main() {
  console.log("=== login both real, on-chain-funded traders ===");
  await login(traderA);
  await login(traderB);

  console.log("\n=== place crossing orders (real on-chain settlement expected) ===");
  await placeOrder(traderA, "sell", "2500", "10");
  const buyResult = await placeOrder(traderB, "buy", "2500", "10");
  console.log("\ntrades:", JSON.stringify(buyResult.trades, null, 2));

  console.log("\nwaiting 6s for async on-chain settle() to land...");
  await new Promise((r) => setTimeout(r, 6000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
