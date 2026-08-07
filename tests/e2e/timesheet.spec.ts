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
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { expectCleanupOk, expectGone, sweepLeftoverTimesheetDrafts, withAdminRequest } from "./helpers/admin-request";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";
import { DEMO_USERS, signIn } from "./helpers/sign-in";

const MARKER_PREFIX = "Playwright smoke test entry";
const ACTOR = DEMO_USERS.employee;

/**
 * Finds an hour today that this user has nothing booked in.
 *
 * WHY THIS IS NOT A FIXED "09:00-10:00": the API refuses any range that overlaps an existing
 * entry for that user and day, and it counts EVERY live entry regardless of status. A hard-coded
 * slot therefore fails the moment a real person logs real time over it — which is exactly what
 * happened here: a genuine 09:30-11:00 submission in the development database made this test fail
 * on one browser and not another, which reads convincingly like a browser bug and is not one.
 *
 * A test that only passes against a pristine database is a test that will eventually be deleted
 * for being flaky. Asking which hours are free costs one request and makes it independent of
 * whatever else is in there.
 */
async function findFreeHour(
  request: APIRequestContext,
  headers: Record<string, string>,
  userId: string
): Promise<{ start: string; end: string }> {
  const res = await request.get(`/api/timesheets?userId=${userId}`, { headers });
  const rows = await res.json();
  // A non-array here means the request was refused (usually an expired token), and letting it
  // reach `.filter` produces "rows.filter is not a function" pointing at this file rather than at
  // the auth problem that actually happened.
  if (!Array.isArray(rows)) {
    throw new Error(`could not read existing entries (${res.status()}): ${JSON.stringify(rows).slice(0, 160)}`);
  }

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const busy = rows
    .filter((r) => String(r.workDate).slice(0, 10) === todayKey)
    .map((r) => [minutes(r.startTime), minutes(r.endTime)] as const);

  // Walk the working day looking for a clear hour. Late hours first would be equally valid; early
  // ones keep the fixture where a reader expects to find it.
  for (let hour = 6; hour <= 22; hour += 1) {
    const start = hour * 60;
    const end = start + 60;
    if (!busy.some(([bs, be]) => start < be && end > bs)) {
      return { start: `${String(hour).padStart(2, "0")}:00`, end: `${String(hour + 1).padStart(2, "0")}:00` };
    }
  }
  throw new Error("every hour today is already booked for this user — cannot place the fixture");
}

/**
 * Signs in per test instead of replaying `.auth/employee.json`.
 *
 * The snapshot holds ONE refresh cookie, and every use rotates it. That was survivable while this
 * spec ran in a single project; running it across chromium, firefox and webkit means three
 * separate contexts each presenting the same already-rotated cookie, and every project after the
 * first gets a 401 when it tries to mint a token. Signing in is free against the rate limiter —
 * successful logins are skipped by it — and makes each project independent.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const signInAsEmployee = (page: Page) => signIn(page, "employee");

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


/**
 * Sets a 24-hour HH:mm on a React Aria segmented time field.
 *
 * The field is a group of `spinbutton` segments — hour, minute and AM/PM — each separately
 * labelled and focusable. There is no single input to `fill`, so each segment is targeted by its
 * own accessible name and typed into. That is also what a keyboard user does, so the test
 * exercises the control rather than reaching around it.
 *
 * Verified against the rendered DOM rather than assumed: the segment names are
 * "hour, Start time" / "minute, Start time" / "AM/PM, Start time".
 */
async function fillTime(page: Page, label: string, value: string) {
  const [h, m] = value.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;

  await page.getByRole("spinbutton", { name: `hour, ${label}` }).click();
  await page.keyboard.type(String(hour12).padStart(2, "0"));
  await page.getByRole("spinbutton", { name: `minute, ${label}` }).click();
  await page.keyboard.type(String(m).padStart(2, "0"));
  // A single character — "a" or "p". "AM" would send "A" then "M", and the second one is not a
  // day-period key.
  await page.getByRole("spinbutton", { name: `AM/PM, ${label}` }).click();
  await page.keyboard.type(h < 12 ? "a" : "p");

  // Assert the control actually holds what was asked for. Without this a mistyped segment shows up
  // much later as an unrelated 422 about end times, which points nowhere near the cause.
  await expect(page.getByRole("spinbutton", { name: `hour, ${label}` })).toHaveText(String(hour12));
  await expect(page.getByRole("spinbutton", { name: `AM/PM, ${label}` })).toHaveText(h < 12 ? "AM" : "PM");
}

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

    await signInAsEmployee(page);

    // ONE refresh for the whole test, taken BEFORE navigating.
    //
    // Both halves matter. Before, because refresh tokens rotate on use and the app's own bootstrap
    // spends one on first paint — a request issued after `goto` races the page for the same
    // single-use cookie and loses. And once, because a second refresh later in the same test
    // presents a cookie the first one already rotated away: it comes back 401, and the JSON body
    // is an error object rather than the array the caller expects, which surfaces as a baffling
    // "rows.filter is not a function" far from the actual cause.
    const refreshed = await page.request.post("/api/auth/refresh");
    expect(refreshed.ok(), "could not mint an access token for this test").toBe(true);
    const { accessToken } = await refreshed.json();
    const headers = { Authorization: `Bearer ${accessToken}` };

    const me = await (await page.request.get("/api/auth/me", { headers })).json();
    const slot = await findFreeHour(page.request, headers, me.id);

    await page.goto("/app/timesheet");
    await page.getByLabel("Project", { exact: true }).click();
    await page.getByRole("option").first().click();
    await page.getByLabel("Module", { exact: true }).click();
    await page.getByRole("option").first().click();
    await page.getByLabel("Activity", { exact: true }).click();
    await page.getByRole("option").first().click();
    // The time fields are React Aria segmented inputs now, not `<input type="time">`. A segmented
    // field has no single value to `fill` — it has an hour, a minute and (in 12-hour locales) a
    // day-period segment, each focusable. Typing the digits is what a person does, and it is what
    // exercises the control rather than bypassing it.
    await fillTime(page, "Start time", slot.start);
    await fillTime(page, "End time", slot.end);
    await page.getByLabel("Task description", { exact: true }).fill(marker);
    await page.getByRole("button", { name: /save draft/i }).click();


    // The real assertion: the row exists server-side. Polled because the save is a mutation whose
    // list invalidation lands a beat later — but polling for a row that never appears still fails,
    // which is the property the old text matcher lacked.
    const findDraft = async () => {
      const rows: Array<{ id: string; taskDescription: string }> = await (
        await page.request.get("/api/timesheets?status=DRAFT", { headers })
      ).json();
      return rows.find((r) => r.taskDescription?.includes(marker));
    };
    // Polls until something CONCLUSIVE has happened — the row exists, or the API rejected the
    // save — then asserts which. Waiting only on the row would spend the full timeout on every
    // failure and report "it isn't there" without saying why; a fixed sleep would be slower and
    // still racy. The rejection assertion comes first because it's the actionable one.
    await expect
      .poll(async () => rejections.length > 0 || Boolean(await findDraft()), {
        message: "the save should have either created the draft or been rejected",
        timeout: 10_000
      })
      .toBe(true);

    expect(rejections, "the API rejected the save").toEqual([]);
    expect(await findDraft(), "the draft should exist server-side after saving").toBeTruthy();

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

  /**
   * Submitting an incomplete form must TAKE YOU TO the field that stopped it.
   *
   * react-hook-form's own `shouldFocusError` only fires for fields it holds a DOM ref for, and
   * every select on this form is a Radix trigger rendered through `<Controller>` — so RHF has no
   * ref for any of them. Before `focusFirstInvalid`, pressing Submit with an empty Project scrolled
   * nowhere, focused nothing and raised no toast: the form simply appeared not to respond to the
   * button, with the offending field off-screen above.
   *
   * The assertion is on `document.activeElement`, not on the error text. An error message can
   * render perfectly while the user is still looking at the wrong part of a long form, which is
   * exactly the bug.
   */
  test("submitting an incomplete form focuses the first invalid field", async ({ page }) => {
    await signInAsEmployee(page);
    await page.goto("/app/timesheet");

    // Project is the first field in document order and the first that can fail, so it is both the
    // trigger and the expected destination.
    const project = page.getByLabel("Project", { exact: true });
    await expect(project).toBeVisible({ timeout: 15_000 });

    // Times first, deliberately: "Submit for approval" is disabled while the total is zero, so an
    // entirely empty form cannot reach the submit path at all. One hour makes the button live
    // while Project is still empty — which is the state a real person submits from.
    await fillTime(page, "Start time", "09:00");
    await fillTime(page, "End time", "10:00");

    await page.getByRole("button", { name: /submit for approval/i }).click();

    // Keyed off `aria-invalid` for the same reason the app is: it is stamped on whichever element
    // is in error, so this keeps working as fields move or are added.
    await expect(project).toHaveAttribute("aria-invalid", "true", { timeout: 10_000 });
    await expect(project).toBeFocused({ timeout: 10_000 });

    // And the first invalid field is the FIRST one in document order — focusing some later error
    // would scroll past the one the user has to fix first.
    const focusedIsFirstInvalid = await page.evaluate(() => {
      const form = document.querySelector("form");
      const first = form?.querySelector('[aria-invalid="true"]');
      return Boolean(first) && first === document.activeElement;
    });
    expect(focusedIsFirstInvalid, "focus landed on an invalid field, but not the first one").toBe(true);

    // The toast names the field, so a keyboard user who lost the scroll position still knows what
    // is being asked of them.
    await expect(page.getByText(/check the highlighted field/i)).toBeVisible({ timeout: 10_000 });
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
