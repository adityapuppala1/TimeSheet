import { test, expect } from "@playwright/test";
import { accessToken } from "./helpers/sign-in";

test.describe("Authentication", () => {
  test("rejects an invalid password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password-123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(/sign-in failed/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("logs in, sees the dashboard, and logs out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });

    // Sign out via the API directly (same call the Topbar's account menu makes) — this
    // revokes the session server-side and clears the httpOnly refresh cookie, so a reload
    // afterward has no valid credential left to restore a session from. /logout requires
    // an access token, so mint one first the same way the app's own refresh flow would.
    await page.request.post("/api/auth/logout", { headers: await accessToken(page) });
    await page.reload();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  /*
   * The reported bug, pinned where it lives.
   *
   * With a live session, /login used to render the form and accept the password again — the only
   * way out was to sign out first. Every guard in the app pointed one way, into protected routes,
   * and the public sign-in pages had none at all.
   *
   * Worth an e2e test rather than only the unit tests on `safeReturnTo`: what broke was ROUTING,
   * and routing is only real in a browser holding a real cookie. The regression this catches also
   * has a second edge — the guard must wait for session hydration, or it shows the form for a beat
   * to somebody who is signed in, which is the same bug just briefer.
   */
  test("a signed-in visitor is not asked to sign in again", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });

    await page.goto("/login");
    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });
    await expect(page.getByLabel("Email", { exact: true })).toBeHidden();

    // The other public auth pages inherit the same guard.
    for (const path of ["/signup", "/find-workspace", "/forgot-password"]) {
      await page.goto(path);
      await expect(page, `${path} should redirect a signed-in visitor`).toHaveURL(/\/app/, { timeout: 10_000 });
    }

    // …and the escape hatch still works, or somebody signing in as a colleague on a shared machine
    // is trapped. This is what `helpers/sign-in.ts` relies on.
    await page.goto("/login?switch=1");
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("a deep link survives the round trip through sign-in", async ({ page }) => {
    // The destination was known at the moment of the redirect and used to be thrown away, so
    // following a link to a filtered view and signing in landed you on the dashboard instead.
    await page.goto("/app/tickets?status=open");
    await expect(page).toHaveURL(/\/login\?next=/, { timeout: 10_000 });

    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page).toHaveURL(/\/app\/tickets\?status=open/, { timeout: 10_000 });
  });

  test("a cross-origin `next` is refused after sign-in", async ({ page }) => {
    // `next` is attacker-controllable and is consumed at the exact moment somebody has proven they
    // trust the site — the classic post-login phishing pivot. `safeReturnTo` has unit tests over
    // every bypass; this asserts the guard is actually WIRED to the navigation.
    await page.goto(`/login?next=${encodeURIComponent("https://example.com/harvest")}`);
    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });
    expect(new URL(page.url()).hostname).not.toBe("example.com");
  });
});
