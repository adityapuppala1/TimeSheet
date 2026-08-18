/**
 * Pins the daily brief's arithmetic and, more importantly, its DISCRETION.
 *
 * The brief is the one surface that aggregates across other people's work, so the interesting
 * failures are not arithmetic — they are disclosure and noise:
 *
 *  - A section somebody cannot act on must not appear. An approval queue shown to a person without
 *    `timesheets:approve` is both a leak of workload information and a to-do they cannot clear.
 *  - "All clear" must mean it. If informational rows (due today, unread) could set the alarm tone,
 *    nobody would ever see an all-clear and the signal would be worthless.
 *  - Every figure must come from an existing definition. The overdue count here is the same
 *    `computeMyWork` the /plan/my-work page renders, mocked at that boundary on purpose: a test
 *    that re-implemented bucketing would pass against a brief that had drifted from the page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const computeMyWork = vi.fn();
const timesheetCount = vi.fn();
const approvalStepCount = vi.fn();
const notificationCount = vi.fn();
const riskFindMany = vi.fn();

vi.mock("../../src/services/my-work.service.js", () => ({ computeMyWork: (...a: unknown[]) => computeMyWork(...a) }));
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    timesheet: { count: (...a: unknown[]) => timesheetCount(...a) },
    approvalStep: { count: (...a: unknown[]) => approvalStepCount(...a) },
    notification: { count: (...a: unknown[]) => notificationCount(...a) },
    projectRiskSnapshot: { findMany: (...a: unknown[]) => riskFindMany(...a) }
  }
}));

const { buildDailyBrief } = await import("../../src/services/inbox.service.js");

const NOW = new Date("2026-08-17T10:00:00.000Z");

const emptyWork = {
  overdue: [],
  today: [],
  thisWeek: [],
  later: [],
  blocked: [],
  counts: { total: 0, blocked: 0 }
};

const item = (key: string, title = "Something") => ({
  id: key.toLowerCase(),
  key,
  title,
  startDate: null,
  endDate: null,
  dueAt: null,
  deadline: null,
  priority: "MEDIUM",
  status: "OPEN",
  statusCategory: "TODO",
  statusLabel: null,
  type: "TASK",
  isMilestone: false,
  progressPct: null,
  estimatedHours: null,
  project: null,
  blockers: [] as Array<{ id: string; key: string; title: string; status: string }>
});

const section = (brief: Awaited<ReturnType<typeof buildDailyBrief>>, key: string) =>
  brief.sections.find((s) => s.key === key);

/** `prisma.timesheet.count` answers two different questions in the brief — "did I log today"
 *  (scoped to the caller) and "how many are awaiting review" (everybody else's SUBMITTED rows).
 *  A single mockResolvedValue answers both with one number and makes assertions about either
 *  meaningless, so the mock discriminates on the `where` exactly as the real queries differ. */
const timesheets = ({ loggedToday = 0, pendingReview = 0 } = {}) =>
  timesheetCount.mockImplementation((args: any) =>
    Promise.resolve(args?.where?.status === "SUBMITTED" ? pendingReview : loggedToday)
  );

beforeEach(() => {
  vi.clearAllMocks();
  computeMyWork.mockResolvedValue(emptyWork);
  timesheets();
  approvalStepCount.mockResolvedValue(0);
  notificationCount.mockResolvedValue(0);
  riskFindMany.mockResolvedValue([]);
});

describe("what the brief shows whom", () => {
  it("omits the timesheet approval queue from somebody who cannot approve", async () => {
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(section(brief, "timesheetApprovals")).toBeUndefined();
    // And does not even ask — the count is a cross-user aggregate.
    expect(timesheetCount).toHaveBeenCalledTimes(1); // only the caller's own "logged today"
  });

  it("shows it to an approver", async () => {
    timesheets({ pendingReview: 4 });
    const brief = await buildDailyBrief({ id: "u-1", permissions: ["timesheets:approve"] }, NOW);
    expect(section(brief, "timesheetApprovals")?.count).toBe(4);
  });

  it("omits project risk from somebody without reports:view, and never queries it", async () => {
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(section(brief, "atRisk")).toBeUndefined();
    expect(riskFindMany).not.toHaveBeenCalled();
  });

  it("always shows the caller's own sections regardless of permissions", async () => {
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    for (const key of ["overdue", "today", "blocked", "unlogged", "deliverableApprovals", "unread"]) {
      expect(section(brief, key), key).toBeDefined();
    }
  });
});

describe("the figures come from the existing definitions", () => {
  it("takes overdue and blocked straight from computeMyWork", async () => {
    const blockedItem = { ...item("WEB-9", "Blocked thing"), blockers: [{ id: "b", key: "API-2", title: "Dep", status: "OPEN" }] };
    computeMyWork.mockResolvedValue({
      ...emptyWork,
      overdue: [item("WEB-1", "Late thing"), item("WEB-2")],
      today: [item("WEB-3")],
      blocked: [blockedItem],
      counts: { total: 4, blocked: 1 }
    });
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(section(brief, "overdue")?.count).toBe(2);
    expect(section(brief, "today")?.count).toBe(1);
    expect(section(brief, "blocked")?.count).toBe(1);
    // Detail names the actual item and the actual blocker — "you are blocked" is not actionable,
    // "WEB-9 waits on API-2" is.
    expect(section(brief, "overdue")?.detail).toContain("WEB-1");
    expect(section(brief, "blocked")?.detail).toContain("API-2");
  });

  it("counts only the LATEST snapshot per project as red", async () => {
    // A project that was red in March is not red now. `distinct` on the descending query is what
    // stops history inflating this number forever.
    riskFindMany.mockResolvedValue([{ band: "RED" }, { band: "AMBER" }, { band: "RED" }]);
    const brief = await buildDailyBrief({ id: "u-1", permissions: ["reports:view"] }, NOW);
    expect(section(brief, "atRisk")?.count).toBe(2);
    expect(riskFindMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ["projectId"], orderBy: { computedAt: "desc" } }));
  });

  it("asks about today's own timesheet with a UTC-midnight workDate, matching /daily-status", async () => {
    await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    const ownCall = timesheetCount.mock.calls.find((c) => (c[0] as any).where.userId === "u-1");
    expect((ownCall![0] as any).where.workDate).toEqual(new Date("2026-08-17T00:00:00.000Z"));
  });
});

describe("tone, and what 'all clear' is allowed to mean", () => {
  it("is all clear on an empty workspace with time logged", async () => {
    timesheets({ loggedToday: 1 });
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(brief.allClear).toBe(true);
  });

  it("is NOT all clear when time has not been logged today", async () => {
    timesheets({ loggedToday: 0 });
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(section(brief, "unlogged")?.tone).toBe("attention");
    expect(brief.allClear).toBe(false);
  });

  it("stays all clear with work merely due today — a normal day is not an alarm", async () => {
    timesheets({ loggedToday: 1 });
    computeMyWork.mockResolvedValue({ ...emptyWork, today: [item("WEB-3"), item("WEB-4")] });
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(section(brief, "today")?.tone).toBe("ok");
    expect(brief.allClear).toBe(true);
  });

  it("stays all clear with unread notifications, which are information rather than a task", async () => {
    timesheets({ loggedToday: 1 });
    notificationCount.mockResolvedValue(12);
    const brief = await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    expect(section(brief, "unread")?.count).toBe(12);
    expect(section(brief, "unread")?.tone).toBe("ok");
    expect(brief.allClear).toBe(true);
  });

  it("gives a zero section no link, so a reassuring row is not a dead click", async () => {
    timesheets({ loggedToday: 1, pendingReview: 0 });
    const brief = await buildDailyBrief({ id: "u-1", permissions: ["timesheets:approve", "reports:view"] }, NOW);
    for (const key of ["overdue", "blocked", "timesheetApprovals", "deliverableApprovals", "atRisk", "unread"]) {
      expect(section(brief, key)?.link, key).toBeNull();
    }
  });
});
