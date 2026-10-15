// 真实操作过程录屏：用 Playwright 打开本地跑起来的 demo 页面，注入一个由真实 ethers.Wallet
// （两个预先在 VaultV2 真实存过款的 Fuji 测试网账号）驱动的最小 EIP-1193 + EIP-712 provider，
// 完整走一遍"连接钱包签名登录 -> 看到真实链上保证金余额 -> 填单下单 -> 撮合成交 ->
// 真实调用 VaultV2.settleWithAuthorization() 上链结算 -> 跳到 Snowtrace 验证这笔刚刚发生的
// 真实交易"的操作过程，全程录制成视频。
import { chromium } from "playwright";
import fs from "node:fs";

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


const DEMO_URL = process.env.DEMO_URL || "http://localhost:8080/index.html";
const OUT_DIR = process.env.OUT_DIR || "./recording";
const LANG = process.env.LANG_LABEL || "zh"; // zh | en，只影响注入的少量提示文案

fs.mkdirSync(OUT_DIR, { recursive: true });

// 两个真实在 Fuji VaultV2 里存过款的一次性测试账号（见 server/onchain_settle_v2_test.mjs 注释：
// 专门为这次演示生成的小号，没有真实价值，可以安全公开）。
const SELLER_KEY = requireEnv("DEMO_TRADER_A_KEY");
const BUYER_KEY = requireEnv("DEMO_TRADER_B_KEY");

const styleOverride = `
<style id="__demo-recording-style">
  body { font-size: 20px !important; }
  main { max-width: 1500px !important; gap: 22px !important; }
  header { padding: 28px 34px !important; }
  header h1 { font-size: 34px !important; }
  .pill { font-size: 17px !important; padding: 7px 16px !important; }
  button { font-size: 19px !important; padding: 15px 22px !important; border-radius: 12px !important; }
  .card { padding: 26px !important; border-radius: 18px !important; }
  .card h3 { font-size: 25px !important; margin-top: 0 !important; }
  label { font-size: 17px !important; margin-top: 14px !important; }
  input, select { font-size: 19px !important; padding: 13px !important; margin-top: 6px !important; }
  table { font-size: 21px !important; }
  th, td { padding: 11px 14px !important; }
  .log { font-size: 19px !important; max-height: 360px !important; line-height: 1.5 !important; }
  .row { font-size: 18px !important; padding: 7px 0 !important; }
</style>`;

const mockProviderScript = ({ privateKey }) => `
window.__DEMO_WALLET_READY = new Promise((resolve) => {
  window.__resolveDemoWallet = resolve;
});
(function(){
  function waitForEthers(cb){
    if (window.ethers) return cb();
    const t = setInterval(() => { if (window.ethers) { clearInterval(t); cb(); } }, 20);
  }
  waitForEthers(function(){
    const wallet = new window.ethers.Wallet("${privateKey}");
    window.__demoWallet = wallet;
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
        if (method === 'eth_chainId') return '0xa869';
        if (method === 'personal_sign') {
          const msgHex = params[0];
          const msg = window.ethers.toUtf8String(msgHex);
          return await wallet.signMessage(msg);
        }
        if (method === 'eth_sign') {
          const msg = window.ethers.toUtf8String(params[1]);
          return await wallet.signMessage(msg);
        }
        if (method === 'eth_signTypedData_v4') {
          const typed = JSON.parse(params[1]);
          const { domain, types, message } = typed;
          const cleanTypes = { ...types };
          delete cleanTypes.EIP712Domain;
          return await wallet.signTypedData(domain, cleanTypes, message);
        }
        throw new Error('mock provider: unsupported method ' + method);
      },
      on: () => {},
      removeListener: () => {},
    };
    window.__resolveDemoWallet(wallet.address);
  });
})();
`;

// 给页面原来的下单逻辑打一个"v2 授权"补丁：买单在提交前先向服务端要 EIP-712 domain，
// 用注入的真实钱包签名，再把 authorization 一起带上——这就是 README 里讲的
// Finding #4 修复后的真实流程，不是伪造的。
const patchBuyFlowScript = `
(function(){
  const btn = document.getElementById('placeOrderBtn');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.onclick = async () => {
    try {
      const side = document.getElementById('side').value;
      const price = document.getElementById('price').value;
      const quantity = document.getElementById('quantity').value;
      const tif = document.getElementById('tif').value;
      const apiUrl = document.getElementById('apiUrl').value.trim();
      const account = document.getElementById('account').textContent;
      const body = { traderId: account, side, price, quantity, tif, type: 'limit' };
      if (side === 'buy') {
        const domRes = await fetch(apiUrl + '/settlement/domain');
        const { domain, types } = await domRes.json();
        const maxAmount = String(Number(price) * Number(quantity) * 2);
        const nonce = String(Date.now());
        const deadline = String(Math.floor(Date.now() / 1000) + 3600);
        const value = { from: account, maxAmount, nonce, deadline };
        const typedData = JSON.stringify({ domain, types, message: value, primaryType: 'SettlementAuthorization' });
        const signature = await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [account, typedData] });
        body.authorization = { maxAmount, nonce, deadline, signature };
      }
      console.log('SUBMIT_BODY', JSON.stringify(body));
      const res = await fetch(apiUrl + '/orders', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log('ORDER_RESP', res.status, JSON.stringify(data));
      const el = document.getElementById('log');
      el.textContent = '[' + new Date().toLocaleTimeString() + '] 下单结果: ' + JSON.stringify(data) + '\\n' + el.textContent;
      const balRes = await fetch(apiUrl + '/balance/' + account);
      const balData = await balRes.json();
      document.getElementById('vaultBalance').textContent = balData.onchain
        ? window.ethers.formatUnits(balData.balance, 6) + ' mUSDC' : '(未开启链上结算演示)';
    } catch (e) {
      const el = document.getElementById('log');
      el.textContent = '[' + new Date().toLocaleTimeString() + '] 下单失败: ' + e.message + '\\n' + el.textContent;
    }
  };
})();
`;

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.addInitScript(mockProviderScript({ privateKey: BUYER_KEY }));
  await page.goto(DEMO_URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__DEMO_WALLET_READY !== undefined);
  await page.evaluate(() => window.__DEMO_WALLET_READY);

  // 放大字号，保证录出来的视频清晰可读
  await page.evaluate((html) => { document.head.insertAdjacentHTML("beforeend", html); }, styleOverride);
  await page.waitForTimeout(800);

  // 打上 v2 授权补丁
  await page.evaluate(patchBuyFlowScript);
  await page.waitForTimeout(500);

  // 1) 连接钱包并登录（真实 personal_sign 签名）
  await page.click("#connectBtn");
  await page.waitForFunction(
    () => document.getElementById("apiStatus").textContent.includes("已登录"),
    { timeout: 15000 }
  );
  await page.waitForTimeout(2500); // 让人看清"已登录"状态和真实链上余额

  // 2) 等订单簿推送快照，展示真实盘口深度
  await page.waitForTimeout(2000);

  // 3) 填写一笔会真实成交的买单（价格吃掉 trader A 挂的 2550 卖单）
  await page.fill("#price", "2550");
  await page.waitForTimeout(400);
  await page.fill("#quantity", "1");
  await page.waitForTimeout(400);
  await page.selectOption("#side", "buy");
  await page.waitForTimeout(600);

  // 4) 下单：触发真实 EIP-712 签名 + 服务端撮合 + 真实链上 settleWithAuthorization()
  await page.click("#placeOrderBtn");

  // 5) 等待真实链上结算完成的回执消息出现在日志里（真实等链上确认，不是摆拍延时）
  let txHash = null;
  try {
    await page.waitForFunction(
      () => document.getElementById("log").textContent.includes("链上结算完成"),
      { timeout: 30000 }
    );
    // 把日志面板滚动进可视区域，让观众亲眼看到"链上结算完成"文字落地
    await page.evaluate(() => {
      document.getElementById("log").scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(3500);
    txHash = await page.evaluate(() => {
      const m = document.getElementById("log").textContent.match(/tx:\s*(0x[a-fA-F0-9]{64})/);
      return m ? m[1] : null;
    });
  } catch (e) {
    console.error("等待链上结算超时（可能是 RPC 较慢）：", e.message);
  }

  // 6) 如果拿到了真实 tx hash，跳转 Snowtrace 当场验证
  if (txHash) {
    await page.goto(`https://testnet.snowtrace.io/tx/${txHash}`, { waitUntil: "load" });
    await page.waitForTimeout(4000);
  } else {
    await page.waitForTimeout(2000);
  }

  await page.close();
  await context.close();
  await browser.close();

  console.log("done. txHash =", txHash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
