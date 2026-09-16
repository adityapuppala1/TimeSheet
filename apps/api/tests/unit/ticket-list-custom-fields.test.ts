/**
 * The ticket LIST carries custom-field values as `{ key: value }` per row, so the table can show
 * them as columns without a request per ticket. Pins the shape and that a ticket with no values
 * gets an empty object rather than a missing key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Adm", email: "a@x.io", role: "ADMIN", permissions: [permissions.TICKETS_VIEW] as string[] };

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

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient;
function buildApp() {
  const app = express();
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use(errorHandler);
  return app;
}

const row = (id: string, customFieldValues: unknown[]) => ({
  id, key: `X-${id}`, title: "t", status: "OPEN", priority: "LOW", type: "BUG", createdAt: new Date(), deletedAt: null,
  project: { id: "p", code: "X", name: "P" }, module: null, reporter: null, assignee: null, labels: [], _count: { comments: 0, attachments: 0 },
  customFieldValues
});

beforeEach(() => {
  client = {
    ticket: {
      findMany: vi.fn().mockResolvedValue([
        row("1", [{ value: "Acme", field: { key: "client" } }, { value: 12, field: { key: "seats" } }]),
        row("2", [])
      ])
    },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) }
  } as unknown as PrismaClient;
});

describe("GET /tickets carries customFields", () => {
  it("maps value rows to {key: value} and strips the raw relation", async () => {
    const res = await request(buildApp()).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body[0].customFields).toEqual({ client: "Acme", seats: 12 });
    expect(res.body[0]).not.toHaveProperty("customFieldValues");
  });

  it("gives a ticket with no values an empty object, not a missing key", async () => {
    const res = await request(buildApp()).get("/api/tickets");
    expect(res.body[1].customFields).toEqual({});
  });

  it("asks Prisma for the values with their field keys", async () => {
    await request(buildApp()).get("/api/tickets");
    const include = (vi.mocked(client.ticket.findMany).mock.calls[0][0] as any).include;
    expect(include.customFieldValues).toEqual({ select: { value: true, field: { select: { key: true } } } });
  });
});
