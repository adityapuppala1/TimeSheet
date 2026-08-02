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
  // Dedicated to timesheet.spec.ts. dashboard.spec.ts logs in as the same real account under
  // its OWN snapshot ("employee-dashboard") rather than sharing this one — both specs call
  // POST /auth/refresh directly (see each spec's cleanup step), which rotates that SESSION's
  // refresh secret. Two specs sharing one snapshot file race to invalidate each other the
  // moment the suite's total runtime crosses the 30s rotation-grace window (auth.service.ts's
  // REFRESH_GRACE_PERIOD_MS) — this bit us for real: timesheet.spec.ts started failing with
  // "redirected to /login" once dashboard.spec.ts ran earlier in the same full sequential suite
  // and rotated the shared secret out from under it. Separate logins mean separate sessions
  // (distinct `sid`), so one spec's refresh can never revoke the other's.
  employee: { email: "employee@timesheet.local", password: "Admin@12345" },
  "employee-dashboard": { email: "employee@timesheet.local", password: "Admin@12345" },
  // Dedicated to backend-health.spec.ts for the same separate-session reason as above. That spec
  // additionally spends ~30s with the API deliberately unreachable, so sharing a snapshot would
  // park another spec's session right at the edge of the rotation-grace window.
  "employee-health": { email: "employee@timesheet.local", password: "Admin@12345" }
} as const;

/**
 * NOTE ON THE LIMIT OF THIS PATTERN, learned building product-tour.spec.ts: a snapshot file
 * replays ONE fixed refresh cookie, and every `/app` load rotates that session's secret. The grace
 * window forgives only the immediately-previous secret, so a spec with MANY tests exhausts the
 * chain — the first test leaves the snapshot two generations behind and the rest land on /login.
 *
 * Giving such a spec its own snapshot does NOT help; the exhaustion happens within the spec. A
 * multi-test spec should sign in per test instead (see product-tour.spec.ts's `signIn`), which is
 * free against the rate limiter because successful logins are skipped by it.
 */

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
