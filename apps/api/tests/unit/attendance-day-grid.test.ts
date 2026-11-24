/**
 * 7.0.0 — GET /attendance/day-grid, the dashboard and Reports integration of leave, holidays and
 * attendance. Real router and real service, prisma mocked.
 *
 * Under test: module-off answers `{ enabled: false }` and reads nothing else; scope follows the
 * dashboard (users:manage → everyone, otherwise self + direct reports); no leave reason, note or
 * coordinate ever leaves the server; statuses come from the shared resolver; leave-only mode never
 * claims ABSENT; the query count does not grow with the number of people.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { permissions } from "@timesheet/shared";

let actor = { id: "mgr", name: "Max", email: "max@x.io", role: "MANAGER", permissions: [] as string[] };
let settings = { attendanceEnabled: true, leaveEnabled: true };
let entitled = true;

type Person = { id: string; name: string; managerId: string | null; timezone: string; holidayCalendarId: string | null };
let people: Person[] = [];
const calls: Record<string, number> = {};
const count = (n: string) => {
  calls[n] = (calls[n] ?? 0) + 1;
};
const selects: Array<Record<string, unknown>> = [];

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
    globalAttendanceSettings: { upsert: async () => settings, findUnique: async () => settings },
    user: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; managerId?: string } }) => {
        count("user.findMany");
        if (where.managerId) return people.filter((p) => p.managerId === where.managerId).map((p) => ({ id: p.id }));
        return people.filter((p) => !where.id || where.id.in.includes(p.id));
      }
    },
    holidayCalendar: { findFirst: async () => ({ id: "cal-1" }) },
    holiday: {
      findMany: async () => {
        count("holiday.findMany");
        return [{ calendarId: "cal-1", date: new Date("2026-11-18T00:00:00Z"), name: "Diwali" }];
      }
    },
    leaveRequest: {
      findMany: async (args: { select: Record<string, unknown> }) => {
        count("leaveRequest.findMany");
        selects.push(args.select);
        return [
          {
            userId: "r1",
            startDate: new Date("2026-11-19T00:00:00Z"),
            endDate: new Date("2026-11-19T00:00:00Z"),
            startHalf: "FULL",
            endHalf: "FULL",
            reason: "SECRET REASON",
            leaveType: { code: "PL" }
          },
          {
            userId: "r2",
            startDate: new Date("2026-11-20T00:00:00Z"),
            endDate: new Date("2026-11-20T00:00:00Z"),
            startHalf: "FIRST_HALF",
            endHalf: "FIRST_HALF",
            leaveType: { code: "CL" }
          }
        ];
      }
    },
    leaveType: {
      findMany: async () => {
        count("leaveType.findMany");
        return [
          { code: "PL", name: "Privilege leave" },
          { code: "CL", name: "Casual leave" }
        ];
      }
    },
    attendanceRecord: {
      findMany: async (args: { select: Record<string, unknown> }) => {
        count("attendanceRecord.findMany");
        selects.push(args.select);
        return [{ userId: "r2", workDate: new Date("2026-11-20T00:00:00Z"), lat: 12.97, lng: 77.59 }];
      }
    },
    timesheet: {
      findMany: async () => {
        count("timesheet.findMany");
        return [
          { userId: "r1", totalHours: 2 },
          { userId: "r1", totalHours: "1.5" }
        ];
      }
    }
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getPlanningEntitlements: async () => ({ attendanceEnabled: entitled, leaveManagementEnabled: entitled }),
  isPlanningCapabilityAllowed: async () => entitled
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5] }) }));

const { attendanceRouter } = await import("../../src/controllers/attendance.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { getDayGrid } = await import("../../src/services/attendance-day-grid.service.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/att", attendanceRouter);
  a.use(errorHandler);
  return a;
}

const p = (id: string, managerId: string | null): Person => ({ id, name: id.toUpperCase(), managerId, timezone: "UTC", holidayCalendarId: null });
// Mon 16 Nov – Sun 22 Nov 2026. Diwali on Wed 18, r1 on PL Thu 19, r2 half CL Fri 20 and punched in.
const URL = "/att/day-grid?from=2026-11-16&to=2026-11-22";

beforeEach(() => {
  actor = { id: "mgr", name: "Max", email: "max@x.io", role: "MANAGER", permissions: [] };
  settings = { attendanceEnabled: true, leaveEnabled: true };
  entitled = true;
  people = [p("r1", "mgr"), p("r2", "mgr"), p("x1", "other"), p("mgr", null)];
  selects.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
});

describe("module off", () => {
  it("answers { enabled: false } and reads nothing else when both toggles are off", async () => {
    settings = { attendanceEnabled: false, leaveEnabled: false };
    const res = await request(app()).get(URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual({});
  });

  it("answers { enabled: false } when the plan does not include it", async () => {
    entitled = false;
    const res = await request(app()).get(URL);
    expect(res.body).toEqual({ enabled: false });
    expect(calls["user.findMany"]).toBeUndefined();
  });
});

describe("scope", () => {
  it("a manager sees themselves and their direct reports", async () => {
    const res = await request(app()).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.people.map((x: { userId: string }) => x.userId).sort()).toEqual(["mgr", "r1", "r2"]);
  });

  it("an employee who manages nobody sees only themselves", async () => {
    actor = { ...actor, id: "x1", role: "EMPLOYEE" };
    const res = await request(app()).get(URL);
    expect(res.body.people.map((x: { userId: string }) => x.userId)).toEqual(["x1"]);
  });

  it("users:manage sees everyone", async () => {
    actor = { ...actor, id: "adm", role: "ADMIN", permissions: [permissions.USERS_MANAGE] };
    const res = await request(app()).get(URL);
    expect(res.body.people).toHaveLength(4);
  });
});

describe("statuses and privacy", () => {
  it("resolves weekend, holiday, leave, half day, present and absent through the shared resolver", async () => {
    const res = await request(app()).get(URL);
    const r1 = res.body.people.find((x: { userId: string }) => x.userId === "r1");
    const r2 = res.body.people.find((x: { userId: string }) => x.userId === "r2");
    expect(r1.days["2026-11-16"]).toEqual({ status: "ABSENT" });
    expect(r1.days["2026-11-18"]).toEqual({ status: "HOLIDAY", holidayName: "Diwali" });
    expect(r1.days["2026-11-19"]).toEqual({ status: "LEAVE", leaveTypeCode: "PL", leaveTypeName: "Privilege leave" });
    expect(r1.days["2026-11-21"]).toEqual({ status: "WEEKEND" });
    expect(r2.days["2026-11-20"]).toEqual({ status: "PRESENT", leaveTypeCode: "CL", leaveTypeName: "Casual leave", halfDay: "FIRST_HALF" });
    expect(r1.summary).toEqual({ workingDays: 4, holidays: 1, leaveDays: { PL: 1 }, presentDays: 0, absentDays: 3, loggedHours: 3.5 });
    expect(r2.summary.leaveDays).toEqual({ CL: 0.5 });
    expect(r2.summary.presentDays).toBe(1);
  });

  it("never sends a leave reason, note or coordinate, and never selects one", async () => {
    const res = await request(app()).get(URL);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("SECRET");
    expect(text).not.toMatch(/"(lat|lng|reason|note|decisionNote|attachment)"/);
    for (const s of selects) {
      expect(Object.keys(s)).not.toEqual(expect.arrayContaining(["lat"]));
      expect(Object.keys(s)).not.toContain("reason");
    }
  });

  it("with leave on and attendance off, a working day is never ABSENT or PRESENT", async () => {
    settings = { attendanceEnabled: false, leaveEnabled: true };
    const res = await request(app()).get(URL);
    expect(res.body.attendanceEnabled).toBe(false);
    const statuses = res.body.people.flatMap((x: { days: Record<string, { status: string }> }) => Object.values(x.days).map((d) => d.status));
    expect(statuses).not.toContain("ABSENT");
    expect(statuses).not.toContain("PRESENT");
    expect(calls["attendanceRecord.findMany"]).toBeUndefined();
  });
});

describe("validation and batching", () => {
  it("refuses a bad or too-long range", async () => {
    expect((await request(app()).get("/att/day-grid?from=nope&to=2026-11-22")).status).toBe(422);
    expect((await request(app()).get("/att/day-grid?from=2026-11-22&to=2026-11-16")).status).toBe(422);
    expect((await request(app()).get("/att/day-grid?from=2026-01-01&to=2026-12-31")).status).toBe(422);
  });

  it("runs the same number of queries for 3 people and 300", async () => {
    actor = { ...actor, permissions: [permissions.USERS_MANAGE] };
    await getDayGrid(actor, { from: "2026-11-16", to: "2026-11-22" });
    const small = { ...calls };
    for (const k of Object.keys(calls)) delete calls[k];
    people = [...people, ...Array.from({ length: 300 }, (_, i) => p(`u${i}`, "mgr"))];
    await getDayGrid(actor, { from: "2026-11-16", to: "2026-11-22" });
    expect(calls).toEqual(small);
  });
});
