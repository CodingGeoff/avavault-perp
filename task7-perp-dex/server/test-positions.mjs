import { ethers } from "ethers";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 永续仓位引擎的服务端集成测试（自包含，不依赖链上环境）：
//   1. 成交生成多/空净仓位，杠杆决定保证金占用，入场价按 VWAP
//   2. 标记价随最新成交移动，未实现盈亏与强平价可查
//   3. 价格崩落时高杠杆仓位被自动强平，穿仓缺口被记录
//   4. 未平仓位落库，服务重启后恢复
//
// 用法： node test-positions.mjs   （需要先在 ../matching-engine 里 npm run build）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4321;
const API = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-dex-positions-"));
const DB_PATH = path.join(tmpDir, "test.sqlite");

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// 独立标记价喂价桩：测试中手动控制标记价（模拟外部预言机），与成交价解耦
let feedPrice = 2500;
const feedServer = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ price: feedPrice }));
});

function startServer() {
  const child = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      MARK_PRICE_FEED_URL: `http://127.0.0.1:${feedServer.address().port}/price`,
      MARK_PRICE_FEED_CACHE_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function stopServer(child) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

async function waitForHealth() {
  for (let i = 0; i < 75; i++) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy");
}

async function login(wallet) {
  const message = `Mini-Dex login for ${wallet.address} at ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address, message, signature }),
  });
  if (!res.ok) throw new Error(`login failed: ${await res.text()}`);
}

async function placeOrder(wallet, side, price, quantity, extra = {}) {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traderId: wallet.address, side, price, quantity, ...extra }),
  });
  return { status: res.status, data: await res.json() };
}

async function getPosition(wallet) {
  const res = await fetch(`${API}/positions/${wallet.address}`);
  return res.json();
}

async function main() {
  const alice = ethers.Wallet.createRandom(); // 将开 10x 多头并被强平
  const bob = ethers.Wallet.createRandom();   // 对手空头
  const carol = ethers.Wallet.createRandom(); // 制造崩盘成交价的第三方
  const dave = ethers.Wallet.createRandom();

  await new Promise((r) => feedServer.listen(0, "127.0.0.1", r));
  let server = startServer();
  try {
    await waitForHealth();
    for (const w of [alice, bob, carol, dave]) await login(w);

    console.log("=== 0. mark price comes from the independent feed ===");
    const markInfo = await (await fetch(`${API}/markprice`)).json();
    check("mark price served from external feed", markInfo.price === "2500" && markInfo.source === "external-feed");

    console.log("=== 1. leverage validation ===");
    const badLev = await placeOrder(alice, "buy", "2500", "1", { leverage: 99 });
    check("leverage above max rejected (400)", badLev.status === 400);

    console.log("\n=== 2. trade opens leveraged long/short positions ===");
    await placeOrder(bob, "sell", "2500", "10", { leverage: 2 });
    const buy = await placeOrder(alice, "buy", "2500", "10", { leverage: 10 });
    check("crossing trade executed", buy.data.trades?.length === 1);
    const long = await getPosition(alice);
    check("alice is long 10 @ 2500", long.sizeSigned === "10" && long.entryPrice === "2500");
    check("10x margin allocated = 2500", long.marginAllocated === "2500");
    check("liquidation price is below entry and close to it", Number(long.liquidationPrice) < 2500 && Number(long.liquidationPrice) > 2000);
    const short = await getPosition(bob);
    check("bob is short 10 with 2x margin 12500", short.sizeSigned === "-10" && short.marginAllocated === "12500");

    console.log("\n=== 3. mark price crash liquidates the 10x long ===");
    feedPrice = 2200; // 独立预言机标记价崩落（不需要靠成交价砸盘触发）
    await placeOrder(dave, "sell", "2200", "1");
    await placeOrder(carol, "buy", "2200", "1");
    const markAfter = await (await fetch(`${API}/markprice`)).json();
    check("mark price moved to 2200 via feed", markAfter.price === "2200");
    const after = await getPosition(alice);
    check("alice position liquidated to zero", after.sizeSigned === "0");
    check("realized pnl records the -3000 loss", after.realizedPnl === "-3000");
    const bobAfter = await getPosition(bob);
    check("bob short still open and profitable", bobAfter.sizeSigned === "-10" && bobAfter.unrealizedPnl === "3000");

    console.log("\n=== 4. insurance fund covers/records liquidation deficit ===");
    const insurance = await (await fetch(`${API}/insurance`)).json();
    check("liquidation deficit recorded as bad debt (fund was empty)", insurance.totalBadDebt === "500" && insurance.insuranceFund === "0");
    const fundRes = await fetch(`${API}/insurance/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traderId: bob.address, amount: "1000" }),
    });
    check("insurance funding accepted from a logged-in user", fundRes.ok && (await fundRes.json()).insuranceFund === "1000");

    console.log("\n=== 5. positions and insurance survive restart ===");
    await stopServer(server);
    server = startServer();
    await waitForHealth();
    const restored = await getPosition(bob);
    check("bob short position restored after restart", restored.sizeSigned === "-10" && restored.entryPrice === "2500");
    const insuranceAfter = await (await fetch(`${API}/insurance`)).json();
    check("insurance state restored after restart", insuranceAfter.insuranceFund === "1000" && insuranceAfter.totalBadDebt === "500");
  } finally {
    await stopServer(server);
    feedServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll position checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
