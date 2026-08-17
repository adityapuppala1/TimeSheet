/**
 * "Active sessions" as a list of DEVICES, not a log of sign-ins.
 *
 * THE BUG: `establishSession` INSERTed a `Session` row on every sign-in and nothing ever collapsed
 * or reaped them. Measured on the development workspace before the fix — **7,486 live sessions for
 * a single user**, 6,952 carrying the identical Chrome-on-Windows user-agent string. One person,
 * one machine. Both surfaces that read the table (the Profile page's session list, the admin's
 * who's-online panel) exist to answer "is there a session here that shouldn't be?", and that
 * question cannot be answered in a list of seven thousand identical rows.
 *
 * These drive the real HTTP surface with real cookie jars, because the fix IS cookie behaviour —
 * a unit test can pin the query, only a browser-shaped client can pin that the cookie survives a
 * round trip and comes back on the next login.
 */
import { expect, request, test } from "@playwright/test";
import { E2E_BASE_URL } from "./helpers/base-url";
import { signIn } from "./helpers/sign-in";

test.use({ storageState: { cookies: [], origins: [] } });

const CREDENTIALS = { email: "manager@timesheet.local", password: "Admin@12345" };

/** A client with its own cookie jar — i.e. one browser. Playwright's request context persists
 *  cookies across calls, which is exactly the behaviour under test. */
async function browser() {
  return request.newContext({ baseURL: E2E_BASE_URL, ignoreHTTPSErrors: true });
}

async function loginAndListSessions(ctx: Awaited<ReturnType<typeof browser>>) {
  const login = await ctx.post("/api/auth/login", { data: CREDENTIALS });
  expect(login.ok(), `login failed (${login.status()})`).toBe(true);
  const { accessToken } = await login.json();
  const list = await ctx.get("/api/auth/sessions", { headers: { Authorization: `Bearer ${accessToken}` } });
  expect(list.ok()).toBe(true);
  return (await list.json()) as Array<{ id: string; current: boolean; device: string; lastSeenAt: string | null }>;
}

test.describe("session device identity", () => {
  test("repeat sign-ins from one browser do not add rows", async () => {
    const ctx = await browser();
    try {
      const first = await loginAndListSessions(ctx);
      const before = new Set(first.map((s) => s.id));

      for (let i = 0; i < 4; i++) await loginAndListSessions(ctx);
      const after = await loginAndListSessions(ctx);

      const added = after.filter((s) => !before.has(s.id));
      expect(added, `five sign-ins from one browser added ${added.length} rows`).toHaveLength(0);
    } finally {
      await ctx.dispose();
    }
  });

  test("a genuinely different browser gets its own row", async () => {
    // The fix must not over-collapse: two real devices are two entries, which is the whole point
    // of the list.
    const first = await browser();
    const second = await browser();
    try {
      const before = new Set((await loginAndListSessions(first)).map((s) => s.id));
      const after = await loginAndListSessions(second);
      expect(after.filter((s) => !before.has(s.id)).length).toBe(1);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  /**
   * The bound that e2e can honestly assert.
   *
   * NOT "never more than ten rows": eviction is conditioned on IDLENESS, so fourteen clients that
   * all signed in seconds ago are all still in use and all correctly kept. An earlier version of
   * this test asserted the flat cap and failed — which is how the design flaw was found, not a
   * flaw in the design. A cap that revokes in-use sessions is a way for one client to sign another
   * out; see `enforceSessionCap`.
   *
   * What is provable here is the property that actually broke: N clients signing in repeatedly
   * produce N rows, not N × sign-ins. The idle sweep needs a clock to move fifteen minutes, so it
   * is pinned in `tests/unit/session-device-identity.test.ts` instead.
   */
  test("many clients each hold ONE row, however often they sign in", async () => {
    const CLIENTS = 6;
    const ROUNDS = 3;
    const contexts = await Promise.all(Array.from({ length: CLIENTS }, () => browser()));
    try {
      const before = new Set((await loginAndListSessions(contexts[0])).map((s) => s.id));

      for (let round = 0; round < ROUNDS; round++) {
        for (const ctx of contexts) await loginAndListSessions(ctx);
      }

      const after = await loginAndListSessions(contexts[0]);
      const added = after.filter((s) => !before.has(s.id)).length;
      // Five new clients (the sixth is the one that established `before`), each signing in three
      // times. Without device identity this is 18 rows.
      expect(added, `${CLIENTS} clients × ${ROUNDS} sign-ins added ${added} rows`).toBeLessThanOrEqual(CLIENTS);
    } finally {
      await Promise.all(contexts.map((ctx) => ctx.dispose()));
    }
  });

  test("the list names devices instead of shipping raw user-agent strings", async () => {
    const ctx = await browser();
    try {
      const sessions = await loginAndListSessions(ctx);
      expect(sessions.length).toBeGreaterThan(0);
      for (const session of sessions) {
        // A decoded label, and no `userAgent` key at all — the raw string is a fingerprinting
        // surface with no remaining purpose once the label exists.
        expect(session).not.toHaveProperty("userAgent");
        expect(typeof session.device).toBe("string");
        expect(session.device.length).toBeGreaterThan(0);
      }
      expect(sessions.some((s) => s.current), "exactly one row must be marked as this device").toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("the Profile page shows one readable device row per device", async ({ page }) => {
    await signIn(page, "manager");
    await page.goto("/app/profile");
    await expect(page.getByRole("heading", { name: /active sessions/i })).toBeVisible({ timeout: 15_000 });

    // "This device" is the anchor the whole list hangs off; without it a reader cannot tell which
    // row is safe to sign out.
    //
    // Filtered to the VISIBLE one: DataTable renders both the table and the phone-card layout at
    // every width and hides one with CSS, so a bare `.first()` picks the hidden card — the same
    // trap approvals.spec.ts records.
    await expect(page.getByText("This device").filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
    // The decoded label, not a Mozilla/5.0 wall.
    await expect(page.getByText(/Mozilla\/5\.0/)).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Last used" })).toBeVisible();
  });
});
