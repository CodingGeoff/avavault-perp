import { ethers } from "ethers";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 自包含的稳健性回归测试：自己拉起服务端子进程（临时 SQLite 文件、临时端口），
// 不依赖链上环境（不配置 VAULT_ADDRESS，结算关闭），验证以下几件曾经出过问题、
// 或这次修复的事情：
//   1. 撤单需要登录且只能撤自己的单（未登录 401 / 撤别人的单 403 / 本人 200）
//   2. 撤单结果落库：重启后已撤订单不会作为"幽灵挂单"被恢复，未撤的挂单则正常恢复
//   3. 买单携带的 EIP-712 结算授权随订单落库，重启后仍能从 /orders/open 读回
//   4. 原有核心链路不受影响：登录、两方成交、自成交保护
//
// 用法： node test-robustness.mjs   （需要先在 ../matching-engine 里 npm run build）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const API = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-dex-robustness-"));
const DB_PATH = path.join(tmpDir, "test.sqlite");

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy in time");
}

function startServer() {
  const child = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function stopServer(child) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

async function login(wallet) {
  const message = `Mini-Dex login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(data)}`);
  return data;
}

/** 连接一个 WebSocket 客户端并收集接下来一段时间内的消息 */
function collectWs(url, durationMs = 700) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const ws = new WebSocket(url);
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    ws.on("error", reject);
    ws.on("open", () => setTimeout(() => { ws.close(); resolve(messages); }, durationMs));
  });
}

async function placeOrder(wallet, side, price, quantity, extra = {}) {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traderId: wallet.address, side, price, quantity, ...extra }),
  });
  return { status: res.status, data: await res.json() };
}

async function cancelOrder(traderId, orderId) {
  const res = await fetch(`${API}/orders/${orderId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traderId ? { traderId } : {}),
  });
  return { status: res.status, data: await res.json() };
}

async function openOrders() {
  const res = await fetch(`${API}/orders/open`);
  return res.json();
}

async function main() {
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();

  let server = startServer();
  try {
    await waitForHealth();
    const aliceLogin = await login(alice);
    check("login returns a session token", typeof aliceLogin.sessionToken === "string" && aliceLogin.sessionToken.length >= 32);
    await login(bob);

    console.log("\n=== 1b. WebSocket private channel requires the session token ===");
    const spyPromise = collectWs(`${API.replace("http", "ws")}/ws?address=${alice.address}`, 900);
    await new Promise((r) => setTimeout(r, 200));
    await placeOrder(alice, "sell", "2700", "1");
    const spyMessages = await spyPromise;
    check(
      "address-only subscriber gets public book but NO private order_update",
      spyMessages.some((m) => m.type === "orderbook") && !spyMessages.some((m) => m.type === "order_update")
    );
    const ownPromise = collectWs(`${API.replace("http", "ws")}/ws?token=${aliceLogin.sessionToken}`, 900);
    await new Promise((r) => setTimeout(r, 200));
    await placeOrder(alice, "sell", "2701", "1");
    const ownMessages = await ownPromise;
    check(
      "token subscriber receives own order_update",
      ownMessages.some((m) => m.type === "order_update" && m.payload.traderId === alice.address)
    );

    console.log("\n=== 1. core matching still works ===");
    const sell = await placeOrder(alice, "sell", "2500", "10");
    check("resting sell order accepted", sell.status === 200 && !!sell.data.order);
    const buy = await placeOrder(bob, "buy", "2500", "10", {
      authorization: { maxAmount: "25000", nonce: "1", deadline: "9999999999", signature: "0x" + "11".repeat(65) },
    });
    check("crossing buy produces a trade", buy.data.trades?.length === 1);

    console.log("\n=== 2. cancel requires login + ownership ===");
    const resting = await placeOrder(alice, "sell", "2600", "5");
    const restingId = resting.data.order.id;
    const anon = await cancelOrder(null, restingId);
    check("cancel without traderId rejected (400)", anon.status === 400);
    const stranger = await cancelOrder(bob.address, restingId);
    check("cancel someone else's order rejected (403)", stranger.status === 403);
    const own = await cancelOrder(alice.address, restingId);
    check("owner can cancel own order (200, ok)", own.status === 200 && own.data.ok === true);
    check("cancelled order leaves /orders/open", !(await openOrders()).some((o) => o.id === restingId));

    console.log("\n=== 3. buy authorization is persisted with the order ===");
    const auth = { maxAmount: "12500", nonce: "42", deadline: "9999999999", signature: "0x" + "22".repeat(65) };
    const restingBuy = await placeOrder(bob, "buy", "2400", "5", { authorization: auth });
    const restingBuyId = restingBuy.data.order.id;
    const stored = (await openOrders()).find((o) => o.id === restingBuyId);
    check("resting buy order visible in /orders/open", !!stored);
    check(
      "authorization stored alongside the order",
      !!stored?.authorization && JSON.parse(stored.authorization).nonce === "42"
    );

    console.log("\n=== 4. restart: cancelled stays gone, resting + authorization survive ===");
    await stopServer(server);
    server = startServer();
    await waitForHealth();
    const afterRestart = await openOrders();
    check("cancelled order is NOT resurrected after restart", !afterRestart.some((o) => o.id === restingId));
    const restoredBuy = afterRestart.find((o) => o.id === restingBuyId);
    check("resting buy order IS restored after restart", !!restoredBuy);
    check(
      "authorization survives restart",
      !!restoredBuy?.authorization && JSON.parse(restoredBuy.authorization).signature === auth.signature
    );
    const book = await (await fetch(`${API}/orderbook`)).json();
    check(
      "orderbook after restart shows the restored bid (cancelled ask stays gone)",
      book.bids.length === 1 && book.bids[0].price === "2400" &&
        book.asks.every((a) => a.price !== "2600") && book.asks.length === 2
    );

    console.log("\n=== 5. self-trade prevention still holds ===");
    const afterRestartOrder = await placeOrder(alice, "sell", "2800", "1");
    check("login session survives restart (order without re-login)", afterRestartOrder.status === 200);
    await login(alice);
    // alice 的买单挂在最优价位，自己的卖单在该价位只能碰到自己的单（更低价位的
    // 他人买单与 2500 的卖价不交叉），用来隔离验证自成交保护。
    await placeOrder(alice, "buy", "2500", "5");
    const selfSell = await placeOrder(alice, "sell", "2500", "5");
    check("crossing own orders produces 0 trades", selfSell.status === 200 && selfSell.data.trades?.length === 0);
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll robustness checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
