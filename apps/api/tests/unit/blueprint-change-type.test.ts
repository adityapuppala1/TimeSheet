/**
 * A blueprint never carries a change, and never stamps a CHANGE-typed ticket.
 *
 * THE DEFECT: "Save as blueprint" learned from EVERY ticket in the project, and a change's own ticket
 * is a ticket of type CHANGE. So a blueprint derived from a project that had run changes listed them
 * as ordinary steps, and instantiating it created CHANGE-typed tickets with no change request behind
 * them — changes nobody raised, with no plan, approval or lifecycle. A change is a one-off record of
 * shipping something, not a reusable step of a plan.
 *
 * The rule now lives in three places: derive skips change tickets, `validateBlueprint` refuses the
 * type on save, and instantiate refuses a blueprint saved before this rule existed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "u1", role: "ADMIN", name: "Ada", email: "ada@x.io", permissions: ["plan:write", "tickets:view"] } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/planning.service.js", () => ({ assertPlanningEnabled: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/plan-schedule.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-schedule.service.js")>("../../src/services/plan-schedule.service.js");
  return { ...actual, readWorkingDays: vi.fn().mockResolvedValue([1, 2, 3, 4, 5]) };
});

const { blueprintRouter } = await import("../../src/controllers/blueprint.controller.js");
const { validateBlueprint } = await import("../../src/services/blueprint.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BLUEPRINT = "22222222-2222-4222-8222-222222222222";

type TicketRow = { id: string; title: string; type: string; changeRequest: { id: string } | null };
let tickets: TicketRow[];
let client: Record<string, any>;

function app() {
  const server = express();
  server.use(express.json());
  server.use((_req, _res, next) => runInTenant(client as unknown as PrismaClient, async () => next(), "org-1").catch(next));
  server.use("/api/blueprints", blueprintRouter);
  server.use(errorHandler);
  return request(server);
}

beforeEach(() => {
  tickets = [
    { id: "t1", title: "Design the schema", type: "TASK", changeRequest: null },
    { id: "t2", title: "CHG: rotate the TLS cert", type: "CHANGE", changeRequest: { id: "chg-1" } }
  ];
  client = {
    ticket: {
      findMany: vi.fn(async (args: any = {}) =>
        tickets
          .filter((t) => !(args.where?.changeRequest && args.where.changeRequest.is === null && t.changeRequest !== null))
          .map((t) => ({ ...t, priority: "MEDIUM", parentId: null, startDate: null, endDate: null, isMilestone: false, estimatedHours: null, module: null }))
      ),
      create: vi.fn(async (args: any) => ({ id: "new", key: args.data.key, title: args.data.title }))
    },
    globalTicketSettings: {
      upsert: vi.fn().mockResolvedValue({ id: "global", slaLowHours: 168, slaMediumHours: 72, slaHighHours: 24, slaCriticalHours: 4 }),
      findUnique: vi.fn().mockResolvedValue({ id: "global", slaLowHours: 168, slaMediumHours: 72, slaHighHours: 24, slaCriticalHours: 4 })
    },
    projectModule: { upsert: vi.fn() },
    ticketLink: { findMany: vi.fn().mockResolvedValue([]) },
    blueprint: {
      create: vi.fn(async (args: any) => ({ id: BLUEPRINT, ...args.data })),
      findUnique: vi.fn()
    },
    project: { findFirst: vi.fn().mockResolvedValue({ id: PROJECT }), update: vi.fn().mockResolvedValue({ id: PROJECT, code: "WEB", ticketSeq: 3 }) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client))
  };
});

describe("saving a project as a blueprint", () => {
  it("learns from the project's work items, not from its changes", async () => {
    const res = await app().post("/api/blueprints/derive").send({ projectId: PROJECT, name: "Launch" });

    expect(res.status).toBe(201);
    const saved = client.blueprint.create.mock.calls[0][0].data.payload.items.map((i: { title: string }) => i.title);
    expect(saved).toEqual(["Design the schema"]);
  });
});

describe("validateBlueprint", () => {
  it("refuses an item of the CHANGE type", () => {
    expect(() => validateBlueprint({ items: [{ title: "Rotate the cert", type: "CHANGE" }] } as never)).toThrow(/CHANGE type/);
  });
});

describe("instantiating a blueprint saved before the rule", () => {
  it("refuses it, naming the item, and creates nothing", async () => {
    client.blueprint.findUnique.mockResolvedValue({ id: BLUEPRINT, payload: { items: [{ title: "Rotate the cert", type: "CHANGE" }] } });

    const res = await app().post(`/api/blueprints/${BLUEPRINT}/instantiate`).send({ projectId: PROJECT, startDate: "2026-10-05" });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Rotate the cert/);
    expect(client.ticket.create).not.toHaveBeenCalled();
  });
});
