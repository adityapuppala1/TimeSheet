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
import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";
import { signIn } from "./helpers/sign-in";

import { E2E_BASE_URL as BASE_URL } from "./helpers/base-url";
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
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
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
    const ctx: APIRequestContext = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
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
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

  /**
   * The incident LIFECYCLE is covered by tests/unit/service-health.service.test.ts, not here, and
   * that placement was learned the hard way.
   *
   * This spec used to force a real outage by setting the workspace's AI settings to "enabled, no
   * API key". It restored `aiEnabled` afterwards and could not restore the key — the API masks it
   * on read, so the test had no way to put back what it had cleared. Every run therefore destroyed
   * a real credential and left that workspace's AI permanently down. A test that mutates
   * configuration it cannot restore is not a test, it is an outage on a timer.
   *
   * What is left here is what only an end-to-end test can answer: the route exists, is
   * SUPER_ADMIN-gated, and returns the shape the page renders. Everything about how an incident
   * opens, accumulates and closes is logic, and logic is tested where nothing real can be harmed.
   */
  test("the incident log is exposed in the shape the status page renders", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const page = await (await ctx.get("/api/maintenance/status-page?days=7", { headers })).json();
      expect(Array.isArray(page.incidents)).toBe(true);

      for (const incident of page.incidents) {
        expect(["OPERATIONAL", "DEGRADED", "DOWN"]).toContain(incident.status);
        expect(typeof incident.serviceLabel).toBe("string");
        // A duration is always computable — an ongoing incident measures to now rather than
        // reporting null, because "how long has this been broken" is the question being asked.
        expect(incident.durationMinutes).toBeGreaterThanOrEqual(1);
        expect(incident.sampleCount).toBeGreaterThanOrEqual(1);
      }

      // At most one OPEN incident per service, which the database now enforces with a unique
      // index. Before that constraint a single outage could be recorded twice by two overlapping
      // health runs, and the page showed the same failure as two separate rows.
      const openByService = page.incidents.filter((i: any) => !i.endedAt).map((i: any) => i.service);
      expect(new Set(openByService).size).toBe(openByService.length);
    });
  });

});

/**
 * The API performance panel on the Maintenance tab.
 *
 * WHAT IS WORTH ASSERTING HERE, and it is not "a chart appeared": the panel's whole reason for
 * existing is that an empty chart must never be ambiguous. Recording off and recording on with
 * nothing served look identical unless the page says which — and a monitoring page that cannot
 * tell "we measured nothing" from "nothing happened" is mistrusted the first week it is used.
 *
 * Recording is an environment variable read at boot (`API_TELEMETRY_ENABLED`), so the OFF state
 * cannot be produced by clicking anything. It is produced here by rewriting the overview response,
 * which is exactly the payload the panel branches on — the alternative is restarting the API
 * mid-suite, which would take the rest of the run with it.
 */
test.describe("API performance panel", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const openPanel = async (page: import("@playwright/test").Page) => {
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /maintenance/i }).click();
    await expect(page.getByRole("heading", { name: "API performance" })).toBeVisible({ timeout: 20_000 });
  };

  test("renders with recording on, and says so when it is off", async ({ page }) => {
    await signIn(page, "superadmin");

    const overview = page.waitForResponse(
      (res) => res.url().includes("/api/maintenance/api-performance?") && res.status() === 200
    );
    await openPanel(page);
    const collection = (await (await overview).json()).collection;
    expect(typeof collection.enabled, "the panel cannot explain an empty chart without this flag").toBe("boolean");

    if (collection.enabled) {
      // Recording is on in this environment, so the off-state banner must NOT be showing — the
      // wrong one of the two is worse than neither.
      await expect(page.getByText(/request recording is switched off/i)).toBeHidden();
      // The suite itself has been generating traffic for minutes, so there is real data: the tiles
      // and the four drill-down tabs are what the panel is for.
      await expect(page.getByText("p95 latency")).toBeVisible({ timeout: 20_000 });
      for (const tab of ["Latency & errors", "Endpoints", "Hosts & pods", "Request log"]) {
        await expect(page.getByRole("tab", { name: tab })).toBeVisible();
      }
      await page.getByRole("tab", { name: "Endpoints" }).click();
      await expect(page.getByRole("columnheader", { name: "Endpoint" })).toBeVisible({ timeout: 15_000 });
    }

    // Now the other branch, from the same page: the response is rewritten to a workspace whose
    // recorder is off and has never written a row.
    await page.route("**/api/maintenance/api-performance?*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          collection: { ...body.collection, enabled: false },
          totals: { ...body.totals, total: 0 }
        }
      });
    });
    await page.reload();
    await openPanel(page);

    await expect(page.getByText(/request recording is switched off/i)).toBeVisible({ timeout: 20_000 });
    // "never recorded", not "none in this window" — the distinction IS the feature.
    await expect(page.getByText(/no requests were ever recorded/i)).toBeVisible();
    await expect(page.getByText("API_TELEMETRY_ENABLED=true")).toBeVisible();
  });
});

/* ============ The scheduling pickers refuse a moment that has passed ============ */

/**
 * THE GAP: the calendar half of the window pickers refused earlier DAYS (`minValue`), and the
 * time half offered all forty-eight half-hour slots regardless. So on a day where it is already
 * 14:00 you could pick 09:00, read a form that looked entirely valid, press Save, and only then
 * be told "the window can't start in the past" — the server's rule was right and invisible until
 * after the mistake.
 *
 * NOTHING HERE SAVES ANYTHING. This spec drives the picker's popover only; the shared demo
 * workspace's maintenance settings are never written, which is what keeps it from locking out
 * every spec that runs after it (see this file's own header).
 */
test.describe("maintenance window pickers", () => {
  /** Local `HH:mm` of the most recent half-hour slot that has already passed today, or null when
   *  it is so early that none has. Derived from the clock rather than hardcoded, so the test does
   *  not depend on what time CI happens to run. */
  function lastPassedSlot(now: Date): string | null {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const slot = Math.floor(minutes / 30) * 30 - (minutes % 30 === 0 ? 30 : 0);
    if (slot < 0) return null;
    return `${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}`;
  }

  /** The picker labels slots in the browser's locale ("2:30 PM"), so the assertion has to speak
   *  the same language rather than compare `HH:mm` strings. */
  function slotLabel(page: Page, hhmm: string): Promise<string> {
    return page.evaluate((value) => {
      const [h, m] = value.split(":").map(Number);
      const at = new Date();
      at.setHours(h, m, 0, 0);
      return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }, hhmm);
  }

  test("greys out today's already-passed times, and says why", async ({ page }) => {
    const passed = lastPassedSlot(new Date());
    test.skip(!passed, "it is before 00:30 locally — no slot has passed yet today");

    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /maintenance/i }).click();
    await page.locator("#maintenance-start").click();

    const popover = page.getByRole("dialog").last();
    await expect(popover.getByText("Available times")).toBeVisible({ timeout: 10_000 });

    // The picker opens on the saved date, which may not be today — pick today explicitly, since
    // the floor only applies on the floor's own day.
    // `exact` matters: the grid's own cell for today is announced as "Today, Monday, August 17,
    // 2026, …", so a loose match is a strict-mode violation between it and the footer button.
    await popover.getByRole("button", { name: "Today", exact: true }).click();

    const label = await slotLabel(page, passed!);
    const blocked = popover.getByRole("button", { name: label, exact: true });
    await expect(blocked).toBeDisabled();
    // A run of greyed rows with no explanation is a puzzle, not a restriction.
    await expect(popover.getByText(/already passed/i)).toBeVisible();

    // The list must OPEN on something pickable. Without this the floor makes the picker worse
    // than it was: at 3pm it would open on 12:00 AM and the admin scrolls past thirty greyed rows
    // to reach anything live.
    const firstVisible = await popover.evaluate((root) => {
      const list = root.querySelector<HTMLElement>(".overflow-y-auto");
      if (!list) return null;
      const live = Array.from(list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))[0];
      if (!live) return null;
      const listBox = list.getBoundingClientRect();
      const liveBox = live.getBoundingClientRect();
      return { withinView: liveBox.top >= listBox.top - 2 && liveBox.top <= listBox.bottom, label: live.textContent };
    });
    expect(firstVisible?.withinView, `first selectable slot (${firstVisible?.label}) is scrolled out of view`).toBe(true);

    await page.keyboard.press("Escape");
  });

  test("still offers a future time on today, and any time on a later day", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /maintenance/i }).click();
    await page.locator("#maintenance-start").click();

    const popover = page.getByRole("dialog").last();
    await expect(popover.getByText("Available times")).toBeVisible({ timeout: 10_000 });
    // `exact` matters: the grid's own cell for today is announced as "Today, Monday, August 17,
    // 2026, …", so a loose match is a strict-mode violation between it and the footer button.
    await popover.getByRole("button", { name: "Today", exact: true }).click();

    // 23:30 is in the future on every day except the last half hour of it.
    const now = new Date();
    const lateEnough = now.getHours() < 23 || now.getMinutes() < 30;
    if (lateEnough) {
      await expect(popover.getByRole("button", { name: await slotLabel(page, "23:30"), exact: true })).toBeEnabled();
    }

    // The restriction is about "has this moment passed", not "is this early in the day" — so a
    // later date must re-enable everything, including 00:00.
    //
    // Day cells are announced with the FULL date ("Tuesday, August 18, 2026"), never the bare
    // number — see helpers/sign-in.ts#pickDate, which documents the same trap. `.first()` because
    // React Aria renders a visually-hidden duplicate grid for screen readers.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (tomorrow.getMonth() !== new Date().getMonth()) {
      await popover.getByRole("button", { name: "Next" }).first().click();
    }
    const dayLabel = tomorrow.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    await popover.getByRole("button", { name: dayLabel, exact: true }).first().click();

    await expect(popover.getByRole("button", { name: await slotLabel(page, "00:00"), exact: true })).toBeEnabled();
    await expect(popover.getByText(/already passed/i)).toHaveCount(0);

    await page.keyboard.press("Escape");
  });
});
