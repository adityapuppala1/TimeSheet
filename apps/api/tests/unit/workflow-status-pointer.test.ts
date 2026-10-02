/**
 * The planning views read the ticket's real status, not the frozen workflow pointer.
 *
 * `Ticket.workflowStatusId` was backfilled once, by the V6 planning migration, and no write path has
 * set it since: custom workflows were never connected to ticket writes (`resolveStatusWrite` has no
 * caller). Yet My Work, the Timeline and the Calendar preferred it over `Ticket.status`. So a ticket
 * that was OPEN on upgrade day and has since moved to IN_PROGRESS still showed the badge "Open" in
 * My Work, and a ticket RESOLVED on upgrade day and since reopened was drawn struck-through as DONE
 * on the Timeline. Until custom workflows are wired into the one transition path, the built-in status
 * is the only truth these views may show.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "admin-1", name: "Ada", email: "ada@acme.test", role: "ADMIN", permissions: [permissions.TICKETS_VIEW] as string[] };

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
vi.mock("../../src/services/planning.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/planning.service.js")>()),
  assertPlanningEnabled: vi.fn().mockResolvedValue(undefined)
}));

const { computeMyWork } = await import("../../src/services/my-work.service.js");
const { buildPlan } = await import("../../src/services/plan-schedule.service.js");
const { planRouter } = await import("../../src/controllers/plan.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

/** A ticket that was OPEN on upgrade day (so its frozen pointer says "Open", category TODO) and is
 *  IN_PROGRESS now. Whatever the query selects, the stale pointer is on the row. */
const MOVED_ON = {
  id: "t-1",
  key: "WEB-1",
  title: "Checkout retries",
  status: "IN_PROGRESS",
  priority: "MEDIUM",
  type: "BUG",
  startDate: null,
  endDate: null,
  dueAt: new Date("2026-10-05T00:00:00Z"),
  isMilestone: false,
  progressPct: 0,
  estimatedHours: null,
  parentId: null,
  assigneeId: "admin-1",
  projectId: "proj-1",
  baselineStartDate: null,
  baselineEndDate: null,
  baselineEffortHours: null,
  workflowStatus: { id: "ws-open", name: "Open", category: "TODO", color: "#999999" },
  assignee: null,
  project: { id: "proj-1", code: "WEB", name: "Web", color: null },
  linksTo: []
};

let client: PrismaClient;

beforeEach(() => {
  client = {
    ticket: { findMany: vi.fn().mockResolvedValue([MOVED_ON]) },
    ticketLink: { findMany: vi.fn().mockResolvedValue([]) },
    ticketComment: { findMany: vi.fn().mockResolvedValue([]) },
    timesheet: { groupBy: vi.fn().mockResolvedValue([]) },
    globalPlanningSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    project: { findMany: vi.fn().mockResolvedValue([{ id: "proj-1" }]) }
  } as unknown as PrismaClient;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/plan", planRouter);
  app.use(errorHandler);
  return app;
}

describe("the built-in status wins over the frozen workflow pointer", () => {
  it("My Work shows the ticket as ACTIVE, with no stale 'Open' badge", async () => {
    const work = await runInTenant(client, () => computeMyWork("admin-1", new Date("2026-10-02T06:00:00Z")));
    const item = [...work.overdue, ...work.today, ...work.thisWeek, ...work.later, ...work.blocked].find((t) => t.id === "t-1");
    expect(item).toMatchObject({ status: "IN_PROGRESS", statusCategory: "ACTIVE", statusLabel: null });
  });

  it("the Timeline categorises it by its real status", async () => {
    const plan = await runInTenant(client, () => buildPlan({ projectIds: ["proj-1"] }));
    expect(plan.items[0]).toMatchObject({ status: "IN_PROGRESS", statusCategory: "ACTIVE" });
  });

  it("the Timeline route carries no label or colour from the pointer", async () => {
    const res = await request(buildApp()).get("/api/plan/timeline");
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ statusCategory: "ACTIVE", statusLabel: null, statusColor: null });
  });

  it("the Calendar colours its chip by the real status", async () => {
    const res = await request(buildApp()).get("/api/plan/calendar?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ status: "IN_PROGRESS", statusCategory: "ACTIVE", statusLabel: null });
  });
});
