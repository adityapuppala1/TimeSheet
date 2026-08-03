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

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
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
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
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

    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
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
