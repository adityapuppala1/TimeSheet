/**
 * The "needs review" flag on a ticket can be cleared.
 *
 * Email, chat and request-form intake set `Ticket.needsReview` when nobody trustworthy has looked at
 * the ticket yet. Nothing ever set it back: not the request-form accept (which cleared only the
 * submission's own flag), not assigning the ticket, not moving it, not even closing it. The "Review"
 * badge sat on the list and the Kanban forever, and the AI activity log's "needs review" filter
 * never drained. These pin every way a person now clears it — the request-form side is in
 * request-form-review.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "admin-1", name: "Ada", email: "ada@acme.test", role: "ADMIN", permissions: [] as string[] };

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
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn(),
  bindVerificationToRecord: vi.fn()
}));

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";

let row: Record<string, any>;
let client: PrismaClient;

function buildClient(): PrismaClient {
  return {
    ticket: {
      findFirst: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data, assignee: null, project: null, module: null, reporter: null }))
    },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "proj-1" }]), findFirst: vi.fn().mockResolvedValue({ id: "a-1" }) },
    user: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue(null) },
    ticketComment: { findFirst: vi.fn().mockResolvedValue(null) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }), findUnique: vi.fn().mockResolvedValue(null) }
  } as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use(errorHandler);
  return app;
}

const updateData = () => (vi.mocked(client.ticket.update).mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined)?.data;

beforeEach(() => {
  vi.clearAllMocks();
  actor.id = "admin-1";
  actor.role = "ADMIN";
  actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE, permissions.TICKETS_ASSIGN];
  row = {
    id: TICKET_ID,
    key: "WEB-7",
    title: "Invoice PDF is blank",
    type: "BUG",
    projectId: "proj-1",
    status: "OPEN",
    priority: "MEDIUM",
    reporterId: "intake-system-user",
    assigneeId: null,
    needsReview: true,
    deletedAt: null,
    createdAt: new Date(),
    watchers: [],
    collaborators: [],
    changeRequest: null
  };
  client = buildClient();
});

describe("assigning the ticket to a person clears the flag", () => {
  it("the first human assignment clears needsReview", async () => {
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}/assign`).send({ assigneeId: PERSON });
    expect(res.status).toBe(200);
    expect(updateData()).toMatchObject({ assigneeId: PERSON, needsReview: false });
  });

  it("unassigning does not count as a review", async () => {
    await request(buildApp()).patch(`/api/tickets/${TICKET_ID}/assign`).send({ assigneeId: null });
    expect(updateData()).not.toHaveProperty("needsReview");
  });
});

describe("moving the ticket clears the flag", () => {
  it("a status change clears needsReview in the same write", async () => {
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}/status`).send({ status: "IN_PROGRESS" });
    expect(res.status).toBe(200);
    expect(updateData()).toMatchObject({ status: "IN_PROGRESS", needsReview: false });
  });
});

describe("POST /:id/reviewed — the explicit 'Mark reviewed' action", () => {
  it("clears the flag and records who reviewed it", async () => {
    const res = await request(buildApp()).post(`/api/tickets/${TICKET_ID}/reviewed`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: TICKET_ID, needsReview: false });
    expect(updateData()).toEqual({ needsReview: false });
    expect(auditSpy).toHaveBeenCalledWith("admin-1", "ticket.reviewed", "Ticket", TICKET_ID);
  });

  it("is refused to somebody who could not triage the ticket", async () => {
    actor.id = "employee-1";
    actor.role = "EMPLOYEE";
    actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE];
    const res = await request(buildApp()).post(`/api/tickets/${TICKET_ID}/reviewed`);
    expect(res.status).toBe(403);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });
});
