/**
 * WHAT: the Workflow Studio's data layer — flows, their steps, the authority they resolve to, and
 * the simulation that shows what one WOULD have done.
 *
 * WHY SIMULATION EXISTS AND WHY IT CALLS NO MODEL: an operator's real question before switching a
 * flow on is "what would this have done to my workspace last week", and the honest way to answer it
 * is to replay real triggers through the deterministic parts — branch conditions, gate positions,
 * the authority calculation — and report, for each capability step, that it WOULD have been called
 * at a stated level. Actually invoking the model would spend money, produce a different answer every
 * run, and still not tell you whether the flow's shape is right. So simulation is exact about
 * structure and explicit about the one thing it does not do.
 *
 * WHY THE STUDIO ADDS NO WRITE PATH: it does not write at all. Composition decides WHAT runs and at
 * WHAT authority; execution goes through `queueAgentRun`, so idempotency, the abort flag, the step
 * cap, the cost cap, the taint clamp and the audit trail are the existing ones. See
 * `flow-authority.service.ts` for the three rules this file enforces on top.
 *
 * WHO CALLS THIS: `controllers/automation-flow.controller.ts`.
 */
import { Prisma, type AutomationStepKind, type AutomationTriggerKind } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { resolveAutonomy } from "./ai-autonomy.service.js";
import { findCapability } from "./ai-capability.registry.js";
import {
  computeFlowAuthority,
  validateFlow,
  type FlowAuthority,
  type FlowStepInput,
  type FlowValidationIssue
} from "./flow-authority.service.js";

const FLOW_INCLUDE = {
  steps: { orderBy: { order: "asc" } },
  agentProfile: { select: { id: true, name: true, emoji: true, enabled: true, capabilities: true } },
  createdBy: { select: { id: true, name: true, email: true } }
} as const;

type FlowRow = Prisma.AutomationFlowGetPayload<{ include: typeof FLOW_INCLUDE }>;

export interface FlowStepPayload {
  kind: AutomationStepKind;
  capability?: string | null;
  config?: Record<string, unknown>;
}

const asStringArray = (value: Prisma.JsonValue | null | undefined): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/**
 * Turns stored steps into the four facts the authority rules need.
 *
 * The RESOLVED level is fetched per capability rather than the registry ceiling, because an
 * authority computed from ceilings would be one the runtime never grants — the roster made the same
 * decision for the same reason.
 */
async function toAuthorityInput(steps: FlowRow["steps"]): Promise<FlowStepInput[]> {
  const out: FlowStepInput[] = [];
  for (const step of steps) {
    if (step.kind !== "CAPABILITY" || !step.capability) {
      out.push({ order: step.order, kind: step.kind, capability: step.capability });
      continue;
    }
    const spec = findCapability(step.capability);
    const resolved = await resolveAutonomy(step.capability);
    out.push({
      order: step.order,
      kind: "CAPABILITY",
      capability: step.capability,
      effectiveLevel: resolved.effectiveLevel,
      actsOnUntrustedInput: Boolean(spec?.actsOnUntrustedInput)
    });
  }
  return out;
}

export interface DecoratedFlow {
  id: string;
  name: string;
  description: string | null;
  emoji: string;
  trigger: AutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  enabled: boolean;
  agentProfile: { id: string; name: string; emoji: string; enabled: boolean } | null;
  steps: Array<{
    id: string;
    order: number;
    kind: AutomationStepKind;
    capability: string | null;
    /** The registry's own words, so a step reads as what it does rather than as an id. */
    title: string | null;
    config: Record<string, unknown>;
  }>;
  authority: FlowAuthority;
  issues: FlowValidationIssue[];
  /** Errors block activation. Computed here so the builder's badge and the activate route agree. */
  activatable: boolean;
  createdBy: { id: string; name: string; email: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function decorateFlow(flow: FlowRow): Promise<DecoratedFlow> {
  const input = await toAuthorityInput(flow.steps);
  const authority = computeFlowAuthority(input);
  const issues = validateFlow({
    steps: input,
    trigger: flow.trigger,
    triggerConfig: (flow.triggerConfig as Record<string, unknown>) ?? {},
    agentCapabilities: flow.agentProfile ? asStringArray(flow.agentProfile.capabilities) : null,
    agentName: flow.agentProfile?.name ?? null,
    agentEnabled: flow.agentProfile?.enabled
  });

  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    emoji: flow.emoji,
    trigger: flow.trigger,
    triggerConfig: (flow.triggerConfig as Record<string, unknown>) ?? {},
    enabled: flow.enabled,
    agentProfile: flow.agentProfile
      ? { id: flow.agentProfile.id, name: flow.agentProfile.name, emoji: flow.agentProfile.emoji, enabled: flow.agentProfile.enabled }
      : null,
    steps: flow.steps.map((s) => ({
      id: s.id,
      order: s.order,
      kind: s.kind,
      capability: s.capability,
      title: s.capability ? (findCapability(s.capability)?.title ?? s.capability) : null,
      config: (s.config as Record<string, unknown>) ?? {}
    })),
    authority,
    issues,
    activatable: issues.every((i) => i.severity !== "error"),
    createdBy: flow.createdBy,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt
  };
}

export async function listFlows(): Promise<DecoratedFlow[]> {
  const flows = await prisma.automationFlow.findMany({
    where: { deletedAt: null },
    include: FLOW_INCLUDE,
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }]
  });
  const out: DecoratedFlow[] = [];
  for (const flow of flows) out.push(await decorateFlow(flow));
  return out;
}

export async function getFlow(id: string): Promise<DecoratedFlow> {
  const flow = await prisma.automationFlow.findFirst({ where: { id, deletedAt: null }, include: FLOW_INCLUDE });
  if (!flow) throw new AppError(404, "Flow not found.");
  return decorateFlow(flow);
}

/** Steps are replaced wholesale: the builder always sends the list in full, and a diff-and-patch of
 *  an ordered list the client already owns is extra failure modes for nothing. `order` is assigned
 *  from array position so a reordered UI cannot produce gaps or collisions. */
async function writeSteps(tx: Prisma.TransactionClient, flowId: string, steps: FlowStepPayload[]) {
  await tx.automationStep.deleteMany({ where: { flowId } });
  if (steps.length === 0) return;
  await tx.automationStep.createMany({
    data: steps.map((s, index) => ({
      flowId,
      order: index + 1,
      kind: s.kind,
      capability: s.kind === "CAPABILITY" ? (s.capability ?? null) : null,
      config: (s.config ?? {}) as Prisma.InputJsonValue
    }))
  });
}

export async function createFlow(params: {
  name: string;
  description?: string | null;
  emoji?: string;
  trigger?: AutomationTriggerKind;
  triggerConfig?: Record<string, unknown>;
  agentProfileId?: string | null;
  steps: FlowStepPayload[];
  createdById: string;
}): Promise<DecoratedFlow> {
  const flow = await prisma.$transaction(async (tx) => {
    const created = await tx.automationFlow.create({
      data: {
        name: params.name,
        description: params.description ?? null,
        emoji: params.emoji ?? "⚙️",
        trigger: params.trigger ?? "MANUAL",
        triggerConfig: (params.triggerConfig ?? {}) as Prisma.InputJsonValue,
        agentProfileId: params.agentProfileId ?? null,
        // Never on at creation, whatever the caller asks — the same rule as the roster. An operator
        // simulates first, reads the authority the flow resolves to, and then activates.
        enabled: false,
        createdById: params.createdById
      }
    });
    await writeSteps(tx, created.id, params.steps);
    return created;
  });
  return getFlow(flow.id);
}

export async function updateFlow(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    emoji?: string;
    trigger?: AutomationTriggerKind;
    triggerConfig?: Record<string, unknown>;
    agentProfileId?: string | null;
    steps?: FlowStepPayload[];
  }
): Promise<DecoratedFlow> {
  const existing = await prisma.automationFlow.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw new AppError(404, "Flow not found.");

  await prisma.$transaction(async (tx) => {
    await tx.automationFlow.update({
      where: { id: existing.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
        ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
        ...(patch.triggerConfig !== undefined ? { triggerConfig: patch.triggerConfig as Prisma.InputJsonValue } : {}),
        ...(patch.agentProfileId !== undefined ? { agentProfileId: patch.agentProfileId } : {})
      }
    });
    if (patch.steps) await writeSteps(tx, existing.id, patch.steps);
  });
  return getFlow(existing.id);
}

/**
 * Activation is the one write that reads the validation first.
 *
 * A flow with errors cannot be switched on — not because the runtime could not cope, but because
 * every error describes a flow that would do something other than what it reads as doing (a gate
 * after every write, a branch that guards nothing, a capability its teammate does not own). Warnings
 * are shown and do not block: "this applies its own changes" is a decision, not a mistake.
 */
export async function setFlowEnabled(id: string, enabled: boolean): Promise<DecoratedFlow> {
  const decorated = await getFlow(id);
  if (enabled && !decorated.activatable) {
    const first = decorated.issues.find((i) => i.severity === "error");
    throw new AppError(422, `This flow cannot be switched on yet: ${first?.message ?? "it has unresolved errors."}`);
  }
  await prisma.automationFlow.update({ where: { id }, data: { enabled } });
  return getFlow(id);
}

export async function retireFlow(id: string): Promise<void> {
  const flow = await prisma.automationFlow.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!flow) throw new AppError(404, "Flow not found.");
  // Soft delete and switched off together: a retired flow must not keep firing, and its steps stay
  // readable for anyone asking what it used to do.
  await prisma.automationFlow.update({ where: { id: flow.id }, data: { deletedAt: new Date(), enabled: false } });
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

export interface SimulatedStep {
  order: number;
  kind: AutomationStepKind;
  capability: string | null;
  title: string | null;
  /** What would happen to this step on this sample. */
  outcome: "would-run" | "would-propose" | "skipped-by-branch" | "waits-for-approval" | "not-reached";
  /** The level it would run at, for a capability step. */
  level: string | null;
  detail: string;
}

export interface SimulationSample {
  /** What the trigger matched — a real row, named so the reader recognises it. */
  subject: string;
  subjectId: string | null;
  steps: SimulatedStep[];
}

export interface SimulationResult {
  /** Stated first and prominently: this is a structural replay, not an execution. */
  disclaimer: string;
  trigger: AutomationTriggerKind;
  /** How many real recent triggers were replayed. Zero is a finding, not an empty state. */
  sampleCount: number;
  /** Present when nothing recent matched, so the UI says why rather than showing an empty list. */
  noSamplesReason: string | null;
  authority: FlowAuthority;
  samples: SimulationSample[];
}

/**
 * Recent real subjects for a trigger, so a replay is against this workspace's own history rather
 * than a fabricated example.
 *
 * Deliberately limited to the trigger kinds whose subject is obvious. A SCHEDULE has no subject at
 * all — it fires on a clock — so it simulates once with the workspace itself as the subject, which
 * is honest rather than pretending to have found rows.
 */
async function collectSamples(flow: DecoratedFlow, limit: number): Promise<{ samples: Array<{ subject: string; subjectId: string | null }>; reason: string | null }> {
  if (flow.trigger === "SCHEDULE") {
    return { samples: [{ subject: "the schedule firing once", subjectId: null }], reason: null };
  }
  if (flow.trigger === "MANUAL") {
    return { samples: [{ subject: "one manual run", subjectId: null }], reason: null };
  }
  if (flow.trigger === "FORM_SUBMISSION") {
    const formId = String(flow.triggerConfig.formId ?? "");
    const rows = await prisma.requestFormSubmission.findMany({
      where: formId ? { formId } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true }
    });
    if (rows.length === 0) return { samples: [], reason: "No submissions to this form yet, so there is nothing to replay." };
    return { samples: rows.map((r) => ({ subject: `submission from ${r.createdAt.toISOString().slice(0, 10)}`, subjectId: r.id })), reason: null };
  }

  // EVENT: the subject is a ticket for every ticket.* event, which is all of them that a flow can
  // usefully act on today.
  const rows = await prisma.ticket.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, key: true, title: true }
  });
  if (rows.length === 0) return { samples: [], reason: "No tickets in this workspace yet, so there is nothing to replay." };
  return { samples: rows.map((t) => ({ subject: `${t.key} — ${t.title}`, subjectId: t.id })), reason: null };
}

/**
 * Replays the flow's STRUCTURE against recent real triggers.
 *
 * What it computes exactly: which steps are reached, where a gate stops the run, and whether each
 * writing step would apply or propose (from the authority rules). What it deliberately does not do:
 * call any model, evaluate a branch's condition against live field values, or write anything. Both
 * halves are stated in the result so a reader is never left guessing which they are looking at.
 */
export async function simulateFlow(id: string, limit = 5): Promise<SimulationResult> {
  const flow = await getFlow(id);
  const { samples, reason } = await collectSamples(flow, limit);

  const simulate = (): SimulatedStep[] => {
    const out: SimulatedStep[] = [];
    let stopped: "gate" | null = null;
    for (const step of flow.steps) {
      const authority = flow.authority.steps.find((s) => s.order === step.order);
      const level = authority?.effectiveLevel ?? null;

      if (stopped === "gate") {
        out.push({ ...base(step), outcome: "not-reached", level, detail: "Waits behind the approval above." });
        continue;
      }
      if (step.kind === "HUMAN_GATE") {
        stopped = "gate";
        out.push({ ...base(step), outcome: "waits-for-approval", level: null, detail: "Everything below waits for a person here." });
        continue;
      }
      if (step.kind === "BRANCH") {
        out.push({
          ...base(step),
          outcome: "would-run",
          level: null,
          // Honest about the limit: a branch's condition is evaluated live, not replayed.
          detail: "Condition is evaluated when the flow runs; this replay assumes it passes."
        });
        continue;
      }
      const proposes = level === "SUGGEST";
      out.push({
        ...base(step),
        outcome: proposes ? "would-propose" : "would-run",
        level,
        detail:
          step.kind === "CAPABILITY"
            ? proposes
              ? "Would write a proposal for somebody to accept, row by row."
              : `Would call it and apply the result at ${level}.`
            : proposes
              ? "Would be included in the proposal rather than applied."
              : "Would apply directly — deterministic, no model."
      });
    }
    return out;
  };

  const base = (step: DecoratedFlow["steps"][number]) => ({
    order: step.order,
    kind: step.kind,
    capability: step.capability,
    title: step.title
  });

  return {
    disclaimer:
      "A structural replay against real recent triggers: which steps are reached, where a person is asked, and whether each change would be applied or proposed. No model is called, nothing is written, and branch conditions are assumed to pass.",
    trigger: flow.trigger,
    sampleCount: samples.length,
    noSamplesReason: reason,
    authority: flow.authority,
    samples: samples.map((s) => ({ subject: s.subject, subjectId: s.subjectId, steps: simulate() }))
  };
}
