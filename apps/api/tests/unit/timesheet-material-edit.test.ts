/**
 * Editing an entry that is already in the approval queue, and the checks the create path relied on
 * its pickers for.
 *
 * THE DECISION (integrator, audit 2026-10 timesheets #5): an author's edit of a SUBMITTED entry keeps
 * it SUBMITTED — fixing a typo must not cost a re-submission — and the reviewer is told. But a
 * MATERIAL change (date, times/hours, project, module) is a different entry wearing the old one's
 * id, so:
 *   - the face "identity verified" binding is dropped: the check vouched for the entry as it was
 *     submitted, not for twelve hours on another project;
 *   - the approval deadline restarts, since the reviewer is now deciding something new;
 *   - moving it to another project re-checks that the AUTHOR is assigned to that project — the
 *     create path did, PATCH never did, so a PATCH could log hours anywhere.
 * And the module/submodule must belong to the project on CREATE too: the PATCH comment admitted the
 * create path trusted the UI's cascading pickers, which an API or MCP caller never sees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const AUTHOR = { id: "author-1", name: "Ava Author", email: "ava@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
const MANAGER = { id: "mgr-1", name: "Mo Manager", email: "mo@x.io", role: "MANAGER", permissions: ["timesheets:write", "timesheets:approve"] };
let actor: typeof AUTHOR = AUTHOR;

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
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
  unbindTimesheetVerification: vi.fn().mockResolvedValue(["attempt-1"]),
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));
vi.mock("../../src/services/sla.service.js", () => ({
  computeApprovalDeadline: vi.fn().mockReturnValue(new Date("2026-10-04T00:00:00.000Z")),
  resolveEscalationsFor: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));
vi.mock("../../src/services/attachment-storage.service.js", () => ({ processUpload: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const face = await import("../../src/services/face.service.js");
const { audit } = await import("../../src/services/audit.service.js");
const sla = await import("../../src/services/sla.service.js");

const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "22222222-2222-4222-8222-222222222222";
const MODULE_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const MODULE_B = "55555555-5555-4555-8555-555555555555";
const SUBMODULE_B = "66666666-6666-4666-8666-666666666666";

let client: PrismaClient;
/** Projects the AUTHOR is assigned to. */
let assigned: string[];

function fakeClient(status: string): PrismaClient {
  const row = {
    id: ID,
    userId: AUTHOR.id,
    status,
    projectId: PROJECT_A,
    moduleId: MODULE_A,
    submoduleId: null,
    ticketId: null,
    activityType: "Development",
    taskDescription: "<p>Original description of the work</p>",
    notes: "",
    workDate: new Date("2026-09-28T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "12:00",
    totalHours: 3,
    billable: true,
    billedRate: null,
    deletedAt: null
  };
  const c: any = {
    timesheet: {
      findFirst: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({
        ...row,
        ...data,
        workDate: data.workDate ?? row.workDate,
        project: { id: data.projectId ?? row.projectId, name: "Apollo" },
        user: { id: AUTHOR.id, name: AUTHOR.name, email: AUTHOR.email }
      })),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: ID,
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
      findUniqueOrThrow: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id, slaApprovalHours: 48 })),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id, slaApprovalHours: 48 }))
    },
    projectModule: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
        [MODULE_A, MODULE_B].includes(where.id) ? { id: where.id, projectId: where.id === MODULE_B ? PROJECT_B : PROJECT_A } : null
      )
    },
    projectSubmodule: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => (where.id === SUBMODULE_B ? { id: SUBMODULE_B, moduleId: MODULE_B } : null))
    },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    userProjectAssignment: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => (assigned.includes(where.projectId) && where.userId === AUTHOR.id ? { id: "a" } : null))
    },
    user: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
        where.id === AUTHOR.id ? { id: AUTHOR.id, managerId: MANAGER.id, role: { name: "EMPLOYEE" } } : { id: where.id, managerId: null, role: { name: "MANAGER" } }
      ),
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
  app.use(errorHandler);
  return app;
}

const patch = (body: Record<string, unknown>) => request(buildApp()).patch(`/api/timesheets/${ID}`).send(body);
const updateData = () => (vi.mocked(client.timesheet.update).mock.calls[0]?.[0] as any)?.data as Record<string, unknown> | undefined;

beforeEach(() => {
  actor = AUTHOR;
  assigned = [PROJECT_A];
  client = fakeClient("SUBMITTED");
  vi.mocked(face.unbindTimesheetVerification).mockClear();
  vi.mocked(audit).mockClear();
});

describe("a material change to a SUBMITTED entry", () => {
  it("stays SUBMITTED, as decided — the edit window is unchanged", async () => {
    const res = await patch({ startTime: "08:00", endTime: "12:00" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(updateData()?.status).toBeUndefined();
  });

  it("drops the identity-verified binding, and says so in the audit", async () => {
    await patch({ startTime: "08:00", endTime: "12:00" });
    expect(face.unbindTimesheetVerification).toHaveBeenCalledWith(ID);
    const updated = vi.mocked(audit).mock.calls.find((c) => c[1] === "timesheet.updated");
    expect(updated?.[4]).toMatchObject({ identityVerificationDropped: ["attempt-1"] });
  });

  it("restarts the approval deadline", async () => {
    await patch({ workDate: "2026-09-29" });
    expect(updateData()?.approvalDeadline).toEqual(new Date("2026-10-04T00:00:00.000Z"));
  });

  it("clears the old breach and resolves its escalation — the restarted clock has not been missed", async () => {
    // The breach marker is also the sweep's "already handled" flag: left set, the new deadline could
    // pass unnoticed, while the open Escalation kept chasing somebody about the old claim.
    vi.mocked(sla.resolveEscalationsFor).mockClear();
    await patch({ startTime: "08:00" });
    expect(updateData()).toMatchObject({ slaBreachAt: null, escalatedAt: null });
    expect(sla.resolveEscalationsFor).toHaveBeenCalledWith(ID);
  });

  it("refuses moving it to a project the AUTHOR is not assigned to", async () => {
    const res = await patch({ projectId: PROJECT_B, moduleId: MODULE_B });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.message).toMatch(/not assigned/i);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });

  it("checks the AUTHOR's assignment, not the editor's, when a manager moves it", async () => {
    actor = MANAGER;
    const refused = await patch({ projectId: PROJECT_B, moduleId: MODULE_B });
    expect(refused.status).toBe(403);
    assigned = [PROJECT_A, PROJECT_B];
    vi.mocked(client.timesheet.update).mockClear();
    const allowed = await patch({ projectId: PROJECT_B, moduleId: MODULE_B });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });
});

describe("a wording change to a SUBMITTED entry", () => {
  it("keeps the binding and the deadline — a typo fix vouches for the same work", async () => {
    const res = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(face.unbindTimesheetVerification).not.toHaveBeenCalled();
    expect(updateData()).not.toHaveProperty("approvalDeadline");
    expect(updateData()).not.toHaveProperty("slaBreachAt");
  });
});

describe("module ownership on create", () => {
  const draft = (body: Record<string, unknown>) =>
    request(buildApp())
      .post("/api/timesheets/draft")
      .send({
        projectId: PROJECT_A,
        moduleId: MODULE_A,
        activityType: "Development",
        taskDescription: "Did some real work today",
        workDate: "2026-09-28",
        startTime: "09:00",
        endTime: "10:00",
        ...body
      });

  it("refuses a module of another project", async () => {
    const res = await draft({ moduleId: MODULE_B });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toMatch(/module does not belong/i);
    expect(client.timesheet.create).not.toHaveBeenCalled();
  });

  it("refuses a submodule of another module", async () => {
    const res = await draft({ submoduleId: SUBMODULE_B });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toMatch(/submodule does not belong/i);
    expect(client.timesheet.create).not.toHaveBeenCalled();
  });

  it("accepts a module of the chosen project", async () => {
    const res = await draft({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
