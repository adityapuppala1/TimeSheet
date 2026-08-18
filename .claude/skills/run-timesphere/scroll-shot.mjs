// Full-page marketing screenshot with the scroll-reveal animations already fired: scrolls
// through the page step by step (which trips every IntersectionObserver), returns to the top,
// then captures. Read-only.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const [route = "/", name = "page"] = process.argv.slice(2);
const WEB = process.env.TS_WEB ?? "https://localhost:5173";
const OUT = process.env.TS_OUT ?? "test-results/marketing-verify";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true })).newPage();
await page.goto(`${WEB}${route}`, { waitUntil: "networkidle" });
const height = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < height; y += 800) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
  await page.waitForTimeout(120);
}
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
await page.waitForTimeout(600);
mkdirSync(OUT, { recursive: true });
await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
console.log(`${OUT}/${name}.png`);
await browser.close();
