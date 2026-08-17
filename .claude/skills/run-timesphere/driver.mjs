#!/usr/bin/env node
/**
 * TimeSphere run-driver — the programmatic handle on the running app.
 *
 * WHY THIS FILE LIVES INSIDE THE REPO (do not move it to a temp dir): it imports
 * `@playwright/test`, and Node resolves that by walking up from the SCRIPT's directory looking for
 * node_modules. A copy in %TEMP% dies with ERR_MODULE_NOT_FOUND even when the cwd is the repo.
 *
 * WHY PLAYWRIGHT AND NOT chromium-cli: the repo already depends on @playwright/test for its e2e
 * suite (browsers installed), and the dev server is HTTPS with a self-signed cert — this needs
 * ignoreHTTPSErrors, which is one flag here.
 *
 * WHY IT SIGNS IN FRESH EVERY RUN instead of reusing tests/e2e/.auth/*.json: every /app load
 * rotates the session secret and the grace window forgives only the previous one, so a stored
 * snapshot goes stale and lands you on /login. Successful logins are skipped by the rate limiter,
 * so re-signing in is free (see the comment at the top of tests/e2e/auth.setup.ts).
 *
 * Usage (from the repo root):
 *   node .claude/skills/run-timesphere/driver.mjs health
 *   node .claude/skills/run-timesphere/driver.mjs shot /app/whats-new whats-new
 *   node .claude/skills/run-timesphere/driver.mjs text /app/whats-new 1200
 *   node .claude/skills/run-timesphere/driver.mjs eval /app/whats-new "document.querySelectorAll('svg').length"
 *   node .claude/skills/run-timesphere/driver.mjs bell
 *
 * Env: TS_WEB (https://localhost:5173) TS_API (http://localhost:4000)
 *      TS_USER / TS_PASS (seeded superadmin) TS_OUT (test-results/run-shots)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const WEB = (process.env.TS_WEB ?? "https://localhost:5173").replace(/\/$/, "");
const API = (process.env.TS_API ?? "http://localhost:4000").replace(/\/$/, "");
const USER = process.env.TS_USER ?? "superadmin@timesheet.local";
const PASS = process.env.TS_PASS ?? "Admin@12345";
const OUT = process.env.TS_OUT ?? "test-results/run-shots";

const [cmd, ...rest] = process.argv.slice(2);

/** Sign-in is only needed for /app routes; /login and /shared/* are public. */
async function open(route) {
  const needsLogin = !route || route.startsWith("/app");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const failures = [];
  const seen = { notifications: null };
  page.on("pageerror", (e) => failures.push(`pageerror ${e}`));
  page.on("response", async (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    // Attached before the first navigation on purpose: the SPA fetches notifications during the
    // initial /app load, and React Query serves the bell from cache afterwards — a listener added
    // later than this sees nothing when the panel opens.
    if (/notification/i.test(r.url()) && r.ok()) { try { seen.notifications = await r.json(); } catch { /* not json */ } }
  });

  if (needsLogin) {
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email", { exact: true }).fill(USER);
    await page.getByLabel("Password", { exact: true }).fill(PASS);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/app/, { timeout: 20_000 });
  }
  if (route) {
    await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200); // React Query paints a tick after the fetch settles
  }
  return { browser, page, failures, seen };
}

/** `401 POST .../auth/refresh` fires on every cold load before sign-in — never a real failure. */
function reportFailures(failures) {
  const real = [...new Set(failures)].filter((f) => !/40[13] POST \S+\/auth\/refresh/.test(f));
  console.log(real.length ? `\nrequests that failed:\n  ${real.join("\n  ")}` : "\nrequests that failed: none (ignoring the pre-login auth/refresh 401s)");
}

async function health() {
  const h = await fetch(`${API}/health`);
  console.log(`GET /health -> ${h.status}`);
  const version = await (await fetch(`${API}/api/system/version`)).json();
  console.log(`version: ${JSON.stringify(version)}`);
  const u = await (await fetch(`${API}/api/system/updates`)).json();
  console.log(`updates: current=${u.currentVersion} latest=${u.latestVersion} releases=${u.releases.length}`);
  for (const r of u.releases) {
    console.log(`  v${r.version.padEnd(7)} ${String(r.publishedAt).slice(0, 10)}  ${(r.name ?? "").slice(0, 56)}`);
  }
  if (h.status !== 200) process.exitCode = 1;
}

async function shot(route, name) {
  const { browser, page, failures } = await open(route);
  mkdirSync(OUT, { recursive: true });
  // The first replace already collapses runs, so at most one dash can sit at either end — no
  // quantifier needed here (a `-+` alternation backtracks super-linearly; Sonar S8786).
  const slug = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const file = path.join(OUT, (name || slug || "page") + ".png");
  await page.screenshot({ path: file, fullPage: true });
  console.log(`url: ${page.url()}`);
  console.log(`screenshot: ${file}`);
  reportFailures(failures);
  await browser.close();
}

async function text(route, limit) {
  const { browser, page, failures } = await open(route);
  const body = await page.locator("body").innerText();
  console.log(`url: ${page.url()}`);
  console.log(body.slice(0, Number(limit ?? 2000)));
  reportFailures(failures);
  await browser.close();
}

async function evaluate(route, expr) {
  const { browser, page, failures } = await open(route);
  const value = await page.evaluate(`(() => (${expr}))()`);
  console.log(`url: ${page.url()}`);
  console.log(JSON.stringify(value, null, 2));
  reportFailures(failures);
  await browser.close();
}

/**
 * The bell must be driven through the UI, not its endpoint: the SPA holds the access token in
 * memory and sends it as a header, so `page.request.get("/api/notifications")` answers 401 even
 * with a signed-in page. Listening for the response the app itself makes is how you see the rows.
 */
async function bell() {
  // Stay on wherever sign-in lands (the top bar is part of the /app shell) rather than navigating
  // to a named route — "/app/dashboard" is not the dashboard's path and renders no top bar.
  const { browser, page, failures, seen } = await open(null);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);
  await page.locator("button:has(svg)").filter({ hasText: /9\+|\d+/ }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(2500);

  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "bell.png");
  await page.screenshot({ path: file });

  // What the user can actually read in the open panel — the source of truth for "did it arrive?".
  const lines = (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => /^notifications$/i.test(l));
  console.log("panel:");
  for (const l of (start >= 0 ? lines.slice(start, start + 12) : ["(no 'Notifications' heading found — did the panel open?)"])) {
    console.log(`  ${l}`);
  }

  const payload = seen.notifications;
  const rows = Array.isArray(payload) ? payload : (payload?.items ?? payload?.notifications ?? payload?.data ?? []);
  console.log(`\nbell rows from the API response: ${rows.length}`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${JSON.stringify({ title: r.title, link: r.link ?? r.url, readAt: r.readAt })}`);
  }
  console.log(`screenshot: ${file}`);
  reportFailures(failures);
  await browser.close();
}

const commands = {
  health: () => health(),
  shot: () => shot(rest[0] ?? "/app/dashboard", rest[1]),
  text: () => text(rest[0] ?? "/app/dashboard", rest[1]),
  eval: () => evaluate(rest[0], rest.slice(1).join(" ")),
  bell: () => bell()
};

if (!commands[cmd]) {
  console.error(`usage: node .claude/skills/run-timesphere/driver.mjs <${Object.keys(commands).join("|")}> [args]`);
  process.exit(2);
}
await commands[cmd]();
