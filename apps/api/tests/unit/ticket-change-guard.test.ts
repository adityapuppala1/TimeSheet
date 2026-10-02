/**
 * A change IS a ticket, and the change owns it.
 *
 * ChangeRequest and Ticket are 1:1, and the change module walks the ticket in step with the
 * change's own state. The status writers are covered in ticket-transition.test.ts; this file pins
 * the rest of the boundary: retyping or deleting a change's ticket from the Tickets page, raising a
 * plain ticket under the CHANGE type (which would look like a change everywhere and be none), and
 * the ticket SLA sweep escalating a change that has its own stage SLAs.
 *
 * It also pins the priority half of the SLA-clock fix: a real priority change starts a fresh window
 * from now and clears the old breach, and an edit that does not change the priority leaves the
 * clock alone.
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
vi.mock("../../src/middleware/public-api-auth.js", () => ({
  publicApiAuth: (req: any, _res: express.Response, next: express.NextFunction) => {
    req.apiKey = { id: "key-1", scope: "WRITE" };
    next();
  },
  requireWriteScope: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
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
const { publicApiRouter } = await import("../../src/controllers/public-api.controller.js");
const { processTicketSlaSweep } = await import("../../src/services/ticket-sla.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const HOUR = 3_600_000;
const SLA = { slaLowHours: 10, slaMediumHours: 20, slaHighHours: 30, slaCriticalHours: 40 };

let row: Record<string, any>;
let client: PrismaClient;

function buildClient(): PrismaClient {
  return {
    ticket: {
      findFirst: vi.fn(async () => ({ ...row })),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }))
    },
    // Every active type, CHANGE included: the CHANGE row exists in any workspace that has raised a
    // change (change.controller.ts upserts it), so "is it an active type?" alone would accept it.
    ticketType: { findFirst: vi.fn(async ({ where }: { where: { name: string } }) => ({ id: `tt-${where.name}`, name: where.name, isActive: true })) },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "proj-1" }]), findFirst: vi.fn().mockResolvedValue({ id: "a-1" }) },
    user: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue(null) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue(SLA), findUnique: vi.fn().mockResolvedValue(null) },
    project: { findFirst: vi.fn().mockResolvedValue({ id: "proj-1", code: "WEB", name: "Web", status: "ACTIVE" }) },
    apiKey: { findUnique: vi.fn().mockResolvedValue({ id: "key-1", createdById: "admin-1" }) },
    $transaction: vi.fn()
  } as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use("/api/public/v1", publicApiRouter);
  app.use(errorHandler);
  return app;
}

const updateData = () => (vi.mocked(client.ticket.update).mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined)?.data;

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "ADMIN";
  actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE, permissions.TICKETS_MANAGE];
  row = {
    id: TICKET_ID,
    key: "WEB-12",
    title: "Upgrade the payments gateway",
    type: "CHANGE",
    projectId: "proj-1",
    status: "IN_REVIEW",
    priority: "MEDIUM",
    reporterId: "requester-1",
    assigneeId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    dueAt: new Date("2026-01-02T00:00:00Z"),
    slaBreachAt: new Date("2026-01-02T00:15:00Z"),
    deletedAt: null,
    changeRequest: { id: "chg-1" }
  };
  client = buildClient();
});

describe("a change's ticket cannot be retyped or deleted from the Tickets page", () => {
  it("PATCH /:id refuses a type change with 409 CHANGE_OWNED_TICKET", async () => {
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}`).send({ type: "BUG" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHANGE_OWNED_TICKET");
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("PATCH /:id still lets the title be edited — only the lifecycle is the change's", async () => {
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}`).send({ title: "Upgrade the payments gateway to v3" });
    expect(res.status).toBe(200);
  });

  it("DELETE /:id refuses with 409 and deletes nothing", async () => {
    const res = await request(buildApp()).delete(`/api/tickets/${TICKET_ID}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHANGE_OWNED_TICKET");
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("DELETE /:id still deletes a plain ticket", async () => {
    row = { ...row, type: "BUG", changeRequest: null };
    const res = await request(buildApp()).delete(`/api/tickets/${TICKET_ID}`);
    expect(res.status).toBe(204);
  });
});

describe("a plain ticket cannot be raised or retyped as CHANGE", () => {
  it("POST / refuses type CHANGE", async () => {
    const res = await request(buildApp())
      .post("/api/tickets")
      .send({ projectId: "22222222-2222-4222-8222-222222222222", type: "CHANGE", title: "Looks like a change" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/change/i);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("PATCH /:id refuses retyping a plain ticket to CHANGE", async () => {
    row = { ...row, type: "BUG", changeRequest: null };
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}`).send({ type: "CHANGE" });
    expect(res.status).toBe(422);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("the public API refuses creating one too", async () => {
    const res = await request(buildApp()).post("/api/public/v1/tickets").send({ projectCode: "WEB", type: "CHANGE", title: "Looks like a change" });
    expect(res.status).toBe(422);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  // `TicketType.name` and `Ticket.type` use utf8mb4_unicode_ci: case- and accent-insensitive, trailing
  // spaces ignored. Each spelling below finds the CHANGE row and, once stored, is a change to every SQL
  // filter on `type` — the exact `=== "CHANGE"` let all of them through.
  for (const spelling of ["change", "Change", "CHANGE ", "chánge"]) {
    it(`POST / refuses "${spelling}", which the database reads as CHANGE`, async () => {
      const res = await request(buildApp())
        .post("/api/tickets")
        .send({ projectId: "22222222-2222-4222-8222-222222222222", type: spelling, title: "Looks like a change" });
      expect(res.status).toBe(422);
      expect(client.$transaction).not.toHaveBeenCalled();
    });
  }

  it("refuses any spelling the database itself matches to the CHANGE row", async () => {
    // Whatever folding the string check misses, the collation is the authority: the row it finds says
    // which type this is.
    vi.mocked(client.ticketType.findFirst).mockResolvedValue({ id: "tt-change", name: "CHANGE", isActive: true } as never);
    const res = await request(buildApp())
      .post("/api/tickets")
      .send({ projectId: "22222222-2222-4222-8222-222222222222", type: "CH​ANGE", title: "Looks like a change" });
    expect(res.status).toBe(422);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe("the ticket SLA sweep leaves changes to their own stage SLAs", () => {
  it("excludes tickets that belong to a change request", async () => {
    await runInTenant(client, () => processTicketSlaSweep(new Date("2026-02-01T00:00:00Z")));
    const where = (vi.mocked(client.ticket.findMany).mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.changeRequest).toEqual({ is: null });
  });
});

describe("a real priority change restarts the SLA clock", () => {
  beforeEach(() => {
    row = { ...row, type: "BUG", changeRequest: null };
  });

  it("counts the new window from now, not from creation, and clears the old breach", async () => {
    const before = Date.now();
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}`).send({ priority: "HIGH" });
    expect(res.status).toBe(200);
    const data = updateData()!;
    expect(data.priority).toBe("HIGH");
    expect(data.slaBreachAt).toBeNull();
    expect((data.dueAt as Date).getTime()).toBeGreaterThanOrEqual(before + 30 * HOUR);
  });

  it("leaves the clock alone when the edit re-sends the same priority", async () => {
    await request(buildApp()).patch(`/api/tickets/${TICKET_ID}`).send({ priority: "MEDIUM", title: "Reworded" });
    const data = updateData()!;
    expect(data).not.toHaveProperty("dueAt");
    expect(data).not.toHaveProperty("slaBreachAt");
  });
});
