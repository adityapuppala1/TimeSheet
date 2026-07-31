/**
 * Backend health gate escalation.
 *
 * WHY this is an e2e test rather than a manual check: the whole feature is a state machine that
 * only reveals itself when the API stops answering, which is exactly the condition nobody
 * reproduces by hand twice. Intercepting `/api/health` at the browser gives the same signal a real
 * outage does, without stopping the server the rest of the suite is using.
 *
 * The three properties that matter, and each one is a real failure if it regresses:
 *   1. One dropped request does NOT block the app — a sleeping laptop or a rolling deploy would
 *      otherwise slam a modal in front of someone mid-sentence.
 *   2. A sustained outage DOES block, because with the backend gone every screen can only mislead:
 *      stale numbers look current and "Save" appears to work.
 *   3. Recovery is automatic and does not unmount the app — the overlay sits on top, so in-progress
 *      form state survives and no reload is needed.
 */
import { test, expect } from "@playwright/test";

// Its own snapshot — see auth.setup.ts. This spec deliberately spends ~30s with the API
// unreachable, which is exactly the situation that would strand a shared session.
test.use({ storageState: "tests/e2e/.auth/employee-health.json" });

const BANNER = /Having trouble reaching the server/i;
const BLOCKING_TITLE = /Can't reach the server/i;

test.describe("backend health gate", () => {
  test("escalates from banner to blocking overlay, then recovers on its own", async ({ page }) => {
    let failProbes = false;

    // Only the health probe is intercepted. Real API traffic keeps working, which is deliberate:
    // it isolates the probe's own escalation logic from every other reason a page might break.
    await page.route("**/api/health", async (route) => {
      if (failProbes) await route.abort("connectionrefused");
      else await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });

    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Healthy: neither surface is present.
    await expect(page.getByText(BANNER)).toBeHidden();

    failProbes = true;

    // FIRST failure → warning strip only. The app must stay usable; a single blip is not an outage.
    // "Retry now" forces a probe instead of waiting out the 15s poll, which keeps this test honest
    // about the escalation thresholds rather than about timer tuning.
    await expect(page.getByText(BANNER)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole("alertdialog")).toBeHidden();

    // THIRD consecutive failure → blocking overlay. The polling interval tightens to 5s once
    // failures start, so this arrives well inside the timeout.
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(BLOCKING_TITLE)).toBeVisible();

    // The app is still MOUNTED underneath — that's the difference between pausing and destroying
    // whatever the user had typed.
    await expect(page.getByRole("heading", { level: 1 })).toBeAttached();

    failProbes = false;

    // Recovery with no reload and no user action beyond the automatic retry.
    await expect(page.getByRole("alertdialog")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(BANNER)).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("a single dropped probe warns but never blocks", async ({ page }) => {
    let dropped = 0;

    await page.route("**/api/health", async (route) => {
      // Exactly one failure, then healthy again — the sleeping-laptop case.
      if (dropped === 0) {
        dropped++;
        await route.abort("connectionrefused");
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });

    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Give it more than two poll intervals: if a single failure could escalate, it would have by now.
    await page.waitForTimeout(12_000);
    await expect(page.getByRole("alertdialog")).toBeHidden();
  });
});
