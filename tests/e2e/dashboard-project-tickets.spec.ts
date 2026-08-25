/**
 * The Open / Closed / Done / Changes columns on "My projects this month".
 *
 * The counting itself is pinned server-side. What is checked HERE is the half a unit test cannot
 * see: that the numbers reach the cells they belong in, and — the part worth the spec — that
 * "none of these are done" and "there are none of these" stay distinguishable on screen. The easy
 * implementation renders both as "0%", and somebody reads that number in a review.
 *
 * WHY IT INTERCEPTS ONE ROUTE AND SEEDS NOTHING: the card is fed by a single request,
 * `GET /api/dashboards/my-month`, which returns the rows AND their ticket and change counts
 * together. Fulfilling it outright makes this a pure rendering test that mutates nobody's data.
 *
 * That single request is itself the fix this file was updated for. The card used to build its rows
 * in the browser from `GET /timesheets` — a list capped at 100 rows, newest first — and fetch ticket
 * counts separately. Two consequences, both now gone: on a busy account the older half of the month
 * fell off the cap and whole projects vanished from the card, and the rows could paint before their
 * counts arrived, so the columns needed a "not known yet" state distinct from zero. Rows and counts
 * can no longer arrive apart, because they are the same response.
 */
import { expect, test } from "@playwright/test";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";
import { signIn } from "./helpers/sign-in";

test.use({ storageState: { cookies: [], origins: [] } });

let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
});
test.afterAll(async () => {
  await faceGate?.restore();
});

const PROJECT_WITH_TICKETS = "Rollup Fixture Alpha";
const PROJECT_WITHOUT_TICKETS = "Rollup Fixture Beta";

/** A complete `MyMonthRollup`, so the page renders exactly what this spec describes. */
function rollupBody() {
  return {
    month: { from: new Date().toISOString(), to: new Date().toISOString() },
    truncated: false,
    projects: [
      {
        id: "fixture-alpha",
        code: "ALPHA",
        name: PROJECT_WITH_TICKETS,
        monthHours: 6,
        approvedHours: 3,
        entries: 2,
        lastDate: "2026-08-19",
        assigned: true,
        // 3 open + 9 closed = 75% done. Deliberately not a round half, so a transposed pair or a
        // share computed off the wrong denominator produces a visibly different number.
        tickets: { open: 3, closed: 9, mineOpen: 1, mineClosed: 2 },
        changes: { raised: 4, closed: 1 }
      },
      {
        id: "fixture-beta",
        code: "BETA",
        name: PROJECT_WITHOUT_TICKETS,
        monthHours: 0,
        approvedHours: 0,
        entries: 0,
        lastDate: null,
        assigned: true,
        tickets: { open: 0, closed: 0, mineOpen: 0, mineClosed: 0 },
        changes: { raised: 0, closed: 0 }
      }
    ],
    totals: {
      monthHours: 6,
      approvedHours: 3,
      submittedHours: 0,
      draftHours: 3,
      rejectedHours: 0,
      tickets: { open: 3, closed: 9, total: 12 },
      changes: { raised: 4, closed: 1, total: 4 }
    },
    completion: { timesheetPct: 50, ticketPct: 75, changePct: 25 }
  };
}

async function openDashboardWith(page: import("@playwright/test").Page, body: unknown) {
  await page.route("**/api/dashboards/my-month*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  );
  await page.goto("/app");
}

test.describe("Per-project ticket and change counts on the dashboard", () => {
  test("puts open, closed and the completion share in the cells they belong in", async ({ page }) => {
    await signIn(page, "employee");
    await openDashboardWith(page, rollupBody());

    const row = page.locator("tr", { hasText: PROJECT_WITH_TICKETS }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Per cell, not per row: the row also carries an hours figure and an approval percentage, and
    // asserting on row text would let a number landing in the wrong column still pass.
    await expect(row.getByTestId("rollup-open")).toHaveText("3");
    await expect(row.getByTestId("rollup-closed")).toHaveText("9");
    await expect(row.getByTestId("rollup-done")).toHaveText("75%");
    await expect(row.getByTestId("rollup-changes")).toHaveText("4");
  });

  test("prints an em dash, not 0%, for a project with no tickets at all", async ({ page }) => {
    // The distinction the whole file exists for. Beta has zero tickets, so there is no share to
    // report — and "0% of them are done" is a claim about tickets that do not exist.
    await signIn(page, "employee");
    await openDashboardWith(page, rollupBody());

    const row = page.locator("tr", { hasText: PROJECT_WITHOUT_TICKETS }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await expect(row.getByTestId("rollup-open")).toHaveText("0");
    await expect(row.getByTestId("rollup-closed")).toHaveText("0");
    await expect(row.getByTestId("rollup-done")).toHaveText("—");
  });

  test("lists a project you are assigned to even with nothing logged against it", async ({ page }) => {
    // The bug that motivated the server-side rollup: the card used to be derived from timesheet
    // entries alone, so a project you are responsible for but have not touched this month was
    // invisible — and on a busy account, so were the ones pushed past the 100-row cap.
    await signIn(page, "employee");
    await openDashboardWith(page, rollupBody());

    const row = page.locator("tr", { hasText: PROJECT_WITHOUT_TICKETS }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Says WHY a zero-hour row is on the card, so it does not read as a bug.
    await expect(row.getByText("assigned")).toBeVisible();
  });
});
