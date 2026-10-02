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
const notifySpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: (...a: unknown[]) => notifySpy(...a), dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock("../../src/services/face.service.js", () => ({ isFaceVerificationRequired: vi.fn().mockResolvedValue(false), consumeVerification: vi.fn(), bindVerificationToRecord: vi.fn() }));
vi.mock("../../src/services/ticket-rules.service.js", () => ({ applyTicketRules: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn(), emitTicketStatusChanged: vi.fn() }));

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
      // With the relations the comment path selects (ticket-comment.service.ts), as Prisma returns them.
      findFirst: vi.fn().mockResolvedValue({ ...TICKET, watchers: [], collaborators: [] }),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...TICKET, ...data, id: "new", source: "MANUAL", externalReporterEmail: null, project: { id: data.projectId, code: "X", name: "P", color: null }, module: null, reporter: null, assignee: null })),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({ ...TICKET, ...data, project: { id: "33333333-3333-4333-8333-333333333333", code: "X", name: "P" }, module: null, reporter: null, assignee: null, labels: [], _count: { comments: 0, attachments: 0 } }))
    },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    project: { update: vi.fn().mockResolvedValue({ code: "X", ticketSeq: 7 }) },
    ticketComment: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: "c1", ...data, author: { id: "user-1", name: "Lead" }, createdAt: new Date() })),
      findFirst: vi.fn().mockResolvedValue({ id: "c1", ticketId: "11111111-1111-4111-8111-111111111111", authorId: "author-9", body: "<p>please check</p>", assigneeId: "44444444-4444-4444-8444-444444444444", resolvedAt: null }),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({ id: "c1", ...data }))
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    // The lead is on project 3333… only.
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "33333333-3333-4333-8333-333333333333" }]), findFirst: vi.fn().mockResolvedValue({ id: "a" }) },
    user: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue(null) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) },
    ticketType: { findFirst: vi.fn().mockResolvedValue({ id: "tt", name: "BUG", isActive: true }) },
    // V12 8.4
    requirementsDocument: { findFirst: vi.fn().mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777", title: "Onboarding PRD", docType: "PRD", status: "READY" }) },
    ticketDocumentLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: "dl1", ...data, createdAt: new Date() })),
      delete: vi.fn().mockResolvedValue({})
    }
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

/**
 * V12 3.17 — the sprint on creation. A ticket created from a list grouped or filtered by sprint
 * must land in that sprint, so POST accepts `sprintId` under the SAME own-project rule the PATCH
 * applies (one helper, one message). The refusal happens before the transaction: no ticket key
 * is burned for a request that will not stand.
 */
describe("sprint on creation", () => {
  const body = { projectId: "33333333-3333-4333-8333-333333333333", type: "BUG", title: "Landing in the sprint", priority: "LOW" };

  it("stores the sprint of the ticket's own project", async () => {
    vi.mocked(client.sprint.findFirst).mockResolvedValue(SPRINT as never);
    const res = await request(buildApp()).post("/api/tickets").send({ ...body, sprintId: SPRINT.id });
    expect(res.status).toBe(201);
    expect(client.sprint.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SPRINT.id, projectId: body.projectId } }));
    expect(vi.mocked(client.ticket.create).mock.calls[0][0].data).toMatchObject({ sprintId: SPRINT.id, key: "X-7" });
  });

  it("refuses a sprint from another project with the PATCH's message, before any key is issued", async () => {
    const res = await request(buildApp()).post("/api/tickets").send({ ...body, sprintId: "99999999-9999-4999-8999-999999999999" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/different project/);
    expect(client.project.update).not.toHaveBeenCalled();
    expect(client.ticket.create).not.toHaveBeenCalled();
  });

  it("an empty sprintId means no sprint, exactly as before", async () => {
    const res = await request(buildApp()).post("/api/tickets").send({ ...body, sprintId: "" });
    expect(res.status).toBe(201);
    expect(client.sprint.findFirst).not.toHaveBeenCalled();
    expect(vi.mocked(client.ticket.create).mock.calls[0][0].data.sprintId).toBeUndefined();
  });
});

/* V12 6.1 — membership is its own audit event, on create and on a real change. */
describe("membership audit", () => {
  it("PATCH into a sprint writes ticket.sprint_changed { from: null, to }", async () => {
    auditSpy.mockClear();
    vi.mocked(client.sprint.findFirst).mockResolvedValue(SPRINT as never);
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET.id}`).send({ sprintId: SPRINT.id });
    expect(res.status).toBe(200);
    const call = auditSpy.mock.calls.find((c) => c[1] === "ticket.sprint_changed");
    expect(call?.[4]).toEqual({ from: null, to: SPRINT.id });
  });
  it("a PATCH that does not touch the sprint writes no membership event", async () => {
    auditSpy.mockClear();
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET.id}`).send({ storyPoints: 1 });
    expect(res.status).toBe(200);
    expect(auditSpy.mock.calls.some((c) => c[1] === "ticket.sprint_changed")).toBe(false);
  });
});

/* V12 8.1 — a mention notifies the mentioned member once, under its own category, and only members. */
describe("@mentions in a comment", () => {
  const MEMBER = "44444444-4444-4444-8444-444444444444";
  const STRANGER = "55555555-5555-4555-8555-555555555555";
  it("notifies a mentioned project member under ticket.mentioned and not again under ticket.commented", async () => {
    notifySpy.mockClear();
    const res = await request(buildApp()).post(`/api/tickets/${TICKET.id}/comments`).send({ body: `<p>hi <span data-mention-id="${MEMBER}" data-mention-label="Ana">@Ana</span></p>` });
    expect(res.status).toBe(201);
    const cats = notifySpy.mock.calls.map((c) => c[0]).filter((n) => n.userId === MEMBER).map((n) => n.category);
    expect(cats).toEqual(["ticket.mentioned"]);
    expect(notifySpy.mock.calls.find((c) => c[0].userId === MEMBER)?.[0].title).toMatch(/mentioned you on X-1/);
  });
  it("ignores an id that is neither a member nor an admin", async () => {
    notifySpy.mockClear();
    vi.mocked(client.userProjectAssignment.findFirst).mockResolvedValue(null as never);
    const res = await request(buildApp()).post(`/api/tickets/${TICKET.id}/comments`).send({ body: `<p><span data-mention-id="${STRANGER}">@Nobody</span></p>` });
    expect(res.status).toBe(201);
    expect(notifySpy.mock.calls.some((c) => c[0].userId === STRANGER)).toBe(false);
  });
});

/* V12 8.3 — assigned comments: assign notifies the assignee; resolve notifies the assigner; only members. */
describe("assigned comments", () => {
  const MEMBER = "44444444-4444-4444-8444-444444444444";
  it("POST with assigneeId notifies the assignee once, under ticket.comment_assigned", async () => {
    notifySpy.mockClear();
    const res = await request(buildApp()).post(`/api/tickets/${TICKET.id}/comments`).send({ body: "<p>please check</p>", assigneeId: MEMBER });
    expect(res.status).toBe(201);
    const cats = notifySpy.mock.calls.map((c) => c[0]).filter((n) => n.userId === MEMBER).map((n) => n.category);
    expect(cats).toEqual(["ticket.comment_assigned"]);
  });
  it("refuses assigning to someone who is not on the project", async () => {
    vi.mocked(client.userProjectAssignment.findFirst).mockResolvedValueOnce(null as never);
    const res = await request(buildApp()).post(`/api/tickets/${TICKET.id}/comments`).send({ body: "<p>x</p>", assigneeId: "55555555-5555-4555-8555-555555555555" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not on this project/);
  });
  it("PATCH resolved notifies the comment's author with the resolver's name", async () => {
    notifySpy.mockClear();
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET.id}/comments/c1`.replace("c1", "66666666-6666-4666-8666-666666666666")).send({ resolved: true });
    expect(res.status).toBe(200);
    const toAuthor = notifySpy.mock.calls.map((c) => c[0]).find((n) => n.userId === "author-9");
    expect(toAuthor?.category).toBe("ticket.comment_resolved");
    expect(toAuthor?.title).toMatch(/Lead resolved your comment on X-1/);
    const data = (vi.mocked(client.ticketComment.update).mock.calls[0][0] as any).data;
    expect(data.resolvedById).toBe("user-1");
    expect(data.resolvedAt).toBeInstanceOf(Date);
  });
});

/* V12 8.4 — related documents from the ticket's side. */
describe("related documents", () => {
  const DOC = "77777777-7777-4777-8777-777777777777";
  it("relates a document and answers with its summary", async () => {
    const res = await request(buildApp()).post(`/api/tickets/${TICKET.id}/documents`).send({ documentId: DOC });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "dl1", document: { id: DOC, title: "Onboarding PRD", docType: "PRD", status: "READY" } });
    expect((vi.mocked(client.ticketDocumentLink.create).mock.calls[0][0] as any).data).toMatchObject({ ticketId: TICKET.id, documentId: DOC, createdById: "user-1" });
  });
  it("refuses the same pair twice", async () => {
    vi.mocked(client.ticketDocumentLink.findFirst).mockResolvedValueOnce({ id: "dl1" } as never);
    const res = await request(buildApp()).post(`/api/tickets/${TICKET.id}/documents`).send({ documentId: DOC });
    expect(res.status).toBe(422);
    expect(client.ticketDocumentLink.create).not.toHaveBeenCalled();
  });
  it("unlinks only a link that belongs to this ticket", async () => {
    const missing = await request(buildApp()).delete(`/api/tickets/${TICKET.id}/documents/88888888-8888-4888-8888-888888888888`);
    expect(missing.status).toBe(404);
    vi.mocked(client.ticketDocumentLink.findFirst).mockResolvedValueOnce({ id: "dl1", ticketId: TICKET.id, documentId: DOC } as never);
    const res = await request(buildApp()).delete(`/api/tickets/${TICKET.id}/documents/88888888-8888-4888-8888-888888888888`);
    expect(res.status).toBe(204);
    expect(client.ticketDocumentLink.delete).toHaveBeenCalledWith({ where: { id: "dl1" } });
  });
});
