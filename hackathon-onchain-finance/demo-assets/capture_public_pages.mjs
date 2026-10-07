import { chromium } from "playwright";

const targets = [
  { url: "https://testnet.snowtrace.io/address/0x9128AE5F8cf51eB35A69C29c55B07A7776603b0B", out: "02-vault-contract-snowtrace.png" },
  { url: "https://testnet.snowtrace.io/tx/0xa2a7b995ec17392645be8ce5775e276c307c246175c94710992168cbb04066d1", out: "03-real-deposit-tx-snowtrace.png" },
  { url: "https://testnet.snowtrace.io/tx/0x452c4cf135fc77a1ef09bcf54b39fc2037dd2723e469e7f8347910b62eddb256", out: "04-real-settle-tx-snowtrace.png" },
];

async function main() {
  const browser = await chromium.launch();
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(t.url, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `./raw_screenshots/${t.out}`, fullPage: false });
      console.log("saved", t.out);
    } catch (e) {
      console.error("FAILED", t.url, e.message);
    }
    await page.close();
  }
  await browser.close();
}
main();
