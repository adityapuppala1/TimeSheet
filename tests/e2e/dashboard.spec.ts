/**
 * Dashboard day-timeline verification. Exists because of a shipped timezone bug: the timeline
 * built "today's" key via toISOString() (UTC), which in any UTC+N timezone resolves local
 * midnight to the PREVIOUS day — so the banner said hours were logged while the timeline
 * rendered empty. These tests pin the fix with real data: create an entry for today through
 * the API, then assert the dashboard actually draws it.
 */
import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/employee.json" });

/** Local calendar date — deliberately NOT toISOString(), matching the app-side fix. */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test.describe("Dashboard day timeline", () => {
  test("shows an entry logged today, and the date picker walks to an empty day", async ({ page }) => {
    await page.goto("/app");
    const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
    const headers = { Authorization: `Bearer ${accessToken}` };

    // A draft is enough — the timeline shows every status — and never trips the face gate.
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const marker = `Timeline check ${Date.now()}`;
    // Late-evening slot to dodge overlaps with entries other suites created today.
    const create = await page.request.post("/api/timesheets/draft", {
      headers,
      data: {
        projectId: projects[0].id,
        moduleId: projects[0].modules?.[0]?.id,
        activityType: "Development",
        taskDescription: marker,
        workDate: localDateKey(new Date()),
        startTime: "22:10",
        endTime: "22:40"
      }
    });
    let created: { id: string } | null = null;
    if (create.ok()) {
      created = await create.json();
    } else {
      // 409 = this exact slot already exists from a prior run — the timeline assertion below
      // is still valid, since SOME entry exists for today either way.
      expect(create.status(), `draft create failed: ${await create.text()}`).toBe(409);
    }

    try {
      await page.goto("/app");
      const track = page.getByTestId("day-timeline-track");
      await expect(track).toBeVisible({ timeout: 10_000 });

      // The actual regression assertion: today's entries render as blocks.
      await expect(page.getByTestId("timeline-entry").first()).toBeVisible({ timeout: 10_000 });
      await expect(track).not.toContainText("Nothing logged yet today");

      // Date picker: walk far into the past (before any seeded data) and expect the empty state.
      const past = new Date();
      past.setFullYear(past.getFullYear() - 2);
      await page.getByLabel("Timeline date").fill(localDateKey(past));
      await expect(page.getByTestId("timeline-entry")).toHaveCount(0);
      await expect(track).toContainText(/Nothing logged on/);

      // "Today" button returns to a populated view.
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.getByTestId("timeline-entry").first()).toBeVisible();
    } finally {
      if (created?.id) {
        await page.request.delete(`/api/timesheets/${created.id}`, { headers }).catch(() => undefined);
      }
    }
  });
});
