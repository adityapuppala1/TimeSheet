/**
 * Every face/identity alert goes to somebody who can open the page it links to, and opens the
 * right tab when they do.
 *
 * THE DEFECT (audit 2026-10, notifications #2): the flagged-check alert, the review-overdue nudge,
 * the weekly identity digest and the entitlement-lost notice all linked to a bare `/app/settings`,
 * and were sent to every ADMIN (and, for a flagged check, the person's manager). Workspace Settings
 * is SUPER_ADMIN-only (App.tsx RequireRole), so an ADMIN or manager clicking through landed on the
 * home page with no route to the log they were being chased about — and a SUPER_ADMIN landed on the
 * Reminders tab, the page's default, not the review log; "Review plan & billing" opened Reminders too.
 *
 * THE CHOICE: send these to SUPER_ADMIN only, linking to `?tab=face-verification` (or `?tab=billing`
 * for the entitlement notice). Exposing the review log to ADMIN would mean loosening a page that is
 * documented and gated as SUPER_ADMIN-only in three places, whose face card reads a super-admin-only
 * settings endpoint — not a clean per-tab gate. So the alerts stop going where they cannot be acted on.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  people: [
    { id: "sa-1", name: "Sam Super", role: "SUPER_ADMIN" },
    { id: "ad-1", name: "Ada Admin", role: "ADMIN" },
    { id: "mg-1", name: "Mo Manager", role: "MANAGER" }
  ],
  allowed: true,
  settings: {} as Record<string, unknown>
}));

/** Users filtered by the `role.name` predicate the producers write — `in` or equality. */
function byRole(where: any) {
  const name = where?.role?.name;
  return state.people
    .filter((p) => (typeof name === "string" ? p.role === name : name?.in ? name.in.includes(p.role) : true))
    .map((p) => ({ id: p.id, name: p.name }));
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async (args: any) => byRole(args?.where)) },
    globalFaceVerificationSettings: { update: vi.fn(async () => ({})) },
    faceEnrollment: { count: vi.fn(async () => 3), findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({})) },
    faceVerificationAttempt: {
      findMany: vi.fn(async (args: any) =>
        args?.where?.createdAt?.gte ? [{ userId: "e-1", outcome: "NO_MATCH", virtualCameraSuspected: false, unfamiliarNetwork: false }] : []
      ),
      findFirst: vi.fn(async () => ({ createdAt: new Date(Date.now() - 72 * 3_600_000) })),
      count: vi.fn(async () => 2),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    notification: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    faceChallenge: { deleteMany: vi.fn(async () => ({})) }
  }
}));
vi.mock("../../src/config/tenant-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/config/tenant-context.js")>("../../src/config/tenant-context.js");
  return { ...actual, requireTenantContext: () => ({ orgSlug: "acme" }) };
});
vi.mock("../../src/services/face.service.js", () => ({
  getFaceSettings: vi.fn(async () => state.settings),
  isFaceFeatureAllowedForOrg: vi.fn(async () => state.allowed),
  findCoveredUnenrolledUserIds: vi.fn(async () => []),
  notifyEnrollmentRequired: vi.fn(async () => 0),
  removeUserFaceDirectories: vi.fn(async () => undefined),
  autoTriageHonestFailures: vi.fn(async () => ({ resolved: 0 }))
}));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn(async () => undefined) }));

const { sweepEntitlement, runFaceLifecycleSweep } = await import("../../src/workers/face-retention.worker.js");
const { runIdentityWeeklyDigest } = await import("../../src/workers/identity-weekly-digest.worker.js");
const { templates } = await import("../../src/services/mail-templates.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");

const sent = (category: string) => vi.mocked(dispatchNotification).mock.calls.map((c) => c[0]).filter((n) => n.category === category);

beforeEach(() => {
  vi.mocked(dispatchNotification).mockClear();
  state.allowed = true;
  state.settings = { id: "s-1", enabled: true, entitlementLostAt: null, imageRetentionDays: 30, autoTriageHonestFailures: false };
});

describe("who is told, and where they are sent", () => {
  it("entitlement lost: super admins only, linked to the Billing tab", async () => {
    state.allowed = false;
    expect((await sweepEntitlement()).state).toBe("grace-started");
    const notices = sent("face.entitlement_lost");
    expect(notices.map((n) => n.userId)).toEqual(["sa-1"]);
    expect(notices[0].link).toBe("/app/settings?tab=billing");
  });

  it("review overdue: super admins only, linked to the face verification tab", async () => {
    await runFaceLifecycleSweep();
    const nudges = sent("face.review_overdue");
    expect(nudges.map((n) => n.userId)).toEqual(["sa-1"]);
    expect(nudges[0].link).toBe("/app/settings?tab=face-verification");
  });

  it("weekly identity digest: super admins only, linked to the face verification tab", async () => {
    await runIdentityWeeklyDigest(new Date("2026-10-05T04:30:00.000Z"));
    const digests = sent("digest.identity_weekly");
    expect(digests.map((n) => n.userId)).toEqual(["sa-1"]);
    expect(digests[0].link).toBe("/app/settings?tab=face-verification");
  });
});

describe("the emails' buttons open the same tabs", () => {
  it("links the review emails to the face verification tab", () => {
    for (const html of [
      templates.faceVerificationFlagged({ targetName: "Sam", employeeName: "Eve", failureCount: 3, context: "TIMESHEET" }),
      templates.faceReviewOverdue({ targetName: "Sam", pendingCount: 2, oldestAgeHours: 50 }),
      templates.identityWeeklyDigest({ targetName: "Sam", weekLabel: "2026-09-28", total: 4, passed: 2, failed: 2, flaggedPending: 1, notes: "" })
    ]) {
      expect(html).toContain("/app/settings?tab=face-verification");
    }
  });

  it("links the entitlement email to the Billing tab", () => {
    expect(templates.faceEntitlementLost({ targetName: "Sam", graceDays: 30 })).toContain("/app/settings?tab=billing");
  });
});

describe("no identity alert links a bare /app/settings", () => {
  // Line endings normalised: these files are CRLF in some checkouts and LF in others.
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("in any of its producers, including the flagged-check alert in face.controller.ts", () => {
    for (const file of [
      "../../src/controllers/face.controller.ts",
      "../../src/workers/face-retention.worker.ts",
      "../../src/workers/identity-weekly-digest.worker.ts"
    ]) {
      expect(read(file), file).not.toMatch(/link:\s*"\/app\/settings"/);
    }
  });

  it("names tabs the settings page really has", () => {
    const tabs = read("../../../web/src/utils/settings-tabs.ts");
    expect(tabs).toContain('"face-verification"');
    expect(tabs).toContain('"billing"');
  });

  it("sends the flagged-check alert to the super admins, not to every admin and the manager", () => {
    const source = read("../../src/controllers/face.controller.ts");
    const notify = source.slice(source.indexOf("async function notifyFlagged"));
    const body = notify.slice(0, notify.indexOf("\n}\n") + 3);
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/managerId/);
  });
});
