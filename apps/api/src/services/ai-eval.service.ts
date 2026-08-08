/**
 * WHAT: replays a golden dataset through a capability and scores the answers.
 *
 * WHY: this closes the loop. Capture (AIInteraction) told you something went wrong, a golden set
 * (AIDataset) says what right looks like, prompt versioning (AIPromptVersion) let you change it —
 * and this is what turns "the new prompt feels better" into a number you can act on.
 *
 * ── THE THREE THINGS THAT MAKE THIS SAFE ────────────────────────────────────────────────────
 *
 * 1. NO BYPASS PATH. Replay calls the SAME capability functions production calls. That means the
 *    existing preflight → assertWithinBudget → toggle checks all apply unchanged. There is
 *    deliberately no "eval mode" that skips them, because that path would inevitably drift from
 *    the real one and you'd be measuring something you don't ship.
 *
 * 2. COST IS BOUNDED THREE TIMES. Enqueue refuses a run whose estimate exceeds the remaining
 *    monthly budget; a mid-run 402 stops the run and marks it PARTIAL (keeping what it scored);
 *    and hard caps limit items per run and runs per workspace.
 *
 * 3. SCORING IS CHEAPEST-FIRST. Structured answers are compared field by field — deterministic,
 *    free, and reproducible. Only free text can reach the LLM judge, and only when an admin has
 *    turned that on, because it's the one part of a run that costs extra calls.
 */
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import {
  answerWorkspaceQuestion,
  classifyChatMessage,
  classifyCiFailure,
  classifySecurityFinding,
  classifyTicket,
  estimateCostUsd,
  explainAssigneeSuggestion,
  findDuplicateTickets,
  generateBugPatternDigest,
  generateSecurityWeeklyDigest,
  generateStatusReport,
  generateWeeklyDigest,
  getGlobalAISettings,
  improveText,
  judgeAnswerEquivalence,
  planAgentStep,
  refineText,
  summarizeComments,
  summarizePullRequest,
  suggestStaleTicketNextAction
} from "./ai.service.js";
import { findCapability } from "./ai-capability.registry.js";

/** A run this size already costs real money; past it you're paying to re-learn what you know. */
export const MAX_ITEMS_PER_RUN = 100;
/** Runs are serial by design — parallel LLM calls would race the budget gate against itself. */
const NON_TERMINAL = ["QUEUED", "RUNNING"];
/** Used only when a capability has no billing history yet to estimate from. */
const FALLBACK_COST_PER_CALL_USD = 0.004;

/* ------------------------------- Replay registry ------------------------------------------ */

/**
 * How to re-run each capability from the params a dataset item captured.
 *
 * The zod schema is doing real work: params arrive as JSON, so `Date` came back as a string and a
 * capability that was captured before a signature change may no longer match. Parsing gives
 * coercion where it's safe and a clear "this item can't be replayed" where it isn't — much better
 * than a TypeError halfway through a paid run.
 */
interface Replayer {
  schema: z.ZodType<any>;
  /** Returns the answer as a string: JSON for structured capabilities, prose for free text. */
  invoke: (params: any) => Promise<string>;
  structured: boolean;
}

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  modules: z.array(z.object({ id: z.string(), name: z.string() }))
});

const REPLAYERS: Record<string, Replayer> = {
  triage: {
    structured: true,
    schema: z.object({
      title: z.string(),
      description: z.string().nullish(),
      project: projectSchema,
      typeNames: z.array(z.string()),
      untrustedSource: z.boolean().optional()
    }),
    invoke: async (p) => JSON.stringify(await classifyTicket(p))
  },
  chat_triage: {
    structured: true,
    schema: z.object({
      messageText: z.string(),
      senderName: z.string(),
      project: projectSchema,
      typeNames: z.array(z.string())
    }),
    invoke: async (p) => JSON.stringify(await classifyChatMessage(p))
  },
  ci_failure_triage: {
    structured: true,
    schema: z.object({ failureText: z.string(), provider: z.string(), ticketKey: z.string().optional() }),
    invoke: async (p) => JSON.stringify(await classifyCiFailure(p))
  },
  security_finding_triage: {
    structured: true,
    schema: z.object({
      type: z.string(),
      tool: z.string(),
      severity: z.string(),
      title: z.string(),
      description: z.string().nullish(),
      filePath: z.string().nullish(),
      cwe: z.string().nullish()
    }),
    invoke: async (p) => JSON.stringify(await classifySecurityFinding(p))
  },
  duplicate_detection: {
    structured: true,
    schema: z.object({
      title: z.string(),
      description: z.string().nullish(),
      candidates: z.array(z.object({ id: z.string(), key: z.string(), title: z.string(), description: z.string().nullable() }))
    }),
    invoke: async (p) => JSON.stringify(await findDuplicateTickets(p))
  },
  pr_review_summary: {
    structured: true,
    schema: z.object({
      title: z.string(),
      body: z.string().nullish(),
      filesChanged: z.array(z.object({ path: z.string(), patch: z.string().optional() })),
      ticketKey: z.string().optional()
    }),
    invoke: async (p) => JSON.stringify(await summarizePullRequest({ ...p, body: p.body ?? null }))
  },
  writing_assistant: {
    structured: false,
    schema: z.object({ text: z.string(), context: z.enum(["ticket_description", "comment"]) }),
    invoke: async (p) => (await improveText(p)).improved
  },
  text_refine: {
    structured: false,
    schema: z.object({
      text: z.string(),
      field: z.enum(["ticket_title", "ticket_description", "ticket_comment", "timesheet_description", "timesheet_notes"])
    }),
    invoke: async (p) => (await refineText(p)).refined
  },
  comment_summary: {
    structured: false,
    schema: z.object({
      ticketTitle: z.string(),
      // Coerced: JSON round-trips a Date into an ISO string, and the capability formats it.
      comments: z.array(z.object({ authorName: z.string(), body: z.string(), createdAt: z.coerce.date() }))
    }),
    invoke: async (p) => (await summarizeComments(p)).summary
  },
  ask_ai: {
    structured: false,
    schema: z.object({
      question: z.string(),
      tickets: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          status: z.string(),
          priority: z.string(),
          description: z.string().nullable()
        })
      ),
      insightsSnapshot: z.string().optional()
    }),
    invoke: async (p) => (await answerWorkspaceQuestion(p)).answer
  },
  weekly_digest: {
    structured: false,
    schema: z.object({
      userName: z.string(),
      weekLabel: z.string(),
      ticketsCreated: z.number(),
      ticketsResolved: z.number(),
      openAssigned: z.number(),
      hoursLogged: z.number(),
      notableTickets: z.array(z.object({ key: z.string(), title: z.string(), status: z.string() }))
    }),
    invoke: async (p) => (await generateWeeklyDigest(p)).summary
  },
  security_weekly_digest: {
    structured: false,
    schema: z.object({
      weekLabel: z.string(),
      openFindings: z.number(),
      newCriticalOrHigh: z.number(),
      resolvedThisWeek: z.number(),
      riskScore: z.number(),
      riskScoreLastWeek: z.number(),
      ticketsStuckPastSla: z.number(),
      topRepositories: z.array(z.object({ repository: z.string(), count: z.number() }))
    }),
    invoke: async (p) => (await generateSecurityWeeklyDigest(p)).summary
  },
  bug_pattern_digest: {
    structured: false,
    schema: z.object({
      periodLabel: z.string(),
      recurringFailures: z.array(z.object({ provider: z.string(), branch: z.string().nullable(), count: z.number() })),
      hotTickets: z.array(z.object({ key: z.string(), title: z.string(), failureCount: z.number() })),
      findingHotspots: z.array(z.object({ repository: z.string(), count: z.number() }))
    }),
    invoke: async (p) => (await generateBugPatternDigest(p)).summary
  },
  status_report: {
    structured: false,
    schema: z.object({
      projectName: z.string(),
      periodLabel: z.string(),
      ticketsCreated: z.number(),
      ticketsResolved: z.number(),
      openCount: z.number(),
      overdueCount: z.number(),
      hoursLogged: z.number(),
      notableTickets: z.array(z.object({ key: z.string(), title: z.string(), status: z.string() }))
    }),
    invoke: async (p) => (await generateStatusReport(p)).report
  },
  assignee_suggestion_explanation: {
    structured: false,
    schema: z.object({
      ticketTitle: z.string(),
      candidates: z.array(z.object({ name: z.string(), openTicketCount: z.number(), resolvedHereCount: z.number() }))
    }),
    invoke: async (p) => (await explainAssigneeSuggestion(p)) ?? ""
  },
  stale_ticket_nudge: {
    structured: false,
    schema: z.object({
      ticketTitle: z.string(),
      ticketType: z.string(),
      priority: z.string(),
      hoursOverdue: z.number(),
      commentCount: z.number(),
      hasLinkedBranch: z.boolean()
    }),
    invoke: async (p) => (await suggestStaleTicketNextAction(p)) ?? ""
  },
  /**
   * One agent-loop decision: given this goal, these tools and this transcript, what did the model
   * choose? This is how the loop's quality becomes measurable rather than anecdotal — the three
   * live pilot runs each taught something the unit tests could not, and promoting their captured
   * steps into a golden set turns those lessons into a number a prompt change has to beat.
   *
   * The TOOLS are replayed as captured, not rebuilt from today's registry: the decision being
   * judged was made against the tool list the model actually saw. Only the featureToggle is
   * re-resolved, because replay still has to respect the workspace's toggles and budget.
   */
  agent_step: {
    structured: true,
    schema: z.object({
      capability: z.string(),
      goal: z.string(),
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
      transcript: z.array(z.object({ tool: z.string(), args: z.unknown(), result: z.string() })),
      stepsRemaining: z.number(),
      mustFinish: z.boolean().optional()
    }),
    invoke: async (p) => {
      const spec = findCapability(p.capability);
      if (!spec?.featureToggle) {
        throw new Error(`"${p.capability}" is not a model-driven capability in this build, so this item cannot be replayed.`);
      }
      const { decision } = await planAgentStep({ ...p, featureToggle: spec.featureToggle });
      return JSON.stringify(decision);
    }
  }
};

export function isReplayable(feature: string): boolean {
  return feature in REPLAYERS;
}

/** Read access to one replayer. The run loop keeps parse and invoke separate for their distinct
 *  error handling; this lets tests (and any future caller) exercise the same two phases. */
export function replayerFor(feature: string): Replayer | undefined {
  return REPLAYERS[feature];
}

/* ------------------------------- Scoring -------------------------------------------------- */

/** The model's own confidence is self-reported and unverifiable — scoring it would reward a model
 *  for being confidently wrong in the same way as being right. */
const IGNORED_FIELDS = new Set(["confidence", "reasoning"]);

export interface Score {
  score: number;
  passed: boolean;
  detail: string;
}

function parseJsonLoosely(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Models wrap JSON in prose or fences often enough that giving up here would report a scoring
    // failure for an answer that's actually correct.
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

/**
 * Field-by-field comparison, scored as a fraction rather than pass/fail.
 *
 * The fraction matters: "got 4 of 5 fields right" and "got nothing right" are very different
 * regressions, and a boolean would hide which one you're looking at.
 */
export function scoreExactFields(expectedRaw: string, actualRaw: string): Score {
  const expected = parseJsonLoosely(expectedRaw);
  const actual = parseJsonLoosely(actualRaw);

  if (expected === undefined) return { score: 0, passed: false, detail: "The expected answer isn't valid JSON, so it can't be compared field by field." };
  if (actual === undefined) return { score: 0, passed: false, detail: "The model's answer wasn't valid JSON." };

  const fields = Object.keys(expected as Record<string, unknown>).filter((k) => !IGNORED_FIELDS.has(k));
  if (fields.length === 0) {
    const same = JSON.stringify(expected) === JSON.stringify(actual);
    return { score: same ? 1 : 0, passed: same, detail: same ? "Matched." : "Didn't match." };
  }

  const mismatches: string[] = [];
  let matched = 0;
  for (const field of fields) {
    const want = (expected as any)[field];
    const got = (actual as any)[field];
    if (JSON.stringify(want) === JSON.stringify(got)) matched++;
    else mismatches.push(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }

  const score = matched / fields.length;
  return {
    score,
    passed: score === 1,
    detail: mismatches.length === 0 ? "Every field matched." : mismatches.join("\n")
  };
}

export function scoreContains(expected: string, actual: string): Score {
  const needle = expected.trim().toLowerCase();
  const hit = actual.toLowerCase().includes(needle);
  return {
    score: hit ? 1 : 0,
    passed: hit,
    detail: hit ? "The expected text is present." : "The expected text wasn't found in the answer."
  };
}

/**
 * LLM-as-judge for free text. The model call itself lives in ai.service.ts as a normal capability,
 * so grading passes through the same budget gate as the work it grades — a judge that could spend
 * outside the budget would be a hole in the exact control this runner exists to respect.
 */
export async function scoreWithJudge(params: { expected: string; actual: string }): Promise<Score> {
  const settings = await getGlobalAISettings();
  if (!settings.aiEvalJudgeEnabled) {
    // Degrade to the free check rather than failing the run — a scoring method being switched off
    // isn't an error, and CONTAINS still says something true, so the detail line says which was used.
    const fallback = scoreContains(params.expected, params.actual);
    return { ...fallback, detail: `${fallback.detail} (AI grading is off, so this was a plain text check.)` };
  }

  const judgement = await judgeAnswerEquivalence(params);
  if (!judgement) return { score: 0, passed: false, detail: "The grader's response couldn't be read." };
  return { score: judgement.equivalent ? 1 : 0, passed: judgement.equivalent, detail: judgement.reason };
}

/* ------------------------------- Enqueue -------------------------------------------------- */

/** This capability's own recent cost per call, so the estimate reflects real prompt sizes rather
 *  than a guess that's wrong by an order of magnitude for a diff-heavy feature. */
async function estimateCostPerCall(feature: string, model: string): Promise<number> {
  const recent = await prisma.aIUsageLog.aggregate({
    where: { feature },
    _avg: { inputTokens: true, outputTokens: true }
  });
  const inputTokens = recent._avg.inputTokens;
  const outputTokens = recent._avg.outputTokens;
  if (inputTokens == null || outputTokens == null) return FALLBACK_COST_PER_CALL_USD;
  return estimateCostUsd(model, Math.ceil(inputTokens), Math.ceil(outputTokens));
}

export async function enqueueEvalRun(params: { datasetId: string; promptVersionId?: string | null; userId: string }) {
  const dataset = await prisma.aIDataset.findUnique({
    where: { id: params.datasetId },
    include: { _count: { select: { items: true } } }
  });
  if (!dataset) throw new AppError(404, "Dataset not found");

  if (!isReplayable(dataset.feature)) {
    throw new AppError(422, `"${dataset.feature}" can't be replayed automatically yet, so it can't be evaluated.`);
  }
  if (dataset._count.items === 0) {
    throw new AppError(422, "This dataset has no examples yet — add one by correcting a real failure first.");
  }

  // One at a time per workspace. Concurrent runs would race each other against the same monthly
  // budget, and the loser would stop halfway through for reasons that look arbitrary.
  const inFlight = await prisma.aIEvalRun.findFirst({ where: { status: { in: NON_TERMINAL } } });
  if (inFlight) throw new AppError(409, "An evaluation is already queued or running. Wait for it to finish.");

  const settings = await getGlobalAISettings();
  if (!settings.aiEnabled) throw new AppError(422, "AI is turned off for this workspace.");

  const itemCount = Math.min(dataset._count.items, MAX_ITEMS_PER_RUN);
  const perCall = await estimateCostPerCall(dataset.feature, settings.model);
  const estimatedCostUsd = perCall * itemCount;

  // Layer 1: refuse before spending anything. Being told "this would cost more than you have
  // left" up front is far better than discovering it after 60 paid calls.
  if (settings.monthlyBudgetUsd != null) {
    const spent = await prisma.aIUsageLog.aggregate({
      where: { createdAt: { gte: startOfMonth() } },
      _sum: { costUsdEstimate: true }
    });
    const remaining = Number(settings.monthlyBudgetUsd) - Number(spent._sum.costUsdEstimate ?? 0);
    if (estimatedCostUsd > remaining) {
      throw new AppError(
        422,
        `This run is estimated at $${estimatedCostUsd.toFixed(2)} but only $${Math.max(0, remaining).toFixed(2)} is left in this month's budget.`
      );
    }
  }

  return prisma.aIEvalRun.create({
    data: {
      datasetId: dataset.id,
      promptVersionId: params.promptVersionId ?? null,
      model: settings.model,
      itemCount,
      estimatedCostUsd,
      createdById: params.userId
    }
  });
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/* ------------------------------- Execution ------------------------------------------------ */

/**
 * Runs one queued evaluation to completion. Called by ai-eval.worker.ts, never from a request.
 *
 * Items are processed serially and each is scored as it finishes, so a run stopped by the budget
 * still leaves behind every result it managed to produce.
 */
export async function executeEvalRun(runId: string): Promise<void> {
  const run = await prisma.aIEvalRun.findUnique({ where: { id: runId }, include: { dataset: true } });
  if (!run || run.status !== "QUEUED") return;

  const replayer = REPLAYERS[run.dataset.feature];
  if (!replayer) {
    await prisma.aIEvalRun.update({
      where: { id: run.id },
      data: { status: "FAILED", error: `"${run.dataset.feature}" can't be replayed.`, finishedAt: new Date() }
    });
    return;
  }

  await prisma.aIEvalRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });

  const items = await prisma.aIDatasetItem.findMany({
    where: { datasetId: run.datasetId },
    orderBy: { createdAt: "asc" },
    take: MAX_ITEMS_PER_RUN
  });

  const spendBefore = await monthSpend();
  let scored = 0;
  let passes = 0;
  let scoreTotal = 0;
  let stoppedReason: string | null = null;

  for (const item of items) {
    let output: string | null = null;
    let score: Score;

    try {
      const parsed = replayer.schema.safeParse(item.inputParamsJson);
      if (!parsed.success) {
        // The item predates a signature change, or was captured incompletely. Recording it as a
        // zero would be a lie about the model's performance, so it's an error on the result row.
        await prisma.aIEvalResult.create({
          data: { runId: run.id, itemId: item.id, score: 0, passed: false, error: "Saved inputs no longer match this capability, so it couldn't be replayed." }
        });
        continue;
      }

      output = await replayer.invoke(parsed.data);
      score = await scoreItem(item, output, replayer.structured);
    } catch (error) {
      const err = error as AppError & { statusCode?: number };
      // Layer 2: the capability's own budget gate fired. Everything scored so far is real and
      // worth keeping, so this is PARTIAL rather than FAILED.
      if (err?.statusCode === 402) {
        stoppedReason = "Stopped early — the workspace's monthly AI budget ran out mid-run.";
        break;
      }
      await prisma.aIEvalResult.create({
        data: { runId: run.id, itemId: item.id, output, score: 0, passed: false, error: String(err?.message ?? error).slice(0, 300) }
      });
      continue;
    }

    await prisma.aIEvalResult.create({
      data: { runId: run.id, itemId: item.id, output, score: score.score, passed: score.passed, detail: score.detail }
    });
    scored++;
    scoreTotal += score.score;
    if (score.passed) passes++;
  }

  const spendAfter = await monthSpend();
  await prisma.aIEvalRun.update({
    where: { id: run.id },
    data: {
      status: stoppedReason ? "PARTIAL" : "COMPLETED",
      error: stoppedReason,
      scoredCount: scored,
      passCount: passes,
      avgScore: scored > 0 ? scoreTotal / scored : null,
      // Measured, not estimated: the difference between the two is itself worth seeing, since it
      // tells you whether the enqueue-time estimate can be trusted next time.
      actualCostUsd: Math.max(0, spendAfter - spendBefore),
      finishedAt: new Date()
    }
  });
}

async function monthSpend(): Promise<number> {
  const agg = await prisma.aIUsageLog.aggregate({
    where: { createdAt: { gte: startOfMonth() } },
    _sum: { costUsdEstimate: true }
  });
  return Number(agg._sum.costUsdEstimate ?? 0);
}

async function scoreItem(item: { expectedKind: string; expectedOutput: string }, output: string, structured: boolean): Promise<Score> {
  if (item.expectedKind === "EXACT_FIELDS") return scoreExactFields(item.expectedOutput, output);
  if (item.expectedKind === "JUDGE") return scoreWithJudge({ expected: item.expectedOutput, actual: output });
  if (item.expectedKind === "CONTAINS") return scoreContains(item.expectedOutput, output);
  // Unknown kind — fall back to the strategy that fits the capability rather than erroring.
  return structured ? scoreExactFields(item.expectedOutput, output) : scoreContains(item.expectedOutput, output);
}

/* ------------------------------- Read surface --------------------------------------------- */

export async function listEvalRuns(datasetId?: string) {
  const runs = await prisma.aIEvalRun.findMany({
    where: datasetId ? { datasetId } : {},
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { dataset: { select: { id: true, name: true, feature: true } }, createdBy: { select: { id: true, name: true } } }
  });
  return runs.map((run) => ({
    id: run.id,
    dataset: run.dataset,
    promptVersionId: run.promptVersionId,
    model: run.model,
    status: run.status,
    itemCount: run.itemCount,
    scoredCount: run.scoredCount,
    passCount: run.passCount,
    avgScore: run.avgScore,
    estimatedCostUsd: run.estimatedCostUsd,
    actualCostUsd: run.actualCostUsd,
    error: run.error,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt
  }));
}

export async function getEvalRun(id: string) {
  const run = await prisma.aIEvalRun.findUnique({
    where: { id },
    include: {
      dataset: { select: { id: true, name: true, feature: true } },
      results: { orderBy: { createdAt: "asc" } }
    }
  });
  if (!run) throw new AppError(404, "Evaluation not found");

  // Joined here rather than via a relation because AIEvalResult holds itemId flat on purpose —
  // deleting a dataset item must not erase the history of runs that scored it.
  const items = await prisma.aIDatasetItem.findMany({
    where: { id: { in: run.results.map((r) => r.itemId) } },
    select: { id: true, expectedOutput: true, notes: true }
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  return {
    ...run,
    results: run.results.map((r) => ({
      ...r,
      expectedOutput: itemById.get(r.itemId)?.expectedOutput ?? null,
      notes: itemById.get(r.itemId)?.notes ?? null
    }))
  };
}
