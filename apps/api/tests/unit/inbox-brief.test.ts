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
const approvalStepFindMany = vi.fn();
const notificationCount = vi.fn();
const riskFindMany = vi.fn();
const userFindMany = vi.fn();
const userFindUnique = vi.fn();

vi.mock("../../src/services/my-work.service.js", () => ({ computeMyWork: (...a: unknown[]) => computeMyWork(...a) }));
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    timesheet: { count: (...a: unknown[]) => timesheetCount(...a) },
    approvalStep: {
      count: (...a: unknown[]) => approvalStepCount(...a),
      findMany: (...a: unknown[]) => approvalStepFindMany(...a)
    },
    notification: { count: (...a: unknown[]) => notificationCount(...a) },
    projectRiskSnapshot: { findMany: (...a: unknown[]) => riskFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a), findUnique: (...a: unknown[]) => userFindUnique(...a) }
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
  approvalStepFindMany.mockResolvedValue([]);
  notificationCount.mockResolvedValue(0);
  riskFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  userFindUnique.mockResolvedValue({ timezone: "Asia/Kolkata" });
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

  it("counts awaiting review exactly as the approvals queue scopes it — not yours, not your managers'", async () => {
    // u-1 reports to m-1, who reports to m-0. m-1's entries are not u-1's to decide, so counting
    // them sent u-1 to a queue that (correctly) does not list them. m-0 is the top of the tree with
    // no manager of their own — anyone but m-0 may decide theirs (audit 2026-10 R3, finding 1), so
    // they ARE in u-1's count.
    userFindMany.mockResolvedValue([
      { id: "m-0", email: "m0@x.io", managerId: null, status: "ACTIVE", deletedAt: null },
      { id: "m-1", email: "m1@x.io", managerId: "m-0", status: "ACTIVE", deletedAt: null },
      { id: "u-1", email: "u1@x.io", managerId: "m-1", status: "ACTIVE", deletedAt: null }
    ]);
    await buildDailyBrief({ id: "u-1", permissions: ["timesheets:approve"] }, NOW);
    const pendingCall = timesheetCount.mock.calls.find((c) => (c[0] as any).where.status === "SUBMITTED");
    expect([...(pendingCall![0] as any).where.userId.notIn].sort()).toEqual(["m-1", "u-1"]);
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

  it("asks about the person's own today at 02:00 IST, when UTC is still on yesterday", async () => {
    // 2026-10-01T20:30Z is 02:00 on 2 October in India. The brief used UTC getters, so between
    // midnight and 05:30 IST it reported "no time logged today" about the previous day.
    await buildDailyBrief({ id: "u-1", permissions: [] }, new Date("2026-10-01T20:30:00.000Z"));
    const ownCall = timesheetCount.mock.calls.find((c) => (c[0] as any).where.userId === "u-1");
    expect((ownCall![0] as any).where.workDate).toEqual(new Date("2026-10-02T00:00:00.000Z"));
  });

  it("and a New York user's today at the same instant is still 1 October", async () => {
    userFindUnique.mockResolvedValue({ timezone: "America/New_York" });
    await buildDailyBrief({ id: "u-1", permissions: [] }, new Date("2026-10-01T20:30:00.000Z"));
    const ownCall = timesheetCount.mock.calls.find((c) => (c[0] as any).where.userId === "u-1");
    expect((ownCall![0] as any).where.workDate).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });

  it("does not count a REJECTED entry as time logged, exactly as /daily-status does not", async () => {
    // A refused entry is meant to be re-logged. Counting it said "Time logged today" to somebody
    // whose only entry today had just been sent back.
    await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    const ownCall = timesheetCount.mock.calls.find((c) => (c[0] as any).where.userId === "u-1");
    expect((ownCall![0] as any).where.status).toEqual({ not: "REJECTED" });
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

/**
 * "Sign-offs waiting on you" — approval-chain steps (audit 2026-10, notifications #5).
 *
 * It counted every PENDING step naming this person, but superseded steps are deliberately left
 * PENDING forever once a chain is rejected, and in a sequential chain a later step is PENDING long
 * before its turn. So after A rejected an A→B→C chain, B and C saw "1" forever and the brief never
 * read all-clear. And it linked to /app/approvals, which lists timesheets only.
 */
describe("sign-offs waiting on you", () => {
  const step = (id: string, order: number, decision: string, approverId: string | null) => ({ id, order, decision, approverId, guestEmail: null });
  const pendingStep = (stepId: string, ticketId: string, isSequential: boolean, steps: ReturnType<typeof step>[]) => ({
    id: stepId,
    request: { ticketId, isSequential, ticket: { key: `OPS-${ticketId}`, title: "Ship it" }, steps }
  });

  it("asks only for steps whose request is still PENDING", async () => {
    await buildDailyBrief({ id: "u-b", permissions: [] }, NOW);
    const where = (approvalStepFindMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ approverId: "u-b", decision: "PENDING", request: { status: "PENDING" } });
  });

  it("leaves out sign-offs on a deleted ticket — nobody can open it to decide", async () => {
    // A soft-deleted ticket keeps its approval request PENDING, so its step counted for good and
    // the link opened onto a ticket that 404s (audit 2026-10 R3, notifications).
    await buildDailyBrief({ id: "u-b", permissions: [] }, NOW);
    const where = (approvalStepFindMany.mock.calls[0][0] as any).where;
    expect(where.request).toMatchObject({ status: "PENDING", ticket: { deletedAt: null } });
  });

  it("counts a sequential step only when it is that step's turn", async () => {
    // u-b is step 2 of A→B: not their turn while A has not decided.
    approvalStepFindMany.mockResolvedValue([
      pendingStep("s-b", "1", true, [step("s-a", 0, "PENDING", "u-a"), step("s-b", 1, "PENDING", "u-b")])
    ]);
    const brief = await buildDailyBrief({ id: "u-b", permissions: [] }, NOW);
    expect(section(brief, "deliverableApprovals")?.count).toBe(0);
    expect(section(brief, "deliverableApprovals")?.tone).toBe("ok");
  });

  it("counts it once it is their turn, and links to the ticket that carries it", async () => {
    approvalStepFindMany.mockResolvedValue([
      pendingStep("s-b", "t-9", true, [step("s-a", 0, "APPROVED", "u-a"), step("s-b", 1, "PENDING", "u-b")])
    ]);
    const brief = await buildDailyBrief({ id: "u-b", permissions: [] }, NOW);
    expect(section(brief, "deliverableApprovals")?.count).toBe(1);
    expect(section(brief, "deliverableApprovals")?.link).toBe("/app/tickets?open=t-9");
    expect(section(brief, "deliverableApprovals")?.detail).toContain("OPS-t-9");
  });

  it("counts every undecided step of a parallel request", async () => {
    approvalStepFindMany.mockResolvedValue([
      pendingStep("s-b", "t-1", false, [step("s-a", 0, "PENDING", "u-a"), step("s-b", 1, "PENDING", "u-b")])
    ]);
    const brief = await buildDailyBrief({ id: "u-b", permissions: [] }, NOW);
    expect(section(brief, "deliverableApprovals")?.count).toBe(1);
  });
});

describe("unread notifications", () => {
  it("counts what the bell counts — unread, not handled, not still snoozed", async () => {
    // The brief counted every unread row, including ones marked done or snoozed, so it said
    // "Unread notifications: 4" while the bell said 0.
    await buildDailyBrief({ id: "u-1", permissions: [] }, NOW);
    const where = (notificationCount.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ userId: "u-1", readAt: null, handledAt: null });
    expect(where.OR).toEqual([{ snoozedUntil: null }, { snoozedUntil: { lte: NOW } }]);
  });
});
