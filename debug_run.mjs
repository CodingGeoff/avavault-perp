import { chromium } from "playwright";

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

const DEMO_URL = "http://localhost:8080/index.html";
const BUYER_KEY = requireEnv("DEMO_TRADER_B_KEY");

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
    const wallet = new window.ethers.Wallet("${BUYER_KEY}");
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
        if (method === 'eth_signTypedData_v4') {
          const typed = JSON.parse(params[1]);
          const { domain, types, message } = typed;
          const cleanTypes = { ...types };
          delete cleanTypes.EIP712Domain;
          return await wallet.signTypedData(domain, cleanTypes, message);
        }
        throw new Error('unsupported ' + method);
      },
      on: () => {}, removeListener: () => {},
    };
    window.__resolveDemoWallet(wallet.address);
  });
})();
`;

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
      el.textContent = '[x] 下单结果: ' + JSON.stringify(data) + '\\n' + el.textContent;
    } catch (e) {
      console.log('ORDER_ERR', e.message);
    }
  };
})();
`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (msg) => console.log('PAGE:', msg.text()));
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.addInitScript(mockProviderScript);
  await page.goto(DEMO_URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__DEMO_WALLET_READY !== undefined);
  await page.evaluate(() => window.__DEMO_WALLET_READY);
  await page.evaluate(patchBuyFlowScript);

  await page.click("#connectBtn");
  await page.waitForFunction(() => document.getElementById("apiStatus").textContent.includes("已登录"), { timeout: 15000 });
  console.log('LOGGED IN');
  await page.waitForTimeout(1500);

  await page.fill("#price", "2550");
  await page.fill("#quantity", "1");
  await page.selectOption("#side", "buy");
  await page.click("#placeOrderBtn");
  await page.waitForTimeout(8000);
  const logText = await page.evaluate(() => document.getElementById('log').textContent);
  console.log('LOG_TEXT:', logText);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
