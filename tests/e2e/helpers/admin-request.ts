/**
 * A superadmin-authenticated API context for test CLEANUP.
 *
 * WHY this exists: tests/e2e/tickets.spec.ts runs as a MANAGER, deliberately, because that's the
 * role whose ticket workflow it exercises. But `tickets:manage` — the permission `DELETE
 * /api/tickets/:id` requires — is granted only to ADMIN and SUPER_ADMIN. So its cleanup call had
 * been returning 403 on every single run since it was written, and because the response was never
 * checked, the suite stayed green while 61 smoke-test tickets piled up in the demo workspace.
 *
 * Two lessons are baked in here:
 *  1. Cleanup must run as an identity that is actually ALLOWED to clean up. Reusing the test's own
 *     session is convenient and wrong the moment the test's role is narrower than the teardown.
 *  2. Cleanup must be ASSERTED. An unchecked teardown is indistinguishable from a working one, so
 *     `expectCleanupOk` fails the test loudly rather than leaking rows quietly.
 *
 * The login is cached per worker process for the same reason face-gate.ts caches its own:
 * `/api/auth/login` is rate-limited to 20/min, and a fresh login per spec per viewport project
 * trips it — surfacing as an unparseable "Too many requests" body rather than an obvious 429.
 */
import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";

import { E2E_BASE_URL as BASE_URL } from "./base-url";
import { waitForApiReady } from "./api-ready";
/** Access tokens last ~15m; refresh well inside that but rarely enough to stay under the limiter. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

let cachedToken: { value: string; obtainedAt: number } | null = null;

/** Runs `fn` with a short-lived superadmin context, disposing it afterwards either way. */
export async function withAdminRequest<T>(
  fn: (ctx: APIRequestContext, headers: Record<string, string>) => Promise<T>
): Promise<T> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  try {
    if (!cachedToken || Date.now() - cachedToken.obtainedAt > TOKEN_TTL_MS) {
      let res = await ctx.post("/api/auth/login", {
        data: { email: "superadmin@timesheet.local", password: "Admin@12345" }
      });
      // A 5xx here is the API being unreachable, not a rejected credential — and against a
      // `reuseExistingServer` dev stack the usual cause is `tsx watch` restarting because somebody
      // saved a file. Wait for the liveness probe (a real readiness condition, on a budget) and
      // try once more; a genuinely dead API still fails, with the status it actually returned.
      if (res.status() >= 500) {
        await waitForApiReady(ctx);
        res = await ctx.post("/api/auth/login", {
          data: { email: "superadmin@timesheet.local", password: "Admin@12345" }
        });
      }
      if (!res.ok()) throw new Error(`admin-request helper could not sign in as superadmin: ${res.status()}`);
      cachedToken = { value: (await res.json()).accessToken, obtainedAt: Date.now() };
    }
    return await fn(ctx, { Authorization: `Bearer ${cachedToken.value}`, "Content-Type": "application/json" });
  } finally {
    await ctx.dispose();
  }
}

/**
 * Asserts a teardown call actually succeeded.
 *
 * 404 is NOT accepted, and that is the whole point. Accepting it seems reasonable ("the row was
 * already gone") but it is exactly what hid the second bug in this story: `DELETE /api/timesheets/:id`
 * did not exist as a route at all, so Express answered 404, the helper called that success, and the
 * drafts kept accumulating. A teardown that cannot tell "already clean" from "there is no such
 * endpoint" is not a teardown.
 *
 * Callers that genuinely tolerate an absent row should check for it first, or assert the
 * postcondition with `expectGone` below.
 */
export function expectCleanupOk(status: number, what: string): void {
  expect([200, 204], `cleanup of ${what} returned ${status} — the row may still be in the demo workspace`).toContain(status);
}

/** Verifies the row is actually gone — the postcondition, rather than a status code that only
 *  claims it is. Use after a delete whose success genuinely matters. */
export async function expectGone(fetchRow: () => Promise<unknown>, what: string): Promise<void> {
  expect(await fetchRow(), `${what} still exists after cleanup`).toBeFalsy();
}

/** Deletes a ticket as superadmin and asserts it worked. */
export async function deleteTicket(ticketId: string): Promise<void> {
  await withAdminRequest(async (ctx, headers) => {
    const res = await ctx.delete(`/api/tickets/${ticketId}`, { headers });
    expectCleanupOk(res.status(), `ticket ${ticketId}`);
  });
}

/**
 * Removes drafts left behind by earlier runs of the timesheet smoke test.
 *
 * WHY a test needs this at all: that spec always books the SAME slot (09:00–10:00 today), and the
 * API correctly refuses overlapping entries. So a single leaked draft poisoned every subsequent
 * run on the same day — the save was rejected, nothing was created, the cleanup found nothing to
 * delete, and the old loose text assertion passed anyway. One missed teardown turned into a test
 * that could never pass again that day, silently.
 *
 * Sweeping first makes the spec self-healing rather than dependent on every previous run having
 * exited cleanly. It only ever removes rows matching the smoke-test marker — never real data.
 */
export async function sweepLeftoverTimesheetDrafts(userEmail: string, marker: string): Promise<number> {
  return withAdminRequest(async (ctx, headers) => {
    const users: Array<{ id: string; email: string }> = await (await ctx.get("/api/users", { headers })).json();
    const user = users.find?.((u) => u.email === userEmail);
    if (!user) return 0;

    const rows: Array<{ id: string; taskDescription: string | null }> = await (
      await ctx.get(`/api/timesheets?status=DRAFT&userId=${user.id}`, { headers })
    ).json();
    const stale = rows.filter((r) => r.taskDescription?.includes(marker));

    for (const row of stale) {
      const res = await ctx.delete(`/api/timesheets/${row.id}`, { headers });
      expectCleanupOk(res.status(), `leftover timesheet draft ${row.id}`);
    }
    return stale.length;
  });
}
