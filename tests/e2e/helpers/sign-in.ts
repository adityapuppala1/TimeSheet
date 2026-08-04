/**
 * Signing in for a test, rather than replaying a stored `storageState` snapshot.
 *
 * WHY SNAPSHOTS KEEP FAILING HERE, documented once so it stops being rediscovered: a snapshot
 * captures ONE refresh cookie, and this app rotates that cookie on every use, forgiving only the
 * immediately-previous value. So a snapshot is good for roughly one session's worth of use, and
 * every consumer after that lands on /login. It has bitten this suite three separate ways:
 *
 *   - A multi-test spec exhausted its own snapshot; test 1 passed, the rest hit the login page.
 *   - Adding the firefox and webkit projects meant three browsers replaying the SAME cookie, so
 *     whichever project ran last failed with symptoms that read exactly like a browser
 *     incompatibility and were nothing of the sort.
 *   - A test taking a second token mid-run found the first had already rotated it away, and got
 *     an error object where it expected an array.
 *
 * Signing in is cheap and free against the rate limiter — `/auth/login` is configured with
 * `skipSuccessfulRequests`, so successful sign-ins never count toward the budget. Prefer this to a
 * snapshot in any spec with more than one test, or that runs in more than one project.
 */
import { expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "Admin@12345";

export const DEMO_USERS = {
  superadmin: "superadmin@timesheet.local",
  manager: "manager@timesheet.local",
  employee: "employee@timesheet.local"
} as const;

export type DemoRole = keyof typeof DEMO_USERS;

/** Signs in and waits for the app shell. Leaves the page on `/app`. */
export async function signIn(page: Page, role: DemoRole = "superadmin"): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(DEMO_USERS[role]);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
}

/**
 * Mints ONE access token for the signed-in session and asserts it worked.
 *
 * Call this before any `page.goto` into `/app`: the app's own bootstrap spends a refresh on first
 * paint, so a token taken afterwards races the page for the same single-use cookie. Take it once
 * and thread it through — a second call later in the same test will fail for the reason above.
 */
export async function accessToken(page: Page): Promise<Record<string, string>> {
  const res = await page.request.post("/api/auth/refresh");
  expect(res.ok(), `could not mint an access token (${res.status()})`).toBe(true);
  const { accessToken: token } = await res.json();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Picks a date through the calendar popover.
 *
 * The date fields are calendars now, not `<input type="date">`, so there is nothing to `fill`. This
 * drives the control the way a person does — open it, step the month header to the target, click
 * the day — which is also the only way to catch the popover failing to open at all.
 */
export async function pickDate(page: Page, triggerId: string, target: Date) {
  await page.locator(`#${triggerId}`).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  const wanted = target.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  // Step backwards or forwards until the heading matches. Bounded so a broken stepper fails fast
  // rather than spinning for the whole timeout.
  for (let i = 0; i < 60; i += 1) {
    const heading = (await dialog.getByRole("heading").first().textContent())?.trim() ?? "";
    if (heading === wanted) break;
    const back = new Date(`${heading} 1`) > target;
    // `.first()` because React Aria renders a second, visually-hidden stepper for screen readers;
    // both carry the same accessible name and a bare match is a strict-mode violation.
    await dialog.getByRole("button", { name: back ? "Previous" : "Next" }).first().click();
  }

  // Cells are buttons whose accessible name is the FULL date — "Wednesday, August 5, 2026" — not
  // the bare day number. Matching on the number alone finds nothing, and matching loosely would
  // hit "5" inside "15" and "25". Verified against the rendered DOM.
  const label = target.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  await dialog.getByRole("button", { name: label, exact: true }).click();

  // A single-date picker commits on click and closes. Waiting for that is not politeness: the
  // popover carries its own "Today" button, so while it is open every page-level lookup for one is
  // ambiguous — and a picker that silently stays open would be a real bug worth failing on.
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}
