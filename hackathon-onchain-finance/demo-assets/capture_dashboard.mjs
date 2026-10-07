import { chromium } from "playwright";
async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.goto("http://localhost:8081/render_dashboard.html", { waitUntil: "load" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "./raw_screenshots/05-onchain-dashboard.png", fullPage: true });
  console.log("saved");
  await browser.close();
}
main();
