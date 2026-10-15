// 演示可用性回归：参考价解析 + 做市签名 + 临时 HTTP 服务冒烟测试。
// 不连接 Fuji、不使用项目数据库；临时服务的 SQLite 文件写入系统 temp 目录并清理。
//   node test-demoready.mjs
// 覆盖的两个真实演示事故：
//   1. 刚重置的环境里「喂价 / 成交 TWAP / 盘口」全空 → /hedge/quote 直接 503
//      "no reference price available"，前端只弹一行英文，演示主线当场卡死；
//   2. 盘口没有对手单 → 对冲空单挂着不成交 → 没有仓位、没有链上结算、没有 Snowtrace 凭证。
import assert from "node:assert";
import { ethers } from "ethers";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReferencePrice, buildRefPriceDiagnostics, REF_PRICE_SOURCE_LABELS } from "./src/referencePrice.js";
import { DemoLiquidity } from "./src/demoLiquidity.js";

// ---------- 1. 参考价解析优先级 ----------
const mark = { price: 2503n, source: "trade-twap" };

assert.deepEqual(
  resolveReferencePrice({ explicit: 2600n, mark, bestAsk: 2502n, bestBid: 2498n, fallback: 2500n }),
  { price: 2600n, source: "explicit-input", marketData: false },
  "显式传入的参考价必须优先于一切"
);
assert.deepEqual(
  resolveReferencePrice({ explicit: null, mark, bestAsk: 2502n, bestBid: 2498n, fallback: 2500n }),
  { price: 2503n, source: "trade-twap", marketData: true },
  "没有显式值时用标记价预言机，并沿用预言机自报的来源"
);
assert.deepEqual(
  resolveReferencePrice({ mark: null, bestAsk: 2502n, bestBid: 2498n, fallback: 2500n }),
  { price: 2502n, source: "book-best-ask", marketData: true }
);
assert.deepEqual(
  resolveReferencePrice({ mark: null, bestAsk: null, bestBid: 2498n, fallback: 2500n }),
  { price: 2498n, source: "book-best-bid", marketData: true }
);
// 演示事故现场：喂价、TWAP、盘口全空 → 落到配置兜底值，且明确标注它不是市场数据
assert.deepEqual(
  resolveReferencePrice({ mark: null, bestAsk: null, bestBid: null, fallback: 2500n }),
  { price: 2500n, source: "config-fallback", marketData: false },
  "三层市场数据都没有时必须退回配置兜底值，而不是 503"
);
// 兜底也没配（HEDGE_FALLBACK_REF_PRICE=""）→ 恢复严格行为，但要给出可执行诊断
assert.deepEqual(resolveReferencePrice({ mark: null, bestAsk: null, bestBid: null, fallback: null }), {
  price: null,
  source: "unavailable",
  marketData: false,
});
// 0 / 负数 / 非法值都当成"没有"，不会算出 0 数量的对冲单
assert.equal(resolveReferencePrice({ explicit: 0n, mark: null, fallback: 2500n }).source, "config-fallback");
assert.equal(resolveReferencePrice({ explicit: -5n, mark: null, fallback: null }).price, null);

const missing = buildRefPriceDiagnostics({
  markFeedConfigured: false,
  tradeSampleCount: 0,
  bookDepth: 0,
  fallbackConfigured: false,
});
assert.equal(missing.length, 4, "四层都缺时应给出四条诊断");
assert.ok(missing.every((m) => m.layer && m.reason && m.fix), "每条诊断都要带可执行的修复动作");
assert.equal(
  buildRefPriceDiagnostics({ markFeedConfigured: true, markPriceAvailable: true, tradeSampleCount: 3, bookDepth: 6, fallbackConfigured: true }).length,
  0
);
for (const source of ["explicit-input", "trade-twap", "book-best-ask", "config-fallback", "unavailable"]) {
  assert.ok(REF_PRICE_SOURCE_LABELS[source]?.zh && REF_PRICE_SOURCE_LABELS[source]?.en, `来源 ${source} 缺中英文说明`);
}
console.log("PASS  reference price precedence (explicit > mark oracle > book > config fallback)");
console.log("PASS  unavailable reference price returns actionable diagnostics instead of a bare 503");

// ---------- 2. 服务端演示做市：铺出双边盘口，买单带真实 EIP-712 授权 ----------
const maker = ethers.Wallet.createRandom();
const DOMAIN = { name: "MiniDexVault", version: "2", chainId: 43113, verifyingContract: ethers.ZeroAddress };
const TYPES = {
  SettlementAuthorization: [
    { name: "from", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

function makeFakeApi({ funded = true } = {}) {
  const calls = { login: 0, orders: [], cancels: [] };
  let seq = 0;
  const liveOrders = new Map();
  const get = async (path) => {
    if (path === "/settlement/domain") return { status: 200, body: { domain: DOMAIN, types: TYPES } };
    if (path === "/orders/open") {
      return { status: 200, body: [...liveOrders.values()].map((o) => ({ ...o, traderId: maker.address, remaining: o.remaining })) };
    }
    if (path === "/orderbook") {
      const bids = [...liveOrders.values()].filter((o) => o.side === "buy").sort((a, b) => Number(b.price) - Number(a.price));
      const asks = [...liveOrders.values()].filter((o) => o.side === "sell").sort((a, b) => Number(a.price) - Number(b.price));
      return { status: 200, body: { bids, asks } };
    }
    return { status: 404, body: null };
  };
  const post = async (path, body) => {
    if (path === "/auth/login") {
      calls.login++;
      // 登录必须是这个钱包自己签的、且签名里包含地址（与 /auth/login 的校验一致）
      assert.ok(body.message.includes(body.address), "登录消息必须包含地址本身");
      const recovered = ethers.verifyMessage(body.message, body.signature);
      assert.equal(recovered.toLowerCase(), body.address.toLowerCase(), "登录签名必须能恢复到做市钱包地址");
      return { status: 200, body: { ok: true, sessionToken: "t" } };
    }
    if (path === "/orders") {
      calls.orders.push(body);
      if (body.side === "buy") {
        // v2 模式下买单必须带可验证的 EIP-712 授权，否则链上结算会 revert InvalidSignature
        assert.ok(body.authorization?.signature, "买单必须携带 EIP-712 结算授权");
        const digest = ethers.TypedDataEncoder.hash(DOMAIN, TYPES, {
          from: body.authorization.from ?? body.traderId,
          maxAmount: body.authorization.maxAmount,
          nonce: body.authorization.nonce,
          deadline: body.authorization.deadline,
        });
        const signer = ethers.recoverAddress(digest, body.authorization.signature);
        assert.equal(signer.toLowerCase(), body.traderId.toLowerCase(), "授权签名人必须是买单提交者");
        assert.ok(
          BigInt(body.authorization.maxAmount) >= BigInt(body.price) * BigInt(body.quantity),
          "授权额度必须覆盖这笔订单的成交金额"
        );
      } else {
        assert.equal(body.authorization, undefined, "卖单不需要授权");
      }
      const order = { id: `order-${++seq}`, side: body.side, price: body.price, quantity: body.quantity, remaining: body.quantity };
      liveOrders.set(order.id, order);
      return { status: 200, body: { order, trades: [] } };
    }
    if (path.startsWith("/orders/") && path.endsWith("/cancel")) {
      const id = path.split("/")[2];
      calls.cancels.push(id);
      liveOrders.delete(id);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: null };
  };
  return { get, post, calls, liveOrders };
}

const api = makeFakeApi();
const liq = new DemoLiquidity({
  makerWallet: maker,
  get: api.get,
  post: api.post,
  midPrice: 2500n,
  levels: 3,
  baseQty: 100n,
  readVaultBalance: async () => 1000n * 10n ** 6n,
  log: () => {},
});

assert.equal(liq.enabled, true);
assert.equal(liq.address, maker.address);
const first = await liq.seed();
assert.equal(first.ok, true);
assert.equal(first.placed, 6, "3 档 × 双边 = 6 笔挂单");
assert.equal(api.calls.login, 1, "铺盘口前必须先给做市钱包建会话，否则 /orders 会 401");
assert.equal(first.bestBid, "2499");
assert.equal(first.bestAsk, "2501");
assert.equal(first.makerVaultBalance, (1000n * 10n ** 6n).toString());
assert.deepEqual(first.warnings, [], "做市钱包有保证金时不应报警");
assert.equal(first.orders.filter((o) => o.side === "buy").length, 3);
// 档位越远挂单越厚（做市阶梯）
assert.deepEqual(api.calls.orders.filter((o) => o.side === "buy").map((o) => o.quantity), ["100", "200", "300"]);

// 再铺一轮：必须先撤掉自己上一轮的挂单，不会越铺越厚
const second = await liq.seed();
assert.equal(second.cancelled, 6, "重新铺盘口前要撤掉上一轮的 6 笔");
assert.equal(second.placed, 6);
assert.equal(api.liveOrders.size, 6, "盘口里只保留最新一轮做市挂单");
assert.equal(api.calls.login, 2);
// 模拟服务重启：新的 DemoLiquidity 对象没有内存 order IDs，仍需从 /orders/open 找回并撤掉旧单
const afterRestart = new DemoLiquidity({ makerWallet: maker, get: api.get, post: api.post, log: () => {} });
const third = await afterRestart.seed();
assert.equal(third.cancelled, 6, "服务重启后必须从持久化的公开订单列表找到并撤旧单");
assert.equal(api.liveOrders.size, 6, "重启后重新铺盘也不能叠加深度");
assert.equal(api.calls.login, 3);
console.log("PASS  demo liquidity seeds a two-sided book with verifiable EIP-712 buy authorizations");
console.log("PASS  re-seeding and re-seeding after service restart cancel the previous ladder");

// 做市钱包在 Vault 里没钱：必须如实报警（否则现场成交撮合成功、链上结算失败、拿不出哈希）
const brokeApi = makeFakeApi();
const brokeLiq = new DemoLiquidity({
  makerWallet: ethers.Wallet.createRandom(),
  get: brokeApi.get,
  post: brokeApi.post,
  readVaultBalance: async () => 0n,
  log: () => {},
});
const broke = await brokeLiq.seed();
assert.equal(broke.warnings.length, 1);
assert.match(broke.warnings[0], /on-chain settlement will FAIL/);
console.log("PASS  unfunded demo maker is reported as a warning, not silently ignored");

// 未配置 DEMO_MAKER_PRIVATE_KEY：模块停用，返回明确的下一步而不是一句 500
const disabled = new DemoLiquidity({ makerWallet: null, get: api.get, post: api.post, log: () => {} });
assert.equal(disabled.enabled, false);
const off = await disabled.seed();
assert.equal(off.ok, false);
assert.match(off.warnings[0], /DEMO_MAKER_PRIVATE_KEY not set/);
console.log("PASS  disabled demo liquidity reports the exact env var to set");

// ---------- 3. Real server endpoint: configured demo fallback removes the bare 503 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverCwd = __dirname;
async function allocatePort() {
  const s = createNetServer();
  await new Promise((resolve, reject) => s.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}
async function withFreshServer(fallbackPrice, callback) {
  const port = await allocatePort();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "avavault-demoready-"));
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverCwd,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, "state.sqlite"),
      VAULT_ADDRESS: "",
      OPERATOR_PRIVATE_KEY: "",
      MULTICOLLATERAL_VAULT_ADDRESS: "",
      MARK_PRICE_FEED_URL: "",
      ADMIN_RESET_TOKEN: "",
      DEMO_MAKER_PRIVATE_KEY: "",
      SEED_DEMO_LIQUIDITY: "false",
      FUNDING_INTERVAL_MS: "-1",
      HEDGE_FALLBACK_REF_PRICE: fallbackPrice,
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "fresh test server should become healthy");
    await callback(base);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await withFreshServer("2500", async (base) => {
  const statusRes = await fetch(`${base}/demo/status`);
  const status = await statusRes.json();
  assert.equal(status.readyForHedgeFlow, false, "fallback price alone does not make an empty book executable");
  assert.equal(status.referencePrice.price, "2500");
  assert.equal(status.referencePrice.source, "config-fallback");
  assert.equal(status.referencePrice.marketData, false, "configured fallback must not be mislabeled as market data");

  const quoteRes = await fetch(`${base}/hedge/quote?assetValue=250000&hedgeRatioBps=10000&leverage=5`);
  const quote = await quoteRes.json();
  assert.equal(quoteRes.status, 200, "with the configured demo fallback, /hedge/quote must not return the old bare 503");
  assert.equal(quote.referencePrice, "2500");
  assert.equal(quote.referencePriceSource, "config-fallback");
  assert.equal(quote.referencePriceIsMarketData, false);
  assert.equal(quote.quantity, "100");
  const invalidRef = await fetch(`${base}/hedge/quote?assetValue=250000&referencePrice=0`);
  assert.equal(invalidRef.status, 400, "an explicitly supplied zero price must be rejected, not silently replaced by the fallback");

  const seedRes = await fetch(`${base}/admin/seed-book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(seedRes.status, 403, "server-side seeding must remain disabled without ADMIN_RESET_TOKEN");
});
console.log("PASS  /demo/status and /hedge/quote expose the explicit fallback source; seed route is closed without admin token");

await withFreshServer("", async (base) => {
  const quoteRes = await fetch(`${base}/hedge/quote?assetValue=250000&hedgeRatioBps=10000&leverage=5`);
  const quote = await quoteRes.json();
  assert.equal(quoteRes.status, 503);
  assert.equal(quote.reason, "no-reference-price");
  assert.equal(quote.missing.length, 4, "strict mode should explain all four missing reference-price layers");
  assert.ok(quote.missing.every((m) => m.layer && m.reason && m.fix));
});
console.log("PASS  strict no-fallback mode returns actionable diagnostics rather than only 'no reference price available'");
