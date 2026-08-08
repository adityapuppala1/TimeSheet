/**
 * WHAT: the envelope one AI capability executes inside — bounded, abortable, auditable, and acting
 * as a named person.
 *
 * WHY AN ENVELOPE BEFORE A LOOP: the hard part of an agent is not the loop, it is everything the
 * loop is allowed to do while nobody is watching. This file is that: a durable record of the run,
 * a step and cost ceiling, an abort that survives a restart, the taint clamp, and a single door to
 * the tools. A model-driven multi-step loop plugs into `execute` once `callChat` grows tool-use
 * support; until then the same envelope runs the deterministic capabilities, which is genuinely
 * useful on its own — a scheduled rebalance is an agent doing work unattended.
 *
 * THREE RULES THIS FILE ENFORCES, EACH BORROWED RATHER THAN INVENTED:
 *
 *   1. IT ACTS AS A PERSON. `onBehalfOfId` is required and every permission check runs as them,
 *      for exactly the reason `McpCredential.userId` is required.
 *   2. IT CANNOT BE ESCALATED MID-FLIGHT. The level is copied when the run is queued, so editing
 *      the policy underneath a running agent cannot widen what it may do.
 *   3. STRANGER-AUTHORED TEXT BUYS LESS AUTHORITY. Once a tool carrying outside content returns,
 *      the run is tainted and clamped to SUGGEST for the rest of its life — the generalisation of
 *      the confidence ceiling the email and chat intakes already apply.
 *
 * WHO RUNS THIS: `workers/agent-run.worker.ts`, never a request. A run is N pieces of work; doing
 * that in a request would hold the connection open and leave a half-run with no owner if the client
 * navigated away — the same argument `ai-eval.worker.ts` makes for evals.
 */
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { findCapability, levelRank } from "./ai-capability.registry.js";
import { resolveAutonomy } from "./ai-autonomy.service.js";
import { loadRequestUser } from "./principal.service.js";
import { getGlobalAISettings } from "./ai.service.js";
import { invokeMcpTool, MCP_TOOLS, type McpEnablementSettings, type McpToolContext } from "./mcp-tools.js";
import { proposeAssignmentRebalance } from "./ai-rebalance.service.js";
import { emitDomainEvent } from "./domain-events.js";

/** Steps a run may take before it is stopped and called PARTIAL. */
const DEFAULT_MAX_STEPS = 12;

export interface QueueRunParams {
  capability: string;
  /** "manual" | "cron" | "event:<name>" */
  trigger: string;
  /** Stable per logical occurrence — a doubled tick must produce the same key, not a new one. */
  triggerKey: string;
  onBehalfOfId: string;
  scopeProjectId?: string | null;
  goal?: string | null;
}

/**
 * Put a run on the queue, or return the one already there.
 *
 * There is no separate queue table: the `AgentRun` row IS the queue entry, which is why
 * `triggerKey` is unique. A doubled cron tick, a retried webhook and a restart mid-tick all
 * collapse to one row because the database refuses the second insert — and it survives a restart,
 * which an in-memory guard could not.
 *
 * Returns the existing run rather than throwing on a duplicate: for a caller, "this is already
 * queued" is success, not an error.
 */
export async function queueAgentRun(params: QueueRunParams): Promise<{ runId: string; created: boolean }> {
  const spec = findCapability(params.capability);
  if (!spec) throw new AppError(404, `Unknown AI capability "${params.capability}".`);

  const actor = await loadRequestUser(params.onBehalfOfId);
  if (!actor) throw new AppError(422, "An agent run must act as an active person in this workspace.");

  const autonomy = await resolveAutonomy(params.capability);

  const existing = await prisma.agentRun.findUnique({ where: { triggerKey: params.triggerKey }, select: { id: true } });
  if (existing) return { runId: existing.id, created: false };

  try {
    const run = await prisma.agentRun.create({
      data: {
        capability: params.capability,
        trigger: params.trigger,
        triggerKey: params.triggerKey,
        onBehalfOfId: params.onBehalfOfId,
        // Copied, not looked up later — see rule 2 in this file's header.
        level: autonomy.effectiveLevel,
        maxSteps: DEFAULT_MAX_STEPS,
        maxCostUsd: autonomy.guardrails.maxCostUsdPerRun,
        scopeProjectId: params.scopeProjectId ?? null,
        goal: params.goal ?? null
      }
    });
    return { runId: run.id, created: true };
  } catch {
    // Lost the race on the unique key — somebody else queued the same logical run microseconds
    // ago, which is exactly what the constraint is for.
    const won = await prisma.agentRun.findUnique({ where: { triggerKey: params.triggerKey }, select: { id: true } });
    if (won) return { runId: won.id, created: false };
    throw new AppError(500, "Could not queue that run.");
  }
}

/** Ask a run to stop. Polled between steps, so an in-flight piece of work finishes and the next
 *  one is never started. Deliberately a database write rather than an in-process signal: a run may
 *  be executing in a different tick, or a different process after a restart. */
export async function requestAbort(runId: string, actorId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true, status: true } });
  if (!run) throw new AppError(404, "Run not found");
  if (run.status !== "QUEUED" && run.status !== "RUNNING") throw new AppError(409, "That run has already finished.");

  await prisma.agentRun.update({ where: { id: runId }, data: { abortRequestedAt: new Date(), abortedById: actorId } });
  await audit(actorId, "agent_run.abort_requested", "AgentRun", runId, {}, { actorType: "USER", agentRunId: runId });
}

/** Whether this run has been asked to stop. Read fresh every step — the flag may arrive mid-run. */
async function abortRequested(runId: string): Promise<boolean> {
  const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { abortRequestedAt: true } });
  return Boolean(row?.abortRequestedAt);
}

/**
 * The tool surface this run may reach, expressed as MCP enablement.
 *
 * IT DOES NOT READ `GlobalMcpSettings`. That is the switch for EXTERNAL clients — turning off the
 * MCP server so Claude Desktop cannot connect must not also stop internal agents, and turning it on
 * must not silently grant them write tools. So the run builds its own value of the same structural
 * interface, which is why `McpEnablementSettings` being an interface rather than the Prisma row
 * type matters: this costs nothing and changes nothing in `mcp-tools.ts`.
 */
function enablementFor(capability: string, effectiveLevel: string, tainted: boolean): McpEnablementSettings {
  const spec = findCapability(capability);
  const allowed = new Set(spec?.tools ?? []);
  return {
    enabled: true,
    // A tainted run may not write, whatever its level says. This is the clamp doing its work.
    allowWrites: !tainted && levelRank(effectiveLevel as never) >= levelRank("AUTO_APPLY"),
    toolOverrides: Object.fromEntries(MCP_TOOLS.map((t) => [t.name, allowed.has(t.name)]))
  };
}

/** Record one step. Content obeys the workspace's AI capture setting, for the reason in the
 *  schema comment — an agent trace is prompt content by another name. */
async function recordStep(
  runId: string,
  index: number,
  step: { kind: string; toolName?: string; args?: unknown; result?: string; error?: string }
): Promise<void> {
  const settings = await getGlobalAISettings();
  const keepContent = Boolean(settings.aiCaptureEnabled && settings.aiCaptureContentEnabled);
  await prisma.agentRunStep.create({
    data: {
      runId,
      index,
      kind: step.kind,
      toolName: step.toolName ?? null,
      argsJson: keepContent && step.args !== undefined ? (step.args as never) : undefined,
      resultText: keepContent && step.result ? step.result.slice(0, 8_000) : null,
      error: step.error?.slice(0, 500) ?? null
    }
  });
}

/**
 * Call a tool as this run, applying the taint clamp to whatever comes back.
 *
 * Exported because the loop that will eventually drive a model needs exactly this, and it must not
 * be able to reach `invokeMcpTool` any other way — the taint bit is only honest if every result
 * passes through the thing that sets it.
 */
export async function callToolForRun(
  runId: string,
  ctx: McpToolContext,
  capability: string,
  level: string,
  toolName: string,
  args: unknown,
  stepIndex: number
): Promise<unknown> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { taintedAt: true } });
  const enablement = enablementFor(capability, level, Boolean(run?.taintedAt));

  const result = await invokeMcpTool(ctx, toolName, args, enablement);

  const spec = MCP_TOOLS.find((t) => t.name === toolName);
  if (spec?.untrustedContent && !run?.taintedAt) {
    // From here on this run's context holds text written outside the workspace. Clamp it, once,
    // and record why — an operator reading the trace should see the moment authority narrowed.
    await prisma.agentRun.update({ where: { id: runId }, data: { taintedAt: new Date() } });
    await recordStep(runId, stepIndex, {
      kind: "note",
      toolName,
      result: `Read content authored outside this workspace, so this run can no longer apply anything.`
    });
  }
  return result;
}

/**
 * Run one queued agent run to completion.
 *
 * Called by the worker, one at a time per workspace. Never throws for an ordinary failure — a run
 * that dies must land in a terminal state, or the worker would pick it up again every minute and
 * spend money on the same failure forever, which is the mistake `processNextEvalRun`'s comment
 * already warns about.
 */
export async function executeAgentRun(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "QUEUED") return;

  const actor = await loadRequestUser(run.onBehalfOfId);
  if (!actor) {
    await finish(runId, "FAILED", "The person this run acts as is no longer active.");
    return;
  }

  await prisma.agentRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } });

  const ctx: McpToolContext = {
    user: actor,
    req: { user: actor },
    caller: { kind: "AGENT_RUN", id: runId }
  };
  void ctx; // handed to callToolForRun by capabilities that use tools

  try {
    if (await abortRequested(runId)) {
      await finish(runId, "ABORTED", null);
      return;
    }

    // The capability's own work. Deterministic capabilities do their arithmetic and emit a
    // proposal; a model-driven one will step through callToolForRun under the same bounds.
    if (run.capability === "assignment_rebalance") {
      if (!run.scopeProjectId) {
        await finish(runId, "FAILED", "A rebalance run needs a project.");
        return;
      }
      const from = new Date();
      const to = new Date(from.getTime() + 28 * 24 * 3_600_000);
      const outcome = await proposeAssignmentRebalance({
        projectId: run.scopeProjectId,
        from,
        to,
        requestedById: run.onBehalfOfId
      });

      await recordStep(runId, 0, { kind: "proposal", result: outcome.reason ?? `${outcome.moves} move(s) proposed` });
      await prisma.agentRun.update({ where: { id: runId }, data: { proposalId: outcome.proposalId, stepCount: 1 } });

      // BLOCKED rather than FAILED when a guardrail held it back: the run did its work and
      // produced something a person now has to look at. That is degradation, not an error.
      await finish(runId, outcome.reason && !outcome.proposalId ? "COMPLETED" : outcome.proposalId ? "COMPLETED" : "BLOCKED", null);
      return;
    }

    await finish(runId, "FAILED", `No runner is implemented for "${run.capability}".`);
  } catch (error) {
    await finish(runId, "FAILED", (error as Error).message);
  }
}

async function finish(runId: string, status: string, error: string | null): Promise<void> {
  const run = await prisma.agentRun.update({
    where: { id: runId },
    data: { status, error: error?.slice(0, 500) ?? null, finishedAt: new Date() },
    select: { id: true, capability: true, status: true, onBehalfOfId: true, proposalId: true }
  });

  await audit(run.onBehalfOfId, "agent_run.finished", "AgentRun", runId, { capability: run.capability, status }, {
    actorType: "AGENT",
    actorLabel: `agent:${run.capability}`,
    agentRunId: runId
  });

  emitDomainEvent(status === "BLOCKED" ? "agent.run_blocked" : "agent.run_finished", {
    runId,
    capability: run.capability,
    status,
    proposalId: run.proposalId
  });
}

/**
 * Mark runs orphaned by a restart.
 *
 * A run left RUNNING with nothing executing it would otherwise sit there forever, and a QUEUED one
 * whose process died would be retried every minute. Called once at boot.
 */
export async function reapOrphanedRuns(maxRunMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxRunMinutes * 60_000);
  const { count } = await prisma.agentRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: { status: "FAILED", error: "The server restarted while this run was in progress.", finishedAt: new Date() }
  });
  return count;
}
