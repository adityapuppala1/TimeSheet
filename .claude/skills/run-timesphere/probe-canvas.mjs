/**
 * Screenshots the Workflow Studio's canvas builder.
 *
 * The canvas only exists inside the flow editor dialog at `lg` and above, so a plain `shot` of
 * /app/studio never shows it — this signs in, opens the first flow, switches to Canvas, and
 * captures the dialog. Written because "the toggle exists" and "the graph is readable" are
 * different claims and only a picture settles the second.
 *
 * Run:  node .claude/skills/run-timesphere/probe-canvas.mjs [dark|light]
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { chromium } from "@playwright/test";

const WEB = process.env.TS_WEB || "https://localhost:5173";
const USER = process.env.TS_USER || "superadmin@timesheet.local";
const PASS = process.env.TS_PASS || "Admin@12345";
const theme = process.argv[2] === "dark" ? "dark" : "light";

const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });

await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Email", { exact: true }).fill(USER);
await page.getByLabel("Password", { exact: true }).fill(PASS);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/\/app/, { timeout: 20_000 });

await page.evaluate((wantDark) => document.documentElement.classList.toggle("dark", wantDark), theme === "dark");

await page.goto(`${WEB}/app/studio`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /^Edit$/ }).first().click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ timeout: 15_000 });
await dialog.getByRole("button", { name: /Canvas/ }).click();
await page.waitForTimeout(700);

mkdirSync("test-results/run-shots", { recursive: true });
const out = `test-results/run-shots/flow-canvas-${theme}.png`;
writeFileSync(out, await dialog.screenshot());
console.log("screenshot:", out);

await browser.close();
