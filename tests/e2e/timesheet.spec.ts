/**
 * Timesheet draft smoke test.
 *
 * TWO BUGS THIS FILE USED TO HAVE, both of which made it pass without testing anything:
 *
 *  1. It never suspended the face gate. The workspace runs with face verification ON and
 *     `requireForTimesheet` set, so `POST /api/timesheets` answers 428 without a fresh capture —
 *     which a headless browser cannot produce. tickets.spec.ts and dashboard.spec.ts both call
 *     `suspendFaceGate` for exactly this reason; this one didn't, so the save silently failed.
 *  2. Its success assertion was `getByText(/saved|draft/i)`, which matches the "Save draft" BUTTON
 *     the test just clicked. So the test went green whether or not anything was saved.
 *
 * Together those hid a completely inert test. The fix asserts against the API — the row either
 * exists afterwards or it doesn't — rather than against text that happens to be on screen.
 */
import { test, expect } from "@playwright/test";
import { expectCleanupOk, expectGone, sweepLeftoverTimesheetDrafts, withAdminRequest } from "./helpers/admin-request";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";

/** Every run books this same slot, so a leftover from a previous run collides with it. */
const MARKER_PREFIX = "Playwright smoke test entry";
const ACTOR = "employee@timesheet.local";

test.use({ storageState: "tests/e2e/.auth/employee.json" });

let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
  // Self-healing: clear anything an earlier run leaked, otherwise the overlap check rejects
  // today's save and the whole test silently does nothing. See the helper for the full story.
  const swept = await sweepLeftoverTimesheetDrafts(ACTOR, MARKER_PREFIX);
  if (swept > 0) console.info(`[timesheet.spec] swept ${swept} leftover draft(s) from earlier runs.`);
});
test.afterAll(async () => {
  await faceGate?.restore();
});

test.describe("Timesheet", () => {
  test("logs a draft entry", async ({ page }) => {
    const marker = `${MARKER_PREFIX} ${Date.now()}`;

    // Surfaces WHY a save was rejected. Without this, a failing save shows up only as "the draft
    // doesn't exist" ten seconds later, with no hint whether it was a 428 face gate, a 409
    // overlap, or a validation error — all of which have looked identical here before.
    const rejections: string[] = [];
    page.on("response", async (res) => {
      if (res.url().includes("/api/timesheets") && res.status() >= 400) {
        rejections.push(`${res.status()} ${res.request().method()} — ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
    });

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

    // The token lives in page memory only (not localStorage) since the session-hardening pass, so
    // `page.request` — which shares the browser context's httpOnly refresh cookie — mints a fresh
    // one rather than trying to read it out of storage.
    const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
    const headers = { Authorization: `Bearer ${accessToken}` };

    // The real assertion: the row exists server-side. Polled because the save is a mutation whose
    // list invalidation lands a beat later — but polling for a row that never appears still fails,
    // which is the property the old text matcher lacked.
    const findDraft = async () => {
      const rows: Array<{ id: string; taskDescription: string }> = await (
        await page.request.get("/api/timesheets?status=DRAFT", { headers })
      ).json();
      return rows.find((r) => r.taskDescription?.includes(marker));
    };
    // Hand-rolled poll rather than expect.poll: its `message` is a static string, so the API
    // rejection list — the one thing that explains a failure here — could never reach the report.
    let saved = false;
    for (let attempt = 0; attempt < 20 && !saved; attempt++) {
      saved = Boolean(await findDraft());
      if (!saved) await page.waitForTimeout(500);
    }
    expect(saved, `the draft should exist server-side after saving. API rejections: ${JSON.stringify(rejections)}`).toBe(true);

    // Clean up so repeated runs don't accumulate drafts. An employee CAN delete their own draft,
    // so unlike tickets.spec.ts this stays on the page's own session — but the result is asserted
    // either way, because an unchecked teardown is indistinguishable from a working one.
    const match = await findDraft();
    const deleted = await page.request.delete(`/api/timesheets/${match!.id}`, { headers });
    expectCleanupOk(deleted.status(), `timesheet draft ${match!.id}`);
    // Postcondition, not just the status: this spec's whole history is of teardowns that reported
    // success while leaving the row behind.
    await expectGone(findDraft, `timesheet draft ${match!.id}`);
  });

  test("refuses to delete an approved entry, even for a superadmin", async ({}, testInfo) => {
    // The guard that protects the billing record: approved hours feed rate snapshots, cost
    // reports and Verified Work Attestations. If this ever starts returning 204, history becomes
    // rewritable after a client has already been shown it.
    //
    // Runs as SUPERADMIN on purpose — that identity passes the ownership check, so the only thing
    // that can refuse the delete is the status rule itself. It also avoids `page.request`, whose
    // /auth/refresh would rotate this session's secret a second time in one spec and fail with
    // "Session expired" (see auth.setup.ts).
    await withAdminRequest(async (ctx, headers) => {
      const body = await (await ctx.get("/api/timesheets?status=APPROVED", { headers })).json();
      expect(Array.isArray(body), `expected an array of timesheets, got ${JSON.stringify(body).slice(0, 200)}`).toBe(true);

      const approved = body as Array<{ id: string }>;
      testInfo.skip(approved.length === 0, "no approved entry in the demo data to test against");

      const res = await ctx.delete(`/api/timesheets/${approved[0].id}`, { headers });
      expect(res.status()).toBe(422);
      expect((await res.json()).message).toMatch(/approved hours are part of the billing record/i);

      // And it is genuinely still there — the status code alone is not the property that matters.
      const after = (await (await ctx.get("/api/timesheets?status=APPROVED", { headers })).json()) as Array<{ id: string }>;
      expect(after.some((r) => r.id === approved[0].id)).toBe(true);
    });
  });
});
