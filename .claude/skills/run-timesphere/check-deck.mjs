// Renders a local HTML file and screenshots chosen scroll positions. Read-only.
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
const [file, ...stops] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 }, colorScheme: process.env.DECK_THEME === "dark" ? "dark" : "light" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(pathToFileURL(file).href, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
for (const stop of stops) {
  await page.evaluate((i) => {
    document.querySelectorAll(".slide")[i]?.scrollIntoView({ behavior: "instant" });
  }, Number(stop));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `test-results/deck-check/slide-${stop}.png` });
}
console.log("pageerrors:", errors.length ? errors : "none");
console.log("counter:", await page.locator("#counter").innerText());
await browser.close();
