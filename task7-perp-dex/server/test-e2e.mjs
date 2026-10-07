import { ethers } from "ethers";

const API = process.env.API_URL || "http://localhost:4000";

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

async function placeOrder(wallet, side, price, quantity, extra = {}) {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traderId: wallet.address, side, price, quantity, ...extra }),
  });
  const data = await res.json();
  console.log(`order [${wallet.address.slice(0, 8)}] ${side} ${quantity}@${price} ->`, JSON.stringify(data));
  return data;
}

async function main() {
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();

  console.log("=== 1. login (wallet signature) ===");
  await login(alice);
  await login(bob);

  console.log("\n=== 2. reject unauthenticated order ===");
  const rogue = ethers.Wallet.createRandom();
  const rejected = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traderId: rogue.address, side: "buy", price: "100", quantity: "1" }),
  });
  console.log("unauthenticated order status:", rejected.status, "(expect 401)");

  console.log("\n=== 3. two different addresses complete a trade ===");
  await placeOrder(alice, "sell", "2500", "10");
  const buyResult = await placeOrder(bob, "buy", "2500", "10");
  console.log("trade executed:", buyResult.trades.length > 0 ? "YES" : "NO");

  console.log("\n=== 4. self-trade prevention sanity check ===");
  await placeOrder(alice, "buy", "2400", "5");
  const selfTradeAttempt = await placeOrder(alice, "sell", "2400", "5");
  console.log("self-trade produced 0 trades:", selfTradeAttempt.trades.length === 0);

  console.log("\n=== 5. orderbook snapshot ===");
  const ob = await (await fetch(`${API}/orderbook`)).json();
  console.log(JSON.stringify(ob, null, 2));

  console.log("\n=== 6. IOC order ===");
  await placeOrder(bob, "sell", "2600", "3");
  const iocResult = await placeOrder(alice, "buy", "2600", "10", { tif: "IOC" });
  console.log("IOC filled 3, cancelled remaining 7:", iocResult.order.remaining === "0");

  console.log("\n=== 7. FOK order (should be rejected, insufficient liquidity) ===");
  const fokResult = await placeOrder(bob, "buy", "9999", "999999", { tif: "FOK" });
  console.log("FOK cancelled with 0 trades:", fokResult.trades.length === 0 && fokResult.order.status === "cancelled");

  console.log("\nAll E2E scenarios executed. See screenshots checklist in README for what to capture manually.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
