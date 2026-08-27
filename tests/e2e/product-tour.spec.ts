/**
 * The guided product tour.
 *
 * THE PROPERTY THAT MATTERS MOST is role-awareness. The tour drives the router, so a step pointing
 * at a page the person's role can't open doesn't just look wrong — it navigates them into a 403 and
 * strands the tour there. It's derived from the same `nav` array and `isVisible` rule the sidebar
 * uses, and the assertion below is that an EMPLOYEE gets strictly fewer stops than a SUPER_ADMIN.
 *
 * Session-scoping is the second thing worth pinning: it auto-starts once per browser session, so a
 * fresh context sees it and a second visit in the same context does not.
 */
import { test, expect, type Page } from "@playwright/test";

/** Scoped to the tour dialog — the pages underneath have their own "Next" (table pagination), and
 *  an unscoped `getByRole("button", { name: "Next" })` hits both. */
function tour(page: Page) {
  return page.getByRole("dialog").filter({ hasText: /Skip tour/ });
}

async function readCounter(page: Page): Promise<{ current: number; total: number }> {
  const text = (await tour(page).getByText(/^\d+ of \d+$/).textContent()) ?? "";
  const [current, total] = text.split(" of ").map((part) => Number(part.trim()));
  return { current, total };
}

/**
 * Guarantees each test starts with a tour that hasn't been seen.
 *
 * The tour records "seen" in sessionStorage, and sessionStorage turned out to survive between
 * tests here — the first test would skip the tour and every test after it then found no tour to
 * drive, failing with "element not found" and pointing nowhere near the cause. Verified by running
 * one of them alone, where it passed.
 *
 * Clearing once per BROWSING SESSION rather than on every navigation is what makes this compatible
 * with the "doesn't reappear in the same session" test below: an unconditional clear in an init
 * script would wipe the flag on that test's second `goto` and make it assert the opposite of what
 * it means to.
 */
async function withFreshTourSession(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__tour_test_session") !== "1") {
      sessionStorage.clear();
      sessionStorage.setItem("__tour_test_session", "1");
    }
  });
}

/**
 * Signs in through the UI, giving this test its own live session.
 *
 * NOT a shared `storageState` snapshot, and that distinction cost real debugging time. A snapshot
 * file replays ONE fixed refresh cookie. Every `/app` load runs AuthBootstrap's `/auth/refresh`,
 * which ROTATES that session's secret, and the grace window forgives only the immediately previous
 * secret — so the first test in a multi-test spec leaves the snapshot two generations behind and
 * every later test lands on the login page. The symptom is "the tour never appeared", which points
 * nowhere near the cause; the screenshot of the login screen is what actually gave it away.
 *
 * Free against the rate limiter: `/auth/login` is capped at 20/min with `skipSuccessfulRequests`,
 * so successful sign-ins don't count toward the budget (see app.ts's login limiter).
 */
async function signIn(page: Page, email: string) {
  await withFreshTourSession(page);
  await asFirstDayUser(page);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
}

/**
 * Makes the signed-in account look like it finished setup moments ago, which is what the tour
 * auto-starts for.
 *
 * Necessary because the seeded accounts are deliberately NOT new: the tour opens itself only for a
 * genuinely first-day user, so that an established user isn't handed a walkthrough every time they
 * open a browser. Rewriting the timestamp in the response exercises the real auto-start logic —
 * the alternative, creating a throwaway user, drags in seat limits and invitations and proves less.
 */
async function asFirstDayUser(page: Page) {
  await page.route("**/api/auth/onboarding-status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, completedAt: new Date().toISOString() } });
  });
}

const EMPLOYEE = "employee@timesheet.local";

test.describe("product tour", () => {
  // No storageState: each test signs in for itself — see signIn's note.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("auto-starts once per session, and not again in the same session", async ({ page }) => {
    await signIn(page, EMPLOYEE);
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });
    await tour(page).getByRole("button", { name: /skip tour/i }).click();
    await expect(tour(page)).toBeHidden();

    // Same browser context, so the session flag persists — it must not reappear.
    await page.goto("/app/history");
    await page.waitForLoadState("networkidle");
    await expect(tour(page)).toBeHidden();
  });

  test("does NOT open itself for an established account", async ({ page }) => {
    // The regression this exists to prevent, and it is not a small one: the tour's overlay
    // captures clicks by design, so a version that auto-started for everyone blocked SEVENTEEN
    // existing e2e tests that click through the app — and would have put a walkthrough in front of
    // every long-standing user each time they opened a browser.
    //
    // No `asFirstDayUser` here: this signs in as the seeded employee exactly as they are, whose
    // onboarding completed long ago.
    await withFreshTourSession(page);
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(EMPLOYEE);
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

    // Well past the 900ms auto-start delay.
    await page.waitForTimeout(3000);
    await expect(tour(page)).toBeHidden();
    // And the app is genuinely interactive, not sitting behind an invisible overlay.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("steps forward and back, with an accurate counter", async ({ page }) => {
    await signIn(page, EMPLOYEE);
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });

    const start = await readCounter(page);
    expect(start.current).toBe(1);
    expect(start.total).toBeGreaterThan(3);

    // Previous is disabled on the first step rather than absent, so the control set doesn't
    // reflow as you move through the tour.
    await expect(tour(page).getByRole("button", { name: /previous step/i })).toBeDisabled();

    await tour(page).getByRole("button", { name: "Next" }).click();
    await expect.poll(async () => (await readCounter(page)).current).toBe(2);

    await tour(page).getByRole("button", { name: /previous step/i }).click();
    await expect.poll(async () => (await readCounter(page)).current).toBe(1);
  });

  test("navigates to the page each step is about", async ({ page }) => {
    await signIn(page, EMPLOYEE);
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });

    // The first three steps are the shell (sidebar, search, notifications); the fourth onward are
    // destinations, and the first of those is the dashboard. Step past them to reach a step that
    // must actually move the router.
    for (let i = 0; i < 4; i++) {
      await tour(page).getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(900);
    }

    // Whatever the fifth stop is for this role, the tour must have taken the browser there.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).not.toBe("/app");
    await expect(tour(page)).toBeVisible();
  });

  test("Escape leaves the tour", async ({ page }) => {
    await signIn(page, EMPLOYEE);
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(tour(page)).toBeHidden();
  });

  test("is usable on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, EMPLOYEE);
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });

    // The card must sit fully inside the viewport. On a phone the sidebar target is display:none,
    // which is exactly the case that would otherwise place a card against a zero-size rect.
    const box = await tour(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);

    await expect(tour(page).getByRole("button", { name: "Next" })).toBeVisible();
  });

  test("can be restarted from the profile menu after being skipped", async ({ page }) => {
    await signIn(page, EMPLOYEE);
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });
    await tour(page).getByRole("button", { name: /skip tour/i }).click();
    await expect(tour(page)).toBeHidden();

    // The whole reason the menu entry exists: someone who dismissed it needs a way back.
    await page.getByRole("button", { name: /account|dev|employee/i }).first().click();
    await page.getByRole("menuitem", { name: /take the tour/i }).click();
    await expect(tour(page)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("product tour is role-aware", () => {
  test("a super admin gets more stops than an employee", async ({ browser }) => {
    // Two fresh contexts so each gets its own session flag and the tour auto-starts in both.
    const readTotal = async (email: string) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, email);
      await expect(tour(page)).toBeVisible({ timeout: 15_000 });
      const { total } = await readCounter(page);
      await context.close();
      return total;
    };

    const employeeStops = await readTotal(EMPLOYEE);
    const adminStops = await readTotal("superadmin@timesheet.local");

    // A tour that offered everyone the same itinerary would walk an employee into pages that 403.
    expect(adminStops, "a super admin sees more of the app, so the tour must be longer").toBeGreaterThan(employeeStops);
  });
});
