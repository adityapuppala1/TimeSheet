/**
 * ticket.service.ts's `assertTicketVisible` carries the codebase's own rule in its doc comment:
 * every route that reads or writes a ticket must call it, because the coarse
 * `tickets:view` / `tickets:write` / `tickets:assign` permissions are held TENANT-WIDE by
 * ordinary roles and say nothing about which projects you belong to.
 *
 * The 22 ticket sub-resource routes followed that rule; five of the primary ones did not, and
 * an EMPLOYEE or TEAM_LEAD could reach straight past their project scope with a ticket id.
 * These tests drive the real router through supertest so the guard is asserted at the route,
 * not at the helper it happens to call today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

/** An EMPLOYEE-shaped session, escalated per-test by handing it more permissions. */
const actor = { id: "user-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    // The token/session half of requireAuth is not what's under test; the authorization half
    // (requirePermission) is left as the real implementation.
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
// Notification/audit/face side effects would need their own DB fixtures and prove nothing here.
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET = { id: "11111111-1111-4111-8111-111111111111", projectId: "proj-hidden", reporterId: "someone-else", assigneeId: null, deletedAt: null, createdAt: new Date(), status: "OPEN", key: "X-1", title: "t" };

let client: PrismaClient;

/** Wraps the real router in the tenant context supertest can't establish itself. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  actor.role = "EMPLOYEE";
  actor.permissions = [];
  client = {
    ticket: {
      findFirst: vi.fn().mockResolvedValue(TICKET),
      update: vi.fn().mockResolvedValue(TICKET),
      groupBy: vi.fn().mockResolvedValue([])
    },
    // ticketProjectScope: the actor belongs to `proj-mine`, never to the ticket's `proj-hidden`.
    userProjectAssignment: {
      findMany: vi.fn().mockResolvedValue([{ projectId: "proj-mine", user: { id: "u9", name: "Other", status: "ACTIVE", deletedAt: null } }]),
      findFirst: vi.fn().mockResolvedValue(null)
    },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) },
    ticketType: { findFirst: vi.fn().mockResolvedValue({ id: "tt", name: "BUG", isActive: true }) },
    aIInteraction: { findFirst: vi.fn().mockResolvedValue(null) }
  } as unknown as PrismaClient;
});

describe("a ticket outside the caller's project scope is unreachable", () => {
  // Every case models a TEAM_LEAD/MANAGER-shaped actor: `canModifyTicket` returns true for any
  // TICKETS_ASSIGN or TICKETS_MANAGE holder tenant-wide, so it is NOT a project boundary and
  // these routes have nothing else standing between the caller and someone else's project.
  const cases = [
    { name: "PATCH /:id", perms: [permissions.TICKETS_WRITE, permissions.TICKETS_ASSIGN], call: (a: express.Express) => request(a).patch(`/api/tickets/${TICKET.id}`).send({ title: "pwned" }) },
    { name: "PATCH /:id/status", perms: [permissions.TICKETS_WRITE, permissions.TICKETS_ASSIGN], call: (a: express.Express) => request(a).patch(`/api/tickets/${TICKET.id}/status`).send({ status: "IN_PROGRESS" }) },
    { name: "PATCH /:id/assign", perms: [permissions.TICKETS_ASSIGN], call: (a: express.Express) => request(a).patch(`/api/tickets/${TICKET.id}/assign`).send({ assigneeId: null }) },
    { name: "PATCH /:id/ai-feedback", perms: [permissions.TICKETS_ASSIGN], call: (a: express.Express) => request(a).patch(`/api/tickets/${TICKET.id}/ai-feedback`).send({ feedback: "up" }) },
    { name: "DELETE /:id", perms: [permissions.TICKETS_MANAGE], call: (a: express.Express) => request(a).delete(`/api/tickets/${TICKET.id}`) }
  ];

  for (const { name, perms, call } of cases) {
    it(`${name} is 403, and writes nothing`, async () => {
      actor.role = "TEAM_LEAD";
      actor.permissions = perms;
      const response = await call(buildApp());
      expect(response.status).toBe(403);
      expect(client.ticket.update).not.toHaveBeenCalled();
    });
  }

  it("GET /suggest-assignee will not enumerate a project the caller isn't on", async () => {
    actor.permissions = [permissions.TICKETS_WRITE];
    const response = await request(buildApp()).get("/api/tickets/suggest-assignee?projectId=proj-hidden");
    expect(response.status).toBe(403);
  });

  it("…but the same routes still work inside the caller's own scope", async () => {
    actor.permissions = [permissions.TICKETS_ASSIGN];
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ ...TICKET, projectId: "proj-mine" } as never);
    const response = await request(buildApp()).patch(`/api/tickets/${TICKET.id}/ai-feedback`).send({ feedback: "up" });
    expect(response.status).toBe(200);
    expect(client.ticket.update).toHaveBeenCalled();
  });

  it("an ADMIN is unrestricted, so nothing here narrows the admin console", async () => {
    actor.role = "ADMIN";
    actor.permissions = [permissions.TICKETS_ASSIGN];
    const response = await request(buildApp()).patch(`/api/tickets/${TICKET.id}/ai-feedback`).send({ feedback: "up" });
    expect(response.status).toBe(200);
  });
});
