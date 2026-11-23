/**
 * V17 A1 — the Attendance & Leave admin routes at the boundary, through the real router.
 *
 * What only the router can answer: that a non-super-admin is refused (the REAL requireSuperAdmin is
 * kept), that a workspace whose plan lacks the entitlement gets a 403 on every write while still
 * being able to READ its locked state, that the AI toggles need their own entitlement, and that
 * validation refuses the shapes a hand-written client gets wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "sa-1", name: "Root", email: "r@x.io", role: "SUPER_ADMIN", permissions: [] as string[] };
let currentRole = "SUPER_ADMIN";

const entitlements = {
  attendanceEnabled: true,
  leaveManagementEnabled: false,
  attendanceIntegrationsEnabled: false,
  attendanceAiInsightsEnabled: false
};

const settingsRow = { id: "global", attendanceEnabled: false, punchInMode: "OFF" };
const upsert = vi.fn().mockResolvedValue(settingsRow);
const holidayCreate = vi.fn();
const calendarFindUnique = vi.fn();
const auditFn = vi.fn().mockResolvedValue(undefined);
let reasonSettingOn = false;
let reasonOptions: { id: string; enabled: boolean }[] = [];
const optionUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => ({ id: where.id, ...data }));
const optionDeleteMany = vi.fn(async () => ({ count: 1 }));

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, role: currentRole, permissions: [] } as never;
      next();
    }
  };
});

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    globalAttendanceSettings: { upsert: (...a: unknown[]) => upsert(...a), findUnique: async () => ({ id: "global", missedDayReasonEnabled: reasonSettingOn }) },
    holidayCalendar: { findUnique: (...a: unknown[]) => calendarFindUnique(...a), findMany: vi.fn().mockResolvedValue([]) },
    holiday: { create: (...a: unknown[]) => holidayCreate(...a) },
    missedReasonOption: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      findUnique: async ({ where }: { where: { id: string } }) => reasonOptions.find((o) => o.id === where.id) ?? null,
      count: async ({ where }: { where: { enabled?: boolean; id?: { not: string } } }) =>
        reasonOptions.filter((o) => (where.enabled === undefined || o.enabled === where.enabled) && o.id !== where.id?.not).length,
      update: (...a: unknown[]) => optionUpdate(...a),
      deleteMany: (...a: unknown[]) => optionDeleteMany(...a)
    }
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));

vi.mock("../../src/services/plan-limits.service.js", () => ({
  getPlanningEntitlements: async () => ({ ...entitlements }),
  isPlanningCapabilityAllowed: async (_org: string, key: keyof typeof entitlements) => entitlements[key]
}));

vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditFn(...a) }));

const { attendanceSettingsRouter } = await import("../../src/controllers/attendance-settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { attendanceSettingsBody, isoDate } = await import("../../src/services/attendance-settings.service.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/a", attendanceSettingsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  currentRole = "SUPER_ADMIN";
  entitlements.attendanceEnabled = true;
  entitlements.attendanceAiInsightsEnabled = false;
  upsert.mockClear();
  holidayCreate.mockReset();
  calendarFindUnique.mockReset();
  auditFn.mockClear();
  reasonSettingOn = false;
  reasonOptions = [];
  optionUpdate.mockClear();
  optionDeleteMany.mockClear();
});

describe("attendance settings validation", () => {
  it("accepts a partial update and refuses unknown keys", () => {
    expect(attendanceSettingsBody.safeParse({ punchInMode: "MANDATORY" }).success).toBe(true);
    expect(attendanceSettingsBody.safeParse({ punchInMode: "SOMETIMES" }).success).toBe(false);
    expect(attendanceSettingsBody.safeParse({ surprise: true }).success).toBe(false);
  });

  it("refuses strings where numbers belong, because nothing coerces", () => {
    expect(attendanceSettingsBody.safeParse({ punchInReminderHour: "11" }).success).toBe(false);
    expect(attendanceSettingsBody.safeParse({ punchInReminderHour: 24 }).success).toBe(false);
    expect(attendanceSettingsBody.safeParse({ minGroupSize: 2 }).success).toBe(false);
  });

  it("refuses dates that are not real calendar days", () => {
    expect(isoDate.safeParse("2027-01-26").success).toBe(true);
    expect(isoDate.safeParse("2027-02-30").success).toBe(false);
    expect(isoDate.safeParse("26/01/2027").success).toBe(false);
  });
});

describe("/api/attendance/admin permissions and entitlement", () => {
  it("refuses anyone who is not a super admin", async () => {
    currentRole = "EMPLOYEE";
    await request(app()).get("/a/settings").expect(403);
    await request(app()).put("/a/settings").send({ attendanceEnabled: true }).expect(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("lets a super admin read the locked state when the plan lacks attendance", async () => {
    entitlements.attendanceEnabled = false;
    const res = await request(app()).get("/a/settings").expect(200);
    expect(res.body.entitlements.attendanceEnabled).toBe(false);
    expect(res.body.effective).toBe(false);
  });

  it("403s every write when the plan lacks attendance", async () => {
    entitlements.attendanceEnabled = false;
    await request(app()).put("/a/settings").send({ attendanceEnabled: true }).expect(403);
    await request(app()).post("/a/calendars").send({ name: "India" }).expect(403);
    await request(app()).post("/a/missed-reasons").send({ code: "X_Y", label: "x" }).expect(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("saves and audits when entitled", async () => {
    await request(app()).put("/a/settings").send({ attendanceEnabled: true, punchInReminderHour: 10 }).expect(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(auditFn).toHaveBeenCalledWith("sa-1", "attendance.settings_updated", "GlobalAttendanceSettings", "global", {
      attendanceEnabled: true,
      punchInReminderHour: 10
    });
  });

  it("needs the AI entitlement to turn an AI insight on, but not to turn one off", async () => {
    await request(app()).put("/a/settings").send({ aiInsightsSelf: true }).expect(403);
    await request(app()).put("/a/settings").send({ aiInsightsSelf: false }).expect(200);
    entitlements.attendanceAiInsightsEnabled = true;
    await request(app()).put("/a/settings").send({ aiInsightsOrg: true }).expect(200);
  });

  it("422s a malformed settings body before touching the database", async () => {
    await request(app()).put("/a/settings").send({ punchInReminderHour: "11" }).expect(422);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("holidays", () => {
  it("stores the date as midnight UTC and returns the calendar day", async () => {
    calendarFindUnique.mockResolvedValue({ id: "cal-1" });
    holidayCreate.mockImplementation(async ({ data }: { data: { date: Date } }) => ({ id: "h-1", ...data }));
    const res = await request(app()).post("/a/calendars/cal-1/holidays").send({ date: "2027-01-26", name: "Republic Day" }).expect(201);
    expect((holidayCreate.mock.calls[0][0] as { data: { date: Date } }).data.date.toISOString()).toBe("2027-01-26T00:00:00.000Z");
    expect(res.body.date).toBe("2027-01-26");
  });

  it("answers a duplicate date with 409, not a 500", async () => {
    calendarFindUnique.mockResolvedValue({ id: "cal-1" });
    holidayCreate.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await request(app()).post("/a/calendars/cal-1/holidays").send({ date: "2027-01-26", name: "Dup" }).expect(409);
  });

  it("404s a holiday on a calendar that does not exist", async () => {
    calendarFindUnique.mockResolvedValue(null);
    await request(app()).post("/a/calendars/nope/holidays").send({ date: "2027-01-26", name: "x" }).expect(404);
  });
});

describe("missed-day reason options can never all be off while the rule is on", () => {
  it("409s disabling or deleting the last enabled option while the rule is on", async () => {
    reasonSettingOn = true;
    reasonOptions = [{ id: "r1", enabled: true }, { id: "r2", enabled: false }];
    const put = await request(app()).put("/a/missed-reasons/r1").send({ enabled: false }).expect(409);
    expect(put.body.message).toMatch(/last enabled reason/i);
    await request(app()).delete("/a/missed-reasons/r1").expect(409);
    expect(optionUpdate).not.toHaveBeenCalled();
    expect(optionDeleteMany).not.toHaveBeenCalled();
  });

  it("allows it when another option stays enabled, or when the rule is off", async () => {
    reasonSettingOn = true;
    reasonOptions = [{ id: "r1", enabled: true }, { id: "r2", enabled: true }];
    await request(app()).put("/a/missed-reasons/r1").send({ enabled: false }).expect(200);
    reasonOptions = [{ id: "r1", enabled: true }];
    reasonSettingOn = false;
    await request(app()).delete("/a/missed-reasons/r1").expect(204);
  });

  it("409s turning the rule on with zero enabled options", async () => {
    reasonOptions = [{ id: "r1", enabled: false }];
    const res = await request(app()).put("/a/settings").send({ missedDayReasonEnabled: true }).expect(409);
    expect(res.body.message).toMatch(/enable at least one/i);
    expect(upsert).not.toHaveBeenCalled();
    reasonOptions = [{ id: "r1", enabled: true }];
    await request(app()).put("/a/settings").send({ missedDayReasonEnabled: true }).expect(200);
  });
});