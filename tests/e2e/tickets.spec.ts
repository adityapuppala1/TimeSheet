import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/manager.json" });

test.describe("Tickets", () => {
  test("creates a ticket, changes its status, and adds a checklist item", async ({ page }) => {
    await page.goto("/app/tickets");
    await page.getByRole("button", { name: /new ticket/i }).click();

    const title = `Playwright smoke test ${Date.now()}`;
    // The create dialog's fields use plain (unassociated) <Label> elements, and Radix's
    // SelectTrigger doesn't expose its placeholder text as an accessible name the way its
    // visible text suggests — so scope to the open dialog and use structural position
    // (Project is always the first combobox) rather than getByLabel/name matching.
    const createDialog = page.getByRole("dialog", { name: /new ticket/i });
    await createDialog.getByRole("combobox").first().click();
    await page.getByRole("option").first().click();
    await createDialog.getByPlaceholder(/short, specific summary/i).fill(title);
    await createDialog.getByRole("button", { name: /^create ticket$/i }).click();

    // Ticket detail sheet opens automatically after creation.
    const detailSheet = page.getByRole("dialog").filter({ hasText: title });
    await expect(detailSheet.getByRole("heading", { name: title })).toBeVisible({ timeout: 10_000 });

    // Move it forward one legal status step (OPEN -> IN_PROGRESS). Status is the first
    // combobox in the detail sheet's Status/Assignee row.
    await detailSheet.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /in progress/i }).click();
    await expect(page.getByText(/status updated/i)).toBeVisible({ timeout: 10_000 });

    // Add a checklist item.
    await page.getByRole("tab", { name: /checklist/i }).click();
    await page.getByPlaceholder(/add a sub-task/i).fill("Verify the fix");
    await page.getByRole("button", { name: /^add$/i }).click();
    await expect(page.getByText("Verify the fix")).toBeVisible();

    // Clean up so the demo dataset doesn't accumulate one ticket per test run. The access
    // token lives in page memory only (not localStorage) since the session-hardening pass,
    // so `page.request` (which shares the browser context's httpOnly refresh cookie) mints
    // a fresh one via /auth/refresh instead of trying to read it out of storage.
    const ticketId = new URL(page.url()).searchParams.get("open");
    const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
    await page.request.delete(`/api/tickets/${ticketId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  });
});
