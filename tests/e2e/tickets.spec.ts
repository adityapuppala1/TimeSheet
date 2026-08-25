import { test, expect } from "@playwright/test";
import { deleteTicket } from "./helpers/admin-request";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";
import { signIn } from "./helpers/sign-in";

/**
 * Signs in per test rather than replaying a stored snapshot. A snapshot holds one rotating refresh
 * cookie, so it survives about one session's use — which broke the moment this spec started
 * running in three browser projects. See helpers/sign-in.ts.
 */
test.use({ storageState: { cookies: [], origins: [] } });

// Creating a ticket and moving its status are both face-gated when the workspace enables
// verification — through the UI that means a camera dialog a headless browser can't satisfy.
// See helpers/face-gate.ts.
let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
});
test.afterAll(async () => {
  await faceGate?.restore();
});

test.describe("Tickets", () => {
  test("creates a ticket, changes its status, and adds a checklist item", async ({ page }) => {
    await signIn(page, "manager");
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
    //
    // The Add button is `disabled={!newLabel.trim() || add.isPending}` (pages/Tickets.tsx), so it
    // only becomes clickable once the controlled input's onChange has round-tripped through React
    // state. Playwright's click waits for "visible, enabled and stable" and then simply times out
    // if that update is late — which WebKit occasionally is, and which made this the flakiest test
    // in the suite: it failed on WebKit in CI and roughly one run in three locally, always here,
    // always with the button resolved but never enabled.
    //
    // Waiting for the button to be enabled is not weakening the test — an Add button that stays
    // disabled after you type IS a bug, so this assertion would catch it rather than hide it. It
    // just moves the wait to the condition that is actually being waited on.
    await page.getByRole("tab", { name: /checklist/i }).click();
    const subTask = page.getByPlaceholder(/add a sub-task/i);
    await subTask.fill("Verify the fix");
    const addSubTask = page.getByRole("button", { name: /^add$/i });
    await expect(addSubTask).toBeEnabled({ timeout: 10_000 });
    await addSubTask.click();
    await expect(page.getByText("Verify the fix")).toBeVisible();

    // Clean up so the demo dataset doesn't accumulate one ticket per run.
    //
    // NOT via this page's own session, which is the bug this replaced: DELETE /api/tickets/:id
    // requires `tickets:manage`, granted only to ADMIN and SUPER_ADMIN, while this spec runs as a
    // MANAGER on purpose. The old cleanup therefore 403'd on every single run, and since nothing
    // asserted the response the suite stayed green while 61 smoke-test tickets accumulated in the
    // demo workspace. See helpers/admin-request.ts.
    const ticketId = new URL(page.url()).searchParams.get("open");
    expect(ticketId, "the detail sheet should put the new ticket's id in the URL").toBeTruthy();
    await deleteTicket(ticketId!);
  });
});
