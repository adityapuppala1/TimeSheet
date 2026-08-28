import { chromium } from "@playwright/test";
import path from "node:path";

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
const abs = path.resolve("dist-pitch/timesphere-pitch.html").split(path.sep).join("/");
await page.goto(`file:///${abs}`, { waitUntil: "load" });
await page.waitForTimeout(1800);
const info = await page.evaluate(() => ({
  sections: document.querySelectorAll("section.slide").length,
  lockup: !!document.querySelector("img.lockup") && document.querySelector("img.lockup").naturalWidth > 0,
  broken: [...document.querySelectorAll("img")].filter((i) => i.naturalWidth === 0).length
}));
console.log(JSON.stringify(info));
for (const id of ["ask", "team"]) {
  const el = page.locator(`#${id}`);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await el.screenshot({ path: `test-results/run-shots/deck-${id}.png` });
}
await b.close();
