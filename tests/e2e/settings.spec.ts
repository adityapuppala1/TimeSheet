import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

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
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

    await page.goto("/app/settings");
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
  });
});
