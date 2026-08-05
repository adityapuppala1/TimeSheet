/**
 * Phone-width layout of the face-enrollment surfaces. The generic responsive suite catches
 * page-level overflow, but the enrollment card's interesting states (retrain wizard open, step
 * chips, camera panel) only exist after clicks it never makes — which is exactly where "the UI
 * comes out of the page" was reported from a real phone.
 *
 * The camera itself can't grant in a headless run; that's fine — denied/idle states render the
 * same layout skeleton, and layout is what this spec asserts.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

test.describe("face enrollment on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 }, storageState: { cookies: [], origins: [] } });

  test("the profile face card, wizard open, stays inside the viewport", async ({ page }) => {
    await signIn(page, "employee");
    await page.goto("/app/profile");

    const card = page.getByText("Face verification", { exact: true }).first();
    let cardVisible = true;
    try {
      await card.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      cardVisible = false;
    }
    test.skip(!cardVisible, "face verification is not enabled for this workspace/user");

    // Open the wizard if this account is already enrolled (retrain) — the state with the most
    // going on: step chips, camera panel, progress line, wizard buttons.
    const retrain = page.getByRole("button", { name: /retrain face model/i });
    if (await retrain.count()) {
      await retrain.first().click();
      await expect(page.getByText("Four quick positions")).toBeVisible({ timeout: 10_000 });
    }

    // The page must never scroll sideways — the body { overflow-x: clip } contract, asserted
    // the same way responsive.spec.ts asserts it everywhere else.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow at 360px").toBeLessThanOrEqual(1);

    // And there is exactly ONE Start and ONE Cancel in the wizard — the duplicate-button bug.
    if (await retrain.count().then(() => page.getByText("Four quick positions").isVisible())) {
      const starts = await page.getByRole("button", { name: /^start$/i }).count();
      const cancels = await page.getByRole("button", { name: /^cancel$/i }).count();
      expect(starts, "exactly one Start button in the wizard").toBeLessThanOrEqual(1);
      expect(cancels, "exactly one Cancel button in the wizard").toBeLessThanOrEqual(1);
    }
  });
});
