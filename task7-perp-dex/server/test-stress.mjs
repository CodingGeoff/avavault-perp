import { ethers } from "ethers";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { OrderBook } from "../matching-engine/dist/orderbook.js";
import { PositionManager } from "../matching-engine/dist/positions.js";

// 压力/时序边缘套件：随机撮合不变量、并发下单一致性、会话过期、
// 标记价过期标记、WebSocket 私有推送隔离。
// 用法： node test-stress.mjs   （需要先在 ../matching-engine 里 npm run build）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}
// 确定性 PRNG，保证随机测试可复现
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log("=== A. fuzz: 500 random orders keep book invariants ===");
{
  const rnd = mulberry32(42);
  const book = new OrderBook();
  const traders = ["t1", "t2", "t3", "t4", "t5"];
  let selfTrades = 0;
  let negativeRemaining = 0;
  let badSnapshotOrder = 0;
  for (let i = 0; i < 500; i++) {
    const side = rnd() < 0.5 ? "buy" : "sell";
    const type = rnd() < 0.15 ? "market" : "limit";
    const price = 2400n + BigInt(Math.floor(rnd() * 200));
    const qty = 1n + BigInt(Math.floor(rnd() * 5));
    const tif = type === "market" ? "IOC" : ["GTC", "IOC", "FOK"][Math.floor(rnd() * 3)];
    const { order, trades } = book.placeOrder({
      traderId: traders[Math.floor(rnd() * traders.length)],
      side, type, tif, quantity: qty, ...(type === "limit" ? { price } : {}),
    });
    if (order.remaining < 0n) negativeRemaining++;
    for (const t of trades) if (t.buyTraderId === t.sellTraderId) selfTrades++;
    const snap = book.getSnapshot(50);
    for (let j = 1; j < snap.bids.length; j++) if (snap.bids[j - 1].price < snap.bids[j].price) badSnapshotOrder++;
    for (let j = 1; j < snap.asks.length; j++) if (snap.asks[j - 1].price > snap.asks[j].price) badSnapshotOrder++;
    for (const level of [...snap.bids, ...snap.asks]) if (level.quantity <= 0n) badSnapshotOrder++;
  }
  check("no self-trades in 500 random orders (STP invariant)", selfTrades === 0);
  check("no negative remaining quantities", negativeRemaining === 0);
  check("snapshot always sorted & positive quantities", badSnapshotOrder === 0);
}

console.log("\n=== B. fuzz: positions stay net-zero until liquidation ===");
{
  const rnd = mulberry32(7);
  const pm = new PositionManager();
  const traders = ["t1", "t2", "t3", "t4"];
  for (let i = 0; i < 200; i++) {
    const a = traders[Math.floor(rnd() * traders.length)];
    let b = traders[Math.floor(rnd() * traders.length)];
    if (a === b) b = traders[(traders.indexOf(a) + 1) % traders.length];
    pm.applyTrade({
      buyTraderId: a, sellTraderId: b,
      price: 2400n + BigInt(Math.floor(rnd() * 200)),
      quantity: 1n + BigInt(Math.floor(rnd() * 5)),
      buyLeverage: 1 + Math.floor(rnd() * 20),
      sellLeverage: 1 + Math.floor(rnd() * 20),
    });
  }
  const total = traders.reduce((acc, t) => acc + pm.getPosition(t).sizeSigned, 0n);
  check("sum of all signed positions == 0 (every long has its short)", total === 0n);
  check("no position has negative allocated margin before liquidation",
    traders.every((t) => pm.getPosition(t).marginAllocated >= 0n));
  pm.setMarkPrice(1000n); // 极端崩盘
  const liquidatable = pm.checkLiquidations();
  let recordsOk = true;
  for (const s of liquidatable) {
    const rec = pm.liquidate(s.traderId);
    if (!rec || pm.getPosition(s.traderId).sizeSigned !== 0n) recordsOk = false;
  }
  check(`crash liquidates all at-risk positions cleanly (${liquidatable.length} hit)`, recordsOk);
  check("insurance/bad-debt accounting is non-negative & consistent",
    pm.insuranceFund >= 0n && pm.totalBadDebt >= 0n && pm.totalInsuranceCovered >= 0n);
}

// --- 服务端时序/并发 ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-dex-stress-"));
function startServer(port, extraEnv = {}) {
  const child = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmpDir, `db-${port}.sqlite`), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}
async function stopServer(child) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}
async function waitForHealth(port) {
  for (let i = 0; i < 75; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy");
}
async function login(port, wallet) {
  const message = `Mini-Dex login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  if (!res.ok) throw new Error(`login failed: ${await res.text()}`);
  return res.json();
}
async function post(port, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PORT = 4331;
let server = startServer(PORT);
try {
  await waitForHealth(PORT);
  console.log("\n=== C. concurrency: 20 parallel sells + one market sweep ===");
  const sellers = Array.from({ length: 20 }, () => ethers.Wallet.createRandom());
  for (const w of sellers) await login(PORT, w);
  const buyer = ethers.Wallet.createRandom();
  await login(PORT, buyer);
  const results = await Promise.all(
    sellers.map((w) => post(PORT, "/orders", { traderId: w.address, side: "sell", price: "2500", quantity: "1" }))
  );
  check("all 20 concurrent sells accepted (no 5xx/races)", results.every((r) => r.status === 200));
  const sweep = await post(PORT, "/orders", { traderId: buyer.address, side: "buy", quantity: "20", type: "market", tif: "IOC" });
  const sweptQty = (sweep.data.trades || []).reduce((a, t) => a + BigInt(t.quantity), 0n);
  check("market sweep fills exactly 20 across 20 makers", sweep.status === 200 && sweptQty === 20n);
  const buyerPos = await (await fetch(`http://127.0.0.1:${PORT}/positions/${buyer.address}`)).json();
  check("buyer position is long 20 after sweep", buyerPos.sizeSigned === "20");

  console.log("\n=== D. websocket: private updates only reach the token owner ===");
  const alice = ethers.Wallet.createRandom();
  const { sessionToken } = await login(PORT, alice);
  const wsPriv = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${sessionToken}`);
  const wsAnon = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=bogus-token`);
  const privMsgs = [];
  const anonMsgs = [];
  wsPriv.on("message", (d) => privMsgs.push(JSON.parse(d.toString())));
  wsAnon.on("message", (d) => anonMsgs.push(JSON.parse(d.toString())));
  await Promise.all([
    new Promise((r) => wsPriv.once("open", r)),
    new Promise((r) => wsAnon.once("open", r)),
  ]);
  await new Promise((r) => setTimeout(r, 300));
  await post(PORT, "/orders", { traderId: alice.address, side: "sell", price: "2600", quantity: "1" });
  await new Promise((r) => setTimeout(r, 500));
  wsPriv.close(); wsAnon.close();
  check("owner receives own order_update over WS", privMsgs.some((m) => m.type === "order_update"));
  check("bogus-token connection gets NO private order_update", !anonMsgs.some((m) => m.type === "order_update"));
  check("bogus-token connection still gets public snapshot", anonMsgs.some((m) => m.type === "snapshot"));
} finally {
  await stopServer(server);
}

console.log("\n=== E. session expiry is enforced at runtime (max age 50ms) ===");
{
  const p2 = 4332;
  const s2 = startServer(p2, { SESSION_MAX_AGE_MS: "50" });
  try {
    await waitForHealth(p2);
    const w = ethers.Wallet.createRandom();
    await login(p2, w);
    await new Promise((r) => setTimeout(r, 90));
    const res = await post(p2, "/orders", { traderId: w.address, side: "sell", price: "2500", quantity: "1" });
    check("order with expired session -> 401", res.status === 401);
  } finally {
    await stopServer(s2);
  }
}

console.log("\n=== F. mark price is flagged stale after the TWAP window passes ===");
{
  const p3 = 4333;
  const s3 = startServer(p3, { MARK_PRICE_WINDOW_SEC: "1" });
  try {
    await waitForHealth(p3);
    const a = ethers.Wallet.createRandom();
    const b = ethers.Wallet.createRandom();
    await login(p3, a);
    await login(p3, b);
    await post(p3, "/orders", { traderId: a.address, side: "sell", price: "2500", quantity: "1" });
    await post(p3, "/orders", { traderId: b.address, side: "buy", price: "2500", quantity: "1" });
    const fresh = await (await fetch(`http://127.0.0.1:${p3}/markprice`)).json();
    await new Promise((r) => setTimeout(r, 1300));
    const stale = await (await fetch(`http://127.0.0.1:${p3}/markprice`)).json();
    check("fresh mark is not flagged stale", fresh.stale === false);
    check("mark older than window is flagged stale (not silently trusted)", stale.stale === true);
  } finally {
    await stopServer(s3);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll stress/edge checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
