/**
 * V17 A6 — attendance analytics and insights.
 *
 * Under test: the arithmetic on fixtures (pure functions), k-anonymity suppression, who may call
 * which audience, the rule-based insights, that the AI payload carries no coordinate / IP / note /
 * email / name / id, that an AI failure falls back to rules silently, and that a cached AI answer is
 * reused instead of paying for another call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let actor = { id: "mgr", name: "Max", email: "max@x.io", role: "MANAGER", permissions: [] as string[] };
let settingsRow: Record<string, unknown> = {};
let cacheRow: { cacheKey: string; insights: unknown; expiresAt: Date } | null = null;
const cacheWrites: unknown[] = [];
const cacheStore = new Map<string, { cacheKey: string; insights: unknown; expiresAt: Date }>();
const aiCalls: Array<{ audience: string; facts: string }> = [];
let aiImpl: () => Promise<Array<{ title: string; detail: string }>> = async () => [{ title: "AI says", detail: "something" }];

type Person = { id: string; name: string; email: string; managerId: string | null; timezone: string; holidayCalendarId: null; weeklyCapacityHours: number | null };
let people: Person[] = [];
let records: Array<Record<string, unknown>> = [];
/** V17 Phase B: approved / pending leave rows, read only when settingsRow.leaveEnabled is on. */
let leaveRows: Array<Record<string, unknown>> = [];

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
      next();
    }
  };
});

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    globalAttendanceSettings: { upsert: async () => settingsRow, findUnique: async () => settingsRow },
    user: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        people.filter((p) => (typeof where.managerId === "string" ? p.managerId === where.managerId : true)),
      findUnique: async ({ where }: { where: { id: string } }) => people.find((p) => p.id === where.id) ?? null
    },
    holidayCalendar: { findFirst: async () => null },
    holiday: { findMany: async () => [] },
    attendanceRecord: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) => records.filter((r) => where.userId.in.includes(r.userId as string))
    },
    timesheet: { findMany: async () => [] },
    missedDayReason: { findMany: async () => [] },
    auditLog: { findMany: async () => [] },
    attendanceSource: { findMany: async () => [] },
    leaveRequest: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) => leaveRows.filter((l) => where.userId.in.includes(l.userId as string)),
      groupBy: async () => []
    },
    leaveType: { findMany: async () => [{ id: "t-pl", code: "PL", name: "Privilege", colour: "primary", annualQuota: 12, accrual: "YEARLY_UPFRONT", carryForwardMax: 0, allowHalfDay: true, isPaid: true, requiresApproval: true, requiresDocumentAfterDays: null, allowNegative: false, enabled: true, sortOrder: 0 }] },
    leaveBalanceLedger: { groupBy: async () => [] },
    attendanceEvent: { groupBy: async () => [] },
    attendanceInsightCache: {
      findUnique: async ({ where }: { where: { cacheKey: string } }) => cacheRow ?? cacheStore.get(where.cacheKey) ?? null,
      upsert: async (args: { create: { cacheKey: string; insights: unknown; expiresAt: Date } }) => {
        cacheWrites.push(args);
        cacheStore.set(args.create.cacheKey, args.create);
        return {};
      }
    }
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getPlanningEntitlements: async () => ({ attendanceEnabled: true, attendanceAiInsightsEnabled: true }),
  isPlanningCapabilityAllowed: async () => true
}));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 })
}));
vi.mock("../../src/services/user-clock.service.js", () => ({ userClock: async () => ({ today: new Date("2026-11-23T00:00:00Z") }) }));
vi.mock("../../src/services/ai.service.js", () => ({
  generateAttendanceInsights: async (p: { audience: string; facts: string }) => {
    aiCalls.push(p);
    return aiImpl();
  }
}));

const { attendanceRouter } = await import("../../src/controllers/attendance.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const svc = await import("../../src/services/attendance-analytics.service.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/att", attendanceRouter);
  a.use(errorHandler);
  return a;
}

const OPTS = { latenessEnabled: false, expectedStartMinute: 600, workingDaysPerWeek: 5, minGroupSize: 3 };

/** A working-day fact; override what the case needs. 2026-11-02 is a Monday. */
function day(date: string, over: Partial<import("../../src/services/attendance-analytics.service.js").DayFact> = {}) {
  return {
    date,
    weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
    status: "PRESENT" as const,
    isWorkingDay: true,
    closed: true,
    punchMinute: 540,
    source: "WEB" as const,
    face: null,
    hoursLogged: 8,
    hasTimesheet: true,
    reasonCode: null,
    ...over
  };
}

function personFacts(id: string, days: ReturnType<typeof day>[]) {
  return { userId: id, name: `Name ${id}`, managerId: "mgr", weeklyCapacityHours: 40, days };
}

const absent = (date: string, reasonCode: string | null = null) =>
  day(date, { status: "ABSENT", punchMinute: null, source: null, hoursLogged: 0, hasTimesheet: false, reasonCode });

beforeEach(() => {
  actor = { id: "mgr", name: "Max", email: "max@x.io", role: "MANAGER", permissions: [] };
  settingsRow = { attendanceEnabled: true, minGroupSize: 3, latenessEnabled: false, expectedStartMinute: 600, aiInsightsSelf: true, aiInsightsManager: true, aiInsightsOrg: true, aiInsightsFrequency: "WEEKLY" };
  cacheRow = null;
  cacheWrites.length = 0;
  cacheStore.clear();
  aiCalls.length = 0;
  aiImpl = async () => [{ title: "AI says", detail: "something" }];
  people = [
    { id: "mgr", name: "Max", email: "max@x.io", managerId: null, timezone: "UTC", holidayCalendarId: null, weeklyCapacityHours: null },
    { id: "r1", name: "Ana", email: "ana@x.io", managerId: "mgr", timezone: "UTC", holidayCalendarId: null, weeklyCapacityHours: 40 },
    { id: "r2", name: "Ben", email: "ben@x.io", managerId: "mgr", timezone: "UTC", holidayCalendarId: null, weeklyCapacityHours: 40 }
  ];
  leaveRows = [];
  records = [
    { userId: "r1", workDate: new Date("2026-11-20T00:00:00Z"), punchInAt: new Date("2026-11-20T09:10:00Z"), source: "WEB", faceAttemptId: "fa-1", flagged: false, lat: 12.97, lng: 77.59, ip: "10.0.0.1" }
  ];
});

/* ----------------------------- pure aggregation ----------------------------- */

describe("summariseSelf", () => {
  const days = [
    day("2026-11-02", { punchMinute: 540 }),
    day("2026-11-03", { punchMinute: 550, hasTimesheet: false, hoursLogged: 0 }),
    absent("2026-11-04", "FORGOT"),
    day("2026-11-05", { punchMinute: 560, source: "WEBHOOK" }),
    day("2026-11-06", { punchMinute: 620 }),
    day("2026-11-07", { status: "WEEKEND", isWorkingDay: false, punchMinute: null, source: null, hoursLogged: 0, hasTimesheet: false }),
    day("2026-11-09", { status: "PENDING", closed: false, punchMinute: null, source: null, hoursLogged: 0, hasTimesheet: false })
  ];

  it("counts statuses, presence, reasons and sources", () => {
    const s = svc.summariseSelf({ days, weeklyCapacityHours: 40 }, OPTS);
    expect(s.statusCounts).toMatchObject({ PRESENT: 4, ABSENT: 1, WEEKEND: 1, PENDING: 1 });
    expect(s.presenceRate).toBe(0.8);
    expect(s.missedReasons).toEqual({ FORGOT: 1 });
    expect(s.sources).toEqual({ WEB: 3, WEBHOOK: 1 });
    expect(s.absencesByWeekday[3]).toBe(1);
  });

  it("expected hours = closed working days x capacity / working days per week", () => {
    const s = svc.summariseSelf({ days, weeklyCapacityHours: 40 }, OPTS);
    // 5 closed working days (4 present + 1 absent); the pending future day does not count yet.
    expect(s.hours).toEqual({ logged: 24, expected: 40 });
  });

  it("counts present days with no timesheet, only once the day is over", () => {
    const s = svc.summariseSelf({ days, weeklyCapacityHours: 40 }, OPTS);
    expect(s.presentNoTimesheetDays).toBe(1);
    expect(s.closedPresentDays).toBe(4);
  });

  it("reports median and drift, and no on-time rate while lateness is off", () => {
    const s = svc.summariseSelf({ days, weeklyCapacityHours: 40 }, OPTS);
    expect(s.medianPunchMinute).toBe(555);
    expect(s.onTimeRate).toBeNull();
    expect(s.driftMinutesPerWeek).toBeNull(); // 4 punches < 5
  });

  it("computes an on-time rate against expectedStartMinute when lateness is on", () => {
    const s = svc.summariseSelf({ days, weeklyCapacityHours: 40 }, { ...OPTS, latenessEnabled: true, expectedStartMinute: 555 });
    expect(s.onTimeRate).toBe(0.5);
  });
});

describe("driftMinutesPerWeek", () => {
  it("is +7 min/week for a punch 1 minute later every calendar day", () => {
    const pts = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((date, i) => ({ date, minute: 540 + i }));
    expect(svc.driftMinutesPerWeek(pts)).toBe(7);
  });

  it("is null under five points", () => {
    expect(svc.driftMinutesPerWeek([{ date: "2026-11-02", minute: 540 }])).toBeNull();
  });
});

describe("k-anonymity", () => {
  const p = (id: string) => personFacts(id, [day("2026-11-02", { punchMinute: 545 }), absent("2026-11-03", "SICK")]);

  it("suppresses every group aggregate below minGroupSize", () => {
    const g = svc.summariseGroup([p("a"), p("b")], OPTS);
    expect(g).toEqual({ people: 2, suppressed: true, aggregates: null });
  });

  it("shows aggregates at minGroupSize", () => {
    const g = svc.summariseGroup([p("a"), p("b"), p("c")], OPTS);
    expect(g.suppressed).toBe(false);
    expect(g.aggregates).toMatchObject({ presenceRate: 0.5, absenceRate: 0.5, missedReasons: { SICK: 3 } });
    expect(g.aggregates!.punchHistogram).toEqual([{ bucket: "09:00", count: 3 }]);
  });

  it("keeps per-person rows for a manager even when the group is suppressed", () => {
    expect(svc.personRows([p("a")], OPTS)).toHaveLength(1);
  });

  it("suppresses org by-manager groups individually", async () => {
    actor = { ...actor, id: "boss", role: "SUPER_ADMIN" };
    const res = await request(app()).get("/att/analytics/org?from=2026-11-16&to=2026-11-20");
    expect(res.status).toBe(200);
    // mgr has two reports (< 3): suppressed; the overall group is all 3 people.
    const mgrTeam = res.body.byManager.find((t: { managerId: string | null }) => t.managerId === "mgr");
    expect(mgrTeam).toMatchObject({ people: 2, suppressed: true, aggregates: null });
    expect(res.body.overall.suppressed).toBe(false);
    // One person punched via WEB: below the floor, so no punch count is shown.
    expect(res.body.bySource).toEqual([{ source: "WEB", people: 1, suppressed: true, punches: null }]);
    expect(res.body.face.suppressed).toBe(true);
  });
});

/* ----------------------------- rule insights ----------------------------- */

function mine(over: Partial<import("../../src/services/attendance-analytics.service.js").SelfSummary> = {}, upcoming: Array<{ date: string; name: string }> = []) {
  const base = svc.summariseSelf({ days: [], weeklyCapacityHours: 40 }, OPTS);
  return {
    audience: "me" as const,
    range: { from: "2026-11-01", to: "2026-11-30", days: 30, workingDays: 21 },
    lateness: { enabled: false, expectedStartMinute: 600 },
    summary: { ...base, ...over },
    upcomingHolidays: upcoming
  };
}

describe("ruleInsights", () => {
  it("flags Monday-heavy absences", () => {
    const ids = svc.ruleInsights(mine({ absencesByWeekday: [0, 3, 1, 0, 0, 0, 0] })).map((i) => i.id);
    expect(ids).toContain("weekday-heavy");
  });

  it("flags drift, a high Forgot share and present-without-timesheet", () => {
    const list = svc.ruleInsights(
      mine({ driftMinutesPerWeek: 12, missedReasons: { FORGOT: 2, SICK: 1 }, presentNoTimesheetDays: 4, closedPresentDays: 10 })
    );
    expect(list.map((i) => i.id)).toEqual(["drift", "forgot-share", "present-no-timesheet"]);
    expect(list.every((i) => i.source === "rule")).toBe(true);
  });

  it("flags a holiday cluster ahead", () => {
    const list = svc.ruleInsights(mine({}, [{ date: "2026-12-24", name: "Eve" }, { date: "2026-12-25", name: "Christmas" }]));
    expect(list.map((i) => i.id)).toContain("holiday-cluster");
  });

  it("flags an enabled integration silent for 2+ working days (org)", () => {
    const org = {
      audience: "org" as const,
      range: { from: "2026-11-01", to: "2026-11-30", days: 30, workingDays: 21 },
      minGroupSize: 3,
      lateness: { enabled: false, expectedStartMinute: 600 },
      overall: { people: 1, suppressed: true, aggregates: null },
      byManager: [],
      bySource: [],
      face: { suppressed: true, checks: null, passRate: null, flagRate: null },
      loginHistogram: { suppressed: true, hours: null },
      integrations: [
        { id: "s1", name: "Lobby", kind: "WEBHOOK" as const, enabled: true, counts: {}, lastEventAt: null, silentWorkingDays: 3 },
        { id: "s2", name: "Off", kind: "WEBHOOK" as const, enabled: false, counts: {}, lastEventAt: null, silentWorkingDays: 9 }
      ],
      holidays: { dates: 0, personDays: 0 },
      upcomingHolidays: []
    };
    const ids = svc.ruleInsights(org).map((i) => i.id);
    expect(ids).toEqual(["group-too-small", "source-silent:s1"]);
  });

  it("is deterministic", () => {
    const d = mine({ absencesByWeekday: [0, 3, 1, 0, 0, 0, 0], driftMinutesPerWeek: 20 });
    expect(svc.ruleInsights(d)).toEqual(svc.ruleInsights(d));
  });

  it("counts working days since the last event", () => {
    // Fri 20 → Mon 23: Sat/Sun skipped, Mon counts.
    expect(svc.workingDaysSince("2026-11-20", "2026-11-23", [1, 2, 3, 4, 5])).toBe(1);
  });
});

/* ----------------------------- the AI allowlist ----------------------------- */

const FORBIDDEN_KEY = /^(lat|lng|latitude|longitude|ip|userAgent|note|notes|email|name|managerName|userId|managerId|id|faceAttemptId|rawPayload|accuracyM)$/i;
const FORBIDDEN_VALUE = [/@/, /\b[0-9a-f]{8}-[0-9a-f]{4}-/i, /\b\d{1,3}(\.\d{1,3}){3}\b/];

function leaks(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...leaks(v, `${path}.${k}`)]);
  }
  if (typeof value === "string" && FORBIDDEN_VALUE.some((re) => re.test(value))) return [`${path}=${value}`];
  return [];
}

/** Paths of arrays whose items look like one person's figures. */
function perPersonArrays(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    const personal = value.some((v) => v && typeof v === "object" && ("presenceRate" in v || "driftMinutesPerWeek" in v || "absentDays" in v || /^Person /.test(String((v as { label?: unknown }).label ?? ""))));
    return [...(personal ? [path] : []), ...value.flatMap((v, i) => perPersonArrays(v, `${path}[${i}]`))];
  }
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => perPersonArrays(v, `${path}.${k}`));
  return [];
}

describe("buildAiPayload is an allowlist", () => {
  it("self: no coordinates, IPs, notes, emails, names or ids", async () => {
    actor = { ...actor, id: "r1", role: "EMPLOYEE" };
    const data = await svc.getMyAnalytics("r1", { from: "2026-11-16", to: "2026-11-20" }, new Date("2026-11-23T12:00:00Z"));
    expect(leaks(svc.buildAiPayload(data))).toEqual([]);
  });

  it("team: people become positional labels", async () => {
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, new Date("2026-11-23T12:00:00Z"));
    const payload = svc.buildAiPayload(data);
    expect(leaks(payload)).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("Ana");
    expect(perPersonArrays(payload)).toEqual([]);
  });

  it("team: a suppressed group (2 < 3) yields no individual figures and no distribution", async () => {
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, new Date("2026-11-23T12:00:00Z"));
    expect(data.group.suppressed).toBe(true);
    const payload = svc.buildAiPayload(data);
    expect(payload.group).toEqual({ people: 2, suppressed: true });
    expect(payload).not.toHaveProperty("people");
    expect(payload).not.toHaveProperty("distribution");
    expect(JSON.stringify(payload)).not.toMatch(/presenceRate|driftMinutesPerWeek|absentDays|Person \d/);
  });

  it("team: at or above minGroupSize only counts go out, never a row per person", async () => {
    people.push({ id: "r3", name: "Cy", email: "cy@x.io", managerId: "mgr", timezone: "UTC", holidayCalendarId: null, weeklyCapacityHours: 40 });
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, new Date("2026-11-23T12:00:00Z"));
    const payload = svc.buildAiPayload(data);
    expect(perPersonArrays(payload)).toEqual([]);
    expect(payload.distribution).toMatchObject({ people: 3, driftingPeople: expect.any(Number) });
  });

  it("org: no names, ids or source names", async () => {
    const data = await svc.getOrgAnalytics({ id: "boss", role: "SUPER_ADMIN" }, { from: "2026-11-16", to: "2026-11-20" }, new Date("2026-11-23T12:00:00Z"));
    const withSource = {
      ...data,
      integrations: [{ id: "6f1c2b9e-1111-4222-8333-944455556666", name: "Lobby terminal", kind: "WEBHOOK" as const, enabled: true, counts: { ACCEPTED: 3 }, lastEventAt: null, silentWorkingDays: 0 }]
    };
    const payload = svc.buildAiPayload(withSource);
    expect(leaks(payload)).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/Lobby|Max|Ana|Ben/);
    expect(perPersonArrays(payload)).toEqual([]);
  });

  it("what reaches the model is exactly the payload", async () => {
    actor = { ...actor, id: "r1", role: "EMPLOYEE" };
    await request(app()).get("/att/analytics/me/insights?from=2026-11-16&to=2026-11-20");
    expect(aiCalls).toHaveLength(1);
    expect(leaks(JSON.parse(aiCalls[0].facts))).toEqual([]);
    expect(aiCalls[0].facts).not.toMatch(/12\.97|77\.59|10\.0\.0\.1|ana@x\.io/);
  });
});

/* ----------------------------- scope and gates ----------------------------- */

describe("scope", () => {
  it("an employee cannot read team or org analytics", async () => {
    actor = { ...actor, id: "r1", role: "EMPLOYEE" };
    expect((await request(app()).get("/att/analytics/team")).status).toBe(403);
    expect((await request(app()).get("/att/analytics/org")).status).toBe(403);
    expect((await request(app()).get("/att/analytics/team/insights")).status).toBe(403);
    expect((await request(app()).get("/att/analytics/me")).status).toBe(200);
  });

  it("a manager cannot read org analytics", async () => {
    expect((await request(app()).get("/att/analytics/org")).status).toBe(403);
    expect((await request(app()).get("/att/analytics/org/insights")).status).toBe(403);
    expect((await request(app()).get("/att/analytics/team")).status).toBe(200);
  });

  it("refuses a range over 180 days", async () => {
    expect((await request(app()).get("/att/analytics/me?from=2026-01-01&to=2026-11-20")).status).toBe(422);
  });

  it("403s when attendance is off", async () => {
    settingsRow.attendanceEnabled = false;
    expect((await request(app()).get("/att/analytics/me")).status).toBe(403);
  });

  it("a manager's team analytics contain only direct reports", async () => {
    const res = await request(app()).get("/att/analytics/team?from=2026-11-16&to=2026-11-20");
    expect(res.body.people.map((p: { userId: string }) => p.userId).sort()).toEqual(["r1", "r2"]);
    expect(res.body.group.suppressed).toBe(true); // 2 < 3
  });
});

/* ----------------------------- AI fallback and cache ----------------------------- */

describe("insights", () => {
  it("marks AI items 'ai' and rule items 'rule'", async () => {
    const res = await request(app()).get("/att/analytics/team/insights?from=2026-11-16&to=2026-11-20");
    expect(res.status).toBe(200);
    expect(res.body.aiStatus).toBe("fresh");
    expect(res.body.insights[0]).toMatchObject({ source: "ai", title: "AI says" });
    expect(res.body.insights.some((i: { source: string }) => i.source === "rule")).toBe(true);
    expect(cacheWrites).toHaveLength(1);
  });

  it("falls back to rules silently when the AI throws", async () => {
    aiImpl = async () => {
      throw new Error("provider down");
    };
    const res = await request(app()).get("/att/analytics/team/insights?from=2026-11-16&to=2026-11-20");
    expect(res.status).toBe(200);
    expect(res.body.aiStatus).toBe("unavailable");
    expect(res.body.insights.every((i: { source: string }) => i.source === "rule")).toBe(true);
    expect(res.body.insights.length).toBeGreaterThan(0);
  });

  it("reuses an unexpired cached answer without calling the model", async () => {
    cacheRow = { cacheKey: "team:mgr:2026-W48", insights: [{ title: "Cached", detail: "from before" }], expiresAt: new Date(Date.now() + 3_600_000) };
    const res = await request(app()).get("/att/analytics/team/insights?from=2026-11-16&to=2026-11-20");
    expect(res.body.aiStatus).toBe("cached");
    expect(res.body.insights[0]).toMatchObject({ source: "ai", title: "Cached" });
    expect(aiCalls).toHaveLength(0);
  });

  it("does not call the model when the audience's AI switch is off", async () => {
    settingsRow.aiInsightsManager = false;
    const res = await request(app()).get("/att/analytics/team/insights?from=2026-11-16&to=2026-11-20");
    expect(res.body.aiStatus).toBe("off");
    expect(aiCalls).toHaveLength(0);
  });
});

describe("AI insights cache is per period, not per range", () => {
  it("two different ranges in the same period make one model call", async () => {
    await request(app()).get("/att/analytics/team/insights?from=2026-11-16&to=2026-11-20").expect(200);
    const second = await request(app()).get("/att/analytics/team/insights?from=2026-11-01&to=2026-11-20").expect(200);
    expect(aiCalls).toHaveLength(1);
    expect(second.body.aiStatus).toBe("cached");
    // Rule insights still follow the requested range.
    expect(second.body.range.from).toBe("2026-11-01");
  });

  it("keys on the ISO week for WEEKLY and the day for DAILY", () => {
    const now = new Date("2026-11-25T10:00:00Z"); // Wednesday, ISO week 48
    expect(svc.insightCacheKey("team", "mgr", svc.aiInsightPeriod("WEEKLY", now))).toBe("team:mgr:2026-W48");
    expect(svc.insightCacheKey("team", "mgr", svc.aiInsightPeriod("DAILY", now))).toBe("team:mgr:2026-11-25");
    expect(svc.aiInsightPeriod("WEEKLY", new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  it("rate-limits the insights route per user", async () => {
    actor = { ...actor, id: "rate-limited-mgr" };
    people.forEach((p) => {
      if (p.managerId === "mgr") p.managerId = "rate-limited-mgr";
    });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await request(app()).get("/att/analytics/team/insights")).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

/* ----------------------------- V17 Phase B: leave in analytics ----------------------------- */

describe("leave in analytics", () => {
  const leave = (userId: string, startDate: string, endDate: string, status = "APPROVED", startHalf = "FULL") => ({
    userId,
    status,
    startDate: new Date(`${startDate}T00:00:00Z`),
    endDate: new Date(`${endDate}T00:00:00Z`),
    startHalf,
    endHalf: startHalf,
    leaveType: { code: "PL", name: "Privilege" },
    // Present on the row to prove it never travels further.
    reason: "Surgery at City Hospital"
  });
  const NOW = new Date("2026-11-23T12:00:00Z");

  it("is absent (null) while leave is switched off", async () => {
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, NOW);
    expect(data.leave).toBeNull();
  });

  it("team: flags two people off in one week as a coverage risk, with no reason text anywhere", async () => {
    settingsRow = { ...settingsRow, leaveEnabled: true };
    leaveRows = [leave("r1", "2026-11-30", "2026-12-01"), leave("r2", "2026-12-02", "2026-12-02", "PENDING")];
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, NOW);
    expect(data.leave?.coverage?.find((w) => w.weekStart === "2026-11-30")).toMatchObject({ peopleOff: 2, atRisk: true });
    expect(svc.ruleInsights(data).map((i) => i.id)).toContain("leave-coverage");
    expect(JSON.stringify(data)).not.toContain("Surgery");
  });

  it("team below minGroupSize: utilisation is suppressed and the AI gets no leave block", async () => {
    settingsRow = { ...settingsRow, leaveEnabled: true };
    leaveRows = [leave("r1", "2026-11-16", "2026-11-17")];
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, NOW);
    expect(data.leave?.utilisation).toBeNull();
    expect(svc.buildAiPayload(data)).not.toHaveProperty("leave");
  });

  it("team at minGroupSize: the AI gets counts per type and week, never names, ids, dates of a person or reasons", async () => {
    settingsRow = { ...settingsRow, leaveEnabled: true };
    people.push({ id: "r3", name: "Cy", email: "cy@x.io", managerId: "mgr", timezone: "UTC", holidayCalendarId: null, weeklyCapacityHours: 40 });
    leaveRows = [leave("r1", "2026-11-16", "2026-11-17"), leave("r2", "2026-11-30", "2026-11-30"), leave("r3", "2026-12-01", "2026-12-01")];
    const data = await svc.getTeamAnalytics(actor, { from: "2026-11-16", to: "2026-11-20" }, NOW);
    expect(data.leave?.utilisation).toEqual([{ code: "PL", name: "Privilege", days: 2, people: 1 }]);
    const payload = svc.buildAiPayload(data);
    expect(payload.leave).toEqual({ approvedDaysByType: { PL: 2 }, upcomingRequests: 2, upcomingPeople: 2, weeksAtRisk: 1, expiringDaysByType: undefined });
    expect(leaks(payload)).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/Ana|Ben|Cy|Surgery|2026-11-30/);
  });

  it("org: counts only, no upcoming entries at all", async () => {
    settingsRow = { ...settingsRow, leaveEnabled: true };
    leaveRows = [leave("r1", "2026-11-30", "2026-11-30")];
    const data = await svc.getOrgAnalytics({ id: "boss", role: "SUPER_ADMIN" }, { from: "2026-11-16", to: "2026-11-20" }, NOW);
    expect(data.leave?.upcoming.entries).toBeNull();
    expect(leaks(svc.buildAiPayload(data))).toEqual([]);
  });

  it("me: a half day of leave owes half the expected hours", () => {
    const s = svc.summariseSelf(personFacts("r1", [day("2026-11-02"), day("2026-11-03", { halfLeave: true })]), OPTS);
    expect(s.hours.expected).toBe(12);
  });

  it("me: the payload carries my own leave counts and nothing identifying", async () => {
    settingsRow = { ...settingsRow, leaveEnabled: true };
    actor = { ...actor, id: "r1", role: "EMPLOYEE" };
    leaveRows = [leave("r1", "2026-11-30", "2026-11-30")];
    const data = await svc.getMyAnalytics("r1", { from: "2026-11-16", to: "2026-11-20" }, NOW);
    expect(data.leave?.upcoming.requests).toBe(1);
    expect(leaks(svc.buildAiPayload(data))).toEqual([]);
  });
});

