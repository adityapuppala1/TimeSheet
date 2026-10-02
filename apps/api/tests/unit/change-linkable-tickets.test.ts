/**
 * A change's "delivered work" can only be plain tickets — never another change's own ticket.
 *
 * THE DEFECT (audit 2026-10, change management finding 6): the picker offered every RESOLVED/CLOSED
 * ticket in the project, and a change's ticket is one of those once the change is CLOSED — or the
 * moment it is REJECTED or CANCELLED, which also map to CLOSED. So another change (even one that was
 * never approved) appeared as shipped work, and the link route accepted it. A change is a record of
 * what shipped; a cancelled change shipped nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { ACTORS, CHANGE_ID, buildChangeApp, createChangeWorld } from "../helpers/change-world.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: any, _res: unknown, next: () => void) => {
      req.user = ACTORS.admin;
      next();
    },
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
  };
});
vi.mock("../../src/services/plan-limits.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-limits.service.js")>("../../src/services/plan-limits.service.js");
  return { ...actual, isPlanningCapabilityAllowed: vi.fn(async () => true) };
});
vi.mock("../../src/services/ticket.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/ticket.service.js")>("../../src/services/ticket.service.js");
  return { ...actual, assertTicketVisible: vi.fn(async () => undefined) };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));

const { changeRouter } = await import("../../src/controllers/change.controller.js");

type Row = { id: string; key: string; title: string; status: string; type: string; projectId: string; deletedAt: null; changeRequest: { id: string } | null };

/** The fake honours the filters the routes send, so a test can say "this row was not offered". */
function matches(row: Row, where: any): boolean {
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (where.projectId && row.projectId !== where.projectId) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.id?.notIn && where.id.notIn.includes(row.id)) return false;
  if (where.changeRequest && "is" in where.changeRequest && where.changeRequest.is === null && row.changeRequest !== null) return false;
  return true;
}

let world: ReturnType<typeof createChangeWorld>;
let rows: Row[];

beforeEach(() => {
  world = createChangeWorld({ change: { state: "IMPLEMENTING" } });
  rows = [
    { id: "t-plain", key: "WEB-1", title: "Fix the login form", status: "CLOSED", type: "BUG", projectId: "project-1", deletedAt: null, changeRequest: null },
    { id: "t-change", key: "WEB-2", title: "CHG: rotate the TLS cert", status: "CLOSED", type: "CHANGE", projectId: "project-1", deletedAt: null, changeRequest: { id: "chg-other" } }
  ];
  world.client.ticket.findMany = vi.fn(async (args: any = {}) => rows.filter((r) => matches(r, args.where ?? {})));
  world.client.changeTicketLink = {
    findMany: vi.fn(async () => []),
    createMany: vi.fn(async (args: any) => ({ count: args.data.length }))
  };
});

describe("the delivered-work picker on a change", () => {
  it("offers closed plain tickets, never another change's own ticket", async () => {
    const res = await request(buildChangeApp(changeRouter, world.client)).get(`/api/changes/${CHANGE_ID}/linkable-tickets`);

    expect(res.status).toBe(200);
    expect(res.body.map((t: Row) => t.key)).toEqual(["WEB-1"]);
  });

  it("refuses to link another change's ticket even when asked for it directly", async () => {
    const res = await request(buildChangeApp(changeRouter, world.client))
      .post(`/api/changes/${CHANGE_ID}/tickets`)
      .send({ ticketIds: ["t-change"] });

    expect(res.status).toBe(422);
    expect(world.client.changeTicketLink.createMany).not.toHaveBeenCalled();
  });
});
