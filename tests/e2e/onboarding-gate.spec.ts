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
      const users: Array<{
        id: string;
        email: string;
        createdAt: string;
        onboardingCompletedAt: string | null;
      }> = await (await ctx.get("/api/users", { headers })).json();
      expect(users.length).toBeGreaterThan(0);

      // ASSERTED BEFORE USE. An earlier version of this test fetched `/api/users/:id` — a route
      // that does not exist — swallowed the 404, and compared `undefined === null`. It passed
      // while checking nothing at all, which is precisely the failure this test exists to catch.
      // If the field ever stops being serialised, this line fails instead of the test going quiet.
      expect(
        users[0],
        "the users list must expose onboardingCompletedAt for this test to mean anything"
      ).toHaveProperty("onboardingCompletedAt");
      expect(
        users[0],
        "the users list must expose createdAt for the pre-gate scoping below to mean anything"
      ).toHaveProperty("createdAt");

      // The backfill's promise covers accounts that EXISTED when the gate shipped — the migration
      // stamped every one of them, and a null on any of those means somebody who could use the
      // app yesterday cannot today. An account created AFTER the gate shipped is legitimately
      // un-onboarded until its owner first signs in; that is the gate doing its job, not a
      // lockout. The first version of this test asserted null-free across ALL accounts, which was
      // true on migration day and then failed the first time an admin added three real people —
      // so the assertion is scoped by the migration's own timestamp, which keeps it true forever
      // while still catching the only failure it exists to catch.
      const GATE_SHIPPED_AT = new Date("2026-08-02T17:19:43Z"); // 20260802171943_user_onboarding_completed_at
      const gated = users
        .filter((user) => new Date(user.createdAt) < GATE_SHIPPED_AT && user.onboardingCompletedAt === null)
        .map((user) => user.email);
      expect(gated, "these pre-gate users would be locked out — the backfill missed them").toEqual([]);
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
