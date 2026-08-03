/**
 * WHAT: the planning layer's settings singleton and its feature gates.
 *
 * WHY THE GATE IS TWO CONDITIONS, ALWAYS CHECKED TOGETHER: a capability is available only when
 * the workspace has turned it ON *and* the org's plan tier includes it. Checking one without the
 * other produces the two worst outcomes available — a feature the customer paid for that stays
 * dark, or a feature they didn't pay for that works. `assertPlanningEnabled` and friends are the
 * single place that AND lives on the server, and `GET /planning/settings` returns the same
 * computed `effective` object to the client so the UI can never disagree with the API about what
 * is available.
 *
 * WHO CALLS THIS: `controllers/plan.controller.ts`, `controllers/portfolio.controller.ts`, and
 * from later phases the resource, intake and approval controllers.
 */
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { getPlanningEntitlements, isPlanningCapabilityAllowed, type PlanningCapability } from "./plan-limits.service.js";

export const PLANNING_SETTINGS_ID = "global";

export interface PlanningSettingsRow {
  enablePlanning: boolean;
  enableResourceManagement: boolean;
  enableApprovals: boolean;
  enableProofing: boolean;
  enableRequestForms: boolean;
  enableCustomWorkflows: boolean;
  workingDays: number[];
  defaultWeeklyCapacityHours: number;
}

const ALL_OFF: PlanningSettingsRow = {
  enablePlanning: false,
  enableResourceManagement: false,
  enableApprovals: false,
  enableProofing: false,
  enableRequestForms: false,
  enableCustomWorkflows: false,
  workingDays: [1, 2, 3, 4, 5],
  defaultWeeklyCapacityHours: 40
};

/**
 * The singleton, created by the phase-1 migration on existing installs and by `seed.ts` on new
 * ones. Falls back to all-off rather than throwing if a database somehow predates both: the
 * honest answer to "is planning on?" without a row is "no", which is also the safe one.
 */
export async function getPlanningSettings(): Promise<PlanningSettingsRow> {
  const row = await prisma.globalPlanningSettings.findUnique({ where: { id: PLANNING_SETTINGS_ID } });
  if (!row) return ALL_OFF;
  return {
    enablePlanning: row.enablePlanning,
    enableResourceManagement: row.enableResourceManagement,
    enableApprovals: row.enableApprovals,
    enableProofing: row.enableProofing,
    enableRequestForms: row.enableRequestForms,
    enableCustomWorkflows: row.enableCustomWorkflows,
    workingDays: Array.isArray(row.workingDays) && (row.workingDays as number[]).length > 0 ? (row.workingDays as number[]) : [1, 2, 3, 4, 5],
    defaultWeeklyCapacityHours: Number(row.defaultWeeklyCapacityHours ?? 40)
  };
}

/** Workspace toggle AND plan entitlement, per feature. This is the shape the client gates on. */
export async function getEffectivePlanning() {
  const [settings, entitlements] = await Promise.all([
    getPlanningSettings(),
    getPlanningEntitlements(requireTenantContext().orgId)
  ]);
  return {
    settings,
    entitlements,
    effective: {
      planning: settings.enablePlanning,
      timeline: settings.enablePlanning && entitlements.ganttEnabled,
      resourceManagement: settings.enableResourceManagement && entitlements.resourceMgmtEnabled,
      approvals: settings.enableApprovals && entitlements.approvalsEnabled,
      proofing: settings.enableProofing && entitlements.proofingEnabled,
      requestForms: settings.enableRequestForms,
      customWorkflows: settings.enableCustomWorkflows && entitlements.customWorkflowsEnabled
    }
  };
}

/**
 * The base gate for every planning route.
 *
 * The two failure messages are deliberately different, because they need different actions from
 * different people: "turn it on in settings" is for an admin of this workspace, "upgrade" is a
 * commercial conversation. A single generic 403 would send both to the wrong place.
 */
export async function assertPlanningEnabled(): Promise<PlanningSettingsRow> {
  const settings = await getPlanningSettings();
  if (!settings.enablePlanning) {
    throw new AppError(403, "Planning is off for this workspace. A super admin can enable it in Workspace Settings → Planning.");
  }
  const allowed = await isPlanningCapabilityAllowed(requireTenantContext().orgId, "ganttEnabled");
  if (!allowed) {
    throw new AppError(403, "Planning is not included in this plan. Upgrade to Team or Enterprise to use timelines and dependencies.");
  }
  return settings;
}

/** Same shape for the capabilities that have their own toggle beyond `enablePlanning`. */
export async function assertPlanningCapability(
  toggle: keyof PlanningSettingsRow,
  capability: PlanningCapability,
  featureLabel: string
): Promise<void> {
  const settings = await getPlanningSettings();
  if (!settings[toggle]) {
    throw new AppError(403, `${featureLabel} is off for this workspace. A super admin can enable it in Workspace Settings → Planning.`);
  }
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, capability))) {
    throw new AppError(403, `${featureLabel} is not included in this plan.`);
  }
}
