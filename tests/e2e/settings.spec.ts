import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/superadmin-settings.json" });

test.describe("Workspace settings", () => {
  test("toggles weekdays-only reminders and it persists across reload", async ({ page }) => {
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /reminders/i }).click();

    const toggle = page.locator("#weekdays-only");
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    const before = await toggle.getAttribute("data-state");

    await toggle.click();
    await expect(toggle).not.toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });

    await page.reload();
    await page.getByRole("tab", { name: /reminders/i }).click();
    await expect(page.locator("#weekdays-only")).not.toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });

    // Restore original state so this test is idempotent across runs.
    await page.locator("#weekdays-only").click();
  });
});
