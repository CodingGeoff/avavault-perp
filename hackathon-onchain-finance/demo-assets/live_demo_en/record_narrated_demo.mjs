// ---------------------------------------------------------------------------
// 完整操作录屏（take 3）：按英文旁白节奏拍摄
//   - 每个场景的停留时长 = 对应旁白段时长 + 0.3s，保证后期对齐
//   - 全程真实操作：真钱包（ethers.Wallet + eth_sendTransaction 广播）、
//     真撮合、真链上结算（EIP-712 授权）
//   - viewport 2400x1350 渲染、1920x1080 输出（超采样，文字更锐利）
//   - 场景边界写入 steps.json，供后期做配音/字幕对齐
// ---------------------------------------------------------------------------
import { chromium } from "playwright";
import fs from "node:fs";

const DEMO_URL = process.env.DEMO_URL || "http://127.0.0.1:8080/index.html";
const API_URL = process.env.API_URL || "http://127.0.0.1:4000";
const RPC_URL = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const OUT_DIR = process.env.OUT_DIR || "/home/user/demo_video/raw";
const PK = process.env.DEMO_TRADER_KEY;
const TIMING = JSON.parse(fs.readFileSync("/home/user/demo_video/timing.json", "utf8"));
if (!PK) throw new Error("missing DEMO_TRADER_KEY");

fs.mkdirSync(OUT_DIR, { recursive: true });
const D = Object.fromEntries(TIMING.chunks.map((c) => [c.id, c.dur]));
const PAD = 0.3;
// 场景目标时长
const T = {
  ready: D.c1 + PAD,
  book: D.c2 + PAD,
  connect: D.c3 + PAD,
  deposit_usdc: D.c4 + PAD,
  deposit_rwa: D.c5 + PAD,
  hedge: D.c6 + PAD,
  order_settle: D.c7 + PAD,
  position: 9.0,
  trades: 8.0,
  contracts: 8.0,
  perp_panel: D.c8 - 9.0 - 8.0 - 8.0 + PAD,
  snowtrace: D.c9 + PAD,
};

const scenes = [];
let t0 = 0;
const now = () => Date.now() / 1000;
const markSceneStart = (name) => { sceneClock = { name, start: now() }; };
let sceneClock = null;
const endScene = async (page, name) => {
  const target = T[name];
  const elapsed = now() - sceneClock.start;
  const remain = target - elapsed;
  if (remain > 0) await page.waitForTimeout(remain * 1000);
  const end = now();
  const rec = { name, start: +(sceneClock.start - t0).toFixed(2), end: +(end - t0).toFixed(2), dur: +(end - sceneClock.start).toFixed(2), target };
  scenes.push(rec);
  console.log("SCENE " + JSON.stringify(rec));
};

const styleOverride = `
<style id="__rec_style">
  body { font-size: 21px !important; }
  main { max-width: 2340px !important; gap: 24px !important; }
  header { padding: 26px 34px !important; }
  header h1 { font-size: 36px !important; }
  .pill { font-size: 18px !important; padding: 8px 17px !important; }
  button { font-size: 20px !important; padding: 15px 24px !important; border-radius: 12px !important; }
  .card { padding: 26px !important; border-radius: 18px !important; }
  .card h3 { font-size: 26px !important; margin-top: 0 !important; }
  label { font-size: 18px !important; margin-top: 13px !important; }
  input, select { font-size: 20px !important; padding: 13px !important; margin-top: 6px !important; }
  table { font-size: 21px !important; }
  th, td { padding: 11px 14px !important; }
  .log { font-size: 19px !important; max-height: 380px !important; line-height: 1.55 !important; }
  .row { font-size: 18.5px !important; padding: 7px 0 !important; }
  #__click_ring { position: fixed; width: 52px; height: 52px; margin: -26px 0 0 -26px; border: 4px solid #ff4d4d;
    border-radius: 50%; pointer-events: none; z-index: 99999; opacity: 0; }
  #__click_ring.go { animation: __ring .6s ease-out; }
  @keyframes __ring { 0% { opacity: .95; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.3); } }
</style>`;

const walletScript = ({ privateKey, rpcUrl }) => `
window.__DEMO_WALLET_READY = new Promise((resolve) => { window.__resolveDemoWallet = resolve; });
(function(){
  function waitForEthers(cb){ if (window.ethers) return cb(); const t=setInterval(()=>{ if(window.ethers){clearInterval(t);cb();} },20); }
  waitForEthers(function(){
    const wallet = new window.ethers.Wallet("${privateKey}", new window.ethers.JsonRpcProvider("${rpcUrl}"));
    window.__demoWallet = wallet;
    window.ethereum = {
      isMetaMask: true, chainId: '0xa869',
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
        if (method === 'eth_chainId') return '0xa869';
        if (method === 'personal_sign') return await wallet.signMessage(window.ethers.toUtf8String(Array.isArray(params) ? params[0] : params));
        if (method === 'eth_sign') return await wallet.signMessage(window.ethers.toUtf8String(params[1]));
        if (method === 'eth_signTypedData_v4') {
          const ty = JSON.parse(params[1]); const c = { ...ty.types }; delete c.EIP712Domain;
          return await wallet.signTypedData(ty.domain, c, ty.message);
        }
        if (method === 'eth_sendTransaction') {
          const tx = { ...(params[0] || {}) }; delete tx.from;
          const sent = await wallet.sendTransaction(tx);
          console.log('WALLET_SENT ' + sent.hash);
          return sent.hash;
        }
        if (method.startsWith('wallet_')) return null;
        return await wallet.provider.send(method, params || []);
      },
      on: () => {}, removeListener: () => {}, addListener: () => {},
    };
    window.__resolveDemoWallet(wallet.address);
  });
})();`;

const clickRing = `(function(){ const r=document.createElement('div'); r.id='__click_ring'; document.body.appendChild(r);
  document.addEventListener('mousedown',(e)=>{ r.style.left=e.clientX+'px'; r.style.top=e.clientY+'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); },true); })();`;

// 平滑滚动，避免瞬移感
const smoothScroll = async (page, selector, block = 'center') => {
  await page.evaluate(({ sel, blk }) => {
    const el = document.querySelector(sel);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (blk === 'center' ? window.innerHeight / 2.4 : 90), behavior: 'smooth' });
  }, { sel: selector, blk: block });
  await page.waitForTimeout(1200);
};

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 2400, height: 1350 },
    recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  t0 = now();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 160)));
  page.on("console", (m) => { const t = m.text(); if (t.startsWith("WALLET_SENT")) console.log("[page]", t); });

  await page.addInitScript(() => localStorage.setItem('avavault-lang', 'en'));
  await page.addInitScript(walletScript({ privateKey: PK, rpcUrl: RPC_URL }));

  console.log(">>> goto");
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });
  const addr = await Promise.race([
    page.evaluate(() => window.__DEMO_WALLET_READY),
    new Promise((_, rej) => setTimeout(() => rej(new Error("wallet injection timeout")), 20000)),
  ]);
  console.log(">>> wallet:", addr);
  await page.evaluate((css) => document.head.insertAdjacentHTML("beforeend", css), styleOverride);
  await page.evaluate(clickRing);
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = false)));
  await page.evaluate((api) => {
    const el = document.getElementById('apiUrl');
    el.value = api; el.dispatchEvent(new Event('change', { bubbles: true }));
  }, API_URL);
  await page.waitForFunction(() => !document.getElementById('connectBtn').disabled, null, { timeout: 45000 });
  await page.waitForTimeout(1200);

  // ---------- 场景 1/2：就绪 + 盘口（c1 + c2） ----------
  markSceneStart('ready');
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(Math.round((T.ready - 1.2 - 6.5) * 1000));
  await smoothScroll(page, '#hedgeQuoteBtn');
  await endScene(page, 'ready');

  markSceneStart('book');
  await smoothScroll(page, '#bookBody');
  await endScene(page, 'book');

  // ---------- 场景 3：连接钱包（c3） ----------
  markSceneStart('connect');
  await smoothScroll(page, '#connectBtn');
  await page.click('#connectBtn');
  await page.waitForFunction(() => /0x[0-9a-fA-F]{40}/.test(document.getElementById('account').textContent || ''), null, { timeout: 45000 });
  await endScene(page, 'connect');
  console.log(">>> connected:", await page.locator('#account').textContent(), "| vault:", await page.locator('#vaultBalance').textContent());

  // ---------- 场景 4：领取并存入 mUSDC（c4，3 笔真交易） ----------
  markSceneStart('deposit_usdc');
  await page.click('#depositBtn');
  await page.waitForFunction(() => { const t = document.getElementById('vaultBalance').textContent; return /[1-9]/.test(t) && t.includes('mUSDC'); }, null, { timeout: 90000 }).catch(() => {});
  await endScene(page, 'deposit_usdc');
  console.log(">>> vault balance:", await page.locator('#vaultBalance').textContent());

  // ---------- 场景 5：存入 RWA + 推进 TWAP（c5） ----------
  markSceneStart('deposit_rwa');
  await smoothScroll(page, '#rwaDepositBtn');
  await page.click('#rwaDepositBtn');
  await page.waitForFunction(() => /[1-9]/.test(document.getElementById('rwaVaultBal').textContent || ''), null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.click('#refreshTwapBtn').catch(() => {});
  await page.waitForTimeout(Math.max(0, (T.deposit_rwa - (now() - sceneClock.start) - 2) * 1000));
  await smoothScroll(page, '#rwaValue2');
  await endScene(page, 'deposit_rwa');
  console.log(">>> rwa vault:", await page.locator('#rwaVaultBal').textContent(), "| value:", await page.locator('#rwaValue2').textContent());

  // ---------- 场景 6：计算对冲（c6） ----------
  markSceneStart('hedge');
  await smoothScroll(page, '#hedgeQuoteBtn');
  await page.click('#hedgeQuoteBtn');
  await page.waitForFunction(() => document.getElementById('hedgeQty').textContent.trim() !== '-', null, { timeout: 30000 }).catch(() => {});
  await endScene(page, 'hedge');
  console.log(">>> hedge qty:", await page.locator('#hedgeQty').textContent(), "| ref:", await page.locator('#hedgeRefState').textContent());

  // ---------- 场景 7：下单 → 撮合 → 链上结算（c7） ----------
  markSceneStart('order_settle');
  await page.click('#hedgeFillBtn');
  await page.waitForTimeout(1200);
  await smoothScroll(page, '#placeOrderBtn');
  await page.click('#placeOrderBtn');
  let txHash = null;
  try {
    await page.waitForFunction(() => /0x[a-fA-F0-9]{64}/.test(document.getElementById('log').textContent), null, { timeout: 60000 });
    txHash = await page.evaluate(() => (document.getElementById('log').textContent.match(/(0x[a-fA-F0-9]{64})/) || [])[1] || null);
    await smoothScroll(page, '#log');
  } catch (e) { console.log("settle wait:", e.message); }
  await endScene(page, 'order_settle');
  console.log(">>> settle tx:", txHash);

  // ---------- 场景 8：仓位 / 成交 / 合约面板 / 合约层保证金 ----------
  markSceneStart('position');
  await smoothScroll(page, '#positionBody');
  await endScene(page, 'position');

  markSceneStart('trades');
  await smoothScroll(page, '#tradesBody');
  await endScene(page, 'trades');

  markSceneStart('contracts');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.card h3')).find((h) => h.textContent.includes('On-chain Contracts'));
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
  });
  await page.waitForTimeout(1200);
  await endScene(page, 'contracts');

  markSceneStart('perp_panel');
  await smoothScroll(page, '#perpMarkPrice');
  await endScene(page, 'perp_panel');
  console.log(">>> perp panel:", await page.locator('#perpMarkPrice').textContent(), "|", await page.locator('#perpInsurance').textContent());

  // ---------- 场景 9：Snowtrace 链上凭证（c9） ----------
  markSceneStart('snowtrace');
  if (txHash) {
    await page.goto(`https://testnet.snowtrace.io/tx/${txHash}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
  }
  await endScene(page, 'snowtrace');

  await page.close();
  await context.close();
  await browser.close();

  const vids = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".webm")).map((f) => `${OUT_DIR}/${f}`);
  fs.writeFileSync(`${OUT_DIR}/scenes.json`, JSON.stringify({ scenes, txHash, video: vids, lang: 'en' }, null, 2));
  console.log("VIDEO " + vids.join(","));
  console.log("TXHASH " + txHash);
  console.log("TOTAL " + scenes[scenes.length - 1].end);
}

main().catch((e) => { console.error(e); process.exit(1); });
