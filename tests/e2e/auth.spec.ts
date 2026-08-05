import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("rejects an invalid password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/sign-in failed/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("logs in, sees the dashboard, and logs out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });

    // Sign out via the API directly (same call the Topbar's account menu makes) — this
    // revokes the session server-side and clears the httpOnly refresh cookie, so a reload
    // afterward has no valid credential left to restore a session from. /logout requires
    // an access token, so mint one first the same way the app's own refresh flow would.
    const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
    await page.request.post("/api/auth/logout", { headers: { Authorization: `Bearer ${accessToken}` } });
    await page.reload();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
