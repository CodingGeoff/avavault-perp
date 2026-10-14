import { ethers } from "ethers";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MarginService, convertQuoteValueToMargin, parsePriceToE6 } from "./src/margin.js";

// 验证 MultiCollateralVaultV2.totalAccountValue() 接入撮合服务后的保证金逻辑：
//   1. 换算数学：quote 计价（18 位）按美元价折算成 mUSDC（6 位），整数运算无浮点误差
//   2. MarginService 聚合、缓存、读取失败时的降级行为
//   3. 端到端（本地 JSON-RPC 桩模拟 Fuji）：RWA 估值能让一笔 Vault 余额为 0、
//      仅靠 RWA 抵押的买单通过保证金校验；无任何保证金的买单被 403 拦截；卖单不受影响
//
// 用法： node test-margin.mjs   （需要先在 ../matching-engine 里 npm run build）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

console.log("=== 1. unit: price parsing + conversion ===");
check("parsePriceToE6('35.25')", parsePriceToE6("35.25") === 35_250_000n);
check("parsePriceToE6 rejects junk", (() => { try { parsePriceToE6("abc"); return false; } catch { return true; } })());
// 0.1 WAVAX（1e17）按 $35 折算 = $3.50 = 3_500_000 mUSDC raw
check(
  "0.1 quote @ $35 -> 3_500_000 margin raw",
  convertQuoteValueToMargin(100_000_000_000_000_000n, parsePriceToE6("35")) === 3_500_000n
);
check("zero value converts to zero", convertQuoteValueToMargin(0n, parsePriceToE6("35")) === 0n);

console.log("\n=== 2. unit: MarginService aggregation / cache / failure ===");
{
  let vaultCalls = 0;
  const svc = new MarginService({
    readVaultBalance: async () => { vaultCalls++; return 1_000n; },
    readRwaAccountValue: async () => 100_000_000_000_000_000n, // 0.1 quote
    quotePriceE6: parsePriceToE6("35"),
    cacheTtlMs: 60_000,
  });
  const m1 = await svc.getMargin("0x0000000000000000000000000000000000000001");
  check("effective = vault + RWA margin", m1.effectiveMargin === 1_000n + 3_500_000n);
  check("rwaCounted true when price configured", m1.rwaCounted === true);
  await svc.getMargin("0x0000000000000000000000000000000000000001");
  check("second read served from cache", vaultCalls === 1);

  const noPrice = new MarginService({
    readVaultBalance: async () => 1_000n,
    readRwaAccountValue: async () => 100_000_000_000_000_000n,
    quotePriceE6: null,
  });
  const m2 = await noPrice.getMargin("0x0000000000000000000000000000000000000001");
  check("without quote price RWA is reported but NOT counted", m2.rwaMarginValue === null && m2.effectiveMargin === 1_000n);

  const broken = new MarginService({
    readVaultBalance: async () => { throw new Error("rpc down"); },
    readRwaAccountValue: null,
    quotePriceE6: null,
  });
  const m3 = await broken.getMargin("0x0000000000000000000000000000000000000001");
  check("reader failure is surfaced in sourceErrors, not thrown", m3.sourceErrors.length === 1 && m3.effectiveMargin === 0n);
}

// --- 3. 端到端：本地 JSON-RPC 桩 + 真实服务端子进程 ---
const RICH = ethers.Wallet.createRandom(); // Vault 0，靠 RWA 估值
const POOR = ethers.Wallet.createRandom(); // 什么都没有
const RWA_VALUE_BY_ADDRESS = new Map([
  [RICH.address.toLowerCase(), 100_000_000_000_000_000n], // totalAccountValue = 0.1 quote
]);

const BALANCE_OF = ethers.id("balanceOf(address)").slice(0, 10);
const TOTAL_ACCOUNT_VALUE = ethers.id("totalAccountValue(address)").slice(0, 10);

function handleRpcCall(params) {
  const [{ data }] = params;
  const selector = data.slice(0, 10);
  const address = ("0x" + data.slice(-40)).toLowerCase();
  let value = 0n;
  if (selector === TOTAL_ACCOUNT_VALUE) value = RWA_VALUE_BY_ADDRESS.get(address) ?? 0n;
  if (selector === BALANCE_OF) value = 0n; // 两人的 Vault mUSDC 余额都是 0
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]);
}

const rpcStub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body);
    const reply = (msg) => ({ jsonrpc: "2.0", id: msg.id, result: handleOne(msg) });
    const handleOne = (msg) => {
      if (msg.method === "eth_chainId") return "0xa869";
      if (msg.method === "net_version") return "43113";
      if (msg.method === "eth_blockNumber") return "0x1";
      if (msg.method === "eth_call") return handleRpcCall(msg.params);
      return "0x";
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(reply) : reply(payload)));
  });
});

const PORT = 4319;
const API = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-dex-margin-"));

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

async function placeOrder(wallet, side, price, quantity) {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traderId: wallet.address, side, price, quantity }),
  });
  return { status: res.status, data: await res.json() };
}

let server;
try {
  await new Promise((r) => rpcStub.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${rpcStub.address().port}`;
  server = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(tmpDir, "test.sqlite"),
      FUJI_RPC_URL: rpcUrl,
      VAULT_ADDRESS: "0x0425352bc3c5293D5629c27525969439Ab9C27b5",
      OPERATOR_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      VAULT_ABI_VERSION: "v1",
      MULTICOLLATERAL_VAULT_ADDRESS: "0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884",
      MARGIN_QUOTE_USD_PRICE: "35",
      MARGIN_ENFORCE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
  await login(RICH);
  await login(POOR);

  console.log("\n=== 3. integration: margin endpoint + order enforcement (stub RPC) ===");
  const health = await (await fetch(`${API}/health`)).json();
  check("health reports margin enforcement on", health.marginEnforce === true && health.rwaCollateralCounted === true);

  const margin = await (await fetch(`${API}/account/${RICH.address}/margin`)).json();
  check("margin endpoint reads totalAccountValue", margin.rwaAccountValueQuote === "100000000000000000");
  check("RWA margin value converted at $35", margin.rwaMarginValue === "3500000");
  check("effective margin counts RWA with zero vault balance", margin.vaultBalance === "0" && margin.effectiveMargin === "3500000");

  const richBuy = await placeOrder(RICH, "buy", "2500", "5"); // 需要 12,500，可用 3,500,000
  check("buy covered only by RWA collateral is accepted", richBuy.status === 200);

  const poorBuy = await placeOrder(POOR, "buy", "2500", "5");
  check("buy with no margin at all is rejected (403)", poorBuy.status === 403 && /insufficient margin/.test(poorBuy.data.error || ""));

  const poorSell = await placeOrder(POOR, "sell", "2600", "5");
  check("sell orders are not margin-checked (settlement pays the seller)", poorSell.status === 200);
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  rpcStub.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll margin checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
