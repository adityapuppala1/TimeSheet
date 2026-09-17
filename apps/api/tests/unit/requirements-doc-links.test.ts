/**
 * V12 8.4 — the document's side of a ticket ↔ document relationship. The one rule worth a test:
 * the list and the add both read THROUGH the ticket scope, so a document never shows (or links)
 * a ticket its reader could not open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Lead", email: "l@x.io", role: "TEAM_LEAD", permissions: [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE] };

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
vi.mock("../../src/services/requirements-doc.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/requirements-doc.service.js")>("../../src/services/requirements-doc.service.js");
  return { ...actual, getRequirementsDocument: vi.fn().mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777", title: "Onboarding PRD" }) };
});
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));

const { requirementsDocRouter } = await import("../../src/controllers/requirements-doc.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const DOC = "77777777-7777-4777-8777-777777777777";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const TICKET = { id: "11111111-1111-4111-8111-111111111111", key: "X-1", title: "One", status: "OPEN", priority: "MEDIUM" };
let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/requirements-docs", requirementsDocRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  actor.role = "TEAM_LEAD";
  client = {
    // The lead is on project 3333… only.
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: PROJECT }]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    ticket: { findFirst: vi.fn().mockResolvedValue(TICKET) },
    ticketDocumentLink: {
      findMany: vi.fn().mockResolvedValue([{ id: "dl1", ticket: TICKET }]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: "dl1", ...data })),
      delete: vi.fn().mockResolvedValue({})
    }
  } as unknown as PrismaClient;
});

describe("related tickets on a document", () => {
  it("lists links through the reader's project scope", async () => {
    const res = await request(buildApp()).get(`/api/requirements-docs/${DOC}/tickets`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "dl1", ticket: TICKET }]);
    const where = (vi.mocked(client.ticketDocumentLink.findMany).mock.calls[0][0] as any).where;
    expect(where).toEqual({ documentId: DOC, ticket: { deletedAt: null, projectId: { in: [PROJECT] } } });
  });
  it("a super admin's list is unscoped", async () => {
    actor.role = "SUPER_ADMIN";
    await request(buildApp()).get(`/api/requirements-docs/${DOC}/tickets`);
    const where = (vi.mocked(client.ticketDocumentLink.findMany).mock.calls[0][0] as any).where;
    expect(where.ticket).toEqual({ deletedAt: null });
  });
  it("relates by key, only a ticket inside the scope, and never the same pair twice", async () => {
    const res = await request(buildApp()).post(`/api/requirements-docs/${DOC}/tickets`).send({ ticketKey: "x-1" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "dl1", ticket: TICKET });
    const where = (vi.mocked(client.ticket.findFirst).mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ key: "X-1", projectId: { in: [PROJECT] } });
    expect(auditSpy).toHaveBeenCalledWith("user-1", "ticket.document_linked", "Ticket", TICKET.id, { documentId: DOC });

    vi.mocked(client.ticketDocumentLink.findFirst).mockResolvedValueOnce({ id: "dl1" } as never);
    const dup = await request(buildApp()).post(`/api/requirements-docs/${DOC}/tickets`).send({ ticketKey: "X-1" });
    expect(dup.status).toBe(422);

    vi.mocked(client.ticket.findFirst).mockResolvedValueOnce(null as never);
    const outside = await request(buildApp()).post(`/api/requirements-docs/${DOC}/tickets`).send({ ticketKey: "Y-9" });
    expect(outside.status).toBe(404);
  });
});
