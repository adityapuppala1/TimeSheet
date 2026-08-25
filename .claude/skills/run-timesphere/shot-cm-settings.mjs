/**
 * Opens Workspace Settings → Change management and screenshots the catalogue editors, so the seven
 * dropdown managers can be checked visually rather than assumed from a passing typecheck.
 *
 * Lives beside driver.mjs because Node resolves @playwright/test from the SCRIPT's directory.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const WEB = (process.env.TS_WEB ?? "https://localhost:5173").replace(/\/$/, "");
const USER = process.env.TS_USER ?? "superadmin@timesheet.local";
const PASS = process.env.TS_PASS ?? "Admin@12345";
const OUT = process.env.TS_OUT ?? "test-results/run-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const failures = [];
page.on("pageerror", (e) => failures.push(`pageerror ${e}`));
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().includes("/api/") && !/auth\/refresh/.test(r.url())) {
    failures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  }
});

await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Email", { exact: true }).fill(USER);
await page.getByLabel("Password", { exact: true }).fill(PASS);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/\/app/, { timeout: 30000 });

await page.goto(`${WEB}/app/settings`, { waitUntil: "networkidle" });
await page.getByRole("tab", { name: /change management/i }).click();
await page.waitForTimeout(2500);

const headings = await page.locator("h4").allInnerTexts();
console.log("catalogue sections rendered:");
for (const h of headings) console.log("   " + h);

await page.screenshot({ path: path.join(OUT, "cm-settings.png"), fullPage: true });
console.log(`\nscreenshot: ${path.join(OUT, "cm-settings.png")}`);
console.log(failures.length ? `\nfailures:\n${[...new Set(failures)].join("\n")}` : "\nno errors");
await browser.close();
