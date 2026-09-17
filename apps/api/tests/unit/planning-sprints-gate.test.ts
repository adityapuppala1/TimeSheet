/**
 * The sprints gate. Two facts a workspace relies on: sprints are OFF until a super admin turns
 * them on (so this migration changes nothing for anyone), and they ride on the planning layer —
 * the switch alone is not enough. Both messages name the toggle to flip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("../../src/config/prisma.js", () => ({ prisma: { globalPlanningSettings: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getPlanningEntitlements: vi.fn().mockResolvedValue({ ganttEnabled: true, resourceMgmtEnabled: true, approvalsEnabled: true, proofingEnabled: true, customWorkflowsEnabled: true, goalsEnabled: true }),
  isPlanningCapabilityAllowed: vi.fn().mockResolvedValue(true)
}));

const { assertSprintsEnabled, getEffectivePlanning, getPlanningSettings } = await import("../../src/services/planning.service.js");

const row = (over: Record<string, unknown> = {}) => ({
  id: "global", enablePlanning: false, enableResourceManagement: false, enableApprovals: false, enableProofing: false,
  enableRequestForms: false, enableCustomWorkflows: false, enableGoals: false, enableSprints: false,
  workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40, ...over
});

beforeEach(() => findUnique.mockReset());

describe("sprints are off by default", () => {
  it("reads false with no settings row at all, and false on a row that predates the column", async () => {
    findUnique.mockResolvedValue(null);
    expect((await getPlanningSettings()).enableSprints).toBe(false);
    findUnique.mockResolvedValue(row({ enableSprints: undefined }));
    expect(Boolean((await getPlanningSettings()).enableSprints)).toBe(false);
  });

  it("is effective only when BOTH the sprints switch and planning are on", async () => {
    findUnique.mockResolvedValue(row({ enableSprints: true }));
    expect((await getEffectivePlanning()).effective.sprints).toBe(false);
    findUnique.mockResolvedValue(row({ enableSprints: true, enablePlanning: true }));
    expect((await getEffectivePlanning()).effective.sprints).toBe(true);
    findUnique.mockResolvedValue(row({ enablePlanning: true }));
    expect((await getEffectivePlanning()).effective.sprints).toBe(false);
  });
});

describe("assertSprintsEnabled", () => {
  it("names the planning layer when that is what is missing", async () => {
    findUnique.mockResolvedValue(row({ enableSprints: true }));
    await expect(assertSprintsEnabled()).rejects.toThrow(/planning layer/);
  });

  it("names the sprints switch when planning is on but sprints are not", async () => {
    findUnique.mockResolvedValue(row({ enablePlanning: true }));
    await expect(assertSprintsEnabled()).rejects.toThrow(/Sprints are off/);
  });

  it("passes when both are on", async () => {
    findUnique.mockResolvedValue(row({ enablePlanning: true, enableSprints: true }));
    await expect(assertSprintsEnabled()).resolves.toBeUndefined();
  });
});

/* Decided 2026-09-17 (V12 Open Questions): sprints ride with the timeline's tier. */
describe("sprints and the plan tier", () => {
  it("are not effective, and the route refuses naming the plan, without the timeline entitlement", async () => {
    const { getPlanningEntitlements } = await import("../../src/services/plan-limits.service.js");
    vi.mocked(getPlanningEntitlements).mockResolvedValueOnce({ ganttEnabled: false, resourceMgmtEnabled: true, approvalsEnabled: true, proofingEnabled: true, customWorkflowsEnabled: true, goalsEnabled: true } as never);
    findUnique.mockResolvedValue(row({ enablePlanning: true, enableSprints: true }));
    expect((await getEffectivePlanning()).effective.sprints).toBe(false);
    vi.mocked(getPlanningEntitlements).mockResolvedValueOnce({ ganttEnabled: false, resourceMgmtEnabled: true, approvalsEnabled: true, proofingEnabled: true, customWorkflowsEnabled: true, goalsEnabled: true } as never);
    await expect(assertSprintsEnabled()).rejects.toThrow(/Upgrade to Team or Enterprise to use sprints/);
  });
});
