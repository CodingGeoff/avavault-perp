// 给录屏专门准备的订单簿深度：卖盘深度用随机账号的真实签名挂单（卖单不需要 v2 授权），
// 买盘深度同样用随机账号，但会生成真实的 EIP-712 签名授权（只是签名，不需要账号有真实资金——
// 因为这些挂单价格故意设置在不会被成交的区间，不会触发链上结算，只用来让订单簿界面显得有深度）。
// 真正会在录屏里被吃掉、触发真实链上结算的，是 trader A 挂的那笔 2550 卖单。
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


const API = process.env.API_URL || "http://localhost:4000";

const traderA = new ethers.Wallet(requireEnv("DEMO_TRADER_A_KEY")); // 真实已在 VaultV2 存款的卖方

async function login(wallet) {
  const message = `Mini-Dex login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function getDomain() {
  const res = await fetch(`${API}/settlement/domain`);
  return res.json();
}

async function placeOrder(wallet, side, price, quantity, authorization) {
  const body = { traderId: wallet.address, side, price: String(price), quantity: String(quantity), tif: "GTC", type: "limit" };
  if (authorization) body.authorization = authorization;
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
  const { domain, types } = await getDomain();

  // ---- 卖盘深度（不需要授权） ----
  const asks = [2552, 2555, 2558, 2561, 2565];
  for (const p of asks) {
    const w = ethers.Wallet.createRandom();
    await login(w);
    await placeOrder(w, "sell", p, Math.floor(Math.random() * 3 + 1));
  }

  // ---- 买盘深度（低于 2550，不会被成交，签名只是为了满足 v2 校验） ----
  const bids = [2545, 2542, 2538, 2535, 2530];
  for (const p of bids) {
    const w = ethers.Wallet.createRandom();
    await login(w);
    const maxAmount = String(p * 50);
    const nonce = String(Date.now() + Math.floor(Math.random() * 1000));
    const deadline = String(Math.floor(Date.now() / 1000) + 3600);
    const signature = await w.signTypedData(domain, types, { from: w.address, maxAmount, nonce, deadline });
    await placeOrder(w, "buy", p, Math.floor(Math.random() * 3 + 1), { maxAmount, nonce, deadline, signature });
  }

  // ---- 真正会在录屏里被吃掉的那笔挂单：trader A 真实账号挂一个 2550 的卖单 ----
  await login(traderA);
  await placeOrder(traderA, "sell", 2550, 3);

  console.log("seeded for recording. traderA (seller) =", traderA.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
