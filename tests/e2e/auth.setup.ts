/**
 * Playwright "setup" project — logs in once per demo role and saves the resulting httpOnly
 * refresh-token cookie to a JSON file. Every other spec then does
 * `test.use({ storageState: ".auth/<role>.json" })` instead of re-logging-in for every test.
 *
 * Because the API rotates the refresh token's secret on every `/auth/refresh` call (see
 * auth.service.ts#refresh) and revokes the whole session if an already-rotated-away secret
 * is presented outside a short grace window, specs that reuse one of these snapshot files
 * must not spread far enough apart in wall-clock time that the grace window lapses between
 * them — the suite runs single-worker/serial (see playwright.config.ts) specifically so this
 * holds in practice.
 */
import { test as setup, expect } from "@playwright/test";

const DEMO_USERS = {
  // Dedicated to settings.spec.ts — responsive.spec.ts (the other superadmin consumer) logs
  // in fresh per test instead of using a snapshot, since it runs under five separate
  // viewport projects (see responsive.spec.ts's header comment).
  "superadmin-settings": { email: "superadmin@timesheet.local", password: "Admin@12345" },
  manager: { email: "manager@timesheet.local", password: "Admin@12345" },
  employee: { email: "employee@timesheet.local", password: "Admin@12345" }
} as const;

for (const [role, creds] of Object.entries(DEMO_USERS)) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(creds.email);
    await page.getByLabel("Password", { exact: true }).fill(creds.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });
    await page.context().storageState({ path: `tests/e2e/.auth/${role}.json` });
  });
}
