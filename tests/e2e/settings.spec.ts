import { test, expect } from "@playwright/test";
import { accessToken, signIn } from "./helpers/sign-in";

/**
 * Signs in per test rather than replaying a stored snapshot. A snapshot holds one rotating refresh
 * cookie, so it survives about one session's use — which broke the moment this spec started
 * running in three browser projects. See helpers/sign-in.ts.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Workspace settings", () => {
  test("toggles weekdays-only reminders and it persists across reload", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /reminders/i }).click();

    const toggle = page.locator("#weekdays-only");
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    const before = await toggle.getAttribute("data-state");

    await toggle.click();
    await expect(toggle).not.toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });

    await page.reload();
    await page.getByRole("tab", { name: /reminders/i }).click();
    await expect(page.locator("#weekdays-only")).not.toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });

    // Restore original state so this test is idempotent across runs.
    await page.locator("#weekdays-only").click();
  });

  /**
   * The Email channels matrix — a category × role grid where the two gates per cell are stored
   * DIFFERENTLY and it matters.
   *
   * The row switch is a plain boolean on GlobalSettings. The per-role ticks are stored INVERTED,
   * as `emailRoleMutes` (a map of category → muted roles), so a workspace that never opens this
   * screen keeps defaulting to "everyone receives it" with no backfill. An inversion bug there
   * reads correctly on screen and sends mail to exactly the wrong set, which is why this asserts
   * a tick SURVIVES A RELOAD rather than that clicking it changed the pixel.
   *
   * The save also REPLACES the whole map rather than merging it, so a round trip is the only
   * thing that proves the other categories were not dropped on the way through.
   */
  test("the email channels matrix renders and a role tick persists across reload", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /email channels/i }).click();

    // Seven columns on a phone is the reason this table lives in its own scroll container; the
    // matrix existing at all is the first thing to assert.
    await expect(page.getByRole("columnheader", { name: "Email template" })).toBeVisible({ timeout: 15_000 });
    // By `title`, not by accessible name: each column header renders the full label and an
    // abbreviation and hides one by width, so the name is "Employee" at this viewport and "Emp" on
    // a phone. The title is the same at every width.
    for (const role of ["Employee", "Team Leader", "Manager", "Admin", "Super Admin"]) {
      await expect(page.locator(`button[title$="every category for ${role}"]`)).toBeVisible();
    }

    // "Timesheet approved" is on in every seeded workspace, which matters: the ticks are disabled
    // while their row's master switch is off, so a muted category would make this untestable.
    const master = page.getByRole("switch", { name: /^Timesheet approved — email on or off for everyone$/ });
    await expect(master).toBeVisible({ timeout: 15_000 });
    if ((await master.getAttribute("data-state")) !== "checked") await master.click();
    await expect(master).toHaveAttribute("data-state", "checked", { timeout: 10_000 });

    const cell = page.getByRole("checkbox", { name: "Team Leader receives Timesheet approved" });
    await expect(cell).toBeEnabled({ timeout: 10_000 });
    const before = await cell.getAttribute("data-state");

    // Waits on the PATCH rather than on a toast: every switch on this card raises its own "Saved",
    // so a toast assertion passes against a stale one and the reload below races the real request.
    const saved = page.waitForResponse(
      (res) => res.url().includes("/api/settings") && res.request().method() === "PATCH" && res.status() < 400
    );
    await cell.click();
    await saved;
    await expect(cell).not.toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });

    await page.reload();
    await page.getByRole("tab", { name: /email channels/i }).click();
    const reloaded = page.getByRole("checkbox", { name: "Team Leader receives Timesheet approved" });
    await expect(reloaded).not.toHaveAttribute("data-state", before ?? "", { timeout: 15_000 });

    // A neighbouring category must be untouched — the map is REPLACED on save, so a partial write
    // would quietly mute or unmute everything this test never looked at.
    await expect(page.getByRole("checkbox", { name: "Manager receives Approval SLA breached" })).toBeVisible();

    // Restore, so the workspace's real mail routing is exactly as it was found.
    const restored = page.waitForResponse(
      (res) => res.url().includes("/api/settings") && res.request().method() === "PATCH" && res.status() < 400
    );
    await reloaded.click();
    await restored;
    await expect(reloaded).toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });
  });
});

/* ------------------------------------------------------------------------------------------- *
 * REGRESSION: settings forms silently discarding what you typed.
 *
 * Three settings cards seeded their local form state from the server query on EVERY change to
 * that query's data. Any save on the card invalidates the query, and React Query also refetches
 * on window focus by default — so a background refetch reset the inputs to the stored values
 * while somebody was still typing in them.
 *
 * Losing keystrokes would have been bad enough. The real damage was that the Save button sends
 * whatever is in that state: "type a new threshold, flip an unrelated switch, press Save" quietly
 * re-saved the OLD value and showed a success toast. The setting looked like it would not persist;
 * what had actually happened is that it was never sent.
 * ------------------------------------------------------------------------------------------- */
test.describe("settings forms keep what you typed", () => {
  // Signs in for itself instead of replaying this file's shared storageState. Every /app load
  // rotates the session's refresh secret and the grace window forgives only the previous one, so
  // by the time a later test in a multi-test spec runs, the snapshot is generations behind and
  // lands on /login. Documented at length in auth.setup.ts.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an unrelated toggle does not revert an edited face threshold, and the edit saves", async ({ page }) => {
    await signIn(page, "superadmin");

    await page.goto("/app/settings");

    /**
     * Face verification is switched ON for the duration of this test, and put back in the `finally`
     * at the end.
     *
     * The calibration inputs render `disabled={readOnly || !enabled}`, so on a workspace where the
     * feature has never been turned on this test hangs on `fill` against a field that is visible and
     * permanently uneditable. That is exactly what it did the first time CI ever reached it — the CI
     * database is freshly seeded — while passing on every developer machine, because those had all
     * enabled face verification at some point months earlier and never turned it back off.
     *
     * Enabled HERE rather than in the seed on purpose: face verification is biometric, `enabled`
     * defaults to false for good reason, and switching it on for every seeded workspace would be a
     * product decision taken to make one test pass. Mutating a workspace-wide row from a test is
     * safe under this suite's own rules — `playwright.config.ts` pins `workers: 1` and each CI shard
     * owns its own database, so nothing else is reading this row while the test holds it.
     *
     * Bearer headers rather than the page's cookies: this API authenticates on the access token, so
     * a cookie-only request never completes and the test times out inside the setup it needs.
     */
    const settingsUrl = "/api/settings/face-verification";
    const authHeaders = await accessToken(page);
    const beforeSettings = await (await page.request.get(settingsUrl, { headers: authHeaders })).json();
    const hadToEnable = !beforeSettings?.enabled;
    if (hadToEnable) await page.request.patch(settingsUrl, { headers: authHeaders, data: { enabled: true } });

    try {
      await page.reload();
      await page.getByRole("tab", { name: /face verification/i }).click();

      const field = page.locator("#face-matchThreshold");
      await expect(field).toBeVisible({ timeout: 15_000 });

      const original = (await field.inputValue()) || "0.75";
      // A different value from whatever is stored, and inside the server's 0.3-0.99 bounds.
      const typed = original.trim() === "0.71" ? "0.73" : "0.71";

      await field.fill(typed);
      expect(await field.inputValue()).toBe(typed);

      // The trigger: a switch on the same card saves immediately and invalidates the query the form
      // was seeded from. This is the exact sequence that used to wipe the box.
      const challenge = page.getByRole("switch").nth(3);
      if (await challenge.count()) {
        const before = await challenge.getAttribute("data-state");
        await challenge.click();
        await expect(challenge).not.toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });
        // Put it back, which fires a second save/invalidate for good measure.
        await challenge.click();
        await expect(challenge).toHaveAttribute("data-state", before ?? "", { timeout: 10_000 });
      }

      // THE ASSERTION: still what was typed, not what the server holds.
      await expect(field).toHaveValue(typed);

      // Wait for the actual PATCH, not for a "Saved" toast.
      //
      // The toggles above each raise their own "Saved" toast, and those are still on screen here —
      // so a toast assertion passes instantly without the calibration save having happened, and the
      // reload below then races the in-flight request. It passed on Chromium and Firefox and failed
      // on WebKit purely because WebKit is slower, which is exactly the shape of a "browser
      // incompatibility" that turns out to be a test asserting the wrong thing.
      const saved = page.waitForResponse(
        (res) => res.url().includes("/api/settings/face-verification") && res.request().method() === "PATCH"
      );
      await page.getByRole("button", { name: /save calibration/i }).click();
      expect((await saved).ok(), "the calibration save was rejected").toBe(true);

      // And it really reached the database, rather than the old value being re-sent.
      await page.reload();
      await page.getByRole("tab", { name: /face verification/i }).click();
      await expect(page.locator("#face-matchThreshold")).toHaveValue(typed, { timeout: 15_000 });

      // Restore, waiting on the request for the same reason.
      const restored = page.waitForResponse(
        (res) => res.url().includes("/api/settings/face-verification") && res.request().method() === "PATCH"
      );
      await page.locator("#face-matchThreshold").fill(original);
      await page.getByRole("button", { name: /save calibration/i }).click();
      expect((await restored).ok(), "the restore save was rejected").toBe(true);
    } finally {
      // Only if this test turned it on. Leaving a biometric feature enabled behind us would
      // change what every later spec in this shard is looking at.
      if (hadToEnable) await page.request.patch(settingsUrl, { headers: authHeaders, data: { enabled: false } });
    }
  });
});

test.describe("face verification review log", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * The regression: "View capture" used window.open() on the authenticated image route, which
   * navigates with no Authorization header — every admin got {"message":"Authentication
   * required"} instead of the capture. The fix fetches the blob through the api client and shows
   * it in-app, so this test asserts the image ACTUALLY LOADS, not merely that a dialog opened.
   */
  test("an admin can view a stored capture from the log", async ({ page }) => {
    await signIn(page, "superadmin");

    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /face verification/i }).click();
    // The heading role, not bare text: the insecure-bypass toggle's description also says
    // "verification log", and a text locator matching both is a strict-mode violation.
    await expect(page.getByRole("heading", { name: "Verification log" })).toBeVisible({ timeout: 15_000 });

    // Only attempts that stored an image carry the eye button, and a fresh CI database has no
    // attempts at all — absence is a data condition here, not a failure.
    const eye = page.getByRole("button", { name: "View capture" }).first();
    let hasCapture = true;
    try {
      await eye.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      hasCapture = false;
    }
    test.skip(!hasCapture, "no stored captures in this workspace to view");

    await eye.click();
    const dialog = page.getByRole("dialog", { name: /verification capture/i });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    const img = dialog.getByRole("img", { name: "Stored verification capture" });
    await expect(img).toBeVisible();
    // blob: proves it came through the authenticated fetch, not a bare URL navigation.
    expect(await img.getAttribute("src")).toMatch(/^blob:/);
    await expect
      .poll(
        () => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0),
        { message: "the capture image must decode — a 401 JSON body would leave naturalWidth at 0", timeout: 10_000 }
      )
      .toBe(true);
  });
});
