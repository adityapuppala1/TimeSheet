/**
 * The sprint routes at the boundary: the toggle gate answers first, the project scope second, and
 * two rules a team would feel — one active sprint per project, and a ticket can only join a sprint
 * of its own project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Lead", email: "l@x.io", role: "TEAM_LEAD", permissions: [permissions.TICKETS_VIEW, permissions.PLAN_WRITE, permissions.TICKETS_WRITE, permissions.TICKETS_ASSIGN] as string[] };
let sprintsOn = true;

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
vi.mock("../../src/services/planning.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/planning.service.js")>("../../src/services/planning.service.js");
  const { AppError } = await import("../../src/middleware/error.js");
  return {
    ...actual,
    assertSprintsEnabled: async () => {
      if (!sprintsOn) throw new AppError(403, "Sprints are off for this workspace. A super admin can enable them in Workspace Settings → Planning.");
    }
  };
});
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined), dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { sprintRouter } = await import("../../src/controllers/sprint.controller.js");
const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const SPRINT = { id: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333", name: "Sprint 1", goal: null, startDate: new Date("2026-09-01"), endDate: new Date("2026-09-14"), status: "PLANNED", createdAt: new Date(), updatedAt: new Date() };
const TICKET = { id: "11111111-1111-4111-8111-111111111111", projectId: "33333333-3333-4333-8333-333333333333", reporterId: "user-1", assigneeId: null, deletedAt: null, createdAt: new Date(), status: "OPEN", key: "X-1", title: "t", type: "BUG", priority: "LOW" };
let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/sprints", sprintRouter);
  app.use("/api/tickets", ticketRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  sprintsOn = true;
  actor.role = "TEAM_LEAD";
  client = {
    sprint: {
      findMany: vi.fn().mockResolvedValue([{ ...SPRINT, _count: { tickets: 2 } }]),
      findUnique: vi.fn().mockResolvedValue(SPRINT),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(SPRINT),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({ ...SPRINT, ...data })),
      delete: vi.fn().mockResolvedValue(SPRINT)
    },
    ticket: {
      groupBy: vi.fn().mockResolvedValue([{ sprintId: SPRINT.id, _sum: { storyPoints: 8 } }]),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(TICKET),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({ ...TICKET, ...data, project: { id: "33333333-3333-4333-8333-333333333333", code: "X", name: "P" }, module: null, reporter: null, assignee: null, labels: [], _count: { comments: 0, attachments: 0 } }))
    },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    // The lead is on project 3333… only.
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "33333333-3333-4333-8333-333333333333" }]), findFirst: vi.fn().mockResolvedValue({ id: "a" }) },
    user: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue(null) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) },
    ticketType: { findFirst: vi.fn().mockResolvedValue({ id: "tt", name: "BUG", isActive: true }) }
  } as unknown as PrismaClient;
});

describe("the toggle gate answers first", () => {
  it("every sprint route is 403 with the switch off, before any scope or data is read", async () => {
    sprintsOn = false;
    const res = await request(buildApp()).get("/api/sprints?projectId=33333333-3333-4333-8333-333333333333");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Sprints are off/);
    expect(client.sprint.findMany).not.toHaveBeenCalled();
  });
});

describe("scope", () => {
  it("lists a visible project's sprints with counts and points", async () => {
    const res = await request(buildApp()).get("/api/sprints?projectId=33333333-3333-4333-8333-333333333333");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ name: "Sprint 1", ticketCount: 2, totalPoints: 8 });
  });

  it("refuses a project outside the caller's scope", async () => {
    const res = await request(buildApp()).get("/api/sprints?projectId=44444444-4444-4444-8444-444444444444");
    expect(res.status).toBe(403);
  });
});

describe("lifecycle rules", () => {
  it("refuses to start a second active sprint in the same project, naming the first", async () => {
    vi.mocked(client.sprint.findFirst).mockResolvedValue({ name: "Sprint 0" } as never);
    const res = await request(buildApp()).patch(`/api/sprints/${SPRINT.id}`).send({ status: "ACTIVE" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Sprint 0/);
    expect(client.sprint.update).not.toHaveBeenCalled();
  });

  it("starts a planned sprint when none is active", async () => {
    const res = await request(buildApp()).patch(`/api/sprints/${SPRINT.id}`).send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");
  });

  it("will not let a sprint end before it starts", async () => {
    const res = await request(buildApp()).post("/api/sprints").send({ projectId: "33333333-3333-4333-8333-333333333333", name: "S", startDate: "2026-09-10", endDate: "2026-09-01" });
    expect(res.status).toBe(422);
    expect(client.sprint.create).not.toHaveBeenCalled();
  });
});

describe("ticket membership", () => {
  it("joins a sprint of the ticket's own project and records points", async () => {
    vi.mocked(client.sprint.findFirst).mockResolvedValue({ id: SPRINT.id } as never);
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET.id}`).send({ sprintId: SPRINT.id, storyPoints: 2.5 });
    expect(res.status).toBe(200);
    const data = vi.mocked(client.ticket.update).mock.calls[0][0].data as any;
    expect(data).toMatchObject({ sprintId: SPRINT.id, storyPoints: 2.5 });
  });

  it("refuses a sprint from another project", async () => {
    vi.mocked(client.sprint.findFirst).mockResolvedValue(null as never);
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET.id}`).send({ sprintId: SPRINT.id });
    expect(res.status).toBe(422);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("refuses points finer than a half", async () => {
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET.id}`).send({ storyPoints: 1.3 });
    expect(res.status).toBe(422);
  });
});
