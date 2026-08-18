/**
 * The two boundaries around Goals, driven through the REAL router with supertest.
 *
 * 1. THE ENTITLEMENT FAILS CLOSED, AND WITH A MESSAGE THAT NAMES THE RIGHT ACTION. Goals are
 *    workspace-toggle AND plan-tier, ANDed server-side. The two refusals must stay distinguishable:
 *    "a super admin can turn it on" is for an admin of this workspace, "upgrade" is a commercial
 *    conversation, and one generic 403 sends both to the wrong place.
 * 2. READING IS OPEN, WRITING NEEDS `goals:manage`. A goal nobody can see aligns nobody, so the
 *    list route deliberately carries no permission — which is exactly the kind of decision that
 *    gets "tidied up" later, so it is pinned here.
 *
 * `requirePermission` is left as the real implementation for the reason ai-proposal-scope.test.ts
 * states: stubbing it would let these pass by bypassing authorization entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "u-1", name: "Mgr", email: "m@x.io", role: "MANAGER", permissions: [] as string[] };

const goalFindMany = vi.fn().mockResolvedValue([]);
const goalCount = vi.fn().mockResolvedValue(0);
const goalCreate = vi.fn();
const overrideCreate = vi.fn();

const settingsFindUnique = vi.fn();
const isPlanningCapabilityAllowed = vi.fn();

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

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    goal: { findMany: goalFindMany, findFirst: vi.fn(), count: goalCount, create: goalCreate, update: vi.fn() },
    goalLink: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
    goalProgressOverride: { create: overrideCreate },
    // The gate reads this row itself — driving it here rather than stubbing
    // assertGoalsEnabled keeps the REAL two-condition AND under test.
    globalPlanningSettings: { findUnique: settingsFindUnique },
    $transaction: vi.fn()
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({
  requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" })
}));

// planning.service.js is deliberately NOT mocked: assertGoalsEnabled is the thing under test, and
// it reads its settings row through the mocked prisma above.
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: (...args: unknown[]) => isPlanningCapabilityAllowed(...args),
  getPlanningQuota: vi.fn().mockResolvedValue(1_000_000)
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/goal-progress.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/goal-progress.service.js")>(
    "../../src/services/goal-progress.service.js"
  );
  return {
    ...actual,
    measureGoal: vi.fn().mockResolvedValue({
      currentValue: 10,
      progressPct: 25,
      health: "AT_RISK",
      unavailable: false,
      unavailableReason: null
    })
  };
});

const { goalRouter } = await import("../../src/controllers/goal.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/goals", goalRouter);
  a.use(errorHandler);
  return a;
}

// Only the field the gate reads; getPlanningSettings fills the rest from the row's own defaults.
const ON = { enableGoals: true, workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 } as never;
const OFF = { enableGoals: false, workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 } as never;

beforeEach(() => {
  vi.clearAllMocks();
  actor.permissions = [];
  goalFindMany.mockResolvedValue([]);
  goalCount.mockResolvedValue(0);
  settingsFindUnique.mockResolvedValue(ON);
  isPlanningCapabilityAllowed.mockResolvedValue(true);
});

describe("the goals gate fails closed", () => {
  it("refuses when the workspace toggle is off, and points at the setting", async () => {
    settingsFindUnique.mockResolvedValue(OFF);
    const res = await request(app()).get("/goals");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/super admin/i);
    expect(res.body.message).toMatch(/Workspace Settings/i);
    expect(goalFindMany).not.toHaveBeenCalled();
  });

  it("refuses when the plan does not include goals, and says upgrade instead", async () => {
    isPlanningCapabilityAllowed.mockResolvedValue(false);
    const res = await request(app()).get("/goals");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not included in this plan/i);
    expect(res.body.message).not.toMatch(/super admin/i);
  });

  it("asks the entitlement layer about goalsEnabled specifically", async () => {
    await request(app()).get("/goals");
    expect(isPlanningCapabilityAllowed).toHaveBeenCalledWith("org-1", "goalsEnabled");
  });

  it("gates writes on the same AND, not only reads", async () => {
    // A gate applied to the list route but forgotten on create is the classic version of this bug.
    actor.permissions = ["goals:manage"];
    settingsFindUnique.mockResolvedValue(OFF);
    const res = await request(app()).post("/goals").send({ title: "Ship it" });
    expect(res.status).toBe(403);
    expect(goalCreate).not.toHaveBeenCalled();
  });
});

describe("reading is open, writing is not", () => {
  it("lets a user with no permissions at all read the goal list", async () => {
    const res = await request(app()).get("/goals");
    expect(res.status).toBe(200);
    expect(goalFindMany).toHaveBeenCalled();
  });

  it("refuses creation without goals:manage", async () => {
    const res = await request(app()).post("/goals").send({ title: "Ship it" });
    expect(res.status).toBe(403);
    expect(goalCreate).not.toHaveBeenCalled();
  });

  it("refuses an override without goals:manage", async () => {
    const res = await request(app()).post("/goals/g-1/override").send({ progressPct: 80, note: "because" });
    expect(res.status).toBe(403);
    expect(overrideCreate).not.toHaveBeenCalled();
  });
});

describe("the active-goal quota", () => {
  it("counts only ACTIVE goals against the ceiling", async () => {
    // Closed goals are history. Counting them would push people to delete the record of what they
    // were aiming at, which is the opposite of what an audit trail is for.
    const { getPlanningQuota } = await import("../../src/services/plan-limits.service.js");
    vi.mocked(getPlanningQuota).mockResolvedValue(2);
    actor.permissions = ["goals:manage"];
    goalCount.mockResolvedValue(2);

    const res = await request(app()).post("/goals").send({ title: "One too many" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/active goal/i);
    expect(goalCount).toHaveBeenCalledWith({ where: { deletedAt: null, status: "ACTIVE" } });
    expect(goalCreate).not.toHaveBeenCalled();
  });
});
