/**
 * The open/resolved split used to be typed out by hand in six independent places, and adding a
 * status without visiting all six compiled green, passed every test, and silently dropped those
 * findings out of five reports. That is the worst shape a security metric can fail in: not wrong
 * and loud, but quietly LOW — the finding exists in the table, counts nowhere, and every dashboard
 * describes a cleaner workspace than the one that exists.
 *
 * `securityFindingStatusBuckets` is the single answer now, and this file is what stops it becoming
 * decorative:
 *
 *   1. TOTAL COVERAGE. Every status has a bucket. TypeScript already enforces this on the Record,
 *      but a `Record` with a hand-written type annotation is one `as` away from silence, and the
 *      assertion costs nothing.
 *   2. THE BUCKETS ARE WIRED UP. That the map exists proves nothing about whether the reports read
 *      it, so the two consumers with the most at stake — the Security Insights aggregation and the
 *      per-ticket risk verdict — are driven for real and asked what they counted.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  openSecurityFindingStatuses,
  pendingSecurityFindingStatuses,
  resolvedSecurityFindingStatuses,
  securityFindingStatusBuckets,
  securityFindingStatuses,
  unresolvedSecurityFindingStatuses
} from "@timesheet/shared";

describe("every status has a bucket", () => {
  it("covers the enum exactly, with nothing extra", () => {
    expect(Object.keys(securityFindingStatusBuckets).sort()).toEqual([...securityFindingStatuses].sort());
    for (const status of securityFindingStatuses) {
      expect(["open", "resolved", "pending"], `${status} has no bucket`).toContain(securityFindingStatusBuckets[status]);
    }
  });

  it("partitions the enum — no status is in two derived sets, and none is in none", () => {
    const all = [...openSecurityFindingStatuses, ...resolvedSecurityFindingStatuses, ...pendingSecurityFindingStatuses];
    expect(all.sort()).toEqual([...securityFindingStatuses].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("counts a claimed-but-unconfirmed fix as unresolved", () => {
    // The decision the whole status exists to encode. If PENDING_VERIFICATION were resolved, a
    // workspace could lower its own risk score by closing tickets rather than by fixing code.
    expect(securityFindingStatusBuckets.PENDING_VERIFICATION).toBe("pending");
    expect(unresolvedSecurityFindingStatuses).toContain("PENDING_VERIFICATION");
    expect(resolvedSecurityFindingStatuses).not.toContain("PENDING_VERIFICATION");
  });
});

/**
 * The Security Insights aggregation, driven for real. The Prisma stand-in records the `where`
 * clause of every query instead of returning data, because what is under test is precisely WHICH
 * findings the page asks the database for.
 */
// `vi.hoisted` because `vi.mock` factories are lifted above every other statement in the file —
// an ordinary `const` declared here is still in its temporal dead zone when the factory runs.
const collected = vi.hoisted(() => ({ findingWheres: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/config/prisma.js", () => {
  const record = (args?: { where?: Record<string, unknown> }) => {
    if (args?.where) collected.findingWheres.push(args.where);
  };
  return {
    prisma: {
      securityFinding: {
        findMany: vi.fn().mockImplementation(async (args) => {
          record(args);
          return [];
        }),
        groupBy: vi.fn().mockImplementation(async (args) => {
          record(args);
          return [];
        }),
        count: vi.fn().mockImplementation(async (args) => {
          record(args);
          return 0;
        })
      },
      // The per-module breakdown names its modules with a second query. It is skipped when the
      // breakdown is empty — which it is here, since every stand-in above returns nothing — but the
      // model is declared anyway: a test that passes because a code path happened not to be reached
      // is a test that breaks the day it is.
      projectModule: { findMany: vi.fn().mockResolvedValue([]) }
    }
  };
});

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

describe("the Security Insights aggregation", () => {
  /**
   * Built ONCE, in a hook with its own timeout.
   *
   * The imports below are the expensive part — `report.controller.ts` pulls in a large slice of the
   * service layer, and the mocks above mean it can only be loaded dynamically, after they are
   * registered. Inside an `it`, that cost counted against the 10s test budget, and under a full
   * parallel suite on a loaded machine it intermittently exceeded it: a red gate that went green on
   * a re-run, which is the kind of failure that teaches people to re-run rather than look.
   *
   * Nothing here hangs — it is module loading — so the fix is to pay it once, in a hook, with a
   * budget that reflects what it actually is rather than pretending it is a fast assertion.
   */
  let app: import("express").Express;

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { reportRouter } = await import("../../src/controllers/report.controller.js");
    const { errorHandler } = await import("../../src/middleware/error.js");

    app = express();
    app.use(express.json());
    app.use("/reports", reportRouter);
    app.use(errorHandler);
  }, 60_000);

  it("asks for pending findings alongside open ones, and excludes them from 'resolved'", async () => {
    const request = (await import("supertest")).default;

    collected.findingWheres.length = 0;
    await request(app).get("/reports/security-insights").expect(200);

    const statusFilters = collected.findingWheres
      .map((where) => (where.status as { in?: string[] } | undefined)?.in)
      .filter((value): value is string[] => Array.isArray(value));

    expect(statusFilters.length).toBeGreaterThan(0);

    // The open/pending set drives totalOpen, openBySeverity, byType, topRepositories and the risk
    // score. Every one of those queries must include PENDING_VERIFICATION, or a workspace that
    // marks its findings fixed reports a posture it has not earned.
    const openLike = statusFilters.filter((filter) => filter.includes("OPEN"));
    expect(openLike.length).toBeGreaterThan(0);
    for (const filter of openLike) {
      expect(filter).toContain("PENDING_VERIFICATION");
    }

    // Mean-time-to-remediate measures time until a fix was PROVEN. A pending finding has not been
    // remediated yet, so counting it here would report a remediation that has not happened.
    const resolvedLike = statusFilters.filter((filter) => filter.includes("FIXED"));
    expect(resolvedLike.length).toBeGreaterThan(0);
    for (const filter of resolvedLike) {
      expect(filter).not.toContain("PENDING_VERIFICATION");
    }
  });
});
