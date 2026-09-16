/**
 * Custom-field values on a ticket, at the route. The service already knows how to validate and
 * write a value per type (custom-field.service.test.ts); what a route adds is WHO may do it, and
 * that is what these pin: the same two questions PATCH /:id asks — is the ticket in a project you
 * can see, and may you work on it — before a single value moves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };

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
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
const setValues = vi.fn().mockResolvedValue(undefined);
const getValues = vi.fn().mockResolvedValue({ client: "Acme" });
vi.mock("../../src/services/custom-field.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/custom-field.service.js")>("../../src/services/custom-field.service.js");
  return { ...actual, setCustomFieldValues: (...a: unknown[]) => setValues(...a), getCustomFieldValues: (...a: unknown[]) => getValues(...a) };
});

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET = { id: "11111111-1111-4111-8111-111111111111", projectId: "proj-mine", reporterId: "someone-else", assigneeId: null, deletedAt: null, createdAt: new Date(), status: "OPEN", key: "X-1", title: "t", type: "BUG" };
let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "EMPLOYEE";
  actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE];
  client = {
    ticket: { findFirst: vi.fn().mockResolvedValue(TICKET) },
    // The actor is on proj-mine and nothing else.
    userProjectAssignment: {
      findMany: vi.fn().mockResolvedValue([{ projectId: "proj-mine", user: { id: "u9", name: "Other", status: "ACTIVE", deletedAt: null } }]),
      findFirst: vi.fn().mockResolvedValue({ id: "a1" })
    },
    user: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    // canWorkOnTicket, for an EMPLOYEE who is neither reporter nor assignee: a collaborator row
    // is the one thing that lets them work on it. Present by default; removed by the 403 case.
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) }
  } as unknown as PrismaClient;
});

describe("GET /tickets/:id/custom-fields", () => {
  it("returns the {key: value} map for a ticket the caller can see", async () => {
    const res = await request(buildApp()).get(`/api/tickets/${TICKET.id}/custom-fields`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ client: "Acme" });
    expect(getValues).toHaveBeenCalledWith({ ticketId: TICKET.id });
  });

  it("is 403 outside the caller's project scope", async () => {
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ ...TICKET, projectId: "proj-hidden" } as never);
    const res = await request(buildApp()).get(`/api/tickets/${TICKET.id}/custom-fields`);
    expect(res.status).toBe(403);
    expect(getValues).not.toHaveBeenCalled();
  });
});

describe("PUT /tickets/:id/custom-fields", () => {
  it("hands the values to the service with the ticket's type, so type-scoped fields apply correctly", async () => {
    const res = await request(buildApp()).put(`/api/tickets/${TICKET.id}/custom-fields`).send({ values: { client: "Acme", seats: "12" } });
    expect(res.status).toBe(200);
    expect(setValues).toHaveBeenCalledWith({ ticketId: TICKET.id }, { client: "Acme", seats: "12" }, { ticketType: "BUG" });
    expect(res.body).toEqual({ client: "Acme" }); // the fresh read-back, not an echo of the request
  });

  it("writes nothing for a caller who may see but not work on the ticket", async () => {
    // Reporter is someone else, unassigned, not a collaborator, and the actor is a plain
    // EMPLOYEE holding tickets:write: canWorkOnTicket says no, exactly as PATCH /:id would.
    vi.mocked((client as any).ticketCollaborator.findFirst).mockResolvedValue(null as never);
    const res = await request(buildApp()).put(`/api/tickets/${TICKET.id}/custom-fields`).send({ values: { client: "Acme" } });
    expect(res.status).toBe(403);
    expect(setValues).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a values map", async () => {
    const res = await request(buildApp()).put(`/api/tickets/${TICKET.id}/custom-fields`).send({ values: "Acme" });
    expect(res.status).toBe(422);
    expect(setValues).not.toHaveBeenCalled();
  });
});
