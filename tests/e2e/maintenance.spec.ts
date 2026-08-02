/**
 * Maintenance mode, end to end: enable → non-admins locked out of both API and login →
 * super admin unaffected → disable → everything restored.
 *
 * THE FINALLY BLOCK IS THE MOST IMPORTANT CODE IN THIS FILE. This spec deliberately locks the
 * shared demo workspace; a failed assertion that skipped cleanup would leave every subsequent
 * spec (and every human using the dev stack) staring at the maintenance page. Disable runs in
 * `finally` and is itself asserted, exactly like the face-gate restore pattern.
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT DO: call POST /maintenance/force-logout. Revoking every
 * non-admin session would kill the `.auth/*` storageState snapshots that later specs depend on —
 * the exact one-owner-per-snapshot trap documented in auth.setup.ts, but done to every snapshot
 * at once. The part of force-logout that is uniquely maintenance logic (the SUPER_ADMIN
 * exemption living in the WHERE clause) is pinned by a unit test instead
 * (apps/api/tests/unit/maintenance.service.test.ts); the revoked-session → 401 chain it rides on
 * is the app's ordinary single-device-logout mechanism, already exercised elsewhere. Only the
 * endpoint's authorization surface is asserted here, which revokes nothing.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const MAINTENANCE_MESSAGE = "E2E maintenance drill — database upgrade in progress.";

/** Enables a window spanning "now", or disables and clears. Asserted — a silently failed
 *  disable in the finally block would be indistinguishable from a working one. */
async function setMaintenance(enabled: boolean): Promise<void> {
  await withAdminRequest(async (ctx, headers) => {
    const res = await ctx.patch("/api/maintenance/settings", {
      headers,
      data: enabled
        ? {
            enabled: true,
            scheduledStartAt: new Date(Date.now() - 60_000).toISOString(),
            scheduledEndAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            message: MAINTENANCE_MESSAGE
          }
        : { enabled: false, scheduledStartAt: null, scheduledEndAt: null, message: null }
    });
    expect(res.ok(), `PATCH /maintenance/settings (enabled=${enabled}) returned ${res.status()}`).toBe(true);
  });
}

test.describe("maintenance mode", () => {
  // Signs in for itself — never borrows another spec's storageState snapshot (auth.setup.ts
  // documents why a snapshot must have exactly one owner).
  test.use({ storageState: { cookies: [], origins: [] } });

  test("public status endpoint answers unauthenticated, admin surface requires SUPER_ADMIN", async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      // Anonymous status probe — the lockout page's lifeline — must work with zero auth.
      const status = await ctx.get("/api/maintenance/status");
      expect(status.status()).toBe(200);
      expect(["off", "scheduled", "active", "ended"]).toContain((await status.json()).phase);

      // The control surface must not leak to ordinary roles: employee → 403, anonymous → 401.
      const login = await ctx.post("/api/auth/login", {
        data: { email: "employee@timesheet.local", password: "Admin@12345" }
      });
      expect(login.ok()).toBe(true);
      const employeeHeaders = { Authorization: `Bearer ${(await login.json()).accessToken}` };

      expect((await ctx.get("/api/maintenance/admin", { headers: employeeHeaders })).status()).toBe(403);
      expect((await ctx.post("/api/maintenance/force-logout", { headers: employeeHeaders })).status()).toBe(403);
      expect((await ctx.get("/api/maintenance/admin")).status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test("active window locks out non-admins (API + login), spares the super admin, and disable restores", async ({ page }) => {
    const ctx: APIRequestContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      // An employee session minted BEFORE the window — proves enabling blocks existing tokens,
      // not merely new logins.
      const preLogin = await ctx.post("/api/auth/login", {
        data: { email: "employee@timesheet.local", password: "Admin@12345" }
      });
      expect(preLogin.ok()).toBe(true);
      const employeeHeaders = { Authorization: `Bearer ${(await preLogin.json()).accessToken}` };
      expect((await ctx.get("/api/auth/me", { headers: employeeHeaders })).status()).toBe(200);

      await setMaintenance(true);
      try {
        // 1. The pre-existing employee token is refused — 503 with the machine-readable code
        //    the client branches on, not a 401 that would send the client refresh-looping.
        const blocked = await ctx.get("/api/auth/me", { headers: employeeHeaders });
        expect(blocked.status()).toBe(503);
        expect((await blocked.json()).code).toBe("MAINTENANCE");

        // 2. A fresh employee login is refused the same way.
        const refusedLogin = await ctx.post("/api/auth/login", {
          data: { email: "employee@timesheet.local", password: "Admin@12345" }
        });
        expect(refusedLogin.status()).toBe(503);
        expect((await refusedLogin.json()).code).toBe("MAINTENANCE");

        // 3. The super admin keeps working — someone has to do the maintenance.
        await withAdminRequest(async (adminCtx, headers) => {
          expect((await adminCtx.get("/api/auth/me", { headers })).status()).toBe(200);
        });

        // 4. The public probe reports the active window with the admin's message.
        const status = await (await ctx.get("/api/maintenance/status")).json();
        expect(status.phase).toBe("active");
        expect(status.message).toBe(MAINTENANCE_MESSAGE);

        // 5. The full browser chain: an employee trying to sign in lands on the branded
        //    maintenance page — message, countdown, no dead-end error toast.
        await page.goto("/login");
        await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
        await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
        await page.getByRole("button", { name: /sign in/i }).click();
        await expect(page).toHaveURL(/\/maintenance/, { timeout: 15_000 });
        await expect(page.getByRole("heading", { name: /scheduled maintenance in progress/i })).toBeVisible();
        await expect(page.getByText(MAINTENANCE_MESSAGE)).toBeVisible();
        await expect(page.getByText(/estimated time remaining/i)).toBeVisible();
      } finally {
        await setMaintenance(false);
      }

      // 6. Recovery, both layers: the SAME employee token works again (enable alone never
      //    revoked it), and the maintenance page notices and sends visitors back to sign in.
      expect((await ctx.get("/api/auth/me", { headers: employeeHeaders })).status()).toBe(200);
      await page.goto("/maintenance");
      await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    } finally {
      await ctx.dispose();
    }
  });
});
