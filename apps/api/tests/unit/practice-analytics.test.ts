/**
 * The derived half of the Weekly AI/ML Practice Update — the rates, ages and ratios a director
 * reads, and the four ways they can each be confidently wrong.
 *
 * WHY THIS FILE IS MOSTLY ABOUT NULLS. Every percentage in this report is a division, and every
 * division has a denominator that can be zero. "0% delivered on time" and "nothing had a due date"
 * render identically if the code is careless, and they are opposite sentences: the first is a
 * failure a director will act on, the second means the team is not tracking dates. A fixture full
 * of ones and twos will never catch that, so the honesty rule is asserted directly, per rate.
 *
 * THE THREE FIGURES MOST LIKELY TO SHIP WRONG, and each has a block below:
 *
 *   1. THE BACKLOG. A plain "currently open" count returns the same number for this period and for
 *      the one before it, so the email prints "unchanged" every single week — a confident statement
 *      about a trend that was never measured. It is reconstructed from dates instead, and the test
 *      drives two different periods over one fixture to prove they differ.
 *   2. THE TWO TEST PASS RATES. Runs and assertions disagree on real data: 2 of 7 suites green
 *      while 62 of 64 tests are. Both are right, and a reader shown one number concludes the other
 *      is a bug. Both are computed, and the test pins that they can legitimately diverge.
 *   3. WHAT A DENOMINATOR INCLUDES. On-time counts only closures that HAD a due date; change
 *      success counts only changes with a RECORDED outcome; the run rate excludes suites still
 *      RUNNING. Each of those exclusions is a decision, and each is asserted rather than assumed.
 *
 * The Prisma stand-in returns fixture rows and records nothing about how they were asked for: what
 * is under test is the arithmetic, not the query shape. Where the query shape IS the behaviour —
 * the period-scoped audit read, the deactivated-people filter — the fixture is filtered by the same
 * predicate the code sends, so a dropped `where` clause changes the answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tickets: [] as Array<Record<string, unknown>>,
  audits: [] as Array<{ entityId: string; metadata: unknown; createdAt: Date }>,
  testRuns: [] as Array<{ status: string; passCount: number; failCount: number }>,
  gates: [] as Array<{ status: string }>,
  changeOutcomes: [] as Array<{ outcome: string }>,
  findingsOpen: [] as Array<{ firstSeenAt: Date }>,
  hoursByUser: [] as Array<{ userId: string; hours: number }>,
  closedByUser: [] as Array<{ assigneeId: string; count: number }>,
  people: [] as Array<{ id: string; name: string; status: string; deletedAt: Date | null; weeklyCapacityHours: number | null; plannedUtilizationPct: number | null }>,
  counts: {} as Record<string, number>,
  billableHours: 0,
  totalHours: 0,
  throwFor: new Set<string>()
}));

const PERIOD_START = new Date("2026-08-17T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-23T00:00:00.000Z");

/** Groups a fixture the way `groupBy` would, so the code under test sees the shape it expects. */
function tally<T>(rows: T[], key: (row: T) => string) {
  const map = new Map<string, number>();
  for (const row of rows) map.set(key(row), (map.get(key(row)) ?? 0) + 1);
  return map;
}

vi.mock("../../src/config/prisma.js", () => {
  const boom = (name: string) => {
    if (state.throwFor.has(name)) throw new Error(`${name} is not configured in this workspace`);
  };
  return {
    prisma: {
      ticket: {
        findMany: vi.fn(async (args: any) => {
          // Two different callers: the closed-in-period read (for cycle time and on-time) and the
          // distinct open-assignee read.
          if (args?.distinct) {
            const seen = new Set<string>();
            return state.tickets
              .filter((t) => !["RESOLVED", "CLOSED"].includes(t.status as string) && t.assigneeId)
              .filter((t) => (seen.has(t.assigneeId as string) ? false : seen.add(t.assigneeId as string)))
              .map((t) => ({ assigneeId: t.assigneeId }));
          }
          return state.tickets.filter(
            (t) =>
              ["RESOLVED", "CLOSED"].includes(t.status as string) &&
              t.resolvedAt &&
              (t.resolvedAt as Date) >= PERIOD_START
          );
        }),
        count: vi.fn(async (args: any) => {
          const w = args?.where ?? {};
          // The backlog query is the one whose SHAPE is the behaviour: raised before the period
          // ended and not resolved by then. Evaluated for real so a reverted fix changes the number.
          if (w.OR) {
            const cutoff = w.createdAt?.lt as Date;
            return state.tickets.filter(
              (t) => (t.createdAt as Date) < cutoff && (!t.resolvedAt || (t.resolvedAt as Date) >= cutoff)
            ).length;
          }
          if (w.assigneeId === null) return state.tickets.filter((t) => !t.assigneeId && !["RESOLVED", "CLOSED"].includes(t.status as string)).length;
          if (w.dueAt?.gte) return state.counts.dueNextWeek ?? 0;
          if (w.priority === "CRITICAL") return state.counts.criticalOverdue ?? 0;
          if (w.createdAt) return state.counts.created ?? 0;
          return 0;
        }),
        groupBy: vi.fn(async (args: any) => {
          const by = args?.by ?? [];
          if (by[0] === "priority") {
            const closed = Boolean(args.where?.resolvedAt);
            const rows = state.tickets.filter((t) =>
              closed
                ? ["RESOLVED", "CLOSED"].includes(t.status as string) && t.resolvedAt
                : !["RESOLVED", "CLOSED"].includes(t.status as string)
            );
            return [...tally(rows, (t) => t.priority as string)].map(([priority, n]) => ({ priority, _count: { _all: n } }));
          }
          if (by[0] === "assigneeId") {
            return state.closedByUser.map((r) => ({ assigneeId: r.assigneeId, _count: { _all: r.count } }));
          }
          return [];
        })
      },
      auditLog: {
        findMany: vi.fn(async (args: any) => {
          boom("auditLog");
          // The period filter IS the behaviour here — an all-time reopen rate under a heading that
          // says "this period" is the bug. Applied to the fixture so removing it changes the answer.
          const range = args?.where?.createdAt;
          return state.audits.filter((a) => !range || (a.createdAt >= range.gte && a.createdAt < range.lt));
        })
      },
      testRun: {
        groupBy: vi.fn(async () => {
          boom("testRun");
          const byStatus = new Map<string, { n: number; pass: number; fail: number }>();
          for (const r of state.testRuns) {
            const e = byStatus.get(r.status) ?? { n: 0, pass: 0, fail: 0 };
            e.n += 1;
            e.pass += r.passCount;
            e.fail += r.failCount;
            byStatus.set(r.status, e);
          }
          return [...byStatus].map(([status, e]) => ({ status, _count: { _all: e.n }, _sum: { passCount: e.pass, failCount: e.fail } }));
        })
      },
      qualityGateRun: {
        groupBy: vi.fn(async () => {
          boom("qualityGateRun");
          return [...tally(state.gates, (g) => g.status)].map(([status, n]) => ({ status, _count: { _all: n } }));
        })
      },
      securityFinding: {
        count: vi.fn(async (args: any) => {
          boom("securityFinding");
          if (args?.where?.verifiedFixedAt) return state.counts.verifiedFixed ?? 0;
          if (args?.where?.status === "PENDING_VERIFICATION") return state.counts.awaitingVerification ?? 0;
          return 0;
        }),
        findMany: vi.fn(async () => {
          boom("securityFinding");
          return state.findingsOpen;
        }),
        groupBy: vi.fn(async () => {
          boom("securityFinding");
          return [];
        })
      },
      scanRun: { count: vi.fn(async () => state.counts.scanRuns ?? 0) },
      changeRequest: {
        count: vi.fn(async (args: any) => {
          boom("changeRequest");
          if (args?.where?.changeKind === "EMERGENCY") return state.counts.emergency ?? 0;
          if (args?.where?.state === "AWAITING_APPROVAL") return state.counts.awaitingApproval ?? 0;
          return state.counts.scheduledNextWeek ?? 0;
        }),
        groupBy: vi.fn(async () => {
          boom("changeRequest");
          return [...tally(state.changeOutcomes, (c) => c.outcome)].map(([outcome, n]) => ({ outcome, _count: { _all: n } }));
        })
      },
      timesheet: {
        groupBy: vi.fn(async () => state.hoursByUser.map((r) => ({ userId: r.userId, _sum: { totalHours: r.hours } }))),
        aggregate: vi.fn(async (args: any) =>
          args?.where?.billable ? { _sum: { totalHours: state.billableHours } } : { _sum: { totalHours: state.totalHours } }
        )
      },
      project: { findMany: vi.fn(async () => []) },
      goal: { count: vi.fn(async () => 0) },
      agentRun: { count: vi.fn(async () => 0) },
      aIInteraction: { count: vi.fn(async () => 0) },
      aIUsageLog: { aggregate: vi.fn(async () => ({ _sum: { costUsdEstimate: null } })) },
      user: {
        findMany: vi.fn(async (args: any) => {
          // The deactivation predicate is applied to the fixture rather than ignored, so dropping
          // it from the source lets a departed colleague back into the contributor list.
          const w = args?.where ?? {};
          return state.people.filter((p) => {
            if (w.deletedAt === null && p.deletedAt !== null) return false;
            if (w.status?.not && p.status === w.status.not) return false;
            return true;
          });
        })
      }
    }
  };
});

vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn().mockResolvedValue({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 })
}));

const { buildPracticeAnalytics, median, rate } = await import("../../src/services/practice-analytics.service.js");

function run(over: { start?: Date; end?: Date } = {}) {
  return buildPracticeAnalytics({
    start: over.start ?? PERIOD_START,
    end: over.end ?? PERIOD_END,
    pocProjectIds: [],
    pocHours: 0
  });
}

beforeEach(() => {
  state.tickets = [];
  state.audits = [];
  state.testRuns = [];
  state.gates = [];
  state.changeOutcomes = [];
  state.findingsOpen = [];
  state.hoursByUser = [];
  state.closedByUser = [];
  state.people = [];
  state.counts = {};
  state.billableHours = 0;
  state.totalHours = 0;
  state.throwFor = new Set();
});

describe("the two arithmetic primitives", () => {
  it("returns null rather than zero when there is nothing to divide by", () => {
    // The single decision this whole file exists to protect.
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
    expect(rate(0, 5)).toBe(0);
    expect(rate(3, 4)).toBe(75);
  });

  it("takes a median, not a mean, and says nothing about an empty sample", () => {
    expect(median([])).toBeNull();
    expect(median([4])).toBe(4);
    expect(median([1, 3])).toBe(2);
    // The reason it is a median: one outlier must not move it.
    expect(median([1, 2, 3, 4, 10_000])).toBe(3);
  });
});

describe("every rate is null when nothing was measured", () => {
  it("reports an empty period as unmeasured, not as a week of total failure", async () => {
    const a = await run();

    // If any of these were 0 instead of null, the email would report a catastrophe on the first
    // week of a new workspace.
    expect(a.delivery.closureRatePct).toBeNull();
    expect(a.delivery.onTimeClosurePct).toBeNull();
    expect(a.delivery.medianCycleHours).toBeNull();
    expect(a.delivery.reopenRatePct).toBeNull();
    expect(a.quality.runPassRatePct).toBeNull();
    expect(a.quality.testPassRatePct).toBeNull();
    expect(a.change.successRatePct).toBeNull();
    expect(a.people.utilisationPct).toBeNull();
    expect(a.people.billablePct).toBeNull();
    expect(a.security.medianOpenAgeDays).toBeNull();
  });
});

describe("delivery", () => {
  it("divides on-time by the closures that HAD a due date, not by all of them", async () => {
    state.tickets = [
      // On time.
      { status: "CLOSED", createdAt: new Date("2026-08-17"), resolvedAt: new Date("2026-08-19"), dueAt: new Date("2026-08-20"), priority: "MEDIUM" },
      // Late.
      { status: "CLOSED", createdAt: new Date("2026-08-17"), resolvedAt: new Date("2026-08-22"), dueAt: new Date("2026-08-20"), priority: "MEDIUM" },
      // No due date at all — must be in NEITHER half, or the rate silently measures something else.
      { status: "CLOSED", createdAt: new Date("2026-08-17"), resolvedAt: new Date("2026-08-19"), dueAt: null, priority: "MEDIUM" }
    ];
    const a = await run();

    expect(a.delivery.closedWithDueDate).toBe(2);
    expect(a.delivery.onTimeClosurePct).toBe(50);
  });

  it("counts the backlog AS AT THE PERIOD END, so two periods give two answers", async () => {
    state.tickets = [
      // Raised before the early period, still open at both cut-offs.
      { status: "OPEN", createdAt: new Date("2026-08-01"), resolvedAt: null, dueAt: null, priority: "LOW", assigneeId: "u1" },
      // Raised and resolved between the two cut-offs: in the first backlog, out of the second.
      { status: "CLOSED", createdAt: new Date("2026-08-02"), resolvedAt: new Date("2026-08-20"), dueAt: null, priority: "LOW" }
    ];

    const early = await run({ start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-08-07T00:00:00Z") });
    const late = await run();

    // The regression this pins: a "currently open" count would answer 1 for both, and the email
    // would print "unchanged" forever.
    expect(early.delivery.backlogOpen).toBe(2);
    expect(late.delivery.backlogOpen).toBe(1);
  });

  it("counts reopens inside the period only", async () => {
    state.audits = [
      { entityId: "t1", metadata: { to: "RESOLVED" }, createdAt: new Date("2026-08-18") },
      { entityId: "t1", metadata: { to: "REOPENED" }, createdAt: new Date("2026-08-19") },
      // Six months earlier. An all-time rate would fold this in and report on work nobody is
      // discussing this week.
      { entityId: "t9", metadata: { to: "RESOLVED" }, createdAt: new Date("2026-02-01") },
      { entityId: "t9", metadata: { to: "REOPENED" }, createdAt: new Date("2026-02-02") }
    ];
    const a = await run();

    expect(a.delivery.everResolved).toBe(1);
    expect(a.delivery.reopened).toBe(1);
    expect(a.delivery.reopenRatePct).toBe(100);
  });
});

describe("quality and testing", () => {
  it("keeps the suite rate and the test rate apart, because on real data they disagree", async () => {
    state.testRuns = [
      { status: "PASSED", passCount: 26, failCount: 0 },
      { status: "PASSED", passCount: 26, failCount: 0 },
      { status: "FAILED", passCount: 2, failCount: 1 },
      { status: "FAILED", passCount: 8, failCount: 1 },
      { status: "FAILED", passCount: 0, failCount: 0 },
      { status: "FAILED", passCount: 0, failCount: 0 },
      { status: "FAILED", passCount: 0, failCount: 0 }
    ];
    const a = await run();

    // 2 of 7 suites green; 62 of 64 assertions green. Both true, seventy points apart — which is
    // precisely why the email labels and prints both.
    expect(a.quality.runsPassed).toBe(2);
    expect(a.quality.runsFailed).toBe(5);
    expect(a.quality.runPassRatePct).toBe(28.6);
    expect(a.quality.testsPassed).toBe(62);
    expect(a.quality.testsFailed).toBe(2);
    expect(a.quality.testPassRatePct).toBe(96.9);
  });

  it("does not count a suite that is still running as one that failed", async () => {
    state.testRuns = [
      { status: "PASSED", passCount: 1, failCount: 0 },
      { status: "RUNNING", passCount: 0, failCount: 0 }
    ];
    const a = await run();

    expect(a.quality.testRuns).toBe(2);
    // 1 of 1 FINISHED runs passed. Counting the running one as a failure would print 50%.
    expect(a.quality.runPassRatePct).toBe(100);
  });
});

describe("change", () => {
  it("rates success against changes with a recorded outcome, not against every change", async () => {
    state.changeOutcomes = [
      { outcome: "SUCCESSFUL" },
      { outcome: "SUCCESSFUL" },
      { outcome: "SUCCESSFUL_WITH_ISSUES" },
      { outcome: "ROLLED_BACK" }
    ];
    const a = await run();

    expect(a.change.outcomeRecorded).toBe(4);
    // "With issues" is deliberately NOT success: it shipped and something went wrong, and folding
    // it in would let a bad quarter round to green.
    expect(a.change.successRatePct).toBe(50);
    expect(a.change.rolledBack).toBe(1);
  });
});

describe("security", () => {
  it("ages open findings from when they were first seen", async () => {
    state.findingsOpen = [
      { firstSeenAt: new Date("2026-08-21T00:00:00Z") }, // 2 days
      { firstSeenAt: new Date("2026-08-13T00:00:00Z") }, // 10 days
      { firstSeenAt: new Date("2026-06-24T00:00:00Z") } // 60 days
    ];
    const a = await run();

    expect(a.security.medianOpenAgeDays).toBe(10);
    // The oldest is the number that starts the conversation; a median alone hides it.
    expect(a.security.oldestOpenDays).toBe(60);
  });
});

describe("people", () => {
  it("measures utilisation against real capacity and leaves deactivated people out", async () => {
    state.people = [
      { id: "u1", name: "Asha Rao", status: "ACTIVE", deletedAt: null, weeklyCapacityHours: 40, plannedUtilizationPct: 100 },
      { id: "u2", name: "Dana Fell", status: "INACTIVE", deletedAt: null, weeklyCapacityHours: 40, plannedUtilizationPct: 100 }
    ];
    state.hoursByUser = [
      { userId: "u1", hours: 20 },
      { userId: "u2", hours: 20 }
    ];
    state.totalHours = 40;
    state.billableHours = 30;
    state.closedByUser = [{ assigneeId: "u1", count: 3 }];

    const a = await run();

    // Mon–Sun contains 5 working days; one person at 40h/week is 40h of capacity.
    expect(a.people.capacityHours).toBe(40);
    // The whole team's 40 logged hours against the one visible person's capacity.
    expect(a.people.utilisationPct).toBe(100);
    expect(a.people.billablePct).toBe(75);

    // Dana is deactivated: her hours still count in the totals, her NAME does not appear.
    expect(a.people.topContributors.map((c) => c.name)).toEqual(["Asha Rao"]);
    expect(a.people.topContributors[0]).toMatchObject({ hours: 20, ticketsClosed: 3 });
  });
});

describe("an unconfigured subsystem costs a row, never the report", () => {
  it("still produces a full result when the optional tables are unavailable", async () => {
    // A workspace with no CI, no scanner and no change management. Every one of these throws.
    state.throwFor = new Set(["testRun", "qualityGateRun", "securityFinding", "changeRequest", "auditLog"]);
    state.tickets = [{ status: "CLOSED", createdAt: new Date("2026-08-17"), resolvedAt: new Date("2026-08-19"), dueAt: null, priority: "LOW" }];

    const a = await run();

    // The report survives, and the delivery figures — which depend on none of it — are still real.
    expect(a.delivery.medianCycleHours).toBe(48);
    expect(a.quality.testRuns).toBe(0);
    expect(a.security.verifiedFixed).toBe(0);
    expect(a.change.outcomeRecorded).toBe(0);
    // And nothing invented a rate out of the absence.
    expect(a.quality.runPassRatePct).toBeNull();
    expect(a.change.successRatePct).toBeNull();
  });
});
