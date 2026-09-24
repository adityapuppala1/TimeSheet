import { test, expect } from "@playwright/test";
import { deleteTicket } from "./helpers/admin-request";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";
import { accessToken, signIn } from "./helpers/sign-in";

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

    const listUrl = new URL(page.url());
    await detailSheet.getByRole("button", { name: /close/i }).click();
    await expect(detailSheet).toBeHidden();
    expect(new URL(page.url()).searchParams.has("open")).toBe(false);
    expect(new URL(page.url()).pathname).toBe(listUrl.pathname);
    await page.goBack();
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

  test("ticket detail tabs stay reachable on a phone and attachment removal is permission-aware and confirmed", async ({ page }) => {
    await signIn(page, "superadmin");
    const headers = await accessToken(page);
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const created = await page.request.post("/api/tickets", {
      headers,
      data: { projectId: projects[0].id, title: `Detail tab UX ${Date.now()}`, type: "BUG", priority: "LOW" }
    });
    expect(created.status(), await created.text()).toBe(201);
    const ticket = await created.json();
    let attachmentId: string | undefined;

    try {
      const upload = await page.request.post(`/api/tickets/${ticket.id}/attachments`, {
        headers,
        multipart: { attachments: { name: `${"long-file-name-".repeat(12)}.txt`, mimeType: "text/plain", buffer: Buffer.from("safe fixture") } }
      });
      expect(upload.status(), await upload.text()).toBe(201);
      attachmentId = (await upload.json())[0].id;

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/app/tickets?open=${ticket.id}`);
      const sheet = page.getByRole("dialog").filter({ hasText: ticket.title });
      await expect(sheet.getByRole("heading", { name: ticket.title })).toBeVisible({ timeout: 15_000 });
      const tabs = sheet.getByRole("tablist").getByRole("tab");
      const count = await tabs.count();
      for (let index = 0; index < count; index++) {
        const tab = tabs.nth(index);
        await tab.scrollIntoViewIfNeeded();
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect.poll(() => tab.evaluate((node) => {
          const list = node.closest('[role="tablist"]')!;
          const item = node.getBoundingClientRect();
          const bounds = list.getBoundingClientRect();
          return item.left >= bounds.left - 1 && item.right <= bounds.right + 1;
        })).toBe(true);
      }

      await page.keyboard.press("Home");
      const commentsTab = sheet.getByRole("tab", { name: /Comments/ });
      await expect(commentsTab).toBeFocused();
      await page.keyboard.press("End");
      await expect(tabs.nth(count - 1)).toBeFocused();

      await sheet.getByRole("tab", { name: /Files/ }).click();
      const longFile = sheet.getByRole("link", { name: `${"long-file-name-".repeat(12)}.txt` });
      await expect(longFile).toBeVisible();
      expect(await longFile.evaluate((node) => getComputedStyle(node).overflowWrap)).toBe("anywhere");
      const remove = sheet.getByRole("button", { name: `Remove ${"long-file-name-".repeat(12)}.txt` });
      await remove.click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await expect(page.getByRole("alertdialog")).toContainText("will be removed from this ticket");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(longFile).toBeVisible();

      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => sheet.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    } finally {
      if (attachmentId) await page.request.delete(`/api/tickets/${ticket.id}/attachments/${attachmentId}`, { headers });
      await deleteTicket(ticket.id);
    }
  });
});
