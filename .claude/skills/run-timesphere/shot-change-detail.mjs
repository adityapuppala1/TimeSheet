/**
 * Opens a change's detail page and screenshots it, so the tab grouping, the outstanding-work dots
 * and the header facts can be checked visually rather than assumed from a passing typecheck.
 *
 * Takes the FIRST change in the register. Pass a change id as argv[2] to target a specific one.
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
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 }, ignoreHTTPSErrors: true });
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

const target = process.argv[2];
if (target) {
  await page.goto(`${WEB}/app/changes/${target}`, { waitUntil: "networkidle" });
} else {
  await page.goto(`${WEB}/app/changes`, { waitUntil: "networkidle" });
  const row = page.locator("table tbody tr").first();
  await row.click();
  await page.waitForURL(/\/app\/changes\/[0-9a-f-]{8}/, { timeout: 20000 });
}
await page.waitForTimeout(2000);

console.log("tabs:", (await page.locator('[role="tab"]').allInnerTexts()).join(" | "));
console.log("header facts:", (await page.locator("dl dt").allInnerTexts()).join(", "));

await page.screenshot({ path: path.join(OUT, "change-detail.png"), fullPage: false });
console.log(`\nscreenshot: ${path.join(OUT, "change-detail.png")}`);
console.log(failures.length ? `\nfailures:\n${[...new Set(failures)].join("\n")}` : "\nno errors");
await browser.close();
