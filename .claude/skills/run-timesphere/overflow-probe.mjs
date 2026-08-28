/**
 * Why a page scrolls sideways, rather than merely what is wide on it.
 *
 * The responsive spec names the widest elements, which is a great start and a bad finish: an
 * element inside an `overflow-x-auto` box is legitimately wider than the viewport and shows up in
 * that list every time, so the real offender hides among a dozen innocents. This walks each wide
 * element's ancestors and only reports the ones with NO scrolling ancestor between them and the
 * document — those are the elements actually stretching `scrollWidth`.
 *
 *   node .claude/skills/run-timesphere/overflow-probe.mjs /platform-admin/backups 390
 */
import { chromium } from "@playwright/test";

const WEB = process.env.TS_WEB ?? "https://localhost:5173";
const [, , route = "/platform-admin", widthArg = "390"] = process.argv;
const width = Number(widthArg);

const email = process.env.TS_PA_USER ?? "platform-admin@timesphere.local";
const password = process.env.TS_PA_PASS ?? "PlatformAdmin@12345";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
const page = await context.newPage();

await page.goto(`${WEB}/platform-admin/login`, { waitUntil: "domcontentloaded" });
if (page.url().includes("/login")) {
  await page.getByPlaceholder("platform-admin@timesphere.local").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/platform-admin(?!\/login)/, { timeout: 20_000 }).catch(() => undefined);
}

await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle").catch(() => undefined);
await page.waitForTimeout(1200);

const result = await page.evaluate(() => {
  const cw = document.documentElement.clientWidth;
  const label = (el) => {
    const cls = String(el.className ?? "").split(/\s+/).filter(Boolean).slice(0, 6).join(".");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
  };
  const scrolls = (el) => {
    const style = getComputedStyle(el);
    return ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
  };
  const culprits = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const rect = el.getBoundingClientRect();
    if (Math.max(rect.right, rect.width) <= cw + 4) continue;
    let contained = false;
    const chain = [];
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      chain.push(`${label(parent)} [overflow-x:${getComputedStyle(parent).overflowX}]`);
      if (scrolls(parent)) {
        contained = true;
        break;
      }
    }
    if (!contained) culprits.push({ width: Math.round(Math.max(rect.right, rect.width)), el: label(el), chain: chain.slice(0, 6) });
  }
  culprits.sort((a, b) => b.width - a.width);
  return { scrollWidth: document.documentElement.scrollWidth, clientWidth: cw, culprits: culprits.slice(0, 12) };
});

console.log(`${route} @ ${width}px — scrollWidth ${result.scrollWidth} / clientWidth ${result.clientWidth}`);
if (!result.culprits.length) console.log("no uncontained wide element");
for (const c of result.culprits) {
  console.log(`\n${c.width}px  ${c.el}`);
  for (const link of c.chain) console.log(`      ↑ ${link}`);
}

await browser.close();
