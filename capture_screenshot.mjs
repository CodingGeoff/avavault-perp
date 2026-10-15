// 用无头 Chromium 打开本地跑起来的 demo/index.html，注入一个用真实 ethers.Wallet 实现的
// 最小 EIP-1193 provider（代替 MetaMask 浏览器插件——沙箱环境里没有真的浏览器插件可装，
// 但这里的签名是真实的 ECDSA 签名，服务端会真实验证，不是摆拍）。
// 然后真的点一次"连接钱包"、真的下一笔单，截图当时的真实渲染结果。
import { chromium } from "playwright";

const DEMO_URL = process.env.DEMO_URL || "http://localhost:8080/index.html";
const OUT = process.env.OUT || "./screenshot-orderbook.png";

const mockProviderScript = `
window.__DEMO_WALLET_READY = new Promise((resolve) => {
  window.__resolveDemoWallet = resolve;
});
(function(){
  function waitForEthers(cb){
    if (window.ethers) return cb();
    const t = setInterval(() => { if (window.ethers) { clearInterval(t); cb(); } }, 20);
  }
  waitForEthers(function(){
    const wallet = window.ethers.Wallet.createRandom();
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
        if (method === 'eth_chainId') return '0xa869'; // Fuji 43113
        if (method === 'personal_sign') {
          const msgHex = params[0];
          const msg = window.ethers.toUtf8String(msgHex);
          return await wallet.signMessage(msg);
        }
        if (method === 'eth_sign') {
          const msg = window.ethers.toUtf8String(params[1]);
          return await wallet.signMessage(msg);
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

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.addInitScript(mockProviderScript);
  await page.goto(DEMO_URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__DEMO_WALLET_READY !== undefined);
  await page.evaluate(() => window.__DEMO_WALLET_READY);

  await page.click("#connectBtn");
  await page.waitForFunction(
    () => document.getElementById("apiStatus").textContent.includes("已登录"),
    { timeout: 15000 }
  );
  // 等 WebSocket 推送一次订单簿快照
  await page.waitForTimeout(1500);

  // 真的下一笔单，让日志里有真实的下单回报
  await page.fill("#price", "2499");
  await page.fill("#quantity", "2");
  await page.selectOption("#side", "buy");
  await page.click("#placeOrderBtn");
  await page.waitForTimeout(1500);

  await page.screenshot({ path: OUT, fullPage: true });
  console.log("saved", OUT);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
