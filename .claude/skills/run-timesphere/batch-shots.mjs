#!/usr/bin/env node
/**
 * Batch capture — signs in ONCE and walks a list of routes, writing a full-page PNG plus the
 * page's innerText for each. Lives beside driver.mjs for the same reason that file does: Node
 * resolves `@playwright/test` by walking up from the SCRIPT's directory.
 *
 * The single sign-in is the point. driver.mjs re-authenticates per invocation, which is correct
 * for one-off checks but costs a full login round-trip per route when capturing a dozen of them.
 *
 * Usage:  node .claude/skills/run-timesphere/batch-shots.mjs
 * Env:    TS_WEB TS_API TS_USER TS_PASS TS_OUT  (same names/defaults as driver.mjs)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const WEB = (process.env.TS_WEB ?? "https://localhost:5173").replace(/\/$/, "");
const USER = process.env.TS_USER ?? "superadmin@timesheet.local";
const PASS = process.env.TS_PASS ?? "Admin@12345";
const OUT = process.env.TS_OUT ?? "test-results/run-shots";

/** [route, filename]. Public routes (no /app prefix) are visited after sign-in anyway — harmless. */
const ROUTES = [
  ["/app", "01-dashboard"],
  ["/app/timesheet", "02-timesheet"],
  ["/app/history", "03-history"],
  ["/app/tickets", "04-tickets"],
  ["/app/projects", "05-projects"],
  ["/app/users", "06-users"],
  ["/app/team", "07-team"],
  ["/app/approvals", "08-approvals"],
  ["/app/reports", "09-reports"],
  ["/app/insights", "10-insights"],
  ["/app/dashboards", "11-dashboards"],
  ["/app/ai", "12-ai-suggestions"],
  ["/app/ai-activity", "13-ai-activity"],
  ["/app/workload", "14-workload"],
  ["/app/timeline", "15-timeline"],
  ["/app/goals", "16-goals"],
  ["/app/security-insights", "17-security-insights"],
  ["/app/audit", "18-audit"],
  ["/pitch", "19-pitch"],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const failures = [];
page.on("pageerror", (e) => failures.push(`pageerror ${e}`));
page.on("response", (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Email", { exact: true }).fill(USER);
await page.getByLabel("Password", { exact: true }).fill(PASS);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/\/app/, { timeout: 30_000 });
console.log("signed in as", USER);

mkdirSync(OUT, { recursive: true });
const textDump = [];

for (const [route, name] of ROUTES) {
  try {
    await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1800); // React Query paints a tick after the fetch settles
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    const text = await page.evaluate(() => document.body.innerText);
    textDump.push(`\n\n${"=".repeat(78)}\n== ${route}  ->  ${name}\n== landed: ${page.url()}\n${"=".repeat(78)}\n${text}`);
    console.log(`ok   ${route.padEnd(26)} -> ${name}.png  (${text.length} chars)`);
  } catch (e) {
    console.log(`FAIL ${route.padEnd(26)} ${e.message.split("\n")[0]}`);
    textDump.push(`\n\n== ${route} FAILED: ${e.message.split("\n")[0]}`);
  }
}

writeFileSync(path.join(OUT, "page-text.txt"), textDump.join(""), "utf8");
const real = [...new Set(failures)].filter((f) => !/40[13] POST \S+\/auth\/refresh/.test(f));
console.log(real.length ? `\nfailed requests:\n  ${real.slice(0, 25).join("\n  ")}` : "\nfailed requests: none");
await browser.close();
