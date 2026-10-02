/**
 * "Today", for the person whose timesheet it is.
 *
 * THE DEFECT (audit 2026-10, timesheets #6): the future-date check compared the work date against
 * the SERVER's calendar day (Asia/Kolkata by default). A New York user at 21:00 on Friday is already
 * on Saturday in India, so the server accepted Saturday as "today" — and Friday's work, defaulted to
 * the wrong day by a UTC-dated form, was saved as Saturday. The Monday escalation then emailed the
 * employee and their manager about a Friday that had in fact been logged.
 *
 * The check now asks the AUTHOR's own zone (`User.timezone`, falling back to the workspace zone,
 * exactly as the daily reminder worker does — utils/recipient-time.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const AUTHOR = { id: "author-1", name: "Ava Author", email: "ava@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
let authorZone: string | null = "Asia/Kolkata";

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
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));
vi.mock("../../src/services/sla.service.js", () => ({
  computeApprovalDeadline: vi.fn().mockReturnValue(null),
  resolveEscalationsFor: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));
vi.mock("../../src/services/attachment-storage.service.js", () => ({ processUpload: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const PROJECT = "22222222-2222-4222-8222-222222222222";
const MODULE = "33333333-3333-4333-8333-333333333333";

let client: PrismaClient;

function fakeClient(): PrismaClient {
  const c: any = {
    timesheet: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: "t-1",
        ...data,
        project: { name: "Apollo" },
        module: { name: "Mod" },
        submodule: null,
        ticket: null,
        attachments: [],
        user: { id: data.userId, name: AUTHOR.name, manager: null }
      }))
    },
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: PROJECT, slaApprovalHours: 48 }) },
    projectModule: { findFirst: vi.fn().mockResolvedValue({ id: MODULE, projectId: PROJECT }) },
    projectSubmodule: { findFirst: vi.fn().mockResolvedValue(null) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    userProjectAssignment: { findFirst: vi.fn().mockResolvedValue({ id: "a" }) },
    user: { findUnique: vi.fn().mockImplementation(async () => ({ id: AUTHOR.id, timezone: authorZone })) }
  };
  c.$transaction = vi.fn().mockImplementation(async (fn: any) => fn(c));
  return c as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use(errorHandler);
  return app;
}

const logFor = (workDate: string) =>
  request(buildApp()).post("/api/timesheets/draft").send({
    projectId: PROJECT,
    moduleId: MODULE,
    activityType: "Development",
    taskDescription: "Did some real work today",
    workDate,
    startTime: "09:00",
    endTime: "10:00"
  });

beforeEach(() => {
  client = fakeClient();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the future-date check uses the author's own calendar day", () => {
  it("accepts today for an IST author at 02:00 IST — between midnight and 05:30, UTC is still yesterday", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T20:30:00.000Z"), toFake: ["Date"] });
    authorZone = "Asia/Kolkata";
    const res = await logFor("2026-10-02");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("refuses tomorrow for that same IST author", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T20:30:00.000Z"), toFake: ["Date"] });
    authorZone = "Asia/Kolkata";
    const res = await logFor("2026-10-03");
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/future/i);
  });

  it("refuses Saturday for a New York author on Friday evening, though India is already on Saturday", async () => {
    // 2026-10-03T01:00Z is Fri 21:00 in New York and Sat 06:30 in India.
    vi.useFakeTimers({ now: new Date("2026-10-03T01:00:00.000Z"), toFake: ["Date"] });
    authorZone = "America/New_York";
    const res = await logFor("2026-10-03");
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((await logFor("2026-10-02")).status).toBe(201);
  });
});
