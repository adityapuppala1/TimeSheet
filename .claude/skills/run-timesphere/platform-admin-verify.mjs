/**
 * Live verification of the platform-admin hardening flows against a RUNNING dev stack:
 *
 *   1. a throwaway platform admin on the seeded password sees the amber banner
 *   2. Change password clears it (and the server rejects the seeded value as a new password)
 *   3. Rescue admin issues a one-time password for the default workspace's super admin
 *   4. that password signs in on the tenant side with `mustChangePassword: true`
 *   5. the tenant account is put back exactly as it was (password restored, flag cleared)
 *   6. the throwaway platform admin is deleted
 *
 * Nothing it touches is left changed: the throwaway row is removed, and the seeded superadmin's
 * password is restored through the real change-password route (which also clears the flag). If it
 * dies half-way, the two recovery lines are printed at the top so a human can finish the cleanup.
 *
 * Screenshots land in test-results/run-shots/pa-*.png. Run from anywhere inside the repo:
 *   node .claude/skills/run-timesphere/platform-admin-verify.mjs
 */
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

const WEB = process.env.TS_WEB ?? "https://localhost:5173";
const API = process.env.TS_API ?? "http://localhost:4000";
const OUT = path.resolve(root, process.env.TS_OUT ?? "test-results/run-shots");

const THROWAWAY = { email: "ops-verify@timesphere.local", name: "Ops Verify", password: "PlatformAdmin@12345" };
const ROTATED = "Rotated-For-Verification-2026!";
const TENANT_ADMIN = { email: "superadmin@timesheet.local", password: "Admin@12345" };

// Control-plane access through the API's own generated client, so the throwaway row is created
// and removed exactly the way the seed does it.
for (const line of readFileSync(path.join(root, "apps/api/.env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
}
// pathToFileURL, not a bare path: on Windows the ESM loader reads `c:\...` as a URL scheme.
/** The workspace the tenant API resolves to with ROOT_DOMAIN unset — the only one whose owner this
 *  script can sign in as afterwards to restore the password. Any other row would leave a real
 *  super admin in a different tenant database changed. */
const DEFAULT_SLUG = process.env.DEFAULT_ORG_SLUG ?? "default";
const { PrismaClient } = await import(pathToFileURL(path.join(root, "apps/api/src/generated/control-client/index.js")).href);
const control = new PrismaClient();

console.log("recovery if this dies mid-way:");
console.log(`  DELETE FROM PlatformAdminUser WHERE email='${THROWAWAY.email}';`);
console.log(`  -- tenant: sign in as ${TENANT_ADMIN.email} with the printed one-time password, then change it back to ${TENANT_ADMIN.password}`);

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`    ok  ${msg}`);
const fail = (msg) => {
  console.log(`    FAIL ${msg}`);
  process.exitCode = 1;
};

async function main() {
  await control.platformAdminUser.deleteMany({ where: { email: THROWAWAY.email } });
  await control.platformAdminUser.create({
    data: { email: THROWAWAY.email, name: THROWAWAY.name, passwordHash: await bcrypt.hash(THROWAWAY.password, 10), status: "ACTIVE" }
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const failed = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/auth/refresh")) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  try {
    step(1, "sign in to the console on the seeded password — expect the banner");
    await page.goto(`${WEB}/platform-admin/login`);
    await page.getByPlaceholder("platform-admin@timesphere.local").fill(THROWAWAY.email);
    await page.getByPlaceholder("••••••••").fill(THROWAWAY.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/platform-admin$/, { timeout: 15_000 });
    const banner = page.getByRole("alert").filter({ hasText: /seeded bootstrap password/i });
    await banner.waitFor({ timeout: 10_000 });
    // Let the table land before the shot — a banner over "Loading…" proves less than a banner over the data.
    await page.getByRole("row").filter({ has: page.getByText(DEFAULT_SLUG, { exact: true }) }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "pa-01-seeded-banner.png") });
    ok("banner visible; screenshot pa-01-seeded-banner.png");

    step(2, "reload — the banner must survive a session restore, not only the sign-in that just happened");
    await page.reload();
    await page.getByRole("alert").filter({ hasText: /seeded bootstrap password/i }).waitFor({ timeout: 10_000 });
    ok("banner still shown after reload (/auth/me carries the flag)");

    step(3, "Change password: the seeded value is refused as a new password");
    await page.getByRole("button", { name: /change it now/i }).click();
    await page.getByLabel("Current password").fill(THROWAWAY.password);
    await page.getByLabel("New password", { exact: true }).fill(THROWAWAY.password);
    await page.getByLabel("Confirm new password").fill(THROWAWAY.password);
    await page.getByRole("button", { name: /^change password$/i }).click();
    await page.getByText(/seeded bootstrap password — choose your own/i).waitFor({ timeout: 10_000 });
    ok("server refused the seeded password as a new value");

    step(4, "Change password to a real one — the banner disappears");
    await page.getByLabel("New password", { exact: true }).fill(ROTATED);
    await page.getByLabel("Confirm new password").fill(ROTATED);
    await page.screenshot({ path: path.join(OUT, "pa-02-change-password-dialog.png") });
    await page.getByRole("button", { name: /^change password$/i }).click();
    await page.getByText(/password changed/i).waitFor({ timeout: 10_000 });
    await banner.waitFor({ state: "detached", timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "pa-03-banner-gone.png") });
    ok("password changed; banner gone; screenshot pa-03-banner-gone.png");

    step(5, "the rotated password signs in; the seeded one no longer does");
    const bad = await page.request.post(`${API}/api/platform-admin/auth/login`, { data: { email: THROWAWAY.email, password: THROWAWAY.password } });
    const good = await page.request.post(`${API}/api/platform-admin/auth/login`, { data: { email: THROWAWAY.email, password: ROTATED } });
    if (bad.status() === 401 && good.status() === 200) ok(`seeded → ${bad.status()}, rotated → ${good.status()}`);
    else fail(`seeded → ${bad.status()}, rotated → ${good.status()}`);
    const rotatedLogin = await good.json();
    if (rotatedLogin.admin?.usingSeededPassword === false) ok("login response reports usingSeededPassword: false");
    else fail(`login response usingSeededPassword = ${rotatedLogin.admin?.usingSeededPassword}`);

    step(6, `Rescue admin on the "${DEFAULT_SLUG}" workspace — refuses a non-super-admin, issues for the owner`);
    // By slug, never `.first()`: the list is newest-first and every ACTIVE org has the button. A
    // wrong row here resets a real super admin in a different tenant database.
    const defaultRow = page.getByRole("row").filter({ has: page.getByText(DEFAULT_SLUG, { exact: true }) });
    await defaultRow.waitFor({ timeout: 10_000 });
    await defaultRow.getByRole("button", { name: /rescue admin/i }).click();
    await page.getByRole("dialog").filter({ hasText: `(${DEFAULT_SLUG})` }).waitFor({ timeout: 10_000 });
    await page.getByPlaceholder("owner@acme.com").fill("employee@timesheet.local");
    await page.getByRole("button", { name: /issue one-time password/i }).click();
    await page.getByText(/not a super administrator/i).waitFor({ timeout: 10_000 });
    ok("employee@timesheet.local refused (403 — not a super admin)");

    await page.getByPlaceholder("owner@acme.com").fill(TENANT_ADMIN.email);
    await page.getByRole("button", { name: /issue one-time password/i }).click();
    const otpBox = page.locator("code.select-all");
    await otpBox.waitFor({ timeout: 15_000 });
    const otp = (await otpBox.textContent())?.trim() ?? "";
    await page.screenshot({ path: path.join(OUT, "pa-04-rescue-otp.png") });
    if (/^[A-Za-z0-9]{12}!7aQ$/.test(otp)) ok(`one-time password issued (${otp.length} chars, shape correct); screenshot pa-04-rescue-otp.png`);
    else fail(`unexpected one-time password shape: ${JSON.stringify(otp)}`);
    await page.getByRole("button", { name: /^done$/i }).click();

    step(7, "tenant side: the old password is dead, the one-time password works and is flagged");
    const oldLogin = await page.request.post(`${API}/api/auth/login`, { data: { email: TENANT_ADMIN.email, password: TENANT_ADMIN.password, rememberMe: false } });
    const otpLogin = await page.request.post(`${API}/api/auth/login`, { data: { email: TENANT_ADMIN.email, password: otp, rememberMe: false } });
    const otpBody = await otpLogin.json();
    if (oldLogin.status() === 401) ok("old password → 401");
    else fail(`old password → ${oldLogin.status()}`);
    if (otpLogin.status() === 200 && otpBody.user?.mustChangePassword === true) ok("one-time password → 200 with mustChangePassword: true");
    else fail(`one-time password → ${otpLogin.status()} mustChangePassword=${otpBody.user?.mustChangePassword}`);

    step(8, "restore: the owner chooses their password back — the flag clears");
    const restore = await page.request.post(`${API}/api/auth/change-password`, {
      headers: { Authorization: `Bearer ${otpBody.accessToken}` },
      data: { currentPassword: otp, nextPassword: TENANT_ADMIN.password }
    });
    const back = await page.request.post(`${API}/api/auth/login`, { data: { email: TENANT_ADMIN.email, password: TENANT_ADMIN.password, rememberMe: false } });
    const backBody = await back.json();
    if (restore.ok() && back.status() === 200 && backBody.user?.mustChangePassword === false) ok(`restored — ${TENANT_ADMIN.email} signs in with the original password, flag cleared`);
    else fail(`restore → ${restore.status()}, re-login → ${back.status()}, flag=${backBody.user?.mustChangePassword}`);

    step(9, "tenant audit log carries the platform-side reset");
    const audit = await page.request.get(`${API}/api/audit?limit=5`, { headers: { Authorization: `Bearer ${backBody.accessToken}` } }).catch(() => null);
    if (audit?.ok()) {
      const rows = await audit.json();
      const list = Array.isArray(rows) ? rows : rows.items ?? rows.data ?? [];
      const hit = list.find((r) => r.action === "user.password_reset_by_platform");
      if (hit) ok(`audit row user.password_reset_by_platform present (by ${hit.metadata?.by ?? "?"})`);
      else console.log("    note audit route answered but the row was not in the first page — check /app/admin/audit by hand");
    } else console.log(`    note audit route not readable from here (${audit?.status() ?? "no response"}) — check /app/admin/audit by hand`);
  } finally {
    await browser.close();
    await control.platformAdminUser.deleteMany({ where: { email: THROWAWAY.email } });
    await control.$disconnect();
    console.log(`\nthrowaway ${THROWAWAY.email} removed`);
    const unexpected = failed.filter((f) => !/\/auth\/login|\/reset-admin-password|\/change-password/.test(f));
    console.log(unexpected.length ? `unexpected failed requests:\n  ${unexpected.join("\n  ")}` : "no unexpected failed requests");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
