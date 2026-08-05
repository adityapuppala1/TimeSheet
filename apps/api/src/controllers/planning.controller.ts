/**
 * WHAT: the planning layer's admin surface — the workspace planning toggles, the plan-tier
 * entitlement matrix, custom workflows, and custom fields.
 *
 * WHY IT IS ONE CONTROLLER RATHER THAN THREE: everything here is configuration a SUPER_ADMIN
 * sets once from Workspace Settings, all of it reads the same entitlement matrix, and all of it
 * is meaningless until `enablePlanning` is on. Splitting it would mean three routers repeating
 * the same gate. The FEATURES built on this configuration (timeline, workload, forms, approvals)
 * each get their own controller in later phases, where the surfaces genuinely differ.
 *
 * WHY THE TOGGLE ENDPOINT IS SUPER_ADMIN-ONLY: it matches every other workspace-wide
 * enable/disable in this app (AI, biometrics, SSO, DevOps ingestion) — see the RequireRole gate
 * on `/app/settings` in the web router. Reading the settings is open to any authenticated user,
 * because the nav has to know whether to show a Plan section.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant` — every route here is per-tenant.
 */
import { Router } from "express";
import { z } from "zod";
import { customFieldTypes, permissions, ticketStatuses, workStatusCategories } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getPlanningEntitlements } from "../services/plan-limits.service.js";
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  updateCustomField
} from "../services/custom-field.service.js";
import { createWorkflow, deleteWorkflow, listWorkflows, updateWorkflow } from "../services/workflow.service.js";

export const planningRouter = Router();
planningRouter.use(requireAuth);

const SETTINGS_ID = "global";

/**
 * The singleton, created by the phase-1 migration on existing installs and by `seed.ts` on new
 * ones. Falling back to an in-memory all-false object rather than throwing keeps the app usable
 * if a database somehow predates both — the honest answer to "is planning on?" without a row is
 * "no", which is also the safe one.
 */
async function readSettings() {
  const row = await prisma.globalPlanningSettings.findUnique({ where: { id: SETTINGS_ID } });
  return (
    row ?? {
      id: SETTINGS_ID,
      enablePlanning: false,
      enableResourceManagement: false,
      enableApprovals: false,
      enableProofing: false,
      enableRequestForms: false,
      enableCustomWorkflows: false,
      workingDays: [1, 2, 3, 4, 5],
      defaultWeeklyCapacityHours: 40,
      updatedAt: new Date(),
      updatedById: null
    }
  );
}

/**
 * Settings + entitlements in one response.
 *
 * They are returned TOGETHER on purpose: a toggle that is on in the workspace but not included
 * in the plan is off in practice, and a UI given only the toggle would render a feature the API
 * then refuses. Sending both lets the client show "on, but not in your plan" — which is the
 * honest state and the one that sells an upgrade.
 *
 * Readable by any authenticated user because the sidebar needs it on every page load.
 */
planningRouter.get("/settings", async (req, res) => {
  const [settings, entitlements] = await Promise.all([
    readSettings(),
    getPlanningEntitlements(requireTenantContext().orgId)
  ]);

  // The effective answer, computed server-side so the client can never disagree with the API
  // about what is actually available.
  const effective = {
    planning: settings.enablePlanning,
    timeline: settings.enablePlanning && entitlements.ganttEnabled,
    resourceManagement: settings.enableResourceManagement && entitlements.resourceMgmtEnabled,
    approvals: settings.enableApprovals && entitlements.approvalsEnabled,
    proofing: settings.enableProofing && entitlements.proofingEnabled,
    requestForms: settings.enableRequestForms,
    customWorkflows: settings.enableCustomWorkflows && entitlements.customWorkflowsEnabled
  };

  res.json({ settings, entitlements, effective });
});

const settingsSchema = z.object({
  body: z
    .object({
      enablePlanning: z.boolean().optional(),
      enableResourceManagement: z.boolean().optional(),
      enableApprovals: z.boolean().optional(),
      enableProofing: z.boolean().optional(),
      enableRequestForms: z.boolean().optional(),
      enableCustomWorkflows: z.boolean().optional(),
      // 0 = Sunday. At least one working day, or the timeline solver divides by zero and the
      // workload board shows infinite utilisation.
      workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      defaultWeeklyCapacityHours: z.number().min(1).max(168).optional()
    })
    .strict()
});

planningRouter.patch("/settings", requireSuperAdmin, validate(settingsSchema), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const data: Record<string, unknown> = { updatedById: req.user!.id };
  for (const key of [
    "enablePlanning",
    "enableResourceManagement",
    "enableApprovals",
    "enableProofing",
    "enableRequestForms",
    "enableCustomWorkflows"
  ]) {
    if (typeof body[key] === "boolean") data[key] = body[key];
  }
  if (Array.isArray(body.workingDays)) data.workingDays = Array.from(new Set(body.workingDays as number[])).sort();
  if (typeof body.defaultWeeklyCapacityHours === "number") data.defaultWeeklyCapacityHours = body.defaultWeeklyCapacityHours;

  const updated = await prisma.globalPlanningSettings.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data }
  });
  await audit(req.user!.id, "planning.settings.updated", "GlobalPlanningSettings", SETTINGS_ID, data);
  res.json(updated);
});

/* ------------------------------------------------------------------ *
 * Workflows
 * ------------------------------------------------------------------ */

/** Readable with TICKETS_VIEW — the board and the status picker both need the status list, and
 *  neither is an admin surface. */
planningRouter.get("/workflows", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  res.json(await listWorkflows());
});

/** The vocabulary the workflow editor's dropdowns are built from, served rather than duplicated
 *  in the client so the two can't drift. */
planningRouter.get("/workflows/meta", requirePermission(permissions.TICKETS_VIEW), (_req, res) => {
  res.json({ categories: workStatusCategories, legacyStatuses: ticketStatuses });
});

const statusInputSchema = z.object({
  name: z.string().min(1).max(60),
  category: z.enum(workStatusCategories),
  legacyStatus: z.enum(ticketStatuses),
  color: z.string().max(20).nullish(),
  isInitial: z.boolean().optional(),
  isFinal: z.boolean().optional()
});

const workflowBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  appliesToTicketType: z.string().max(60).nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  statuses: z.array(statusInputSchema).min(1).max(30),
  transitions: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        requiresApproval: z.boolean().optional(),
        requiredPermission: z.string().max(60).nullish()
      })
    )
    .max(200)
});

planningRouter.post(
  "/workflows",
  requireSuperAdmin,
  validate(z.object({ body: workflowBodySchema })),
  async (req, res) => {
    const created = await createWorkflow(req.body);
    await audit(req.user!.id, "planning.workflow.created", "Workflow", created.id, { name: created.name });
    res.status(201).json(created);
  }
);

planningRouter.put(
  "/workflows/:id",
  requireSuperAdmin,
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: workflowBodySchema })),
  async (req, res) => {
    const updated = await updateWorkflow(String(req.params.id), req.body);
    await audit(req.user!.id, "planning.workflow.updated", "Workflow", updated.id, { name: updated.name });
    res.json(updated);
  }
);

planningRouter.delete(
  "/workflows/:id",
  requireSuperAdmin,
  validate(z.object({ params: z.object({ id: z.string().min(1) }) })),
  async (req, res) => {
    await deleteWorkflow(String(req.params.id));
    await audit(req.user!.id, "planning.workflow.deleted", "Workflow", String(req.params.id));
    res.status(204).end();
  }
);

/* ------------------------------------------------------------------ *
 * Custom fields
 * ------------------------------------------------------------------ */

planningRouter.get("/custom-fields", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  // Inactive fields are admin-only: a retired field still has values on old tickets, and showing
  // it in a normal user's form would invite them to start filling it in again.
  const includeInactive = req.query.all === "true" && req.user!.role === "SUPER_ADMIN";
  res.json(await listCustomFields({ includeInactive }));
});

const customFieldBodySchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  type: z.enum(customFieldTypes),
  description: z.string().max(300).nullish(),
  options: z.array(z.string().min(1).max(120)).max(100).optional(),
  isRequired: z.boolean().optional(),
  appliesTo: z.enum(["TICKET", "PROJECT"]).optional(),
  ticketTypeFilter: z.string().max(60).nullish(),
  showOnRequestForm: z.boolean().optional(),
  order: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional()
});

planningRouter.post(
  "/custom-fields",
  requireSuperAdmin,
  validate(z.object({ body: customFieldBodySchema })),
  async (req, res) => {
    const created = await createCustomField(req.body);
    await audit(req.user!.id, "planning.custom_field.created", "CustomField", created.id, { key: created.key });
    res.status(201).json(created);
  }
);

planningRouter.put(
  "/custom-fields/:id",
  requireSuperAdmin,
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: customFieldBodySchema })),
  async (req, res) => {
    const updated = await updateCustomField(String(req.params.id), req.body);
    await audit(req.user!.id, "planning.custom_field.updated", "CustomField", updated.id, { key: updated.key });
    res.json(updated);
  }
);

planningRouter.delete(
  "/custom-fields/:id",
  requireSuperAdmin,
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const result = await deleteCustomField(String(req.params.id));
    await audit(
      req.user!.id,
      result.deleted ? "planning.custom_field.deleted" : "planning.custom_field.deactivated",
      "CustomField",
      String(req.params.id)
    );
    res.json(result);
  }
);
