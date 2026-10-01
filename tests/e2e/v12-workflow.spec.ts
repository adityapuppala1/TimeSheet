/**
 * V12 workflow smoke (Phase 4.4): the ClickUp-inspired flow END TO END, through the seams between
 * units — the draft pre-fill → the create route → the list's group → the status pill → the ticket
 * sheet → the calendar → the workload board. Each unit was verified alone when it shipped; this is
 * the one spec that would catch a regression in the contract between two of them.
 *
 * Fixtures: its own sprint and ticket, created through the API and removed in `afterAll`, so the
 * spec is idempotent against the shared dev database. Skips honestly when a feature is off.
 */
import { expect, test, type Page } from "@playwright/test";
import { deleteTicket, demoProject, withAdminRequest } from "./helpers/admin-request";

let PROJECT = ""; // HICS Operations Platform in the seed, resolved by code in beforeAll
const SPRINT_NAME = "V12 smoke sprint";
const MARKER = `V12 smoke ${Date.now()}`;

let sprintId: string | null = null;
let ticketId: string | null = null;
let assigneeId: string | null = null;
let sprintsOn = false;
let planningOn = false;
let resourcesOn = false;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withAdminRequest(async (ctx, headers) => {
    PROJECT = (await demoProject(ctx, headers)).id;
    const settings = await (await ctx.get("/api/planning/settings", { headers })).json();
    sprintsOn = Boolean(settings.effective?.sprints);
    planningOn = Boolean(settings.effective?.planning);
    resourcesOn = Boolean(settings.effective?.resourceManagement);
    if (!sprintsOn) return;
    const existing = (await (await ctx.get(`/api/sprints?projectId=${PROJECT}`, { headers })).json()) as Array<{ id: string; name: string }>;
    const found = existing.find((s) => s.name === SPRINT_NAME);
    if (found) sprintId = found.id;
    else {
      const created = await ctx.post("/api/sprints", { headers, data: { projectId: PROJECT, name: SPRINT_NAME, startDate: "2026-09-14", endDate: "2026-09-27" } });
      sprintId = (await created.json()).id;
    }
    const members = (await (await ctx.get(`/api/projects/${PROJECT}/assignments`, { headers })).json()) as Array<{ userId: string }>;
    assigneeId = members[0]?.userId ?? null;
  });
});

test.afterAll(async () => {
  if (ticketId) await deleteTicket(ticketId);
  if (sprintId) {
    await withAdminRequest(async (ctx, headers) => {
      await ctx.delete(`/api/sprints/${sprintId}`, { headers });
    });
  }
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
  await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
}

async function pick(page: Page, triggerId: string, optionName: string) {
  const trigger = page.locator(`#${triggerId}`);
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
  await expect(trigger).toHaveText(new RegExp(optionName));
}

test("1. a ticket created from the sprint group lands in the sprint", async ({ page }) => {
  test.skip(!sprintsOn, "sprints are off for this workspace");
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  await page.goto(`/app/tickets?project=${PROJECT}`);
  await pick(page, "ticket-filter-sprint", SPRINT_NAME);
  await pick(page, "ticket-group-by", "Sprint");
  // The sprint may have no tickets yet, so there may be no group; the header's New ticket honours
  // the filter just the same (3.17). Prefer the group's row when it exists.
  const addRow = page.getByRole("button", { name: "Add ticket", exact: true }).locator(":visible").first();
  if (await addRow.count()) await addRow.click();
  else await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await expect(dialog.locator("#create-ticket-sprint")).toHaveText(new RegExp(SPRINT_NAME), { timeout: 10_000 });
  await dialog.getByPlaceholder("Short, specific summary").fill(MARKER);
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await withAdminRequest(async (ctx, headers) => {
    const rows = (await (await ctx.get(`/api/tickets?projectId=${PROJECT}&sprintId=${sprintId}`, { headers })).json()) as Array<{ id: string; title: string; sprint?: { id: string } | null }>;
    const created = rows.find((r) => r.title === MARKER);
    expect(created, "the new ticket is listed under the sprint").toBeTruthy();
    expect(created?.sprint?.id).toBe(sprintId);
    ticketId = created!.id;
    // Schedule it and give it an assignee and points for the later steps.
    await ctx.patch(`/api/plan/items/${ticketId}`, { headers, data: { startDate: "2026-09-08", endDate: "2026-09-09" } });
    if (assigneeId) await ctx.patch(`/api/tickets/${ticketId}/assign`, { headers, data: { assigneeId } });
    await ctx.patch(`/api/tickets/${ticketId}`, { headers, data: { storyPoints: 2 } });
  });
});

test("2. its status changes from the list's pill and the server agrees", async ({ page }) => {
  test.skip(!ticketId, "no ticket from step 1");
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  await page.goto(`/app/tickets?project=${PROJECT}`);
  await page.getByPlaceholder("Search these results...").fill(MARKER);
  const row = page.locator("tbody tr").filter({ hasText: MARKER }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-status-pill]").first().click();
  await page.getByRole("menuitem", { name: /IN PROGRESS/ }).click();
  await expect(row.locator("[data-status-pill]")).toContainText(/IN PROGRESS/, { timeout: 15_000 });
  await withAdminRequest(async (ctx, headers) => {
    const t = await (await ctx.get(`/api/tickets/${ticketId}`, { headers })).json();
    expect(t.status).toBe("IN_PROGRESS");
  });
});

test("3. the sheet splits when maximized and its activity column can be hidden", async ({ page }) => {
  test.skip(!ticketId, "no ticket from step 1");
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  await page.goto(`/app/tickets?open=${ticketId}`);
  const sheet = page.locator("[data-sheet-layout]");
  await expect(sheet).toHaveAttribute("data-sheet-layout", "stacked", { timeout: 20_000 });
  await page.getByRole("button", { name: "Maximize panel to full width" }).click();
  await expect(sheet).toHaveAttribute("data-sheet-layout", "split");
  await page.locator("[data-activity-toggle]").click();
  await expect(sheet).toHaveAttribute("data-sheet-layout", "focus");
  await page.locator("[data-activity-toggle]").click();
  await expect(sheet).toHaveAttribute("data-sheet-layout", "split");
  // Sprint and points from step 1 are visible in the sheet.
  await expect(page.getByRole("combobox").filter({ hasText: SPRINT_NAME })).toBeVisible();
});

test("4. the calendar reschedules it by drag and the server stores the new dates", async ({ page }) => {
  test.skip(!ticketId || !planningOn, "no ticket, or planning is off");
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  await page.goto(`/app/tickets?project=${PROJECT}`);
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.locator("[data-calendar-period]")).toBeVisible({ timeout: 20_000 });
  // Step back to September 2026 by the month's KEY, waiting for each click to land before looking
  // again. Checking for the day straight after the click raced the re-render, so from any month but
  // September the loop ran straight past it and stopped a year early, in October 2025.
  const shownMonth = page.locator("[data-calendar-month]");
  for (let i = 0; i < 36 && (await shownMonth.getAttribute("data-calendar-month")) !== "2026-09"; i++) {
    const before = (await shownMonth.getAttribute("data-calendar-month")) ?? "";
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(shownMonth).not.toHaveAttribute("data-calendar-month", before);
  }
  await expect(shownMonth).toHaveAttribute("data-calendar-month", "2026-09");
  const chip = page.locator(`[data-calendar-day='2026-09-08'] [data-calendar-chip='${ticketId}']`);
  await expect(chip).toBeVisible({ timeout: 15_000 });
  const target = page.locator("[data-calendar-day='2026-09-15']");
  // Dispatched HTML5 drag events with a real DataTransfer (Playwright's mouse emulation raises none here).
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await chip.dispatchEvent("dragstart", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.locator(`[data-calendar-day='2026-09-15'] [data-calendar-chip='${ticketId}']`)).toBeVisible({ timeout: 15_000 });
  await withAdminRequest(async (ctx, headers) => {
    const cal = (await (await ctx.get(`/api/plan/calendar?from=2026-09-01&to=2026-09-30&projectId=${PROJECT}`, { headers })).json()) as Array<{ id: string; startDate: string | null; endDate: string | null }>;
    const row = cal.find((r) => r.id === ticketId);
    expect(row?.startDate?.slice(0, 10)).toBe("2026-09-15");
    expect(row?.endDate?.slice(0, 10)).toBe("2026-09-16");
  });
});

test("5. the workload board counts it under Tickets and Story points for its assignee", async ({ page }) => {
  test.skip(!ticketId || !resourcesOn || !assigneeId, "no ticket, no assignee, or resource management is off");
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  await withAdminRequest(async (ctx, headers) => {
    const board = await (await ctx.get("/api/resources/workload?from=2026-09-14&to=2026-09-27", { headers })).json();
    const row = board.rows.find((r: { person: { id: string } }) => r.person.id === assigneeId);
    expect(row, "assignee has a workload row").toBeTruthy();
    expect(row.totals.ticketCount).toBeGreaterThanOrEqual(1);
    expect(row.totals.storyPoints).toBeGreaterThanOrEqual(2);
  });
  await page.goto("/app/workload");
  const trigger = page.locator("[data-workload-measure]");
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole("option", { name: "Story points" }).click();
  await expect(trigger).toHaveText("Story points");
});
