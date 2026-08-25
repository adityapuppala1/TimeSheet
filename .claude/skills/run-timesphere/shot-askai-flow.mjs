/**
 * Drives one real question through the Ask AI page and screenshots three moments: at rest, PENDING
 * (the strands loader mid-flight — the state a static route shot can never catch), and answered.
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

const QUESTION = process.argv[2] ?? "How many of my entries are approved till now?";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const failures = [];
page.on("pageerror", (e) => failures.push(`pageerror ${e}`));

await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Email", { exact: true }).fill(USER);
await page.getByLabel("Password", { exact: true }).fill(PASS);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/\/app/, { timeout: 30000 });

await page.goto(`${WEB}/app/ask-ai`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, "askai-rest.png") });

await page.getByLabel("Ask AI", { exact: true }).fill(QUESTION);
await page.getByRole("button", { name: "Ask", exact: true }).click();
// The NIM model takes a few seconds — long enough to catch the loader honestly.
await page.waitForTimeout(650);
await page.screenshot({ path: path.join(OUT, "askai-pending.png") });

// Then wait for the answer to land (the pending card disappears).
await page.waitForFunction(() => !document.body.innerText.includes("Consulting the workspace"), { timeout: 180_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "askai-answered.png") });

const last = await page.evaluate(() => {
  const text = document.body.innerText;
  const i = text.lastIndexOf("approved");
  return text.slice(Math.max(0, i - 300), i + 300).replace(/\n+/g, " | ");
});
console.log("answer region:", last.slice(0, 500));
console.log(failures.length ? `failures:\n${failures.join("\n")}` : "no page errors");
await browser.close();
