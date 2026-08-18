/**
 * WHAT: the three rules that make a no-code composition surface safe, as pure functions.
 *
 * WHY PURE, AND WHY IN THEIR OWN FILE: this is the entire security argument for the Workflow Studio.
 * Every interesting failure here is arithmetic over levels that renders plausibly and is wrong — the
 * same reason `plan-schedule.service.ts` is a pure core with a thin DB shell. Nothing in this file
 * touches Prisma, so all of it can be checked exhaustively without fixtures, and a reviewer can read
 * the whole guarantee in one screen.
 *
 * THE THREE RULES (docs/AGENTIC_WORK_MANAGEMENT.md §5 phase 4):
 *
 *   1. A flow's authority is the MINIMUM of its capability steps'. Composing two AUTO_APPLY steps
 *      must never produce authority neither step had. This is the rule a builder most easily loses:
 *      it is tempting to let the flow declare its own level, and that immediately becomes a way to
 *      promote a SUGGEST-only capability by putting it in the right company.
 *
 *   2. Taint propagates FORWARD. The moment any step reads externally-authored text, every later
 *      writing step is clamped to SUGGEST. This generalises `AgentRun.taintedAt` — which does the
 *      same to a single run — to a composition, and it is why the ORDER of steps changes what a flow
 *      may do: a triage step that reads inbound email before a step that assigns work makes the
 *      assignment a proposal, whereas the reverse order does not.
 *
 *   3. Anything above SUGGEST writes through `AiProposal`. The Studio adds no new write path, so a
 *      flow's changes are per-row reviewable, stale-state-checked and undoable exactly like every
 *      other AI write in this product.
 *
 * WHO CALLS THIS: `automation-flow.service.ts` (validation, activation, simulation) and the
 * controller, which returns the computed authority so the builder shows the same number the server
 * will enforce.
 */
import type { AiAutonomyLevel } from "@prisma/client";

/** Order matters: index IS the rank, so `min` is an array-index comparison and cannot disagree with
 *  `ai-autonomy.service.ts`'s own ladder. */
const LADDER: AiAutonomyLevel[] = ["SUGGEST", "AUTO_APPLY", "AUTONOMOUS"];

const rank = (level: AiAutonomyLevel): number => Math.max(0, LADDER.indexOf(level));

export const FLOOR: AiAutonomyLevel = "SUGGEST";

export type FlowStepKind = "ACTION" | "CAPABILITY" | "HUMAN_GATE" | "BRANCH";

/** The minimum a caller must tell this module about a step. Deliberately not the Prisma row: the
 *  authority rules depend on four facts, and taking the row would let a change in the schema quietly
 *  change the security calculation. */
export interface FlowStepInput {
  order: number;
  kind: FlowStepKind;
  /** Registry id, for CAPABILITY steps. */
  capability?: string | null;
  /** The capability's RESOLVED effective level, as `resolveAutonomy` returns it. Required for
   *  CAPABILITY steps — passing the registry ceiling here instead would compute an authority the
   *  runtime never grants. */
  effectiveLevel?: AiAutonomyLevel | null;
  /** Whether this capability reads text authored outside the workspace. */
  actsOnUntrustedInput?: boolean;
  /** Whether an agent RUN can execute it at all. Most capabilities in the registry are invoked inline
   *  by the feature that owns them and have no tools for a run loop to use — a flow step naming one
   *  validates, activates, dispatches, and then fails with "no runner is implemented". Passed in
   *  rather than looked up, because this module stays pure. */
  agentRunnable?: boolean;
  /** Whether this step WRITES anything (an ACTION always does; a capability does when its level is
   *  above SUGGEST; a BRANCH and a HUMAN_GATE never do). */
  writes?: boolean;
  /** Kind-specific settings — what the step actually DOES, as opposed to what kind it is. Validated
   *  by `validateStepConfig` below; ignored by the authority arithmetic, which depends only on the
   *  four facts above. */
  config?: Record<string, unknown>;
}

/**
 * The condition vocabulary a BRANCH may use.
 *
 * DELIBERATELY THE RULES ENGINE'S OWN (`TicketRule`'s condition columns) rather than a new expression
 * language. A second grammar is a second thing to secure, a second thing to explain, and a second
 * place for "what does this actually match" to be answered differently.
 */
export const BRANCH_FIELDS = ["priority", "source", "projectId", "senderDomain"] as const;
export const BRANCH_OPERATORS = ["is", "is_not"] as const;
export const ACTION_KINDS = ["assign", "label", "notify"] as const;

/** Which config key each action kind requires. An action with no target is a step that runs and does
 *  nothing, which is worse than an error because it looks like it worked. */
const ACTION_TARGET: Record<(typeof ACTION_KINDS)[number], string> = {
  assign: "assigneeId",
  label: "labelId",
  notify: "notifyUserId"
};

/** Safe for a value that arrived as JSON: `String({})` is "[object Object]", which then fails a
 *  membership check with a confusing message instead of a clear one. */
const asText = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

function validateActionConfig(step: FlowStepInput, config: Record<string, unknown>): FlowValidationIssue[] {
  const action = asText(config.action);
  if (!ACTION_KINDS.includes(action as (typeof ACTION_KINDS)[number])) {
    return [{ severity: "error", order: step.order, message: "Choose what this action should do." }];
  }
  const targetKey = ACTION_TARGET[action as (typeof ACTION_KINDS)[number]];
  if (config[targetKey]) return [];

  const missing: Record<string, string> = {
    assign: "Choose who this step assigns to.",
    label: "Choose which label this step adds.",
    notify: "Choose who this step notifies."
  };
  return [{ severity: "error", order: step.order, message: missing[action] }];
}

function validateBranchConfig(step: FlowStepInput, config: Record<string, unknown>): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  if (!BRANCH_FIELDS.includes(asText(config.field) as (typeof BRANCH_FIELDS)[number])) {
    issues.push({ severity: "error", order: step.order, message: "Choose what this condition looks at." });
  }
  if (!BRANCH_OPERATORS.includes(asText(config.op) as (typeof BRANCH_OPERATORS)[number])) {
    issues.push({ severity: "error", order: step.order, message: "Choose whether the condition matches or excludes." });
  }
  if (asText(config.value).length === 0) {
    issues.push({ severity: "error", order: step.order, message: "Give the condition a value to compare against." });
  }
  return issues;
}

/**
 * Per-step settings, checked separately from the authority rules because they fail differently: an
 * unconfigured step is not dangerous, it is inert — and an inert step inside a flow somebody activated
 * is a silent no-op, which is the failure mode that wastes an afternoon.
 */
export function validateStepConfig(step: FlowStepInput): FlowValidationIssue[] {
  const config = step.config ?? {};
  if (step.kind === "ACTION") return validateActionConfig(step, config);
  if (step.kind === "BRANCH") return validateBranchConfig(step, config);
  if (step.kind === "HUMAN_GATE" && !config.approverId) {
    // A gate with nobody named is a gate nobody is asked, and a flow that waits forever reads as
    // broken rather than as blocked.
    return [{ severity: "error", order: step.order, message: "Choose who is asked to approve at this gate." }];
  }
  return [];
}

export interface StepAuthority {
  order: number;
  kind: FlowStepKind;
  capability: string | null;
  /** What this step alone would be allowed. */
  ownLevel: AiAutonomyLevel;
  /** What it gets inside THIS flow, after the minimum and the taint clamp. */
  effectiveLevel: AiAutonomyLevel;
  /** Populated when the two differ, naming which rule did it — the builder shows this verbatim
   *  rather than a generic "restricted", because the two causes need different fixes: a minimum is
   *  fixed by removing a step, a taint clamp by reordering. */
  clampedReason: string | null;
  /** True once a preceding step has read untrusted input. */
  taintedByEarlierStep: boolean;
}

export interface FlowAuthority {
  /** The flow's ceiling: the minimum across capability steps, then the taint clamp. */
  effectiveLevel: AiAutonomyLevel;
  /** Which step, if any, set the minimum. Named so a builder can point at it. */
  limitedBy: { order: number; capability: string; level: AiAutonomyLevel } | null;
  /** The first step that introduced untrusted text, if any. */
  taintedFrom: { order: number; capability: string } | null;
  /** True when the flow may only propose. The Studio's single most important output: it decides
   *  whether writes go through `AiProposal` or land directly. */
  proposalOnly: boolean;
  /** True when a HUMAN_GATE sits before every writing step, which makes a flow safe whatever its
   *  steps could otherwise do. Surfaced because it is the cheapest way for an author to make an
   *  ambitious flow acceptable. */
  gatedBeforeWrites: boolean;
  steps: StepAuthority[];
}

/** A capability step writes when it may apply; below that it only proposes. An ACTION always writes
 *  (that is what it is). BRANCH and HUMAN_GATE never do. */
function stepWrites(step: FlowStepInput, own: AiAutonomyLevel): boolean {
  if (step.writes !== undefined) return step.writes;
  if (step.kind === "ACTION") return true;
  if (step.kind === "CAPABILITY") return rank(own) > rank("SUGGEST");
  return false;
}

/**
 * The whole calculation, in one pass over the steps in ORDER.
 *
 * Order is load-bearing (rule 2), so this deliberately sorts rather than trusting the caller: a
 * builder that reordered rows in the UI without renumbering them would otherwise compute an
 * authority for a flow nobody can see.
 */
export function computeFlowAuthority(stepsInput: FlowStepInput[]): FlowAuthority {
  const steps = [...stepsInput].sort((a, b) => a.order - b.order);

  // Rule 1: the minimum across capability steps. A flow with no capability steps is purely
  // deterministic — the rules engine has always applied those directly — so it is not clamped by a
  // minimum that does not exist.
  let floorLevel: AiAutonomyLevel = "AUTONOMOUS";
  let limitedBy: FlowAuthority["limitedBy"] = null;
  for (const step of steps) {
    if (step.kind !== "CAPABILITY") continue;
    const own = step.effectiveLevel ?? FLOOR;
    if (rank(own) < rank(floorLevel)) {
      floorLevel = own;
      limitedBy = { order: step.order, capability: step.capability ?? "unknown", level: own };
    }
  }
  const hasCapability = steps.some((s) => s.kind === "CAPABILITY");
  if (!hasCapability) floorLevel = "AUTONOMOUS";

  // Rule 2: taint, walked forward.
  let taintedFrom: FlowAuthority["taintedFrom"] = null;
  /** Whether any step that WRITES was clamped by an earlier step's taint. This — not the mere
   *  presence of untrusted input — is what makes a flow proposal-only.
   *
   *  The distinction matters and was found by a test: a flow whose ONLY step is `triage` reads
   *  inbound email and is therefore "tainted", but that step is the SOURCE, not a victim, and the
   *  existing runtime already lets that single capability apply at AUTO_APPLY. Clamping the flow
   *  because of it would have made composing one step stricter than running it alone — a regression
   *  dressed as caution, and the kind that quietly teaches people the Studio is worse than the thing
   *  it replaces. Rule 2 says "every LATER WRITING step", and this is that word doing its work. */
  let taintedWrite = false;
  const decorated: StepAuthority[] = [];
  for (const step of steps) {
    const own = step.kind === "CAPABILITY" ? (step.effectiveLevel ?? FLOOR) : "AUTONOMOUS";
    const taintedByEarlierStep = taintedFrom !== null;

    // The flow's ceiling applies to every step; taint additionally drops a WRITING step to the floor.
    let effective: AiAutonomyLevel = rank(own) < rank(floorLevel) ? own : floorLevel;
    const reasons: string[] = [];
    if (limitedBy && step.kind === "CAPABILITY" && rank(effective) < rank(own)) {
      reasons.push(`limited to ${floorLevel} by step ${limitedBy.order} (${limitedBy.capability})`);
    }
    if (taintedByEarlierStep && stepWrites(step, own)) {
      taintedWrite = true;
    }
    if (taintedByEarlierStep && stepWrites(step, own) && rank(effective) > rank(FLOOR)) {
      effective = FLOOR;
      reasons.push(`clamped to ${FLOOR} because step ${taintedFrom!.order} (${taintedFrom!.capability}) reads text from outside the workspace`);
    }

    decorated.push({
      order: step.order,
      kind: step.kind,
      capability: step.capability ?? null,
      ownLevel: own,
      effectiveLevel: effective,
      clampedReason: reasons.length > 0 ? reasons.join("; ") : null,
      taintedByEarlierStep
    });

    // Set AFTER this step is decorated: a step that reads untrusted input is not itself clamped by
    // its own reading — it is the SOURCE. Everything after it is what changes.
    if (step.kind === "CAPABILITY" && step.actsOnUntrustedInput && taintedFrom === null) {
      taintedFrom = { order: step.order, capability: step.capability ?? "unknown" };
    }
  }

  const flowLevel: AiAutonomyLevel = taintedWrite ? FLOOR : floorLevel;

  // Is every writing step behind a gate? Walked in order: a gate only protects what follows it.
  let seenGate = false;
  let unguardedWrite = false;
  for (const step of steps) {
    if (step.kind === "HUMAN_GATE") {
      seenGate = true;
      continue;
    }
    const own = step.kind === "CAPABILITY" ? (step.effectiveLevel ?? FLOOR) : "AUTONOMOUS";
    if (stepWrites(step, own) && !seenGate) unguardedWrite = true;
  }
  const hasWrite = steps.some((s) => stepWrites(s, s.effectiveLevel ?? FLOOR));

  return {
    effectiveLevel: flowLevel,
    limitedBy,
    taintedFrom,
    // Rule 3: at the floor, the flow may only propose — and a proposal is the existing reviewable,
    // stale-checked, undoable write path, not a new one.
    proposalOnly: rank(flowLevel) <= rank(FLOOR),
    gatedBeforeWrites: hasWrite ? !unguardedWrite : true,
    steps: decorated
  };
}

export interface FlowValidationIssue {
  /** `error` blocks activation; `warning` is shown and does not. */
  severity: "error" | "warning";
  message: string;
  order?: number;
}

/**
 * Everything that makes a flow un-activatable, in one place so the builder and the activate route
 * cannot disagree about what "valid" means.
 *
 * Ordering rules are errors rather than warnings because each describes a flow that would do
 * something other than what it reads as doing — a gate after every write protects nothing, and a
 * branch at the end can never skip anything.
 */
export function validateFlow(params: {
  steps: FlowStepInput[];
  trigger: string;
  triggerConfig: Record<string, unknown>;
  /** Capability ids the flow's agent profile owns, when a profile is attached. */
  agentCapabilities?: string[] | null;
  agentName?: string | null;
  agentEnabled?: boolean;
}): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const steps = [...params.steps].sort((a, b) => a.order - b.order);

  if (steps.length === 0) issues.push({ severity: "error", message: "A flow needs at least one step." });

  if (params.trigger === "EVENT" && !params.triggerConfig.event) {
    issues.push({ severity: "error", message: "An event trigger needs an event to listen for." });
  }
  if (params.trigger === "SCHEDULE" && !params.triggerConfig.cron) {
    issues.push({ severity: "error", message: "A scheduled trigger needs a cron expression." });
  }
  if (params.trigger === "FORM_SUBMISSION" && !params.triggerConfig.formId) {
    issues.push({ severity: "error", message: "A form trigger needs a form to listen to." });
  }

  const lastIndex = steps.length - 1;
  steps.forEach((step, index) => {
    if (step.kind === "CAPABILITY" && !step.capability) {
      issues.push({ severity: "error", order: step.order, message: "A capability step needs a capability." });
    }
    // An error, not a warning: the flow would activate, fire, and fail — which reads as the product
    // being broken rather than as the step being impossible. Refusing at build time is the only place
    // the author is still holding the thing they need to change.
    if (step.kind === "CAPABILITY" && step.capability && step.agentRunnable === false) {
      issues.push({
        severity: "error",
        order: step.order,
        message: `"${step.capability}" is used by the feature that owns it and cannot be run on its own by a workflow. Pick one of the capabilities marked as runnable.`
      });
    }
    // What the step DOES, as opposed to what kind it is. Checked here so the builder's badge, the
    // activate route and this list cannot disagree about whether a flow is finished.
    issues.push(...validateStepConfig(step));
    if (step.kind === "BRANCH" && index === lastIndex) {
      issues.push({
        severity: "error",
        order: step.order,
        message: "A branch is the last step, so it can never skip anything. Move it above the steps it should guard."
      });
    }
    if (step.kind === "HUMAN_GATE" && index === lastIndex) {
      issues.push({
        severity: "error",
        order: step.order,
        message: "A gate is the last step, so there is nothing left for anyone to approve."
      });
    }
  });

  // A flow bound to a teammate may only use capabilities that teammate owns — otherwise the Studio
  // becomes a way around "one capability, one owner", which is the whole point of that rule.
  if (params.agentCapabilities) {
    const owned = new Set(params.agentCapabilities);
    for (const step of steps) {
      if (step.kind !== "CAPABILITY" || !step.capability) continue;
      if (!owned.has(step.capability)) {
        issues.push({
          severity: "error",
          order: step.order,
          message: `${params.agentName ?? "The chosen teammate"} does not have "${step.capability}". Add it to that teammate, or pick a different one.`
        });
      }
    }
    if (params.agentEnabled === false) {
      issues.push({
        severity: "warning",
        message: `${params.agentName ?? "The chosen teammate"} is switched off, so this flow will not run until it is switched on.`
      });
    }
  }

  /**
   * A ticket action in a flow that has no ticket.
   *
   * A MANUAL or SCHEDULE flow fires on a person or a clock, so nothing it runs against is a ticket —
   * and "assign it" then has nothing to assign. A warning rather than an error because the flow is
   * otherwise coherent and its other steps still do their work; it is here at all because the failure
   * is invisible until the run report says the step could not be done.
   */
  const subjectless = params.trigger === "MANUAL" || params.trigger === "SCHEDULE";
  const ticketActions = steps.filter((s) => s.kind === "ACTION" && ["assign", "label"].includes(asText(s.config?.action)));
  if (subjectless && ticketActions.length > 0) {
    issues.push({
      severity: "warning",
      order: ticketActions[0].order,
      message:
        params.trigger === "MANUAL"
          ? "This flow runs by hand, so there is no ticket for it to change. Steps that assign or label will report that they could not run."
          : "A scheduled flow fires on a clock, so there is no ticket for it to change. Steps that assign or label will report that they could not run."
    });
  }

  const authority = computeFlowAuthority(steps);
  if (authority.taintedFrom) {
    issues.push({
      severity: "warning",
      order: authority.taintedFrom.order,
      message: `Step ${authority.taintedFrom.order} reads text from outside the workspace, so every later change this flow makes becomes a proposal for somebody to accept.`
    });
  }
  if (!authority.proposalOnly && !authority.gatedBeforeWrites) {
    issues.push({
      severity: "warning",
      message: "This flow applies its own changes with no human gate in front of them. Every change is still individually undoable."
    });
  }

  return issues;
}
