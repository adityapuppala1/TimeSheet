// Deck-only captures: signs in once, opens each settings tab (or route), applies the same
// gitignored anonymisation map the marketing spec uses, and writes 1920x1080 PNGs. Read-only.
import { chromium } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
const WEB = process.env.TS_WEB ?? "https://localhost:5173";
const OUT = "test-results/deck-shots";
const SHOTS = [
  { slug: "integrations", url: "/app/settings", tab: "Integrations" },
  { slug: "public-api",   url: "/app/settings", tab: "Public API" },
  { slug: "mcp",          url: "/app/settings", tab: "MCP server" },
  { slug: "sec-devops",   url: "/app/settings", tab: "Security & DevOps" },
  { slug: "sec-devops-full", url: "/app/settings", tab: "Security & DevOps", full: true },
  { slug: "email-intake", url: "/app/settings", tab: "Email intake" },
  { slug: "chat",         url: "/app/settings", tab: "Chat integrations" },
  { slug: "ai-overview",  url: "/app/ai" },
];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.addInitScript(() => window.localStorage.setItem("timesheet:theme", "light"));
await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/\/app/, { timeout: 30_000 });
mkdirSync(OUT, { recursive: true });
const anon = existsSync("tests/e2e/.screenshot-anonymise.json")
  ? Object.entries(JSON.parse(readFileSync("tests/e2e/.screenshot-anonymise.json", "utf8"))) : [];
for (const shot of SHOTS) {
  await page.goto(`${WEB}${shot.url}`, { waitUntil: "networkidle" });
  if (shot.tab) {
    const tab = page.getByRole("tab", { name: shot.tab, exact: true });
    await ((await tab.count()) ? tab : page.getByRole("button", { name: shot.tab, exact: true })).first().click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await page.waitForTimeout(1200);
  await page.evaluate((entries) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let t = n.nodeValue ?? "";
      for (const [f, r] of entries) t = t.split(f).join(r);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  }, anon);
  await page.screenshot({ path: `${OUT}/${shot.slug}.png`, fullPage: Boolean(shot.full) });
  console.log("ok", shot.slug);
}
await browser.close();
