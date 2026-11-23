/**
 * V17 A4 — the mandatory "why was this day missed?" reason (services/missed-day-reason.service.ts).
 *
 * Two layers: the pure rule (every edge case without a database), then every door that creates a
 * timesheet entry — the web draft and submit routes, the MCP log_timesheet_entry tool and the in-app
 * AI chat action — each refusing without a reason and saving the reason with it. All of them go
 * through saveTimesheet, so these tests prove there is no quieter door.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const { isMissedDayReasonRequired, validateMissedReason } = await import("../../src/services/missed-day-reason.service.js");

const MON_FRI = [1, 2, 3, 4, 5];
const base = {
  workDateKey: "2026-11-17", // Tuesday
  todayKey: "2026-11-18", // Wednesday
  workingDays: MON_FRI,
  isHoliday: false,
  existingEntries: 0,
  hasReason: false,
  enabled: true
};

describe("isMissedDayReasonRequired (pure)", () => {
  it("requires a reason for the first entry on a past working day", () => {
    expect(isMissedDayReasonRequired(base)).toBe(true);
  });
  it("never for today", () => {
    expect(isMissedDayReasonRequired({ ...base, workDateKey: "2026-11-18" })).toBe(false);
  });
  it("never for the future", () => {
    expect(isMissedDayReasonRequired({ ...base, workDateKey: "2026-11-19" })).toBe(false);
  });
  it("never for a weekend (per the workspace's working days)", () => {
    expect(isMissedDayReasonRequired({ ...base, workDateKey: "2026-11-15" })).toBe(false);
    // ...but a Sunday IS a working day in a workspace that works Sundays.
    expect(isMissedDayReasonRequired({ ...base, workDateKey: "2026-11-15", workingDays: [0, 1, 2, 3, 4] })).toBe(true);
  });
  it("never for a holiday", () => {
    expect(isMissedDayReasonRequired({ ...base, isHoliday: true })).toBe(false);
  });
  it("never for a second entry on the same day", () => {
    expect(isMissedDayReasonRequired({ ...base, existingEntries: 1 })).toBe(false);
  });
  it("never again once a reason exists for that day", () => {
    expect(isMissedDayReasonRequired({ ...base, hasReason: true })).toBe(false);
  });
  it("never when the setting (or the module, or the plan) is off", () => {
    expect(isMissedDayReasonRequired({ ...base, enabled: false })).toBe(false);
  });
});

const OPTIONS = [
  { code: "SICK", label: "Sick", requiresNote: false },
  { code: "OTHER", label: "Other", requiresNote: true }
];

describe("validateMissedReason (pure)", () => {
  it("accepts an enabled code", () => {
    expect(validateMissedReason(OPTIONS, { code: "SICK" })).toBeNull();
  });
  it("refuses a missing code, naming the field", () => {
    expect(validateMissedReason(OPTIONS, {})?.field).toBe("missedReasonCode");
  });
  it("refuses a code that is not enabled", () => {
    expect(validateMissedReason(OPTIONS, { code: "FORGOT" })?.field).toBe("missedReasonCode");
  });
  it("needs a note for a requiresNote option, and only then", () => {
    expect(validateMissedReason(OPTIONS, { code: "OTHER" })?.field).toBe("missedReasonNote");
    expect(validateMissedReason(OPTIONS, { code: "OTHER", note: "   " })?.field).toBe("missedReasonNote");
    expect(validateMissedReason(OPTIONS, { code: "OTHER", note: "Power cut" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Every write path
 * ------------------------------------------------------------------ */

const AUTHOR = { id: "author-1", name: "Ava Author", email: "ava@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
const PROJECT_A = "22222222-2222-4222-8222-222222222222";
const MODULE_A = "33333333-3333-4333-8333-333333333333";

vi.mock("../../src/services/timesheet-policy.service.js", () => ({ getTimesheetBackdateDays: vi.fn().mockResolvedValue(7) }));
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...AUTHOR } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn().mockResolvedValue(null),
  bindVerificationToRecord: vi.fn().mockResolvedValue(undefined),
  unbindTimesheetVerification: vi.fn().mockResolvedValue([]),
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map()),
  getFaceSettings: vi.fn().mockResolvedValue(null),
  isFaceFeatureAllowedForOrg: vi.fn().mockResolvedValue(false)
}));
vi.mock("../../src/services/sla.service.js", () => ({
  computeApprovalDeadline: vi.fn().mockReturnValue(new Date("2026-11-20T00:00:00.000Z")),
  resolveEscalationsFor: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));
vi.mock("../../src/services/attachment-storage.service.js", () => ({ processUpload: vi.fn() }));
vi.mock("../../src/services/plan-limits.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-limits.service.js")>("../../src/services/plan-limits.service.js");
  return { ...actual, isPlanningCapabilityAllowed: vi.fn(async () => planAllows) };
});
vi.mock("../../src/services/planning.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/planning.service.js")>("../../src/services/planning.service.js");
  return { ...actual, getPlanningSettings: vi.fn(async () => ({ workingDays: MON_FRI })) };
});
vi.mock("../../src/services/ticket.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/ticket.service.js")>("../../src/services/ticket.service.js");
  return { ...actual, resolveVisibleProjectByCode: vi.fn(async () => ({ id: PROJECT_A, code: "WEB", name: "Web" })) };
});

let planAllows = true;

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { attendanceRouter } = await import("../../src/controllers/attendance.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { MCP_TOOLS } = await import("../../src/services/mcp-tools.js");
const { AI_CHAT_ACTIONS } = await import("../../src/services/ai-chat-actions.js");

type State = {
  settings: { attendanceEnabled: boolean; missedDayReasonEnabled: boolean };
  entriesOnDay: number;
  reasonExists: boolean;
  holidays: string[];
};
let state: State;
let client: PrismaClient;
let savedReasons: any[];
let enabledOptions: typeof OPTIONS;

function fakeClient(): PrismaClient {
  const c: any = {
    globalAttendanceSettings: {
      upsert: vi.fn(async () => ({ id: "global", ...state.settings })),
      findUnique: vi.fn(async () => ({ id: "global", ...state.settings }))
    },
    holidayCalendar: { findFirst: vi.fn(async () => ({ id: "cal-1" })) },
    holiday: {
      findFirst: vi.fn(async ({ where }: any) => (state.holidays.includes(where.date.toISOString().slice(0, 10)) ? { name: "Founders day" } : null))
    },
    missedReasonOption: { findMany: vi.fn(async () => enabledOptions) },
    missedDayReason: {
      findUnique: vi.fn(async () => (state.reasonExists ? { id: "r-1" } : null)),
      upsert: vi.fn(async (args: any) => {
        savedReasons.push(args.create);
        return { id: "r-new", ...args.create };
      })
    },
    timesheet: {
      count: vi.fn(async () => state.entriesOnDay),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: "ts-1",
        ...data,
        project: { name: "Apollo" },
        module: { name: "Mod" },
        submodule: null,
        ticket: null,
        attachments: [],
        user: { id: data.userId, name: AUTHOR.name, manager: null }
      }))
    },
    project: {
      findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ id: where.id, slaApprovalHours: 48 })),
      findUnique: vi.fn(async ({ where }: any) => ({ id: where.id, slaApprovalHours: 48 })),
      findFirst: vi.fn(async () => ({ id: PROJECT_A, code: "WEB", name: "Web", modules: [{ id: MODULE_A, name: "Core" }] }))
    },
    projectModule: {
      findFirst: vi.fn(async () => ({ id: MODULE_A, projectId: PROJECT_A }))
    },
    projectSubmodule: { findFirst: vi.fn().mockResolvedValue(null) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    userProjectAssignment: { findFirst: vi.fn(async () => ({ id: "a" })) },
    user: {
      findUnique: vi.fn(async () => ({ id: AUTHOR.id, timezone: "Asia/Kolkata", holidayCalendarId: null, managerId: null, role: { name: "EMPLOYEE" } })),
      findMany: vi.fn().mockResolvedValue([])
    }
  };
  c.$transaction = vi.fn().mockImplementation(async (fn: any) => fn(c));
  return c as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use("/api/attendance", attendanceRouter);
  app.use(errorHandler);
  return app;
}

const entry = (workDate: string, extra: Record<string, unknown> = {}) => ({
  projectId: PROJECT_A,
  moduleId: MODULE_A,
  activityType: "Development",
  taskDescription: "Fixed the login redirect loop",
  workDate,
  startTime: "09:00",
  endTime: "12:00",
  ...extra
});

// Wednesday 18 November 2026, 12:00 IST.
const NOW = new Date("2026-11-18T06:30:00.000Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  planAllows = true;
  state = { settings: { attendanceEnabled: true, missedDayReasonEnabled: true }, entriesOnDay: 0, reasonExists: false, holidays: [] };
  savedReasons = [];
  enabledOptions = OPTIONS;
  client = fakeClient();
});

describe.each(["draft", "submit"])("POST /api/timesheets/%s", (kind) => {
  const post = (body: Record<string, unknown>) => request(buildApp()).post(`/api/timesheets/${kind}`).send(body);

  it("refuses the first entry on a missed working day with a 422 the client can render", async () => {
    const res = await post(entry("2026-11-17"));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("MISSED_DAY_REASON_REQUIRED");
    expect(res.body.details.field).toBe("missedReasonCode");
    expect(res.body.details.options).toEqual(OPTIONS);
    expect(vi.mocked(client.timesheet.create)).not.toHaveBeenCalled();
  });

  it("saves the entry and the reason together when one is given", async () => {
    const res = await post(entry("2026-11-17", { missedReasonCode: "SICK" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(savedReasons).toEqual([
      { userId: AUTHOR.id, workDate: new Date("2026-11-17T00:00:00.000Z"), reasonCode: "SICK", note: null, timesheetId: "ts-1" }
    ]);
  });

  it("insists on a note for OTHER", async () => {
    const res = await post(entry("2026-11-17", { missedReasonCode: "OTHER" }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("MISSED_DAY_REASON_INVALID");
    expect(res.body.details.field).toBe("missedReasonNote");
    const ok = await post(entry("2026-11-17", { missedReasonCode: "OTHER", missedReasonNote: "Power cut" }));
    expect(ok.status).toBe(201);
    expect(savedReasons[0]).toMatchObject({ reasonCode: "OTHER", note: "Power cut" });
  });

  it("refuses a disabled or unknown code", async () => {
    const res = await post(entry("2026-11-17", { missedReasonCode: "FORGOT" }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("MISSED_DAY_REASON_INVALID");
  });
});

describe("when the rule does not apply, nothing is asked and nothing is saved", () => {
  const post = (body: Record<string, unknown>) => request(buildApp()).post("/api/timesheets/draft").send(body);

  it.each([
    ["today", () => {}, "2026-11-18"],
    ["a weekend", () => {}, "2026-11-15"],
    ["a holiday", () => (state.holidays = ["2026-11-16"]), "2026-11-16"],
    ["a second entry on the day", () => (state.entriesOnDay = 1), "2026-11-17"],
    ["a day that already has a reason", () => (state.reasonExists = true), "2026-11-17"],
    ["the setting off", () => (state.settings.missedDayReasonEnabled = false), "2026-11-17"],
    ["attendance off", () => (state.settings.attendanceEnabled = false), "2026-11-17"],
    ["the plan without attendance", () => (planAllows = false), "2026-11-17"]
  ])("%s", async (_label, arrange, date) => {
    arrange();
    const res = await post(entry(date));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(savedReasons).toEqual([]);
  });
});

describe("the MCP log_timesheet_entry tool", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "log_timesheet_entry")!;
  const ctx = { user: AUTHOR, req: { user: AUTHOR } } as never;
  const args = { projectCode: "WEB", moduleName: "Core", workDate: "2026-11-17", startTime: "09:00", endTime: "12:00", activityType: "Development", taskDescription: "Fixed the login redirect loop" };

  it("refuses without a reason, listing the codes", async () => {
    await expect(runInTenant(client, () => tool.handler(ctx, args as never))).rejects.toMatchObject({
      statusCode: 422,
      code: "MISSED_DAY_REASON_REQUIRED",
      message: expect.stringContaining("SICK")
    });
  });

  it("saves with one", async () => {
    const out: any = await runInTenant(client, () => tool.handler(ctx, { ...args, missedReasonCode: "SICK" } as never));
    expect(out.created).toBe(true);
    expect(savedReasons[0]).toMatchObject({ reasonCode: "SICK" });
  });
});

describe("the in-app AI chat log_timesheet_draft action", () => {
  const action = AI_CHAT_ACTIONS.find((a) => a.name === "log_timesheet_draft")!;
  const ctx = { req: { user: AUTHOR } };
  const args = { projectCode: "WEB", moduleName: "Core", workDate: "2026-11-17", startTime: "09:00", endTime: "12:00", activityType: "Development", taskDescription: "Fixed the login redirect loop" };

  it("relays the refusal without a reason", async () => {
    const out = await runInTenant(client, () => action.run(args, ctx));
    expect(out).toMatch(/^Refused: .*missedReasonCode/);
    expect(savedReasons).toEqual([]);
  });

  it("saves with one", async () => {
    const out = await runInTenant(client, () => action.run({ ...args, missedReasonCode: "SICK" }, ctx));
    expect(out).toMatch(/^DRAFT saved/);
    expect(savedReasons[0]).toMatchObject({ reasonCode: "SICK" });
  });
});

describe("GET /api/attendance/missed-reasons", () => {
  it("lists the enabled options to any signed-in person", async () => {
    const res = await request(buildApp()).get("/api/attendance/missed-reasons/options");
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual(OPTIONS);
  });

  it("tells the form whether a date needs a reason", async () => {
    const needed = await request(buildApp()).get("/api/attendance/missed-reasons/check?date=2026-11-17");
    expect(needed.body).toMatchObject({ date: "2026-11-17", required: true, options: OPTIONS });
    state.entriesOnDay = 2;
    const notNeeded = await request(buildApp()).get("/api/attendance/missed-reasons/check?date=2026-11-17");
    expect(notNeeded.body).toMatchObject({ required: false, options: [] });
  });

  it("refuses a malformed date", async () => {
    const res = await request(buildApp()).get("/api/attendance/missed-reasons/check?date=17-11-2026");
    expect(res.status).toBe(422);
  });
});

describe("with no enabled reason options, the rule fails open", () => {
  it("saves a backfill entry instead of demanding a reason nobody can give", async () => {
    enabledOptions = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(buildApp()).post("/api/timesheets/draft").send(entry("2026-11-17"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(savedReasons).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});