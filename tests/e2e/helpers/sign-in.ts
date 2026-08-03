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
