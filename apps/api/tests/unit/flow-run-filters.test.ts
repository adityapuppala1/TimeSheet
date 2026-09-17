/**
 * V12 9.5 — the Studio run feed's filters, through the real router.
 *
 * Same guard as the agent list next door: `AutomationFlowRun.status` is a VARCHAR, so an
 * un-validated `?status=` would accept anything and answer with an empty list — which, for a
 * question like "has this flow failed", reads as reassurance rather than as a refused filter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "emp-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };
const findMany = vi.fn().mockResolvedValue([]);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});
// The Studio gate is LOCAL to the controller and asks the plan-limits service, which reads the
// control plane. Entitlement is not what this test is about, so it is answered "yes" here.
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: vi.fn().mockResolvedValue(true),
  getPlanningEntitlements: vi.fn().mockResolvedValue({})
}));
const { automationFlowRouter, buildFlowRunWhere, FLOW_RUN_STATUSES } = await import(
  "../../src/controllers/automation-flow.controller.js"
);
const { errorHandler } = await import("../../src/middleware/error.js");
const { permissions } = await import("@timesheet/shared");
const { runInTenant } = await import("../helpers/tenant-context.js");

// The real `prisma` proxy, over a fake client in tenant context — the same shape the other route
// tests use, so the route under test is reached exactly as a request reaches it.
const client = { automationFlowRun: { findMany: (...a: unknown[]) => findMany(...a) } } as never;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  a.use("/flows", automationFlowRouter);
  a.use(errorHandler);
  return a;
}

const FLOW = "11111111-1111-4111-8111-111111111111";

describe("buildFlowRunWhere", () => {
  it("is empty for no filters — everything, never nothing", () => {
    expect(buildFlowRunWhere({})).toEqual({});
  });
  it("carries each filter only when given", () => {
    expect(buildFlowRunWhere({ flowId: FLOW })).toEqual({ flowId: FLOW });
    expect(buildFlowRunWhere({ status: "FAILED" })).toEqual({ status: "FAILED" });
    expect(buildFlowRunWhere({ flowId: FLOW, status: "WAITING" })).toEqual({ flowId: FLOW, status: "WAITING" });
  });
  it("offers exactly the statuses a flow run reaches", () => {
    expect([...FLOW_RUN_STATUSES].sort()).toEqual(["COMPLETED", "FAILED", "RUNNING", "STOPPED", "WAITING"].sort());
  });
});

describe("GET /api/flows/runs", () => {
  beforeEach(() => {
    findMany.mockClear();
    actor.permissions = [permissions.TICKETS_VIEW];
  });

  it("asks for everything when nothing is filtered, capped at the default page", async () => {
    await request(app()).get("/flows/runs").expect(200);
    const call = findMany.mock.calls[0][0] as any;
    expect(call.where).toEqual({});
    expect(call.take).toBe(20);
  });

  it("narrows to one flow, one status, or both", async () => {
    await request(app()).get(`/flows/runs?flowId=${FLOW}`).expect(200);
    expect((findMany.mock.calls[0][0] as any).where).toEqual({ flowId: FLOW });

    findMany.mockClear();
    await request(app()).get("/flows/runs?status=FAILED").expect(200);
    expect((findMany.mock.calls[0][0] as any).where).toEqual({ status: "FAILED" });

    findMany.mockClear();
    await request(app()).get(`/flows/runs?flowId=${FLOW}&status=STOPPED&limit=5`).expect(200);
    const call = findMany.mock.calls[0][0] as any;
    expect(call.where).toEqual({ flowId: FLOW, status: "STOPPED" });
    expect(call.take).toBe(5);
  });

  it("refuses a status no flow run can hold, and a flow id that is not one", async () => {
    for (const bad of ["SKIPPED", "done", "ABORTED", "1 OR 1=1"]) {
      await request(app()).get(`/flows/runs?status=${encodeURIComponent(bad)}`).expect(422);
    }
    await request(app()).get("/flows/runs?flowId=not-a-uuid").expect(422);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("still answers a reader who only holds tickets:view — narrowing must not need an admin", async () => {
    actor.permissions = [permissions.TICKETS_VIEW];
    await request(app()).get("/flows/runs?status=WAITING").expect(200);
    actor.permissions = [];
    await request(app()).get("/flows/runs?status=WAITING").expect(403);
  });
});
