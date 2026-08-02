/**
 * Lets a spec create timesheets/tickets through the API even when the workspace has face
 * (identity) verification switched ON.
 *
 * WHY this exists: face verification is a real, shippable configuration — once an admin enables
 * it with `enforcementMode: ALL`, every `POST /api/tickets` and timesheet submit returns **428**
 * without a fresh face capture, which a headless browser cannot produce. Specs that build their
 * own fixtures then fail with symptoms that look nothing like the cause (a ticket detail sheet
 * whose ticket never loads, a dashboard timeline that stays empty), so the suite must neutralise
 * the gate explicitly rather than silently depend on the feature being off.
 *
 * The snapshot/restore shape is deliberately the same one `scripts/verify-face-e2e.ts` uses:
 * settings are WORKSPACE-WIDE, so a spec that changes them and doesn't put every field back
 * leaves the workspace in a state its owner never chose — and breaks unrelated suites.
 *
 * TWO Playwright-specific constraints are baked in here, both learned the hard way:
 *  1. It owns its own APIRequestContext instead of taking the `request` fixture — a fixture
 *     captured in `beforeAll` cannot legally be reused in `afterAll` ("Fixture { request } from
 *     beforeAll cannot be reused in a test").
 *  2. The superadmin login is cached per worker process. `/api/auth/login` is rate-limited to
 *     20/min, and this helper runs once per spec file PER viewport project — a fresh login each
 *     time tripped that limiter and surfaced as an unparseable "Too many requests" body.
 */
import type { APIRequestContext } from "@playwright/test";
import { withAdminRequest } from "./admin-request";

export interface FaceGateSnapshot {
  restore: () => Promise<void>;
}

/**
 * Delegates to the ONE cached superadmin login in admin-request.ts.
 *
 * This file used to keep its own identical cache, and for a while both existed — which quietly
 * doubled superadmin logins across the suite. `/api/auth/login` is rate-limited to 20/min and this
 * suite runs every spec across five viewport projects, so the second cache pushed it close enough
 * to the limit to matter: a 429 there surfaces as a fixture that silently fails to be created,
 * and then as a test failure pointing at whatever the fixture was for.
 */
async function withContext<T>(fn: (ctx: APIRequestContext, headers: Record<string, string>) => Promise<T>): Promise<T> {
  return withAdminRequest(fn);
}

/**
 * Turns enforcement off for the duration of a spec and hands back a `restore()` that puts every
 * field back exactly as it was. No-ops harmlessly when the feature is already off.
 */
export async function suspendFaceGate(): Promise<FaceGateSnapshot> {
  return withContext(async (ctx, headers) => {
    const original = await (await ctx.get("/api/settings/face-verification", { headers })).json();
    if (!original?.enabled) return { restore: async () => undefined };

    await ctx.patch("/api/settings/face-verification", {
      headers,
      data: { requireForTimesheet: false, requireForTicket: false, requireForApproval: false }
    });

    return {
      restore: () =>
        withContext(async (restoreCtx, restoreHeaders) => {
          await restoreCtx.patch("/api/settings/face-verification", {
            headers: restoreHeaders,
            data: {
              requireForTimesheet: original.requireForTimesheet,
              requireForTicket: original.requireForTicket,
              requireForApproval: original.requireForApproval
            }
          });
        })
    };
  });
}
