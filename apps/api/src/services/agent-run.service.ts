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
import { recordAgentWork } from "./agent-ledger.service.js";
import { loadRequestUser } from "./principal.service.js";
import { describeDecisionFailure, getGlobalAISettings, planAgentStep, redactSecrets } from "./ai.service.js";
import { invokeMcpTool, MCP_TOOLS, type McpEnablementSettings, type McpToolContext } from "./mcp-tools.js";
import { proposeAssignmentRebalance } from "./ai-rebalance.service.js";
import { emitDomainEvent } from "./domain-events.js";

/**
 * Steps a run may take before it is stopped and called PARTIAL.
 *
 * ENFORCED by `runModelDrivenLoop` below, between every step, alongside `maxCostUsd` — both
 * produce PARTIAL rather than FAILED when they stop a run early, because work already done is
 * real. (An earlier revision of this file recorded the bounds without a loop to enforce them, and
 * said so here; the loop exists now, and the tests hold it to both.)
 */
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
  /** The flow that queued this, when one did. Carried onto the row so a flow's AI spend can be told
   *  apart from the same capability invoked by hand — which is the last piece of "every AI feature is
   *  tracked". */
  flowId?: string | null;
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

  // The daily ceiling an administrator set. Checked HERE and not at execution, because refusing to
  // queue is the only refusal that costs nothing — a run rejected after being queued would still
  // occupy the worker and still have to be explained.
  //
  // Counted AFTER the triggerKey check above on purpose: re-queueing something that already exists
  // is not a new run and must not consume the day's allowance.
  const perDay = autonomy.guardrails.maxRunsPerDay;
  if (perDay !== null) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const used = await prisma.agentRun.count({ where: { capability: params.capability, createdAt: { gte: since } } });
    if (used >= perDay) {
      throw new AppError(429, `"${params.capability}" has already run ${used} time(s) in the last 24 hours, which is its limit.`);
    }
  }

  /**
   * THE PER-AGENT DAILY SPEND CEILING (V8 phase 3).
   *
   * `AgentProfile.maxCostUsdPerDay` is a ceiling shared by every run of one teammate, sitting under
   * the per-run cap above, the org's monthly budget, and the tier's hard platform cap. Enforced
   * here, beside the run-count check, for the same reason that one is: refusing to queue is the only
   * refusal that costs nothing.
   *
   * Checked only when the actor IS an agent identity, so an ordinary person's runs are untouched —
   * and by summing `AgentRun.costUsd` for that identity since local midnight, which is the same
   * figure the roster page displays. A ceiling the product shows and does not apply is worse than no
   * ceiling, because it is read as a guarantee.
   */
  if (actor.isAgent) {
    const profile = await prisma.agentProfile.findFirst({
      where: { identityUserId: params.onBehalfOfId, deletedAt: null },
      select: { name: true, enabled: true, maxCostUsdPerDay: true }
    });
    if (profile && !profile.enabled) {
      throw new AppError(403, `"${profile.name}" is switched off.`);
    }
    if (profile?.maxCostUsdPerDay != null) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const spent = await prisma.agentRun.aggregate({
        _sum: { costUsd: true },
        where: { onBehalfOfId: params.onBehalfOfId, createdAt: { gte: midnight } }
      });
      const used = Number(spent._sum.costUsd ?? 0);
      const ceiling = Number(profile.maxCostUsdPerDay);
      if (used >= ceiling) {
        throw new AppError(
          429,
          `"${profile.name}" has spent $${used.toFixed(4)} today, which is its daily ceiling of $${ceiling.toFixed(2)}.`
        );
      }
    }
  }

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
        goal: params.goal ?? null,
        flowId: params.flowId ?? null
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
      // Redacted like the triage captures are: a tool result can quote a CI log or a scanner
      // finding, and an agent trace is prompt content by another name — it must not become the
      // one store that keeps the credential the capture path masked.
      resultText: keepContent && step.result ? redactSecrets(step.result).slice(0, 8_000) : null,
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

  try {
    if (await abortRequested(runId)) {
      await finish(runId, "ABORTED", null);
      return;
    }

    // The capability's own work. Deterministic capabilities do their arithmetic and emit a
    // proposal; a model-driven one steps through callToolForRun under the same bounds.
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

      await recordStep(runId, 0, {
        kind: "proposal",
        result: outcome.heldForReview ?? outcome.reason ?? `${outcome.moves} move(s) proposed`
      });
      await prisma.agentRun.update({ where: { id: runId }, data: { proposalId: outcome.proposalId, stepCount: 1 } });

      // BLOCKED means the run produced something its level does not let it apply — degradation to
      // propose-only, which is an outcome and not an error. Everything else is a completion,
      // including "there was nothing to rebalance": having correctly decided to do nothing is a
      // successful run, not a blocked one.
      await finish(runId, outcome.heldForReview ? "BLOCKED" : "COMPLETED", null);
      return;
    }

    // Model-driven capabilities: anything whose registry entry names tools and a feature toggle.
    // The registry is the routing table on purpose — a new capability becomes loop-runnable by
    // declaring its allowlist, not by adding a branch here.
    const spec = findCapability(run.capability);
    if (spec && spec.tools.length > 0 && spec.featureToggle) {
      await runModelDrivenLoop(run, spec, ctx);
      return;
    }

    await finish(runId, "FAILED", `No runner is implemented for "${run.capability}".`);
  } catch (error) {
    await finish(runId, "FAILED", (error as Error).message);
  }
}

/** Tool results handed back to the model are truncated hard — a 200KB ticket list would blow the
 *  context and the budget for information the next decision does not need. */
const TRANSCRIPT_RESULT_LIMIT = 4_000;

/**
 * A repeated call is the same tool with the same arguments — identified by signature so the
 * envelope can refuse it rather than ask the model not to.
 *
 * WHY THIS EXISTS: the first live run of this loop spent NINE of its twelve steps re-issuing
 * identical `search_tickets` calls that returned nothing, and opened by calling `list_projects`
 * twice in a row. The prompt already said "do not re-fetch what you already have"; the model
 * ignored it, because an instruction is not a bound. Every one of those steps was a paid model
 * call that bought no new information, and the run hit its ceiling without ever answering.
 *
 * Stringify with sorted keys so `{a,b}` and `{b,a}` are one signature — otherwise key order alone
 * would defeat the check.
 */
function callSignature(tool: string, args: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)])
      );
    }
    return value;
  };
  try {
    return `${tool}:${JSON.stringify(stable(args))}`;
  } catch {
    // Unserialisable args cannot be compared, so they are never treated as repeats.
    return `${tool}:${Math.random()}`;
  }
}

/**
 * The loop: the model chooses each step, the envelope decides whether it may take it.
 *
 * Every control this file promised is checked BETWEEN steps, in order: abort (a person said stop),
 * step ceiling and cost ceiling (both land on PARTIAL — work already done is real), then the
 * decision itself. A tool outside the capability's allowlist is refused and the refusal is fed
 * back as data — the model may recover; a run that cannot produce valid JSON is FAILED, because
 * an agent whose decisions cannot be parsed has no decisions.
 *
 * Tool calls go through `callToolForRun` and nothing else — that is where the taint clamp lives,
 * and the loop deliberately has no other way to reach `invokeMcpTool`.
 */
async function runModelDrivenLoop(
  run: NonNullable<Awaited<ReturnType<typeof prisma.agentRun.findUnique>>>,
  spec: NonNullable<ReturnType<typeof findCapability>>,
  ctx: McpToolContext
): Promise<void> {
  const tools = MCP_TOOLS.filter((t) => spec.tools.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description
  }));
  const transcript: Array<{ tool: string; args: unknown; result: string }> = [];
  const maxCost = run.maxCostUsd !== null ? Number(run.maxCostUsd) : null;
  /** Every (tool, args) already issued this run — see callSignature for why asking wasn't enough. */
  const seenCalls = new Set<string>();
  /** Every distinct RESULT this run has been shown. A call whose answer is byte-identical to one
   *  already seen bought no information, whatever its arguments were — the second live pilot run
   *  spent six steps on differently-argued searches that all returned the same empty answer, which
   *  the args-repeat guard correctly could not block. */
  const seenResults = new Set<string>();
  /** Consecutive steps that produced nothing new. Two earns one steering note; three means the
   *  run is circling and the envelope demands the answer. */
  let consecutiveNoNew = 0;
  let steered = false;
  let costUsd = Number(run.costUsd ?? 0);
  let step = 0;

  /** Dedup-aware transcript append: tracks whether this result taught the run anything. */
  const pushResult = (tool: string, args: unknown, result: string) => {
    transcript.push({ tool, args, result: result.slice(0, TRANSCRIPT_RESULT_LIMIT) });
    const key = result.slice(0, TRANSCRIPT_RESULT_LIMIT);
    if (seenResults.has(key)) {
      consecutiveNoNew++;
    } else {
      seenResults.add(key);
      consecutiveNoNew = 0;
    }
  };

  while (step < run.maxSteps) {
    if (await abortRequested(run.id)) {
      await finish(run.id, "ABORTED", null);
      return;
    }
    if (maxCost !== null && costUsd >= maxCost) {
      await recordStep(run.id, step, { kind: "note", result: `Stopped: the run's cost ceiling ($${maxCost.toFixed(2)}) was reached.` });
      await finish(run.id, "PARTIAL", `Cost ceiling of $${maxCost.toFixed(2)} reached after ${step} step(s).`);
      return;
    }

    // The last allowed step is RESERVED for the answer, always — both live pilot runs spent their
    // whole budget on tool calls and ended at the ceiling having never said what they found, which
    // wastes every step they took. Circling (three no-new results) forfeits the remaining tool
    // budget for the same reason: the data it is going to answer from already exists.
    const mustFinish = step === run.maxSteps - 1 || consecutiveNoNew >= 3;

    const { decision, costUsd: stepCost, raw } = await planAgentStep({
      capability: spec.id,
      featureToggle: spec.featureToggle!,
      goal: run.goal ?? spec.description,
      tools,
      transcript,
      stepsRemaining: run.maxSteps - step,
      mustFinish,
      userId: run.onBehalfOfId
    });
    costUsd += stepCost;
    step++;
    await prisma.agentRun.update({ where: { id: run.id }, data: { stepCount: step, costUsd } });

    if (!decision) {
      // Named cause, not a shrug: on a BYOK deployment the model is the operator's choice, and the
      // old message sent them to check an API key that was never the problem.
      const why = describeDecisionFailure(raw, (await getGlobalAISettings()).model ?? "the configured model");
      await recordStep(run.id, step, { kind: "error", error: why, result: raw.slice(0, 500) });
      await finish(run.id, "FAILED", why);
      return;
    }

    if (decision.action === "finish") {
      await recordStep(run.id, step, { kind: "finish", result: decision.summary });
      await finish(run.id, "COMPLETED", null);
      return;
    }

    if (mustFinish) {
      // Asked for its answer, reached for a tool anyway. PARTIAL, not FAILED: the recorded steps
      // are real work somebody can read — what is missing is the summary, and the trace says so.
      await recordStep(run.id, step, {
        kind: "error",
        toolName: decision.tool,
        error: "Asked for its final answer, tried to call another tool instead.",
        result: raw.slice(0, 500)
      });
      await finish(run.id, "PARTIAL", "The run was asked for its answer and tried to keep working instead.");
      return;
    }

    if (!spec.tools.includes(decision.tool)) {
      // Refused, recorded, and fed back as data. Not FAILED: one bad pick from a model that may
      // correct itself is a wasted step, and the step ceiling already prices wasted steps.
      const refusal = `Tool "${decision.tool}" is not in this capability's allowlist.`;
      await recordStep(run.id, step, { kind: "refusal", toolName: decision.tool, args: decision.args, error: refusal });
      transcript.push({ tool: decision.tool, args: decision.args, result: refusal });
      continue;
    }

    // Refuse a call this run has already made, with the answer it already got. Same treatment a
    // disallowed tool gets — recorded, fed back as data, and charged as a step so a model that
    // insists on looping still runs out — but it costs no tool invocation and no fresh read.
    const signature = callSignature(decision.tool, decision.args);
    if (seenCalls.has(signature)) {
      const previous = transcript.find((entry) => callSignature(entry.tool, entry.args) === signature);
      const refusal =
        `You already called ${decision.tool} with exactly those arguments this run and got: ` +
        `${(previous?.result ?? "(no result recorded)").slice(0, 400)}. ` +
        `Calling it again cannot return anything new — either use a different tool or different arguments, or finish.`;
      await recordStep(run.id, step, { kind: "refusal", toolName: decision.tool, args: decision.args, error: "Repeated call refused." });
      transcript.push({ tool: decision.tool, args: decision.args, result: refusal });
      // A repeat is, by definition, nothing new — it counts toward the circling threshold.
      consecutiveNoNew++;
    } else {
      seenCalls.add(signature);
      try {
        const result = await callToolForRun(run.id, ctx, spec.id, run.level, decision.tool, decision.args, step);
        const resultText = typeof result === "string" ? result : JSON.stringify(result);
        await recordStep(run.id, step, { kind: "tool", toolName: decision.tool, args: decision.args, result: resultText });
        pushResult(decision.tool, decision.args, resultText);
      } catch (error) {
        // A refused or failed tool call is information the model can act on — surfaced as data,
        // charged as a step, never silently retried. It goes through the same result-identity
        // tracking: the third differently-argued call failing with the same message is circling.
        const message = (error as Error).message.slice(0, 500);
        await recordStep(run.id, step, { kind: "error", toolName: decision.tool, args: decision.args, error: message });
        pushResult(decision.tool, decision.args, `That call failed: ${message}`);
      }
    }

    // One explicit course-correction before the envelope forces the answer: at two consecutive
    // no-new results the model gets told, in its own transcript, what its results have been
    // telling it. If it still circles, the mustFinish gate above ends the search on the next turn.
    if (consecutiveNoNew === 2 && !steered) {
      steered = true;
      const note =
        "Your recent calls returned nothing you had not already seen. More of the same search cannot help — " +
        "make ONE genuinely different call, or finish now with what you have.";
      await recordStep(run.id, step, { kind: "note", result: note });
      transcript.push({ tool: "system", args: {}, result: note });
    }
  }

  await finish(run.id, "PARTIAL", `Step ceiling of ${run.maxSteps} reached before the goal was finished.`);
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

  /**
   * The agent ledger (V8 phase 5). Deliberately not awaited-into-failure: accounting is DOWNSTREAM of
   * the work, so a ledger row that cannot be written must never turn a completed run into a failed
   * one. It is a no-op unless the actor is an agent identity.
   */
  await recordAgentWork(runId).catch((error: unknown) => {
    console.error(`[agent-ledger] could not record work for run ${runId}:`, error);
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
