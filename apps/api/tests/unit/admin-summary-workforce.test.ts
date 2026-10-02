/**
 * `GET /reports/admin-summary` — the home page's workforce card and stat tiles, and the Reports
 * page's tiles.
 *
 * Pinned here, each a bug the audit found:
 *   - H4. The workforce card's numerator counted distinct loggers of ANY role, deactivated people
 *     included, while its denominator was active employees and team leads — AI agent identities
 *     among them, because an agent is an ACTIVE EMPLOYEE row. The two sides were different people,
 *     so "Not yet filled" was permanently inflated and the share could pass 100%. Its "vs YTD
 *     avg/day" compared distinct people over a whole range with an average per CALENDAR day.
 *   - M4. "Approved hours" was all-time under a picker that says it governs every card; the
 *     point-in-time tiles carried "vs yesterday" deltas that could only ever go up; "Approved this
 *     week" was a count of entries over a rolling 168 hours.
 *   - M5. "Tickets closed" read `updatedAt`, so editing an old closed ticket counted it again.
 *   - M1. Timestamp windows began at UTC midnight — 05:30 IST.
 *
 * The stand-in database evaluates the `where` clauses it is given rather than returning canned
 * numbers, so a wrong filter shows up as a wrong count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Person = { id: string; status: string; deletedAt: Date | null; isAgent: boolean; role: string; createdAt: Date };

const PEOPLE: Person[] = [
  { id: "asha", status: "ACTIVE", deletedAt: null, isAgent: false, role: "EMPLOYEE", createdAt: new Date("2026-01-05T00:00:00Z") },
  { id: "ben", status: "ACTIVE", deletedAt: null, isAgent: false, role: "TEAM_LEAD", createdAt: new Date("2026-01-05T00:00:00Z") },
  // An AI teammate: an ACTIVE EMPLOYEE row that will never fill a timesheet.
  { id: "bot", status: "ACTIVE", deletedAt: null, isAgent: true, role: "EMPLOYEE", createdAt: new Date("2026-08-26T00:00:00Z") },
  { id: "dana", status: "INACTIVE", deletedAt: null, isAgent: false, role: "EMPLOYEE", createdAt: new Date("2026-01-05T00:00:00Z") },
  { id: "admin", status: "ACTIVE", deletedAt: null, isAgent: false, role: "ADMIN", createdAt: new Date("2026-01-05T00:00:00Z") }
];

const state = vi.hoisted(() => ({
  timesheets: [] as Array<Record<string, any>>,
  tickets: [] as Array<Record<string, any>>,
  personDays: { current: 0, ytd: 0 },
  noWorkforce: false,
  rawCalls: [] as Array<{ sql: string; values: unknown[] }>
}));

function inRange(value: Date | null | undefined, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (value === null || value === undefined) return cond?.not === undefined ? false : cond.not !== null;
  if (cond instanceof Date) return value.getTime() === cond.getTime();
  if (cond.not === null) return true;
  if (cond.gte && value < cond.gte) return false;
  if (cond.gt && value <= cond.gt) return false;
  if (cond.lte && value > cond.lte) return false;
  if (cond.lt && value >= cond.lt) return false;
  return true;
}

function personMatches(p: Person, where: Record<string, any> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "status") {
      if (typeof cond === "string" ? p.status !== cond : p.status === cond.not) return false;
    } else if (key === "deletedAt") {
      if (cond === null && p.deletedAt !== null) return false;
    } else if (key === "isAgent") {
      if (p.isAgent !== cond) return false;
    } else if (key === "role") {
      if (!cond.name.in.includes(p.role)) return false;
    } else if (key === "createdAt") {
      if (!inRange(p.createdAt, cond)) return false;
    } else throw new Error(`fake directory: unsupported ${key}`);
  }
  return true;
}

function rowMatches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((c) => rowMatches(row, c))) return false;
    } else if (key === "user") {
      const person = PEOPLE.find((p) => p.id === row.userId);
      if (!person || !personMatches(person, cond)) return false;
    } else if (key === "status") {
      if (typeof cond === "string") {
        if (row.status !== cond) return false;
      } else if (cond.in) {
        if (!cond.in.includes(row.status)) return false;
      } else if (cond.notIn) {
        if (cond.notIn.includes(row.status)) return false;
      }
    } else if (["workDate", "createdAt", "updatedAt", "resolvedAt", "closedAt", "reviewedAt", "approvalDeadline", "slaBreachAt", "deletedAt"].includes(key)) {
      if (!inRange(row[key], cond)) return false;
    } else if (key === "userId" || key === "projectId") {
      if (row[key] !== cond) return false;
    } else throw new Error(`fake table: unsupported ${key}`);
  }
  return true;
}

function groupBy(rows: Array<Record<string, any>>, args: any) {
  const groups = new Map<string, any>();
  for (const row of rows.filter((r) => rowMatches(r, args.where))) {
    const key = args.by.map((k: string) => String(row[k])).join("|");
    const g = groups.get(key) ?? { ...Object.fromEntries(args.by.map((k: string) => [k, row[k]])), _sum: { totalHours: 0 }, _count: 0 };
    g._sum.totalHours += row.totalHours;
    g._count += 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: {
      count: vi.fn(async (args: any) => (state.noWorkforce && args?.where?.role ? 0 : PEOPLE.filter((p) => personMatches(p, args?.where)).length)),
      // The reporting lines "Pending approvals" is scoped by (timesheet-approval-scope.service.ts) — none here.
      findMany: vi.fn(async () => [])
    },
    project: {
      count: vi.fn(async () => 3),
      findMany: vi.fn(async () => [{ id: "p1", name: "Apollo", code: "APL" }])
    },
    timesheet: {
      count: vi.fn(async (args: any) => state.timesheets.filter((r) => rowMatches(r, args.where)).length),
      aggregate: vi.fn(async (args: any) => ({
        _sum: { totalHours: state.timesheets.filter((r) => rowMatches(r, args.where)).reduce((s, r) => s + r.totalHours, 0) }
      })),
      groupBy: vi.fn(async (args: any) => groupBy(state.timesheets, args)),
      findMany: vi.fn(async (args: any) => {
        const rows = state.timesheets.filter((r) => rowMatches(r, args.where));
        if (args.distinct) return [...new Map(rows.map((r) => [r.userId, r])).values()];
        return rows;
      })
    },
    escalation: { count: vi.fn(async () => 1) },
    notification: { count: vi.fn(async () => 0) },
    ticket: { count: vi.fn(async (args: any) => state.tickets.filter((t) => rowMatches(t, args.where)).length) },
    changeRequest: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      state.rawCalls.push({ sql, values });
      // The year-to-date call ends yesterday; the period call ends inside the period.
      const to = values.find((v) => v instanceof Date && v.getTime() > Date.UTC(2026, 7, 26)) ;
      return [{ n: BigInt(to ? state.personDays.current : state.personDays.ytd) }];
    })
  }
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "admin", permissions: ["reports:view"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock("../../src/services/change.service.js", () => ({ isChangeManagementOn: vi.fn(async () => false) }));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn(async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }))
}));

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
function entry(userId: string, iso: string, hours: number, over: Record<string, any> = {}) {
  return {
    userId,
    projectId: "p1",
    activityType: "DEVELOPMENT",
    workDate: day(iso),
    totalHours: hours,
    status: "APPROVED",
    createdAt: new Date(`${iso}T05:00:00.000Z`),
    reviewedAt: new Date(`${iso}T10:00:00.000Z`),
    approvalDeadline: null,
    slaBreachAt: null,
    deletedAt: null,
    ...over
  };
}

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  // Thursday 27 August 2026, 16:30 IST.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-27T11:00:00.000Z"));
  const express = (await import("express")).default;
  const { reportRouter } = await import("../../src/controllers/report.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/reports", reportRouter);
  app.use(errorHandler);
}, 60_000);
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  state.timesheets = [];
  state.tickets = [];
  state.personDays = { current: 0, ytd: 0 };
  state.noWorkforce = false;
  state.rawCalls = [];
});

const week = "from=2026-08-24&to=2026-08-27";

describe("the workforce card (H4)", () => {
  it("counts the same people on both sides: active employees and team leads, never an agent or a leaver", async () => {
    state.timesheets = [entry("asha", "2026-08-25", 8), entry("dana", "2026-08-25", 8), entry("admin", "2026-08-25", 8)];
    const res = await request(app).get(`/reports/admin-summary?${week}`).expect(200);
    // Asha and Ben are the workforce. Dana has left and the admin is not in it; neither may count
    // as "logged" against a population they are not part of. The bot is not a person.
    expect(res.body.workforce).toMatchObject({ population: 2, logged: 1, notLogged: 1, loggedPct: 50 });
  });

  it("is null — not a red 0% — when there is nobody to measure", async () => {
    state.noWorkforce = true;
    const res = await request(app).get(`/reports/admin-summary?${week}`).expect(200);
    expect(res.body.workforce.loggedPct).toBeNull();
  });

  it("compares per-working-day averages on both sides, over working days only", async () => {
    state.personDays = { current: 6, ytd: 340 };
    const res = await request(app).get(`/reports/admin-summary?${week}`).expect(200);
    // Mon–Thu: four working days so far, 6 person-days → 1.5 people logging per working day.
    expect(res.body.workforce.avgPerWorkingDay).toBe(1.5);
    // 1 Jan – 26 Aug 2026 has 170 working days: 340 person-days is 2 a day.
    expect(res.body.workforce.ytdAvgPerWorkingDay).toBe(2);
    // Both counts are restricted to the configured working weekdays and to the same population.
    for (const call of state.rawCalls) {
      expect(call.sql).toMatch(/COUNT\(DISTINCT/);
      expect(call.sql).toMatch(/isAgent/);
      expect(call.sql).toMatch(/DAYOFWEEK/);
    }
  });
});

describe("the stat tiles (M4)", () => {
  it("reports the period's approved hours, not the all-time total", async () => {
    state.timesheets = [entry("asha", "2026-08-25", 8), entry("asha", "2026-07-02", 5), entry("ben", "2026-08-18", 3)];
    const res = await request(app).get(`/reports/admin-summary?${week}`).expect(200);
    expect(res.body.approvedHours).toBe(8);
    // Like-for-like: Mon 17 – Thu 20 August.
    expect(res.body.approvedHoursPrev).toBe(3);
    expect(res.body.period).toMatchObject({ comparisonFrom: "2026-08-17", comparisonTo: "2026-08-20", comparisonLabel: "vs the same days last week" });
  });

  it("gives point-in-time tiles no one-way 'vs yesterday' delta", async () => {
    const res = await request(app).get(`/reports/admin-summary?${week}`).expect(200);
    expect(res.body).not.toHaveProperty("usersYesterday");
    expect(res.body).not.toHaveProperty("projectsYesterday");
    expect(res.body).not.toHaveProperty("pendingApprovalsYesterday");
    expect(res.body).not.toHaveProperty("openEscalationsYesterday");
    // People are counted as people: the agent and the leaver are not users here.
    expect(res.body.users).toBe(3);
    expect(res.body.usersJoined).toBe(0);
  });

  it("counts approved HOURS this week (Monday to today, IST) against the same weekdays last week", async () => {
    state.timesheets = [entry("asha", "2026-08-24", 7.5), entry("ben", "2026-08-26", 2), entry("asha", "2026-08-17", 4), entry("asha", "2026-08-21", 9)];
    const res = await request(app).get("/reports/admin-summary").expect(200);
    expect(res.body.approvedThisWeek).toBe(9.5);
    // Last Mon–Thu only: Friday the 21st is not "the same days".
    expect(res.body.approvedLastWeek).toBe(4);
  });

  it("counts an approval SLA breach from the deadline, whether or not the breach sweep ran", async () => {
    state.timesheets = [
      // Deadline 10:00 IST today, still waiting at 16:30: breached, though no sweep stamped it.
      entry("asha", "2026-08-26", 8, { status: "SUBMITTED", reviewedAt: null, approvalDeadline: new Date("2026-08-27T04:30:00.000Z") }),
      // Reviewed before its deadline: not a breach.
      entry("ben", "2026-08-26", 8, { reviewedAt: new Date("2026-08-27T03:00:00.000Z"), approvalDeadline: new Date("2026-08-27T04:30:00.000Z") }),
      // Deadline later today: not yet a breach.
      entry("ben", "2026-08-26", 2, { status: "SUBMITTED", reviewedAt: null, approvalDeadline: new Date("2026-08-27T15:00:00.000Z") })
    ];
    const res = await request(app).get("/reports/admin-summary").expect(200);
    expect(res.body.slaBreached).toBe(1);
  });
});

describe("tickets in the window (M5, M1)", () => {
  it("counts a ticket closed when it was resolved or closed, not when it was last edited", async () => {
    state.tickets = [
      // Resolved in July, edited today: not closed today.
      { status: "CLOSED", deletedAt: null, createdAt: day("2026-07-01"), updatedAt: new Date("2026-08-27T06:00:00Z"), resolvedAt: day("2026-07-10"), closedAt: day("2026-07-11") },
      // Resolved this morning.
      { status: "RESOLVED", deletedAt: null, createdAt: day("2026-08-01"), updatedAt: new Date("2026-08-27T06:00:00Z"), resolvedAt: new Date("2026-08-27T06:00:00Z"), closedAt: null },
      // Closed straight from review this morning, never resolved.
      { status: "CLOSED", deletedAt: null, createdAt: day("2026-08-01"), updatedAt: new Date("2026-08-27T07:00:00Z"), resolvedAt: null, closedAt: new Date("2026-08-27T07:00:00Z") }
    ];
    const res = await request(app).get("/reports/admin-summary").expect(200);
    expect(res.body.ticketsClosed).toBe(2);
  });

  it("starts today at IST midnight, so a ticket raised at 02:00 IST counts today", async () => {
    state.tickets = [
      // 20:30 UTC on the 26th is 02:00 IST on the 27th.
      { status: "OPEN", deletedAt: null, createdAt: new Date("2026-08-26T20:30:00.000Z"), updatedAt: null, resolvedAt: null, closedAt: null },
      // 17:00 UTC on the 26th is 22:30 IST on the 26th — yesterday.
      { status: "OPEN", deletedAt: null, createdAt: new Date("2026-08-26T17:00:00.000Z"), updatedAt: null, resolvedAt: null, closedAt: null }
    ];
    const res = await request(app).get("/reports/admin-summary").expect(200);
    expect(res.body.ticketsRaised).toBe(1);
  });
});
