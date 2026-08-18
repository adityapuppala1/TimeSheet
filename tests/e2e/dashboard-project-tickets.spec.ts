/**
 * The Open / Closed / Done columns on "My projects this month".
 *
 * The counting itself is pinned server-side (apps/api/tests/unit/ticket-counts-by-project.test.ts).
 * What is checked HERE is the half that a unit test cannot see: that the numbers reach the cells
 * they belong in, and — the part worth the spec — that the three states of "no closed tickets" stay
 * distinguishable on screen. A project whose counts have not arrived, a project with none closed,
 * and a project with no tickets at all are three different facts, and the easy implementation
 * renders all three as "0%". Somebody reads that number in a review.
 *
 * The counts endpoint is intercepted rather than seeded, so this spec asserts rendering without
 * mutating anyone's tickets.
 */
import { expect, test } from "@playwright/test";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";
import { accessToken, signIn } from "./helpers/sign-in";

test.use({ storageState: { cookies: [], origins: [] } });

let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
});
test.afterAll(async () => {
  await faceGate?.restore();
});

/** Local calendar date — the rollup is a calendar-month view, and toISOString() shifts the day. */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test.describe("Per-project ticket counts on the dashboard", () => {
  test("shows open, closed and the completion share — and never prints 0% for a project with no tickets", async ({ page }) => {
    await signIn(page, "employee");
    await page.goto("/app");
    const headers = await accessToken(page);

    // A project only appears in this widget once there are hours logged against it this month, so
    // the fixture is a timesheet entry, not a ticket.
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const project = projects[0];
    const create = await page.request.post("/api/timesheets/draft", {
      headers,
      data: {
        projectId: project.id,
        moduleId: project.modules?.[0]?.id,
        activityType: "Development",
        taskDescription: `Ticket-count rollup check ${Date.now()}`,
        workDate: localDateKey(new Date()),
        startTime: "21:05",
        endTime: "21:35"
      }
    });
    const entry = create.ok() ? await create.json() : null;

    try {
      // 3 open + 9 closed = 75% done. Deliberately not a round half, so a transposed pair or a
      // share computed off the wrong denominator produces a visibly different number.
      await page.route("**/api/tickets/counts-by-project*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ projectId: project.id, open: 3, closed: 9 }])
        })
      );

      await page.goto("/app");
      const row = page.locator("tr", { hasText: project.name }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Per cell, not per row: the row also carries an hours figure and an approval percentage, and
      // asserting on row text would let a number landing in the wrong column still pass.
      await expect(row.getByTestId("rollup-open")).toHaveText("3");
      await expect(row.getByTestId("rollup-closed")).toHaveText("9");
      await expect(row.getByTestId("rollup-done")).toHaveText("75%");
    } finally {
      if (entry?.id) await page.request.delete(`/api/timesheets/${entry.id}`, { headers }).catch(() => undefined);
    }
  });

  test("prints an em dash, not 0%, while the counts are still loading", async ({ page }) => {
    await signIn(page, "employee");
    const headers = await accessToken(page);
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const project = projects[0];
    const create = await page.request.post("/api/timesheets/draft", {
      headers,
      data: {
        projectId: project.id,
        moduleId: project.modules?.[0]?.id,
        activityType: "Development",
        taskDescription: `Ticket-count pending check ${Date.now()}`,
        workDate: localDateKey(new Date()),
        startTime: "21:40",
        endTime: "22:00"
      }
    });
    const entry = create.ok() ? await create.json() : null;

    try {
      // Never answers. This is the state a user sees for the first second of every page load, and
      // the one where a naive `closed ?? 0` would assert "nothing is finished".
      await page.route("**/api/tickets/counts-by-project*", () => undefined);

      await page.goto("/app");
      const row = page.locator("tr", { hasText: project.name }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      // The Done cell specifically — the row's LAST cell is the approval bar, which legitimately
      // reads 0% for an unapproved draft. Asserting on row text confuses the two.
      await expect(row.getByTestId("rollup-closed")).toHaveText("—");
      await expect(row.getByTestId("rollup-done")).toHaveText("—");
    } finally {
      if (entry?.id) await page.request.delete(`/api/timesheets/${entry.id}`, { headers }).catch(() => undefined);
    }
  });
});
