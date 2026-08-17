/**
 * WHAT: the thing that makes a flow actually fire. Everything before this phase composed flows and
 * replayed them; this executes one against a real subject.
 *
 * WHY THE `triggerKey` CARRIES THE SUBJECT ID: `flow:<flowId>:<subject>` rather than `flow:<flowId>`.
 * A doubled domain event, a retried webhook and a restart mid-dispatch must collapse to one run — but
 * so must NOT the second ticket through the same flow, and a key without the subject would make the
 * first ticket the only ticket that flow ever touched. The uniqueness the runtime already provides for
 * `AgentRun` is only worth having if the key means the right thing.
 *
 * WHY EXECUTION STILL GOES THROUGH `queueAgentRun`: the Studio adds no new write path, and that is the
 * whole security argument. A capability step queues an ordinary agent run, so idempotency, the abort
 * flag, the step cap, the per-run and per-day cost ceilings, the taint clamp and the audit trail are
 * the existing ones. What this file adds is the ORDER and the AUTHORITY those runs happen under.
 *
 * WHY A GATE STOPS RATHER THAN BLOCKS: a flow can wait days for an approval, so its position has to
 * survive a restart. That is the whole reason `AutomationFlowRun` is a row and not a log line — the
 * run is resumed from its own record by `resumeFlowRun`, not from anything held in memory.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: apply a change the flow's authority does not permit. A
 * proposal-only flow routes what it can into `AiProposal` — the existing reviewable, stale-checked,
 * undoable path — and records anything the review queue cannot express as `held`, in words, rather
 * than doing it anyway or silently skipping it.
 *
 * WHO CALLS THIS: `registerFlowDispatch()` from `server.ts` (domain events), the schedule worker, and
 * the controller for a manual run or an approval.
 */
import type { AutomationStepKind, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { getFlow, type DecoratedFlow } from "./automation-flow.service.js";
import { createProposal } from "./ai-proposal.service.js";
import { queueAgentRun } from "./agent-run.service.js";
import { DOMAIN_EVENTS, registerDomainSubscriber, type DomainEvent } from "./domain-events.js";
import { dispatchNotification } from "./notify.service.js";

/** What a flow ran against. A flow with no subject (a schedule) is legitimate — it simply cannot
 *  evaluate a condition, which is checked rather than assumed. */
export interface FlowSubject {
  type: "ticket" | "submission" | "workspace";
  id: string | null;
  label: string;
}

interface StepRecord {
  order: number;
  kind: AutomationStepKind;
  outcome: "ran" | "proposed" | "queued" | "waiting" | "skipped" | "not-reached" | "held" | "failed";
  detail: string;
  agentRunId?: string | null;
}

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

/**
 * A branch's condition, against the live subject.
 *
 * The vocabulary is the rules engine's own (see `flow-authority.service.ts`), so the fields here are
 * the fields a `TicketRule` matches on and nothing more. An unknown field or a subject that cannot
 * answer it returns `null` — "could not evaluate", which is a distinct outcome from "did not match"
 * and is reported as such rather than being read as a silent no.
 */
async function evaluateBranch(config: Record<string, unknown>, subject: FlowSubject): Promise<{ passed: boolean; detail: string } | null> {
  const field = typeof config.field === "string" ? config.field : "";
  const op = config.op === "is_not" ? "is_not" : "is";
  const expected = typeof config.value === "string" ? config.value : String(config.value ?? "");

  if (subject.type !== "ticket" || !subject.id) return null;

  const ticket = await prisma.ticket.findUnique({
    where: { id: subject.id },
    select: { priority: true, source: true, projectId: true, externalReporterEmail: true, reporter: { select: { email: true } } }
  });
  if (!ticket) return null;

  let actual: string | null;
  if (field === "priority") actual = ticket.priority;
  else if (field === "source") actual = ticket.source;
  else if (field === "projectId") actual = ticket.projectId;
  // The real sender for an emailed ticket, falling back to the registered reporter — `reporterId`
  // points at the "Email Intake" system user when the sender is a stranger, so reading only that
  // would make every inbound email look like it came from this workspace.
  else if (field === "senderDomain") actual = (ticket.externalReporterEmail ?? ticket.reporter?.email ?? "").split("@")[1] ?? null;
  else return null;

  const matches = (actual ?? "").toLowerCase() === expected.toLowerCase();
  const passed = op === "is" ? matches : !matches;
  return {
    passed,
    detail: `${field} is ${actual ?? "not set"}, and the condition asked for ${op === "is_not" ? "anything but " : ""}${expected}.`
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic actions
 * ------------------------------------------------------------------ */

/**
 * One ACTION step, applied or proposed according to the flow's authority.
 *
 * `notify` always applies, whatever the authority says, because telling a person something is not a
 * change to the workspace — refusing it would mean a proposal-only flow could not even say it had an
 * opinion. `assign` becomes an `AiProposal` when the flow may only propose. `label` cannot: the review
 * queue's change vocabulary has no LABEL target, so rather than apply it anyway or drop it quietly, the
 * step is recorded as `held` and the reason is on the run.
 */
async function performAction(params: {
  config: Record<string, unknown>;
  subject: FlowSubject;
  flow: DecoratedFlow;
  actorId: string;
  order: number;
}): Promise<StepRecord> {
  const { config, subject, flow, order } = params;
  const action = typeof config.action === "string" ? config.action : "";
  const proposalOnly = flow.authority.proposalOnly;
  const base = { order, kind: "ACTION" as AutomationStepKind };

  if (action === "notify") {
    const userId = String(config.notifyUserId ?? "");
    if (!userId) return { ...base, outcome: "failed", detail: "No one was chosen to notify." };
    await dispatchNotification({
      userId,
      category: "workflow.attention",
      title: `${flow.emoji} ${flow.name}`,
      body: `${subject.label} reached step ${order} of this workflow.`,
      link: subject.type === "ticket" && subject.id ? `/app/tickets/${subject.id}` : "/app/studio"
    });
    return { ...base, outcome: "ran", detail: "Notified them." };
  }

  if (subject.type !== "ticket" || !subject.id) {
    return { ...base, outcome: "failed", detail: "This action changes a ticket, and this run has no ticket to change." };
  }

  if (action === "assign") {
    const assigneeId = String(config.assigneeId ?? "");
    const ticket = await prisma.ticket.findUnique({ where: { id: subject.id }, select: { assigneeId: true, key: true, projectId: true } });
    if (!ticket) return { ...base, outcome: "failed", detail: "That ticket no longer exists." };
    if (ticket.assigneeId === assigneeId) return { ...base, outcome: "skipped", detail: "It was already assigned to them." };

    if (proposalOnly) {
      const proposal = await createProposal({
        kind: "ASSIGNMENT_REBALANCE",
        title: `${flow.name}: reassign ${ticket.key}`,
        rationale: `Proposed by the workflow "${flow.name}", which may only propose.`,
        scopeTicketId: subject.id,
        scopeProjectId: ticket.projectId,
        requestedById: params.actorId,
        changes: [
          {
            targetType: "TICKET",
            targetId: subject.id,
            op: "UPDATE",
            // The state it was computed against. Application refuses if the row has moved since —
            // the one guarantee the whole proposal design rests on.
            before: { assigneeId: ticket.assigneeId },
            after: { assigneeId },
            summary: `Assign ${ticket.key} to the person this workflow chose`
          }
        ]
      });
      return { ...base, outcome: "proposed", detail: `Proposed the assignment for review (${proposal.id.slice(0, 8)}).` };
    }

    await prisma.ticket.update({ where: { id: subject.id }, data: { assigneeId } });
    return { ...base, outcome: "ran", detail: "Assigned it." };
  }

  if (action === "label") {
    const labelId = String(config.labelId ?? "");
    if (proposalOnly) {
      return {
        ...base,
        outcome: "held",
        detail:
          "This flow may only propose, and the review queue cannot hold a label change — so nothing was done. Move the step that reads outside text after this one, or raise the flow's authority."
      };
    }
    const already = await prisma.ticketLabel.findFirst({ where: { ticketId: subject.id, labelId }, select: { id: true } });
    if (already) return { ...base, outcome: "skipped", detail: "It already had that label." };
    await prisma.ticketLabel.create({ data: { ticketId: subject.id, labelId } });
    return { ...base, outcome: "ran", detail: "Added the label." };
  }

  return { ...base, outcome: "failed", detail: "This step has no action configured." };
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

/** Who a flow's runs act as: its teammate's identity if it has one, else whoever built it. A flow with
 *  neither cannot run — an action with no actor has nobody to hold responsible for it. */
async function actorFor(flow: DecoratedFlow): Promise<string | null> {
  if (flow.agentProfile) {
    const profile = await prisma.agentProfile.findUnique({ where: { id: flow.agentProfile.id }, select: { identityUserId: true } });
    if (profile?.identityUserId) return profile.identityUserId;
  }
  return flow.createdBy?.id ?? null;
}

async function recordStep(runId: string, step: StepRecord): Promise<void> {
  await prisma.automationFlowRunStep.create({
    data: {
      runId,
      order: step.order,
      kind: step.kind,
      outcome: step.outcome,
      detail: step.detail.slice(0, 500),
      agentRunId: step.agentRunId ?? null
    }
  });
}

/**
 * Walk the flow from `fromOrder` (exclusive) and settle the run.
 *
 * Every branch of this function ends with the run in a terminal state or WAITING — a run left RUNNING
 * is a run nothing will ever pick up, which is the failure the orphan reaper exists to catch for agent
 * runs and which is cheaper to simply not create here.
 */
async function advance(runId: string, flow: DecoratedFlow, subject: FlowSubject, fromOrder: number): Promise<void> {
  const actorId = await actorFor(flow);
  if (!actorId) {
    await settle(runId, "FAILED", "This flow has no teammate and no author left to act as, so it did nothing.");
    return;
  }

  const remaining = flow.steps.filter((s) => s.order > fromOrder);
  const done: StepRecord[] = [];

  for (const step of remaining) {
    if (step.kind === "HUMAN_GATE") {
      const approverId = String(step.config.approverId ?? "");
      await recordStep(runId, { order: step.order, kind: step.kind, outcome: "waiting", detail: "Waiting for approval." });
      for (const later of remaining.filter((s) => s.order > step.order)) {
        await recordStep(runId, { order: later.order, kind: later.kind, outcome: "not-reached", detail: "Behind the approval above." });
      }
      await prisma.automationFlowRun.update({
        where: { id: runId },
        data: { status: "WAITING", awaitingOrder: step.order, awaitingUserId: approverId || null }
      });
      if (approverId) {
        await dispatchNotification({
          userId: approverId,
          category: "workflow.attention",
          title: `${flow.emoji} ${flow.name} needs your approval`,
          body: `${subject.label} is waiting at step ${step.order}. Nothing after it happens until you decide.`,
          link: "/app/studio"
        });
      }
      return;
    }

    if (step.kind === "BRANCH") {
      const verdict = await evaluateBranch(step.config, subject);
      if (!verdict) {
        await recordStep(runId, {
          order: step.order,
          kind: step.kind,
          outcome: "failed",
          detail: "The condition could not be evaluated against what triggered this run."
        });
        await settle(runId, "FAILED", "A condition could not be evaluated, so the flow stopped rather than guessing.");
        return;
      }
      await recordStep(runId, { order: step.order, kind: step.kind, outcome: verdict.passed ? "ran" : "skipped", detail: verdict.detail });
      if (!verdict.passed) {
        for (const later of remaining.filter((s) => s.order > step.order)) {
          await recordStep(runId, { order: later.order, kind: later.kind, outcome: "not-reached", detail: "The condition above did not match." });
        }
        await settle(runId, "STOPPED", `Stopped at step ${step.order}: ${verdict.detail}`);
        return;
      }
      done.push({ order: step.order, kind: step.kind, outcome: "ran", detail: verdict.detail });
      continue;
    }

    if (step.kind === "CAPABILITY" && step.capability) {
      try {
        const queued = await queueAgentRun({
          capability: step.capability,
          trigger: `flow:${flow.id}`,
          // Per RUN and per STEP: two capability steps in one flow are two runs, and re-dispatching
          // the same subject must find them rather than make more.
          triggerKey: `flowrun:${runId}:step:${step.order}`,
          onBehalfOfId: actorId,
          flowId: flow.id
        });
        const record: StepRecord = {
          order: step.order,
          kind: step.kind,
          outcome: "queued",
          detail: queued.created ? "Queued for the agent worker." : "Already queued.",
          agentRunId: queued.runId
        };
        await recordStep(runId, record);
        done.push(record);
      } catch (error) {
        // A refused run is an outcome, not a crash: a daily ceiling reached mid-flow is exactly the
        // guardrail working, and the run should say so rather than disappearing.
        const detail = error instanceof AppError ? error.message : "Could not queue that step.";
        await recordStep(runId, { order: step.order, kind: step.kind, outcome: "failed", detail });
        await settle(runId, "FAILED", detail);
        return;
      }
      continue;
    }

    const result = await performAction({ config: step.config, subject, flow, actorId, order: step.order });
    await recordStep(runId, result);
    done.push(result);
  }

  // A run with a failed step is not "Done". Settling it as COMPLETED would put a green badge on a
  // flow that did not do what it says — the one reading a busy administrator will not check.
  const failed = done.some((s) => s.outcome === "failed");
  await settle(runId, failed ? "FAILED" : "COMPLETED", summarise(done));
}

/** One line for the Inbox and the run list. Counts rather than adjectives — "did some work" is what a
 *  reader cannot check. */
function summarise(steps: StepRecord[]): string {
  const count = (outcome: StepRecord["outcome"]) => steps.filter((s) => s.outcome === outcome).length;
  const parts: string[] = [];
  if (count("ran")) parts.push(`${count("ran")} applied`);
  if (count("queued")) parts.push(`${count("queued")} sent to a teammate`);
  if (count("proposed")) parts.push(`${count("proposed")} proposed for review`);
  if (count("skipped")) parts.push(`${count("skipped")} skipped`);
  if (count("held")) parts.push(`${count("held")} held back`);
  // Counted last so it reads as the exception it is, and never omitted — a summary that hides a
  // failure is worse than no summary.
  if (count("failed")) parts.push(`${count("failed")} could not be done`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}

async function settle(runId: string, status: "COMPLETED" | "STOPPED" | "FAILED", summary: string): Promise<void> {
  await prisma.automationFlowRun.update({
    where: { id: runId },
    data: { status, summary: summary.slice(0, 500), finishedAt: new Date(), awaitingOrder: null, awaitingUserId: null }
  });
  await announceFirstRun(runId);
}

/**
 * The first time a flow fires, whoever owns it hears about it.
 *
 * An automation nobody notices working is an automation nobody trusts — and the first run is the one
 * where an author finds out their flow does something subtly different from what they read. Only the
 * first: a notification per run would be the thing people mute, and muting it costs them the one that
 * mattered.
 */
async function announceFirstRun(runId: string): Promise<void> {
  const run = await prisma.automationFlowRun.findUnique({
    where: { id: runId },
    select: { id: true, flowId: true, summary: true, status: true, subjectLabel: true, flow: { select: { name: true, emoji: true, createdById: true } } }
  });
  if (!run?.flow?.createdById) return;
  const earlier = await prisma.automationFlowRun.count({ where: { flowId: run.flowId, id: { not: runId } } });
  if (earlier > 0) return;

  await dispatchNotification({
    userId: run.flow.createdById,
    category: "workflow.attention",
    title: `${run.flow.emoji} ${run.flow.name} ran for the first time`,
    body: `${run.subjectLabel ?? "It"} — ${run.summary ?? run.status.toLowerCase()}. Check it did what you meant before it runs again.`,
    link: "/app/studio"
  });
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

export async function startFlowRun(params: {
  flowId: string;
  trigger: string;
  subject: FlowSubject;
  /** Distinguishes this occurrence. The subject id belongs in here — see the file header. */
  triggerKey: string;
}): Promise<{ runId: string; created: boolean }> {
  const flow = await getFlow(params.flowId);
  if (!flow.enabled) throw new AppError(409, "That flow is switched off.");
  if (!flow.activatable) throw new AppError(422, "That flow has unresolved errors and cannot run.");

  const existing = await prisma.automationFlowRun.findUnique({ where: { triggerKey: params.triggerKey }, select: { id: true } });
  if (existing) return { runId: existing.id, created: false };

  let run;
  try {
    run = await prisma.automationFlowRun.create({
      data: {
        flowId: flow.id,
        triggerKey: params.triggerKey,
        trigger: params.trigger,
        subjectType: params.subject.type,
        subjectId: params.subject.id,
        subjectLabel: params.subject.label.slice(0, 200)
      }
    });
  } catch {
    // Lost the race on the unique key — two events for the same subject arrived together, which is
    // exactly what that constraint is for.
    const won = await prisma.automationFlowRun.findUnique({ where: { triggerKey: params.triggerKey }, select: { id: true } });
    if (won) return { runId: won.id, created: false };
    throw new AppError(500, "Could not start that flow.");
  }

  await advance(run.id, flow, params.subject, 0);
  return { runId: run.id, created: true };
}

/** Continue a run stopped at a gate. The approver is checked against the one the step named — a gate
 *  anybody may clear is not a gate. */
export async function resumeFlowRun(runId: string, approverId: string, approved: boolean): Promise<void> {
  const run = await prisma.automationFlowRun.findUnique({ where: { id: runId } });
  if (!run) throw new AppError(404, "That run does not exist.");
  if (run.status !== "WAITING") throw new AppError(409, "That run is not waiting for anybody.");
  if (run.awaitingUserId && run.awaitingUserId !== approverId) throw new AppError(403, "Somebody else was asked to approve this.");

  await audit(approverId, approved ? "flow_run.approved" : "flow_run.declined", "AutomationFlowRun", runId, {
    flowId: run.flowId,
    order: run.awaitingOrder
  });

  if (!approved) {
    await settle(runId, "STOPPED", "Declined at the approval step, so nothing after it happened.");
    return;
  }

  // The steps written when the run stopped are replaced: they recorded what had NOT happened yet, and
  // leaving them beside what did happen would make the run read as having done both.
  await prisma.automationFlowRunStep.deleteMany({ where: { runId, order: { gte: run.awaitingOrder ?? 0 } } });
  await recordStep(runId, {
    order: run.awaitingOrder ?? 0,
    kind: "HUMAN_GATE",
    outcome: "ran",
    detail: "Approved."
  });
  await prisma.automationFlowRun.update({ where: { id: runId }, data: { status: "RUNNING", awaitingOrder: null, awaitingUserId: null } });

  const flow = await getFlow(run.flowId);
  await advance(runId, flow, { type: (run.subjectType as FlowSubject["type"]) ?? "workspace", id: run.subjectId, label: run.subjectLabel ?? "this run" }, run.awaitingOrder ?? 0);
}

/** The subject a domain event is about, in the words a person would use for it. */
function subjectOf(payload: Record<string, unknown>): FlowSubject {
  const ticket = payload.ticket as { id?: string; key?: string; title?: string } | undefined;
  if (ticket?.id) return { type: "ticket", id: ticket.id, label: `${ticket.key ?? "a ticket"} — ${ticket.title ?? ""}`.trim() };
  return { type: "workspace", id: null, label: "this workspace" };
}

/**
 * Wire the Studio to the event bus.
 *
 * Registered once at boot, for every event in the internal vocabulary — the filtering is by what flows
 * exist, not by what this file was compiled knowing about, so a flow listening for a newly-emitted
 * event works without a code change here.
 */
export function registerFlowDispatch(): void {
  registerDomainSubscriber({
    name: "automation-flows",
    events: DOMAIN_EVENTS as readonly DomainEvent[],
    handle: async (event, payload) => {
      const flows = await prisma.automationFlow.findMany({
        where: { enabled: true, deletedAt: null, trigger: "EVENT" },
        select: { id: true, triggerConfig: true }
      });
      const matching = flows.filter((f) => (f.triggerConfig as Prisma.JsonObject)?.event === event);
      if (matching.length === 0) return;

      const subject = subjectOf(payload);
      for (const flow of matching) {
        try {
          await startFlowRun({
            flowId: flow.id,
            trigger: `event:${event}`,
            subject,
            triggerKey: `flow:${flow.id}:${subject.type}:${subject.id ?? event}`
          });
        } catch (error) {
          // One misconfigured flow must not stop the others, and none of this may reach the emitter —
          // the same contract every other domain subscriber works under.
          console.warn(`[flow-dispatch] flow ${flow.id} failed on ${event}:`, (error as Error).message);
        }
      }
    }
  });
}
