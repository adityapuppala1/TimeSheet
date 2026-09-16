/**
 * The sidebar's Project → Module tree deep-links to Tickets with `?module=`, and the page hands
 * that on to BOTH the list and the metrics endpoint as `moduleId`. The two must agree: a tile
 * counting every module while the table under it shows one would be worse than no tile — the
 * exact drift the metrics route's own comment warns about. These drive the real router and read
 * the `where` each endpoint actually sent to Prisma.
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
// The sparkline history is its own tested unit; here it would only demand more fixtures.
vi.mock("../../src/services/ticket-metrics.service.js", () => ({
  buildTicketMetricSeriesFor: vi.fn().mockResolvedValue(null)
}));

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

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
  client = {
    ticket: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([])
    },
    project: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: "proj-1" }) },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) }
  } as unknown as PrismaClient;
});

/** The `where` of every ticket.groupBy call the metrics route issued. */
function groupByWheres(): Array<Record<string, unknown>> {
  return vi.mocked(client.ticket.groupBy).mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
}

describe("GET /tickets", () => {
  it("narrows by moduleId when asked", async () => {
    const response = await request(buildApp()).get("/api/tickets?projectId=proj-1&moduleId=mod-7");
    expect(response.status).toBe(200);
    const where = vi.mocked(client.ticket.findMany).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.projectId).toBe("proj-1");
    expect(where.moduleId).toBe("mod-7");
  });

  it("sends no moduleId clause when the parameter is absent — 'all modules' is an absent key, not a string", async () => {
    await request(buildApp()).get("/api/tickets?projectId=proj-1");
    const where = vi.mocked(client.ticket.findMany).mock.calls[0][0]!.where as Record<string, unknown>;
    expect("moduleId" in where).toBe(false);
  });
});

describe("GET /tickets/metrics", () => {
  it("applies the same moduleId to every tally, so the tiles describe the table under them", async () => {
    const response = await request(buildApp()).get("/api/tickets/metrics?projectId=proj-1&moduleId=mod-7");
    expect(response.status).toBe(200);
    const wheres = groupByWheres();
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) expect(where.moduleId).toBe("mod-7");
  });
});
