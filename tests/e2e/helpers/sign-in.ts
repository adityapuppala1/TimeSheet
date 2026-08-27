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
import { waitForApiReady } from "./api-ready";

export const DEMO_PASSWORD = "Admin@12345";

export const DEMO_USERS = {
  superadmin: "superadmin@timesheet.local",
  manager: "manager@timesheet.local",
  employee: "employee@timesheet.local"
} as const;

export type DemoRole = keyof typeof DEMO_USERS;

/** Signs in and waits for the app shell. Leaves the page on `/app`. */
export async function signIn(page: Page, role: DemoRole = "superadmin"): Promise<void> {
  const submit = async () => {
    // `?switch=1`, NOT a bare /login. As of 3.7.0 the sign-in page redirects anybody who already
    // holds a session straight into the app — which is the fix for "signing in when you are already
    // signed in asks for your password again", and which broke this helper the moment it shipped:
    // a spec that signs in twice (to change role, or after its own navigation) found no Email field
    // to fill and timed out. `switch=1` is the documented escape hatch for exactly this case —
    // deliberately signing in as somebody else while a session exists — so the helper uses it
    // unconditionally rather than trying to guess whether one is live.
    await page.goto("/login?switch=1");
    await page.getByLabel("Email", { exact: true }).fill(DEMO_USERS[role]);
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    // EXACT, not /sign in/i. The loose regex also matches "Sign in with LDAP", so the moment an
    // admin enables LDAP on the workspace this suite runs against, every sign-in in the suite fails
    // with a strict-mode violation — which is what happened, and which reads as a broken test
    // rather than as a workspace-configuration change.
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  };

  await submit();
  try {
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  } catch (error) {
    // Still on /login. Either the credentials are wrong — in which case the retry fails the same
    // way and the original error stands — or the API was unreachable when the POST went out. The
    // second is routine against a `reuseExistingServer` dev stack: `tsx watch` restarts on every
    // save under apps/api/src, and the Vite proxy answers 502 for the second or two it is down,
    // which surfaces here as a login that silently did nothing. See helpers/api-ready.ts.
    if (!(await waitForApiReady(page.request))) throw error;
    await submit();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  }
}

/**
 * Mints ONE access token for the signed-in session and asserts it worked.
 *
 * Call this before any `page.goto` into `/app`: the app's own bootstrap spends a refresh on first
 * paint, so a token taken afterwards races the page for the same single-use cookie. Take it once
 * and thread it through — a second call later in the same test will fail for the reason above.
 */
export async function accessToken(page: Page): Promise<Record<string, string>> {
  let res = await page.request.post("/api/auth/refresh");
  // A 5xx is the API being unreachable, not a rejected session — the dev server restarting under
  // `tsx watch` is the routine cause, and the proxy's 502 has an EMPTY body, so calling `.json()`
  // on it fails with "Unexpected end of JSON input" pointing at the test rather than the cause.
  // See helpers/api-ready.ts. A rotated-away cookie still 401s and still fails, as it should.
  if (res.status() >= 500) {
    await waitForApiReady(page.request);
    res = await page.request.post("/api/auth/refresh");
  }
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

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  /**
   * Turns "August 2026" into a comparable number.
   *
   * NOT `new Date(heading)`. "August 2026" is not a format the spec requires engines to parse:
   * Chromium accepts it, WebKit returns Invalid Date. Every comparison against an invalid date is
   * false, so the direction logic always chose "Next", walked forward to the picker's maxValue,
   * and then waited forever on a stepper that had correctly become disabled — a 30-second timeout
   * pointing at the button rather than at the parsing.
   */
  const monthIndex = (heading: string): number => {
    // The heading is NOT bare "August 2026" — React Aria prefixes it with the calendar's own
    // accessible name, giving "Pick a day, August 2026". Splitting on whitespace therefore read
    // "Pick" as the month, produced NaN, and every comparison against NaN is false: the loop
    // always stepped forward, hit the picker's maxValue, and waited out the timeout on a stepper
    // that had correctly disabled itself. Anchor to the END of the string instead.
    const match = heading.match(/([A-Za-z]+)\s+(\d{4})\s*$/);
    if (!match) throw new Error(`could not read a month from the calendar heading: "${heading}"`);
    return Number(match[2]) * 12 + MONTHS.indexOf(match[1]);
  };
  const wantedIndex = target.getFullYear() * 12 + target.getMonth();

  // Bounded so a broken stepper fails fast rather than spinning for the whole timeout.
  for (let i = 0; i < 60; i += 1) {
    const heading = (await dialog.getByRole("heading").first().textContent())?.trim() ?? "";
    const current = monthIndex(heading);
    if (current === wantedIndex) break;
    // `.first()` because React Aria renders a second, visually-hidden stepper for screen readers;
    // both carry the same accessible name and a bare match is a strict-mode violation.
    await dialog.getByRole("button", { name: current > wantedIndex ? "Previous" : "Next" }).first().click();
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
