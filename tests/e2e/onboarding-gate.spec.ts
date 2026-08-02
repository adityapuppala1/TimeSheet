/**
 * The first-run gate.
 *
 * THE MOST IMPORTANT TEST HERE IS THE NEGATIVE ONE. Adding a blocking gate to an app that never
 * had one is a change that can lock out an entire workforce, and the failure mode is silent from
 * the developer's side — everything looks fine locally because the developer's own account is
 * already set up. The `onboardingCompletedAt` backfill is what prevents that, and "no existing
 * user is gated" is the assertion that proves the backfill did its job.
 *
 * The positive path is exercised by driving the status endpoint directly rather than by creating
 * a throwaway user: user creation goes through seat limits, invitations and email, and a test that
 * fakes its way past those proves less about the gate than it costs to maintain.
 */
import { test, expect } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";

test.describe("first-run onboarding gate", () => {
  test("no existing user is blocked — the backfill did its job", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const users: Array<{ id: string; email: string; onboardingCompletedAt: string | null }> = await (
        await ctx.get("/api/users", { headers })
      ).json();
      expect(users.length).toBeGreaterThan(0);

      // ASSERTED BEFORE USE. An earlier version of this test fetched `/api/users/:id` — a route
      // that does not exist — swallowed the 404, and compared `undefined === null`. It passed
      // while checking nothing at all, which is precisely the failure this test exists to catch.
      // If the field ever stops being serialised, this line fails instead of the test going quiet.
      expect(
        users[0],
        "the users list must expose onboardingCompletedAt for this test to mean anything"
      ).toHaveProperty("onboardingCompletedAt");

      // Every existing account must report onboarded. A null here means the migration's backfill
      // missed someone, and that someone cannot use the app at all.
      const gated = users.filter((user) => user.onboardingCompletedAt === null).map((user) => user.email);
      expect(gated, "these existing users would be locked out by the gate").toEqual([]);
    });
  });

  test("the status endpoint reports an onboarded admin as unblocked", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const status = await (await ctx.get("/api/auth/onboarding-status", { headers })).json();
      expect(status.blocked).toBe(false);
      expect(status.completedAt).not.toBeNull();
      // The shape the client depends on, so a rename breaks here rather than in a blank overlay.
      expect(status.profile).toHaveProperty("complete");
      expect(status.face).toHaveProperty("required");
    });
  });

  test("an ordinary signed-in user sees no gate overlay", async ({ page }) => {
    // Signs in for itself rather than borrowing `.auth/employee.json`, and that is not incidental:
    // this spec sorts BEFORE timesheet.spec, which owns that snapshot. Loading /app here rotates
    // the snapshot's refresh secret, so timesheet.spec then presented a stale one, got its session
    // revoked, and failed on the login page — a failure that looks nothing like its cause.
    // Signing in is free against the limiter, which skips successful logins.
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The gate renders as an alertdialog. Its absence for a set-up user is the whole point.
    await expect(page.getByRole("alertdialog", { name: /finish setting up your account/i })).toBeHidden();
  });
});
