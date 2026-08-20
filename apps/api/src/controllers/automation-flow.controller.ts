/**
 * WHAT: the Workflow Studio's routes — flows, their steps, the authority they resolve to, the
 * simulation, and activation.
 *
 * WHY READING NEEDS `tickets:view` AND EVERY WRITE IS SUPER_ADMIN: a flow decides what happens to
 * other people's work without anyone watching. That is the same class of decision as the agent
 * roster, the MCP server and the AI switches — one person's responsibility. Reading is open to
 * anybody who can see tickets, because "what automation touches my work" is a fair question for the
 * person whose work it touches.
 *
 * WHY THE ENTITLEMENT IS `aiPmCopilotEnabled`: a flow composes AI capabilities, which already have a
 * tier gate. A second switch for one commercial decision is a switch somebody forgets. A flow of
 * purely deterministic steps is still gated, deliberately — the Studio is one feature, and a
 * half-available builder is worse than an absent one.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import {
  createFlow,
  getFlow,
  listFlows,
  retireFlow,
  setFlowEnabled,
  simulateFlow,
  updateFlow
} from "../services/automation-flow.service.js";
import { resumeFlowRun, startFlowRun } from "../services/automation-dispatch.service.js";
import { listCapabilityCatalogue } from "../services/agent-profile.service.js";
import { DOMAIN_EVENTS } from "../services/domain-events.js";
import { changeStates } from "@timesheet/shared";
import { isPlanningCapabilityAllowed } from "../services/plan-limits.service.js";

export const automationFlowRouter = Router();
automationFlowRouter.use(requireAuth);

async function assertStudioAllowed() {
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "aiPmCopilotEnabled"))) {
    throw new AppError(403, "The Workflow Studio is part of the AI copilot family, which is not included in this plan. Upgrade to Enterprise to use it.");
  }
}

const stepSchema = z.object({
  kind: z.enum(["ACTION", "CAPABILITY", "HUMAN_GATE", "BRANCH"]),
  capability: z.string().max(60).nullish(),
  config: z.record(z.unknown()).optional()
});

const bodySchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).nullish(),
      emoji: z.string().min(1).max(16).optional(),
      trigger: z.enum(["EVENT", "SCHEDULE", "FORM_SUBMISSION", "MANUAL"]).optional(),
      triggerConfig: z.record(z.unknown()).optional(),
      agentProfileId: z.string().uuid().nullish(),
      // 20 steps is not a technical limit — it is the point past which nobody reviews a flow, and an
      // unreviewable flow with write authority is the thing this whole phase is careful about.
      steps: z.array(stepSchema).max(20)
    })
    .strict()
});

automationFlowRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  await assertStudioAllowed();
  res.json(await listFlows());
});

/** Everything the builder needs to render its pickers, in one call: the capability catalogue with
 *  ceilings, the real domain events, and the deterministic actions. Two round trips for one screen is
 *  two chances to render half of it. */
automationFlowRouter.get("/catalogue", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  await assertStudioAllowed();
  /**
   * Everything the builder's pickers need, resolved server-side.
   *
   * People, labels and projects come from here rather than from three separate calls the builder
   * would have to orchestrate: a dialog that renders before its options arrive is a dialog where
   * somebody picks nothing and wonders why the step will not validate.
   *
   * Agent identities are excluded from the people lists — assigning work to a teammate is a real
   * idea, but "who should approve this gate" and "who should be notified" are questions about a
   * person, and an identity with no mailbox cannot answer either.
   */
  const [people, labels, projects] = await Promise.all([
    prisma.user.findMany({
      where: { status: "ACTIVE", deletedAt: null, isAgent: false },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
      take: 500
    }),
    prisma.label.findMany({ select: { id: true, name: true, color: true }, orderBy: { name: "asc" }, take: 200 }),
    prisma.project.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
      take: 200
    })
  ]);

  res.json({
    capabilities: listCapabilityCatalogue(),
    events: DOMAIN_EVENTS,
    actions: [
      { key: "assign", label: "Assign it to somebody", target: "assigneeId", options: "people" },
      { key: "label", label: "Add a label", target: "labelId", options: "labels" },
      { key: "notify", label: "Notify somebody", target: "notifyUserId", options: "people" },
      // Change-shaped. A run whose subject is an ordinary ticket SKIPS these rather than failing,
      // so a flow that fires on both kinds does not report a failure for the half that cannot apply.
      // Approve and reject are absent on purpose and at every level: an approval is a named person
      // accepting risk, and there is no undo.
      { key: "change_transition", label: "Move a change to a state", target: "toState", options: "changeStates", changeOnly: true },
      { key: "change_comment", label: "Comment on a change", target: "commentBody", freeText: true, changeOnly: true },
      { key: "change_collaborator", label: "Tag somebody on a change", target: "collaboratorId", options: "people", changeOnly: true }
    ],
    /* The states a workflow may move a change to. APPROVED and REJECTED are not on this list, and
       the dispatcher refuses them again even if one arrives — relying on a catalogue the client
       renders from to enforce the module's central rule is how it stops being enforced. */
    changeStates: changeStates.filter((state) => state !== "APPROVED" && state !== "REJECTED"),
    branchFields: [
      { key: "priority", label: "Priority", values: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
      { key: "source", label: "Where it came from", values: ["MANUAL", "EMAIL", "API", "CHAT"] },
      { key: "projectId", label: "Project", options: "projects" },
      { key: "senderDomain", label: "Sender domain", freeText: true }
    ],
    people,
    labels,
    projects
  });
});

/**
 * What the flows have actually DONE. Readable by anybody who can see tickets, for the same reason the
 * flow list is: "what automation touched my work, and what did it do" is a fair question for the person
 * whose work it touched.
 */
automationFlowRouter.get("/runs", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertStudioAllowed();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
  const runs = await prisma.automationFlowRun.findMany({
    where: req.query.flowId ? { flowId: String(req.query.flowId) } : {},
    orderBy: { startedAt: "desc" },
    take: limit,
    include: {
      flow: { select: { id: true, name: true, emoji: true } },
      awaitingUser: { select: { id: true, name: true } },
      steps: { orderBy: { order: "asc" } }
    }
  });
  res.json(runs);
});

/**
 * Approve or decline at a gate.
 *
 * NOT super-admin: the gate named a person, and that person is who may clear it. A gate anybody with
 * an admin role could clear would be a gate in name only — and `resumeFlowRun` enforces the same rule
 * server-side, so this route is not the guarantee, only the door.
 */
const decisionSchema = z.object({ body: z.object({ approved: z.boolean() }).strict() });

automationFlowRouter.post("/runs/:runId/decision", validate(decisionSchema), async (req, res) => {
  await assertStudioAllowed();
  const { approved } = req.body as z.infer<typeof decisionSchema>["body"];
  await resumeFlowRun(String(req.params.runId), req.user!.id, approved);
  res.status(204).end();
});

/** A manual run, which is what the MANUAL trigger means. Super admin, like every other write here. */
automationFlowRouter.post("/:id/run", requireSuperAdmin, async (req, res) => {
  await assertStudioAllowed();
  const id = String(req.params.id);
  // The actor and the minute are both in the key: running one flow twice by hand is two runs, and
  // a double-clicked button is one.
  const stamp = new Date().toISOString().slice(0, 16);
  const result = await startFlowRun({
    flowId: id,
    trigger: "manual",
    subject: { type: "workspace", id: null, label: `a manual run by ${req.user!.name}` },
    triggerKey: `flow:${id}:manual:${req.user!.id}:${stamp}`
  });
  await audit(req.user!.id, "flow.run_started", "AutomationFlow", id, { runId: result.runId, created: result.created });
  res.status(202).json(result);
});

automationFlowRouter.get("/:id", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertStudioAllowed();
  res.json(await getFlow(String(req.params.id)));
});

/** The simulation. A GET on purpose: it writes nothing, so it must be safe to re-run, bookmark and
 *  refresh — and a POST would imply otherwise. */
automationFlowRouter.get("/:id/simulate", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertStudioAllowed();
  const limit = Math.min(10, Math.max(1, Number(req.query.limit ?? 5)));
  res.json(await simulateFlow(String(req.params.id), limit));
});

automationFlowRouter.post("/", requireSuperAdmin, validate(bodySchema), async (req, res) => {
  await assertStudioAllowed();
  const body = req.body as z.infer<typeof bodySchema>["body"];
  const flow = await createFlow({ ...body, createdById: req.user!.id });
  await audit(req.user!.id, "flow.created", "AutomationFlow", flow.id, {
    trigger: flow.trigger,
    steps: flow.steps.map((s) => s.kind),
    authority: flow.authority.effectiveLevel
  });
  res.status(201).json(flow);
});

automationFlowRouter.patch("/:id", requireSuperAdmin, validate(z.object({ body: bodySchema.shape.body.partial().strict() })), async (req, res) => {
  await assertStudioAllowed();
  const flow = await updateFlow(String(req.params.id), req.body);
  await audit(req.user!.id, "flow.updated", "AutomationFlow", flow.id, {
    fields: Object.keys(req.body as object),
    authority: flow.authority.effectiveLevel
  });
  res.json(flow);
});

const enableSchema = z.object({ body: z.object({ enabled: z.boolean() }).strict() });

/**
 * Activation, and the audit row that matters most in this phase.
 *
 * The authority the flow resolved to is recorded WITH the activation, because "what was this allowed
 * to do when somebody switched it on" is the question an incident review asks, and the answer must
 * not depend on what the policies say weeks later.
 */
automationFlowRouter.post("/:id/enabled", requireSuperAdmin, validate(enableSchema), async (req, res) => {
  await assertStudioAllowed();
  const { enabled } = req.body as z.infer<typeof enableSchema>["body"];
  const flow = await setFlowEnabled(String(req.params.id), enabled);
  await audit(req.user!.id, enabled ? "flow.activated" : "flow.deactivated", "AutomationFlow", flow.id, {
    authority: flow.authority.effectiveLevel,
    proposalOnly: flow.authority.proposalOnly,
    gatedBeforeWrites: flow.authority.gatedBeforeWrites,
    tainted: Boolean(flow.authority.taintedFrom)
  });
  res.json(flow);
});

automationFlowRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  await assertStudioAllowed();
  await retireFlow(String(req.params.id));
  await audit(req.user!.id, "flow.retired", "AutomationFlow", String(req.params.id));
  res.status(204).end();
});
