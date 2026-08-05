/**
 * User-management login visibility + per-user force-logout.
 *
 * WHY THE FORCE-LOGOUT TEST USES A THROWAWAY USER: revoking sessions of ANY seeded account
 * (employee/manager/superadmin) would kill the `.auth/*` storageState snapshots other specs
 * depend on — the same one-owner-per-snapshot trap maintenance.spec.ts documents. So this spec
 * creates its own drill account, proves the whole revocation chain on it (login → 200 → admin
 * force-logout → same token 401s), and soft-deletes it with an ASSERTED cleanup. The sweep at
 * the start makes the spec self-healing when a previous run died before its teardown.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { expectCleanupOk, withAdminRequest } from "./helpers/admin-request";

import { E2E_BASE_URL as BASE_URL } from "./helpers/base-url";
/** Per-run unique: cleanup soft-deletes (the app has no hard delete, on purpose), and a
 *  soft-deleted row KEEPS its unique email while being invisible to every list — so a fixed
 *  address collides with its own ghost on the second run. Learned the hard way: this spec
 *  passed standalone and failed in the full suite for exactly that reason. */
const DRILL_EMAIL_PREFIX = "e2e-logout-drill-";
const DRILL_EMAIL = `${DRILL_EMAIL_PREFIX}${Date.now()}@timesheet.local`;
const DRILL_PASSWORD = "Admin@12345";

/** Soft-deletes any still-ACTIVE drill user a crashed earlier run left behind (matched by
 *  prefix, since each run's address is unique). Already-soft-deleted ghosts are invisible,
 *  seat-free, and need no sweeping. */
async function sweepDrillUser(): Promise<void> {
  await withAdminRequest(async (ctx, headers) => {
    const users: Array<{ id: string; email: string }> = await (await ctx.get("/api/users", { headers })).json();
    for (const stale of users.filter((user) => user.email.startsWith(DRILL_EMAIL_PREFIX))) {
      const res = await ctx.delete(`/api/users/${stale.id}`, { headers });
      expectCleanupOk(res.status(), `stale drill user ${stale.id}`);
    }
  });
}

test.describe("user management — login activity & force-logout", () => {
  test("the users list reports live presence and first/last login times", async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
    try {
      // A fresh employee login + one authenticated call makes them ONLINE by the 15-min
      // lastSeenAt definition, and (since the column shipped) stamps firstLoginAt.
      const login = await ctx.post("/api/auth/login", {
        data: { email: "employee@timesheet.local", password: "Admin@12345" }
      });
      expect(login.ok()).toBe(true);
      const employeeHeaders = { Authorization: `Bearer ${(await login.json()).accessToken}` };
      expect((await ctx.get("/api/auth/me", { headers: employeeHeaders })).status()).toBe(200);

      await withAdminRequest(async (adminCtx, headers) => {
        const users: Array<{
          email: string;
          online: boolean;
          lastSeenAt: string | null;
          firstLoginAt: string | null;
          lastLoginAt: string | null;
        }> = await (await adminCtx.get("/api/users", { headers })).json();

        // Shape asserted before use — a silently-dropped field must fail here, not render "—"
        // forever while the test stays green.
        expect(users[0]).toHaveProperty("online");
        expect(users[0]).toHaveProperty("firstLoginAt");
        expect(users[0]).toHaveProperty("lastLoginAt");

        const employee = users.find((user) => user.email === "employee@timesheet.local")!;
        expect(employee.online).toBe(true);
        expect(employee.lastSeenAt).not.toBeNull();
        expect(employee.firstLoginAt).not.toBeNull();
        expect(employee.lastLoginAt).not.toBeNull();
        // firstLoginAt is a high-water mark: never later than the latest login.
        expect(new Date(employee.firstLoginAt!) <= new Date(employee.lastLoginAt!)).toBe(true);
      });

      // The endpoint is admin surface: an EMPLOYEE (no users:manage) must be refused.
      const forbidden = await ctx.post("/api/users/some-id/force-logout", { headers: employeeHeaders });
      expect(forbidden.status()).toBe(403);
    } finally {
      await ctx.dispose();
    }
  });

  test("force-logout revokes every session of one user, and their open tab is told within a heartbeat", async ({ page }) => {
    await sweepDrillUser();

    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
    let drillUserId: string | null = null;
    try {
      // Create the throwaway account (welcome-email delivery failing is fine — SMTP isn't
      // guaranteed in the e2e stack, and the account itself is created either way).
      await withAdminRequest(async (adminCtx, headers) => {
        const created = await adminCtx.post("/api/users", {
          headers,
          data: { name: "Logout Drill", email: DRILL_EMAIL, role: "EMPLOYEE", password: DRILL_PASSWORD }
        });
        expect(created.ok(), `drill-user creation returned ${created.status()}`).toBe(true);
        drillUserId = (await created.json()).id;
      });

      // One API session (proves raw token revocation) …
      const login = await ctx.post("/api/auth/login", { data: { email: DRILL_EMAIL, password: DRILL_PASSWORD } });
      expect(login.ok()).toBe(true);
      const drillHeaders = { Authorization: `Bearer ${(await login.json()).accessToken}` };
      expect((await ctx.get("/api/auth/me", { headers: drillHeaders })).status()).toBe(200);

      // … and one real BROWSER session — proving the open tab is TOLD it was signed out, not
      // left as a zombie UI that only admits it on the next hard refresh.
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(DRILL_EMAIL);
      await page.getByLabel("Password", { exact: true }).fill(DRILL_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

      await withAdminRequest(async (adminCtx, headers) => {
        const res = await adminCtx.post(`/api/users/${drillUserId}/force-logout`, { headers });
        expect(res.ok()).toBe(true);
        // The API session + the browser session, at minimum.
        expect((await res.json()).revokedSessions).toBeGreaterThanOrEqual(2);
      });

      // The revoked token dies on its next use — the whole point of server-side revocation.
      expect((await ctx.get("/api/auth/me", { headers: drillHeaders })).status()).toBe(401);

      // THE HEADLINE ASSERTION: with zero interaction from the person, the 15s session
      // heartbeat discovers the revocation and the tab shows the "signed out" dialog. 25s
      // timeout = one heartbeat interval plus comfortable slack.
      const dialog = page.getByRole("alertdialog", { name: /you've been signed out/i });
      await expect(dialog).toBeVisible({ timeout: 25_000 });
      await dialog.getByRole("button", { name: /go to sign in/i }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    } finally {
      if (drillUserId) {
        await withAdminRequest(async (adminCtx, headers) => {
          const res = await adminCtx.delete(`/api/users/${drillUserId}`, { headers });
          expectCleanupOk(res.status(), `drill user ${drillUserId}`);
        });
      }
      await ctx.dispose();
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Filtering, pagination and bulk actions.
 *
 * The assertions that matter here are the SAFETY ones, not the happy path. A bulk endpoint that
 * applies an action to a list of ids is trivial; the parts worth pinning are the ones that stop it
 * doing something irreversible to the wrong people — that it re-derives a filter-based selection
 * server-side, that it refuses to act on your own account, and that it reports who it skipped
 * rather than failing the whole batch.
 * ------------------------------------------------------------------------------------------- */
const BULK_PREFIX = "e2e-bulk-";

test.describe("user management — filtering and bulk actions", () => {
  test("paged listing filters by role, status and free text, and reports a real total", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const first = await (await ctx.get("/api/users/paged?pageSize=5", { headers })).json();
      expect(Array.isArray(first.items)).toBe(true);
      expect(first.items.length).toBeLessThanOrEqual(5);
      // `total` counts everything matching, not what fitted on the page — the number the pager
      // and "select all N matching" both depend on.
      expect(first.total).toBeGreaterThanOrEqual(first.items.length);
      expect(Array.isArray(first.designations)).toBe(true);

      const roles = await (await ctx.get("/api/users/roles", { headers })).json();
      const employee = roles.find((r: any) => r.name === "EMPLOYEE");
      const byRole = await (await ctx.get(`/api/users/paged?roleId=${employee.id}&pageSize=100`, { headers })).json();
      for (const u of byRole.items) expect(u.role.name).toBe("EMPLOYEE");

      const inactive = await (await ctx.get("/api/users/paged?status=INACTIVE&pageSize=100", { headers })).json();
      for (const u of inactive.items) expect(u.status).toBe("INACTIVE");

      // Searching by ROLE NAME, which is a plain `contains` on every other field but cannot be on
      // this one — Role.name is an enum, so the server matches the known values instead.
      const byRoleWord = await (await ctx.get("/api/users/paged?search=manager&pageSize=100", { headers })).json();
      expect(byRoleWord.items.length).toBeGreaterThan(0);
    });
  });

  test("pagination walks the whole set without repeating or dropping anybody", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const all = await (await ctx.get("/api/users/paged?pageSize=200", { headers })).json();
      test.skip(all.total < 3, "needs at least 3 users to page through");

      const seen = new Set<string>();
      const pageSize = 2;
      const pages = Math.ceil(all.total / pageSize);
      for (let page = 1; page <= pages; page += 1) {
        const res = await (await ctx.get(`/api/users/paged?pageSize=${pageSize}&page=${page}`, { headers })).json();
        for (const u of res.items) {
          // A stable sort is the whole point: an unordered paged query silently shows the same
          // person twice and never shows somebody else at all.
          expect(seen.has(u.id), `${u.name} appeared on two pages`).toBe(false);
          seen.add(u.id);
        }
      }
      expect(seen.size).toBe(all.total);
    });
  });

  test("a bulk action refuses your own account and reports what it skipped", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const me = await (await ctx.get("/api/auth/me", { headers })).json();
      const res = await ctx.post("/api/users/bulk-action", {
        headers,
        data: { action: "DEACTIVATE", userIds: [me.id] }
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      // Not an error — a refusal, named. Locking yourself out mid-bulk is unrecoverable without a
      // second admin, so there is no version of it the operator meant.
      expect(body.applied).toBe(0);
      expect(body.skipped[0].reason).toMatch(/your own account/i);

      const stillActive = await (await ctx.get("/api/auth/me", { headers })).json();
      expect(stillActive.id).toBe(me.id);
    });
  });

  test("bulk deactivate ends sessions, and bulk-by-filter re-derives the set on the server", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const stamp = Date.now();
      const made: string[] = [];
      try {
        for (const n of [1, 2]) {
          const res = await ctx.post("/api/users", {
            headers,
            data: {
              name: `Bulk Probe ${n} ${stamp}`,
              email: `${BULK_PREFIX}${n}-${stamp}@timesheet.local`,
              role: "EMPLOYEE",
              password: "Admin@12345",
              designation: `E2E Bulk ${stamp}`
            }
          });
          expect(res.status(), await res.text()).toBe(201);
          made.push((await res.json()).id);
        }

        // Filter-based selection: no ids are sent at all. The server re-runs the same query the
        // table used, which is the only way "everything matching" cannot disagree between the two.
        const res = await ctx.post("/api/users/bulk-action", {
          headers,
          data: { action: "DEACTIVATE", filter: { designation: `E2E Bulk ${stamp}` } }
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(body.applied).toBe(2);

        const after = await (
          await ctx.get(`/api/users/paged?designation=${encodeURIComponent(`E2E Bulk ${stamp}`)}&pageSize=100`, { headers })
        ).json();
        expect(after.items).toHaveLength(2);
        // Deactivating without ending sessions would leave them working until their token expired,
        // which is not what the word means to whoever clicked it.
        for (const u of after.items) expect(u.status).toBe("INACTIVE");

        const reactivated = await ctx.post("/api/users/bulk-action", {
          headers,
          data: { action: "ACTIVATE", userIds: made }
        });
        expect((await reactivated.json()).applied).toBe(2);
      } finally {
        for (const id of made) {
          const res = await ctx.delete(`/api/users/${id}`, { headers });
          expectCleanupOk(res.status(), `bulk probe ${id}`);
        }
      }
    });
  });

  test("the users page filters, selects and offers the whole matching set", async ({ page }) => {
    // Signs in for THIS test rather than replaying a shared snapshot — refresh tokens rotate on
    // every /app load, so a multi-test spec exhausts one snapshot and later tests land on /login.
    // Documented at length in auth.setup.ts.
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

    await page.goto("/app/users");
    await expect(page.getByRole("heading", { name: /user management/i })).toBeVisible({ timeout: 15_000 });

    const search = page.getByLabel("Search users");
    await expect(search).toBeVisible();
    await search.fill("zzz-definitely-nobody");
    // The empty state is rendered twice by the shared table component — once as a table cell and
    // once for the card layout it switches to at narrow widths, with CSS hiding whichever does not
    // apply. This spec runs at desktop width, so the cell is the one on screen; matching by text
    // alone picks the hidden copy and waits forever.
    const emptyState = page.getByRole("cell", { name: /nobody matches these filters/i });
    await expect(emptyState).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^clear$/i }).click();
    await expect(emptyState).toBeHidden({ timeout: 15_000 });

    // Selecting the page reveals the bulk bar; the actions live behind a confirm, so nothing is
    // applied by this test.
    await page.getByLabel("Select everyone on this page").check();
    await expect(page.getByText(/\d+ selected/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^delete$/i })).toBeVisible();
  });
});
