/**
 * V17 A5 — Team Activity through the real router and the real service, with prisma mocked.
 *
 * Under test: who may see whom (manager → direct reports only, employee → 403, admin → everyone),
 * the timeline's IDOR refusal, that no coordinate ever leaves the server, the merged timeline's
 * order, and that the list's query count does not grow with the number of people (no N+1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let actor = { id: "mgr", name: "Max", email: "max@x.io", role: "MANAGER", permissions: [] as string[] };

type Person = { id: string; name: string; email: string; managerId: string | null; avatarUrl: null; timezone: string; holidayCalendarId: null; role: { name: string } };
let people: Person[] = [];
const calls: Record<string, number> = {};
function count(name: string) {
  calls[name] = (calls[name] ?? 0) + 1;
}

function matches(p: Person, where: Record<string, unknown>): boolean {
  if (where.id && where.id !== p.id) return false;
  if (where.managerId && where.managerId !== p.managerId) return false;
  return true;
}

let records: Array<Record<string, unknown>> = [];
let audits: Array<{ action: string; createdAt: Date; entity: string }> = [];

// 7.0.0: no shifts assigned in these fixtures, so every work date is the plain local day.
vi.mock("../../src/services/attendance-shift.service.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/attendance-shift.service.js")>();
  const ds = await import("../../src/services/attendance-day-status.js");
  return {
    ...real,
    shiftsForUsers: async () => new Map(),
    shiftForUser: async () => null,
    currentWorkDay: async (_u: string, now: Date, tz: string | null | undefined, fb: string | null | undefined) => ({ dateKey: ds.workDateKeyFor(now, tz, fb, null), shift: null })
  };
});

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

let settingsRow: Record<string, unknown> = { attendanceEnabled: true };
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    globalAttendanceSettings: { upsert: async () => ({ ...settingsRow }), findUnique: async () => ({ ...settingsRow }) },
    user: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        count("user.findMany");
        return people.filter((p) => matches(p, where));
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        count("user.findFirst");
        return people.find((p) => matches(p, where)) ?? null;
      },
      findUnique: async () => ({ timezone: "UTC", holidayCalendarId: null })
    },
    holidayCalendar: { findFirst: async () => { count("holidayCalendar.findFirst"); return null; } },
    holiday: { findMany: async () => { count("holiday.findMany"); return []; } },
    attendanceRecord: {
      findMany: async ({ where }: { where: { userId: unknown } }) => {
        count("attendanceRecord.findMany");
        const uid = where.userId;
        return records.filter((r) => (typeof uid === "string" ? r.userId === uid : true));
      }
    },
    timesheet: {
      findMany: async () => {
        count("timesheet.findMany");
        return [
          { userId: "r1", workDate: new Date("2026-11-20T00:00:00Z"), status: "DRAFT", totalHours: 2 },
          { userId: "r1", workDate: new Date("2026-11-20T00:00:00Z"), status: "SUBMITTED", totalHours: 1.5 }
        ];
      }
    },
    missedDayReason: { findMany: async () => { count("missedDayReason.findMany"); return []; } },
    notification: {
      findMany: async () => {
        count("notification.findMany");
        return [{ userId: "r2", body: "No punch-in recorded for 2026-11-23 yet." }, { userId: "r1", body: "No punch-in recorded for 2026-11-22 yet." }];
      }
    },
    auditLog: {
      findMany: async ({ where }: { where: { action: { in: string[] } } }) => {
        count("auditLog.findMany");
        return audits.filter((a) => where.action.in.includes(a.action));
      }
    },
    emailLog: {
      findMany: async () => {
        count("emailLog.findMany");
        return [{ template: "reminder.punch_in", subject: "You haven't punched in yet", status: "SENT", createdAt: new Date("2026-11-23T05:30:00Z") }];
      }
    }
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getPlanningEntitlements: async () => ({ attendanceEnabled: true }),
  isPlanningCapabilityAllowed: async () => true
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5] }) }));
vi.mock("../../src/services/user-clock.service.js", () => ({ userClock: async () => ({ today: new Date("2026-11-23T00:00:00Z") }) }));

const { attendanceRouter } = await import("../../src/controllers/attendance.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { mergeTimeline } = await import("../../src/services/attendance-team.service.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/att", attendanceRouter);
  a.use(errorHandler);
  return a;
}

function person(id: string, managerId: string | null): Person {
  return { id, name: id.toUpperCase(), email: `${id}@x.io`, managerId, avatarUrl: null, timezone: "UTC", holidayCalendarId: null, role: { name: "EMPLOYEE" } };
}

beforeEach(() => {
  actor = { id: "mgr", name: "Max", email: "max@x.io", role: "MANAGER", permissions: [] };
  people = [person("r1", "mgr"), person("r2", "mgr"), person("x1", "other"), person("mgr", null)];
  records = [
    { userId: "r1", workDate: new Date("2026-11-23T00:00:00Z"), punchInAt: new Date("2026-11-23T04:00:00Z"), source: "WEB", lat: 12.9716, lng: 77.5946, ip: "10.0.0.1", faceAttemptId: "fa-1", flagged: false, sourceRef: null }
  ];
  audits = [
    { action: "auth.login_succeeded", entity: "User", createdAt: new Date("2026-11-23T03:55:00Z") },
    { action: "timesheet.draft", entity: "Timesheet", createdAt: new Date("2026-11-23T09:00:00Z") },
    { action: "timesheet.updated", entity: "Timesheet", createdAt: new Date("2026-11-23T10:00:00Z") }
  ];
  for (const k of Object.keys(calls)) delete calls[k];
  settingsRow = { attendanceEnabled: true };
});

describe("GET /team/today late count", () => {
  it("counts Late over everyone in scope, not just the first page", async () => {
    settingsRow = { attendanceEnabled: true, latenessEnabled: true, expectedStartMinute: 540 };
    actor = { ...actor, id: "boss", role: "SUPER_ADMIN" };
    people = Array.from({ length: 150 }, (_, i) => person(`p${i}`, "mgr"));
    // 10:00 UTC, an hour after the 09:00 start, for all 150.
    records = people.map((p) => ({ ...records[0], userId: p.id, punchInAt: new Date("2026-11-23T10:00:00Z") }));
    const res = await request(app()).get("/att/team/today?date=2026-11-23&pageSize=100");
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(100);
    expect(res.body.late).toBe(150);
  });

  it("is null when lateness is off", async () => {
    const res = await request(app()).get("/att/team/today?date=2026-11-23");
    expect(res.body.late).toBeNull();
  });
});

describe("GET /team/today scoping", () => {
  it("a manager sees only direct reports", async () => {
    const res = await request(app()).get("/att/team/today?date=2026-11-23");
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { user: { id: string } }) => r.user.id).sort()).toEqual(["r1", "r2"]);
  });

  it("an employee is refused", async () => {
    actor.role = "EMPLOYEE";
    const res = await request(app()).get("/att/team/today?date=2026-11-23");
    expect(res.status).toBe(403);
  });

  it("a super admin sees everyone", async () => {
    actor = { ...actor, id: "boss", role: "SUPER_ADMIN" };
    const res = await request(app()).get("/att/team/today?date=2026-11-23");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  it("builds the row: status, punch, timesheet roll-up, reminder for that day only, summary", async () => {
    const res = await request(app()).get("/att/team/today?date=2026-11-23");
    const r1 = res.body.rows.find((r: { user: { id: string } }) => r.user.id === "r1");
    const r2 = res.body.rows.find((r: { user: { id: string } }) => r.user.id === "r2");
    expect(r1.status).toBe("PRESENT");
    expect(r1.punch).toMatchObject({ sourceLabel: "Web", location: "Location shared", face: "PASSED" });
    expect(r1.timesheet).toEqual({ state: "SUBMITTED", hours: 3.5 });
    expect(r1.reminderSent).toBe(false);
    expect(r2.reminderSent).toBe(true);
    expect(res.body.summary.PRESENT).toBe(1);
  });

  it("never sends a coordinate in the manager payload", async () => {
    const res = await request(app()).get("/att/team/today?date=2026-11-23");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("12.97");
    expect(text).not.toContain("77.59");
    expect(text).not.toMatch(/"lat"|"lng"|"ip"/);
  });

  it("issues the same number of queries for 2 people and 200 (no N+1)", async () => {
    await request(app()).get("/att/team/today?date=2026-11-23");
    const small = Object.values(calls).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(calls)) delete calls[k];
    people = [...Array.from({ length: 200 }, (_, i) => person(`p${i}`, "mgr")), person("mgr", null)];
    await request(app()).get("/att/team/today?date=2026-11-23&pageSize=100");
    const large = Object.values(calls).reduce((a, b) => a + b, 0);
    expect(large).toBe(small);
  });
});

describe("GET /team/:userId/timeline", () => {
  it("refuses a person outside the manager's scope (IDOR)", async () => {
    const res = await request(app()).get("/att/team/x1/timeline?from=2026-11-23&to=2026-11-23");
    expect(res.status).toBe(403);
  });

  it("refuses an unknown id with the same 403", async () => {
    const res = await request(app()).get("/att/team/nope/timeline?from=2026-11-23&to=2026-11-23");
    expect(res.status).toBe(403);
  });

  it("merges login, punch, timesheet and reminder email oldest first", async () => {
    const res = await request(app()).get("/att/team/r1/timeline?from=2026-11-23&to=2026-11-23");
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      "LOGIN",
      "PUNCH_IN",
      "REMINDER_EMAIL",
      "TIMESHEET_CREATED",
      "TIMESHEET_UPDATED"
    ]);
    expect(JSON.stringify(res.body)).not.toContain("12.97");
  });

  it("rejects an over-long or reversed window", async () => {
    expect((await request(app()).get("/att/team/r1/timeline?from=2026-10-01&to=2026-11-23")).status).toBe(422);
    expect((await request(app()).get("/att/team/r1/timeline?from=2026-11-23&to=2026-11-01")).status).toBe(422);
  });
});

describe("GET /me/history", () => {
  it("judges every day in the window with the shared resolver", async () => {
    actor.role = "EMPLOYEE";
    records = [{ ...records[0], userId: "mgr" }];
    const res = await request(app()).get("/att/me/history?from=2026-11-21&to=2026-11-23");
    expect(res.status).toBe(200);
    expect(res.body.days.map((d: { status: string }) => d.status)).toEqual(["WEEKEND", "WEEKEND", "PRESENT"]);
  });
});

describe("mergeTimeline", () => {
  it("keeps source order on equal timestamps", () => {
    const at = "2026-11-23T04:00:00.000Z";
    const out = mergeTimeline([
      { kind: "TIMESHEET_CREATED", at: "2026-11-23T05:00:00.000Z", label: "", detail: null },
      { kind: "LOGIN", at, label: "", detail: null },
      { kind: "PUNCH_IN", at, label: "", detail: null }
    ]);
    expect(out.map((e) => e.kind)).toEqual(["LOGIN", "PUNCH_IN", "TIMESHEET_CREATED"]);
  });
});
