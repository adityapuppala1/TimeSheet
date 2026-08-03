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

/** Enables a window (spanning "now" by default, or a future one via startOffsetMs), or
 *  disables and clears. Asserted — a silently failed disable in the finally block would be
 *  indistinguishable from a working one. */
async function setMaintenance(enabled: boolean, startOffsetMs = -60_000): Promise<void> {
  await withAdminRequest(async (ctx, headers) => {
    const res = await ctx.patch("/api/maintenance/settings", {
      headers,
      data: enabled
        ? {
            enabled: true,
            scheduledStartAt: new Date(Date.now() + startOffsetMs).toISOString(),
            // End is START-relative, not now-relative: with a future start, "now + 60min"
            // equals the start to the millisecond and the API (correctly) 422s the
            // zero-length window — a race this test lost only sometimes.
            scheduledEndAt: new Date(Date.now() + startOffsetMs + 60 * 60_000).toISOString(),
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
      expect((await ctx.get("/api/maintenance/health", { headers: employeeHeaders })).status()).toBe(403);

      // The server-health snapshot: super-admin only, and the shape the card renders from.
      await withAdminRequest(async (adminCtx, headers) => {
        const res = await adminCtx.get("/api/maintenance/health", { headers });
        expect(res.status()).toBe(200);
        const health = await res.json();
        expect(health.cpu.cores).toBeGreaterThan(0);
        expect(health.memory.usedPercent).toBeGreaterThan(0);
        expect(health.components.map((c: { name: string }) => c.name)).toContain("Tenant database");
        expect(health.components.find((c: { name: string; ok: boolean }) => c.name === "Tenant database")!.ok).toBe(true);
      });
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

  test("a FUTURE window interrupts signed-in users once with a pop-up, then keeps the banner", async ({ page }) => {
    // Scheduled one hour out: warns, blocks nothing — employees can still sign in and work.
    await setMaintenance(true, 60 * 60_000);
    try {
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
      await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

      // The pop-up is the loud, one-time interruption (people tune out passive chrome — the
      // explicit feedback that motivated it); the banner is the ambient reminder that stays.
      const popup = page.getByRole("alertdialog", { name: /scheduled maintenance ahead/i });
      await expect(popup).toBeVisible({ timeout: 15_000 });
      await expect(popup.getByText(MAINTENANCE_MESSAGE)).toBeVisible();
      await popup.getByRole("button", { name: /got it/i }).click();
      await expect(popup).toBeHidden();

      await expect(page.getByRole("status").getByText(/scheduled maintenance/i)).toBeVisible();

      // Acknowledged once = not interrupted again: a reload shows the banner but NO pop-up.
      await page.reload();
      await expect(page.getByRole("status").getByText(/scheduled maintenance/i)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("alertdialog", { name: /scheduled maintenance ahead/i })).toBeHidden();
    } finally {
      await setMaintenance(false);
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * The status page: per-feature health and recorded downtime.
 *
 * The assertions worth having here are about HONESTY, not about squares rendering. A status page
 * that reports absence of data as success, or that quietly forgets an outage the moment it
 * recovers, is worse than no status page — it will confidently deny something that happened.
 * ------------------------------------------------------------------------------------------- */
test.describe("service status page", () => {
  test("probes every service and never reports 'no data' as healthy", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const ran = await ctx.post("/api/maintenance/status-page/run", { headers });
      expect(ran.status(), await ran.text()).toBe(200);
      const results = (await ran.json()).results;
      expect(results.length).toBeGreaterThanOrEqual(10);
      for (const r of results) {
        expect(["OPERATIONAL", "DEGRADED", "DOWN"]).toContain(r.status);
        expect(typeof r.latencyMs).toBe("number");
      }

      const page = await (await ctx.get("/api/maintenance/status-page?days=30", { headers })).json();
      expect(page.services.length).toBe(results.length);
      expect(["OPERATIONAL", "DEGRADED", "DOWN"]).toContain(page.overall);

      for (const service of page.services) {
        // Exactly one square per day in the window, always — a strip that silently omits days
        // compresses the axis and makes a quiet week look busy.
        expect(service.days).toHaveLength(page.days);
        // The oldest day predates any sample in a fresh workspace and MUST be null rather than
        // green. Reporting "we had no monitoring" as "nothing was wrong" is the specific lie a
        // status page exists not to tell.
        for (const day of service.days) {
          if (day.samples === 0) expect(day.status).toBeNull();
          else expect(["OPERATIONAL", "DEGRADED", "DOWN"]).toContain(day.status);
        }
        // Today was just probed.
        expect(service.days[service.days.length - 1].samples).toBeGreaterThan(0);
      }
    });
  });

  test("an outage opens one incident, accumulates while it lasts, and closes on recovery", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const settings = await (await ctx.get("/api/settings/ai", { headers })).json();
      const restore = { aiEnabled: settings.aiEnabled };

      const aiOf = async () => {
        const page = await (await ctx.get("/api/maintenance/status-page?days=2", { headers })).json();
        return {
          service: page.services.find((s: any) => s.key === "ai"),
          incidents: page.incidents.filter((i: any) => i.service === "ai")
        };
      };
      const probe = () => ctx.post("/api/maintenance/status-page/run", { headers });

      try {
        // A real misconfiguration rather than sabotaged infrastructure: "AI switched on with no
        // key" is exactly the failure this probe exists to catch.
        await ctx.patch("/api/settings/ai", { headers, data: { aiEnabled: true, apiKey: "" } });
        await probe();

        let state = await aiOf();
        test.skip(state.service.current !== "DOWN", "this workspace has a key configured — nothing to break");
        expect(state.incidents.filter((i: any) => !i.endedAt)).toHaveLength(1);
        const opened = state.incidents.find((i: any) => !i.endedAt)!;

        // Two more failing probes must extend the SAME incident, not create three.
        await probe();
        await probe();
        state = await aiOf();
        const still = state.incidents.filter((i: any) => !i.endedAt);
        expect(still).toHaveLength(1);
        expect(still[0].id).toBe(opened.id);
        expect(still[0].sampleCount).toBeGreaterThan(opened.sampleCount);

        await ctx.patch("/api/settings/ai", { headers, data: { aiEnabled: false } });
        await probe();
        state = await aiOf();
        expect(state.service.current).toBe("OPERATIONAL");
        expect(state.incidents.filter((i: any) => !i.endedAt)).toHaveLength(0);

        // THE ASSERTION THAT MATTERS MOST: recovering does not repaint today green. A day is
        // coloured by its worst check, so an outage stays visible for the day it happened —
        // otherwise the page forgets the incident the moment it is fixed, which is precisely
        // when somebody starts asking about it.
        expect(state.service.days[state.service.days.length - 1].status).not.toBe("OPERATIONAL");
      } finally {
        await ctx.patch("/api/settings/ai", { headers, data: restore });
      }
    });
  });
});
