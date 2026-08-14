/**
 * The approvals queue as an approver actually drives it.
 *
 * WHY THIS FILE EXISTS: the queue used to be one unfiltered table of everything SUBMITTED, and the
 * overhaul added the parts that are easy to ship broken and impossible to notice — a status filter
 * that DEFAULTS to the queue (so a page that silently opened on "all statuses" would look fine and
 * be wrong), project/activity/date-range narrowing, a per-entry export, and a detail dialog that is
 * a phone's ONLY view of an entry because the table collapses to cards below `sm`.
 *
 * Nothing here approves or rejects anything. Those are one-way state changes against the shared
 * demo workspace, and the decision path is already covered server-side; what is untested is the
 * screen an approver reads BEFORE deciding, which is what this pins.
 */
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers/sign-in";
import { withAdminRequest } from "./helpers/admin-request";

/** Signs in per test — a stored snapshot holds one rotating refresh cookie and survives about one
 *  session's use. See helpers/sign-in.ts. */
test.use({ storageState: { cookies: [], origins: [] } });

/** The DataTable footer, which is the only place the FILTERED total is stated out loud. Asserting
 *  against it rather than counting rows is what makes these tests independent of the 20-row page
 *  size — a filter that narrows from 41 to 22 does not change how many rows are on screen. */
async function shownTotal(page: Page): Promise<number> {
  const footer = page.getByText(/^Showing \d+-\d+ of \d+$/);
  await expect(footer).toBeVisible({ timeout: 15_000 });
  return Number(/of (\d+)$/.exec((await footer.textContent()) ?? "")?.[1]);
}

/** Status counts straight from the list route the page renders from, so the expectations below are
 *  derived from the same data rather than hardcoded against whatever the demo database holds. */
async function statusCounts(): Promise<Record<string, number>> {
  return withAdminRequest(async (ctx, headers) => {
    const rows: Array<{ status: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
    expect(Array.isArray(rows), "the approvals list route must return an array").toBe(true);
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
  });
}

async function openApprovals(page: Page): Promise<void> {
  await signIn(page, "superadmin");
  await page.goto("/app/approvals");
  await expect(page.getByRole("heading", { name: /timesheet approvals/i })).toBeVisible({ timeout: 15_000 });
}

test.describe("approvals queue", () => {
  test("opens on what is awaiting a decision, and the status filter widens it", async ({ page }) => {
    const counts = await statusCounts();
    test.skip(!counts.SUBMITTED, "no submitted entries in the demo data to queue");

    await openApprovals(page);

    // The default is the product decision worth pinning: the page opens on the QUEUE. Opening on
    // "all statuses" would look identical at a glance and quietly show an approver 41 rows of
    // already-decided work as if it needed them.
    await expect(page.locator("#approval-status")).toHaveText(/awaiting decision/i);
    expect(await shownTotal(page)).toBe(counts.SUBMITTED);

    // Nothing decided may leak into the queue. Scoped to the desktop table so the phone card list
    // (rendered from the same rows, hidden at this width) cannot double-count.
    const table = page.locator("table");
    for (const decided of ["APPROVED", "REJECTED", "DRAFT"]) {
      await expect(table.getByText(decided, { exact: true })).toHaveCount(0);
    }
    // And the decision buttons only exist on rows that are still awaiting one.
    await expect(page.getByRole("button", { name: "Approve" }).first()).toBeVisible();

    await page.locator("#approval-status").click();
    await page.getByRole("option", { name: "Approved" }).click();
    expect(await shownTotal(page)).toBe(counts.APPROVED ?? 0);
    // An already-approved row must not offer Approve — the API refuses anything but SUBMITTED, so
    // the button could only ever fail.
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

    await page.locator("#approval-status").click();
    await page.getByRole("option", { name: "All statuses" }).click();
    expect(await shownTotal(page)).toBe(Object.values(counts).reduce((a, b) => a + b, 0));
  });

  test("a date range that matches nothing empties the queue, and Reset restores it", async ({ page }) => {
    const counts = await statusCounts();
    test.skip(!counts.SUBMITTED, "no submitted entries in the demo data to queue");

    await openApprovals(page);
    const reset = page.getByRole("button", { name: /reset/i });
    // Disabled while nothing is filtered: the control has to report whether there is anything to
    // undo, or an approver cannot tell a filtered queue from an empty one.
    await expect(reset).toBeDisabled();
    expect(await shownTotal(page)).toBe(counts.SUBMITTED);

    // "Last year" rather than a future date: the seeded work is all in the current year, so the
    // previous one is genuinely empty — a real range that really matches nothing.
    await page.locator("#approval-range").click();
    const rangeDialog = page.getByRole("dialog");
    await expect(rangeDialog).toBeVisible({ timeout: 10_000 });
    await rangeDialog.getByRole("button", { name: "Last year", exact: true }).click();
    await rangeDialog.getByRole("button", { name: "Apply" }).click();

    // The empty state must say the filters did it. "Nothing pending — you're all caught up" in
    // front of a filtered-out queue is the message that gets a workspace to stop trusting the page.
    // Scoped to the desktop table because DataTable renders the same message twice — once here and
    // once in the `sm:hidden` card list — and a bare text lookup resolves to the hidden one first.
    await expect(page.locator("table").getByText(/no entries match the current filters/i)).toBeVisible({
      timeout: 15_000
    });

    await expect(reset).toBeEnabled();
    await reset.click();
    expect(await shownTotal(page)).toBe(counts.SUBMITTED);
    await expect(page.locator("#approval-status")).toHaveText(/awaiting decision/i);
  });

  test("an approver can export one entry's full detail", async ({ page }) => {
    const counts = await statusCounts();
    test.skip(!counts.SUBMITTED, "no submitted entries in the demo data to export");

    await openApprovals(page);
    await shownTotal(page);

    // The per-row download moved into the entry dialog when the table shed the columns that
    // forced side-scrolling — so the export now starts by opening the entry.
    await page.locator('button[title="Open the full entry"]').filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog");
    // Wait for the detail fetch to land before clicking: the footer renders immediately but its
    // Download handler no-ops until `detail` exists.
    await expect(dialog.getByText("Task", { exact: true })).toBeVisible({ timeout: 10_000 });

    // The route needs a bearer token, so this is an authenticated fetch turned into a blob and
    // clicked — a bare <a href> would download an unauthenticated error page with a .csv name.
    // Waiting on the download EVENT is what distinguishes the two.
    const download = page.waitForEvent("download", { timeout: 15_000 });
    await dialog.getByRole("button", { name: "Download", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^timesheet-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv$/);

    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    // A UTF-8 BOM so Excel does not mangle accented names, then the same header the workspace-wide
    // export uses — the sharing is deliberate, so a drift here means one of the two moved.
    expect(body.subarray(0, 3).toString("hex")).toBe("efbbbf");
    const text = body.toString("utf8").replace(/^﻿/, "");
    // Every field quoted, including the header — that is what keeps a project name containing a
    // comma from shifting every column after it.
    expect(text.split("\n")[0]).toBe(
      [
        "User", "Email", "Date", "Project", "Project code", "Module", "Submodule", "Ticket",
        "Activity", "Start", "End", "Hours", "Billable", "Rate", "Amount", "Status",
        "Reviewed by", "Reviewed at", "Approval deadline", "SLA breached at", "Task", "Notes",
        "Submitted at", "Last updated"
      ]
        .map((column) => `"${column}"`)
        .join(",")
    );
    // Row content, not just a header: an empty export with the right columns is the failure this
    // catches. Not a line count — Task and Notes are quoted CSV fields that may contain newlines.
    expect(text.length).toBeGreaterThan(text.split("\n")[0].length + 1);
  });

  test("the entry detail dialog opens from the table and from a phone card", async ({ page }) => {
    const counts = await statusCounts();
    test.skip(!counts.SUBMITTED, "no submitted entries in the demo data to open");

    await openApprovals(page);
    await shownTotal(page);

    // Located by `title`, not by accessible name: the button's name is the employee's, and the
    // title is the only stable handle on "the control that opens the entry". Filtered to the
    // VISIBLE one because DataTable renders both layouts at every width and hides one with CSS —
    // so at desktop `.first()` is the phone card's button, which cannot be clicked.
    const openFirstEntry = async () => {
      await page.locator('button[title="Open the full entry"]').filter({ visible: true }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      // Eleven table columns collapsed into one readable pane — the fields that make the entry
      // judgeable, not just a title. This is the SHARED `TimesheetEntryDialog` now (History and
      // the dashboard's day timeline open the same one), so the labels are its: "Logged by" and
      // "Attachments" are the two the old approvals-only dialog never had, and they are the two
      // that were actually missing — who stands behind the entry, and the evidence for it.
      // Status moved into the title as a badge beside the name.
      for (const label of ["Logged by", "Project", "Activity", "When", "Task", "Attachments", "Identity"]) {
        await expect(dialog.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(dialog.getByRole("button", { name: "Download" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 10_000 });
    };

    await openFirstEntry();

    // Below `sm` the DataTable swaps the table for a card list, and this dialog becomes the ONLY
    // way to see the full entry. A door that exists on desktop and not on a phone is the failure
    // mode worth a second pass at a second width rather than trusting one.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("table")).toBeHidden();
    await openFirstEntry();
  });
});
