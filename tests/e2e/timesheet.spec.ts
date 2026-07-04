import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/employee.json" });

test.describe("Timesheet", () => {
  test("logs a draft entry", async ({ page }) => {
    const marker = `Playwright smoke test entry ${Date.now()}`;

    await page.goto("/app/timesheet");
    await page.getByLabel("Project", { exact: true }).click();
    await page.getByRole("option").first().click();
    await page.getByLabel("Module", { exact: true }).click();
    await page.getByRole("option").first().click();
    await page.getByLabel("Activity", { exact: true }).click();
    await page.getByRole("option").first().click();
    await page.getByLabel("Start", { exact: true }).fill("09:00");
    await page.getByLabel("End", { exact: true }).fill("10:00");
    await page.getByLabel("Task description", { exact: true }).fill(marker);

    await page.getByRole("button", { name: /save draft/i }).click();
    await expect(page.getByText(/saved|draft/i).first()).toBeVisible({ timeout: 10_000 });

    // Clean up: find and delete the entry this test just created so repeated runs don't
    // accumulate draft rows in the demo dataset. The access token lives in page memory only
    // (not localStorage) since the session-hardening pass, so `page.request` (which shares
    // the browser context's httpOnly refresh cookie) mints a fresh one via /auth/refresh.
    const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    const rows: Array<{ id: string; taskDescription: string }> = await (
      await page.request.get("/api/timesheets?status=DRAFT", { headers })
    ).json();
    const match = rows.find((r) => r.taskDescription?.includes(marker));
    if (match) await page.request.delete(`/api/timesheets/${match.id}`, { headers });
  });
});
