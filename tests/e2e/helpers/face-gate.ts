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
 * WHY THE REFERENCE COUNT ON DISK (added after it bit during the V6 phase-3 run): the settings
 * are one shared workspace row, but `beforeAll`/`afterAll` run once per spec file PER PROJECT,
 * and `test:e2e:responsive` runs four projects across two workers — which are separate OS
 * processes. Two of them suspend, the first to finish restores, and the second's fixture
 * creation starts 428ing halfway through its own run. The failure is intermittent and points at
 * whatever the fixture was for, never at this file. An in-process counter cannot fix it because
 * the racers are different processes, so the count lives in a lock directory and only the LAST
 * holder restores.
 *
 * TWO Playwright-specific constraints are also baked in here, both learned the hard way:
 *  1. It owns its own APIRequestContext instead of taking the `request` fixture — a fixture
 *     captured in `beforeAll` cannot legally be reused in `afterAll` ("Fixture { request } from
 *     beforeAll cannot be reused in a test").
 *  2. The superadmin login is cached per worker process. `/api/auth/login` is rate-limited to
 *     20/min, and this helper runs once per spec file PER viewport project — a fresh login each
 *     time tripped that limiter and surfaced as an unparseable "Too many requests" body.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { withAdminRequest } from "./admin-request";

export interface FaceGateSnapshot {
  restore: () => Promise<void>;
}

interface FaceSettingsSnapshot {
  requireForTimesheet: boolean;
  requireForTicket: boolean;
  requireForApproval: boolean;
}

/** Under test-results/ so a clean checkout and a wiped report directory both start from nothing. */
const LOCK_DIR = path.resolve(process.cwd(), "test-results", ".face-gate-lock");
const SNAPSHOT_FILE = path.join(LOCK_DIR, "original.json");
const LEADER_DIR = path.join(LOCK_DIR, ".leader");

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

function claimCount(): number {
  try {
    return readdirSync(LOCK_DIR).filter((f) => f.endsWith(".claim")).length;
  } catch {
    return 0;
  }
}

/** `mkdir` is atomic and fails when the directory already exists, so exactly one process can win
 *  it. That is what makes "who takes the snapshot" unambiguous across processes without needing a
 *  real lock service. */
function tryBecomeLeader(): boolean {
  try {
    mkdirSync(LEADER_DIR);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the leader to finish disabling, so a follower never starts creating fixtures against
 *  settings that are still mid-write. Bounded: a hung leader must not hang the whole suite — the
 *  follower proceeds and, at worst, sees the failure it would have seen without any of this. */
async function waitForSnapshot(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(SNAPSHOT_FILE, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Turns enforcement off for the duration of a spec and hands back a `restore()` that puts every
 * field back exactly as it was — but only once every concurrent holder has released. No-ops
 * harmlessly when the feature is already off and nobody else is holding it down.
 */
export async function suspendFaceGate(): Promise<FaceGateSnapshot> {
  return withContext(async (ctx, headers) => {
    const current = await (await ctx.get("/api/settings/face-verification", { headers })).json();

    // Genuinely nothing to do: the feature is off and no other worker has suspended it. The
    // second half of that condition matters — "off" during another worker's suspension is not
    // the same fact as "off because this workspace doesn't use it".
    if (!current?.enabled && claimCount() === 0) {
      return { restore: async () => undefined };
    }

    mkdirSync(LOCK_DIR, { recursive: true });
    const claim = path.join(LOCK_DIR, `${process.pid}-${randomUUID()}.claim`);
    writeFileSync(claim, String(Date.now()));

    if (tryBecomeLeader()) {
      // First in: record the real pre-suspension state for everyone, then disable.
      const original: FaceSettingsSnapshot = {
        requireForTimesheet: Boolean(current?.requireForTimesheet),
        requireForTicket: Boolean(current?.requireForTicket),
        requireForApproval: Boolean(current?.requireForApproval)
      };
      writeFileSync(SNAPSHOT_FILE, JSON.stringify(original));
      await ctx.patch("/api/settings/face-verification", {
        headers,
        data: { requireForTimesheet: false, requireForTicket: false, requireForApproval: false }
      });
    } else {
      await waitForSnapshot();
    }

    return {
      restore: async () => {
        // Drop our own claim FIRST, then look. The other order lets two finishers both see "one
        // claim left besides me" and both decline to restore, leaving the gate off forever.
        rmSync(claim, { force: true });
        if (claimCount() > 0) return;

        let original: FaceSettingsSnapshot;
        try {
          original = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
        } catch {
          // No snapshot means nothing was ever disabled, or another finisher already restored and
          // cleaned up. Either way there is nothing to put back.
          return;
        }

        await withContext(async (restoreCtx, restoreHeaders) => {
          await restoreCtx.patch("/api/settings/face-verification", { headers: restoreHeaders, data: original });
        });
        rmSync(LOCK_DIR, { recursive: true, force: true });
      }
    };
  });
}
