/**
 * WHAT: one answer to "what is the AI in this workspace actually doing", across the four surfaces that
 * each hold a quarter of it.
 *
 * WHY IT EXISTS: AI suggestions, Agents, Workflows and the AI settings tab grew separately and each is
 * coherent on its own. Together they are a map nobody drew — a new administrator meets four sibling
 * screens with no statement of how they relate, and the commonest consequence is a workspace where
 * capabilities are enabled, an agent owns them, a flow composes them, and nothing has been switched on
 * because each screen assumed another had said so.
 *
 * WHY EVERY NUMBER HERE IS A COUNT AND NOT A SCORE: a health score would need a rule for what healthy
 * is, and the honest answer is that it depends on what the workspace wants. Counts can be checked
 * against the screen they came from; a score cannot be checked against anything.
 *
 * WHY IT IS SUPER-ADMIN: it is the orientation surface for the person who configures all four, and it
 * reports spend. The four surfaces keep their own, looser, read permissions.
 *
 * WHO CALLS THIS: `controllers/ai.controller.ts`.
 */
import { prisma } from "../config/prisma.js";
import { getGlobalAISettings, getMonthlyAIUsageSummary } from "./ai.service.js";
import { listCapabilityCatalogue } from "./agent-profile.service.js";
import { summariseLedger } from "./agent-ledger.service.js";
import { resolveAutonomy } from "./ai-autonomy.service.js";

export interface AiOverview {
  /** The master switch. Everything below is inert when this is off, which is why it is first. */
  aiEnabled: boolean;
  captureEnabled: boolean;
  capabilities: {
    total: number;
    /** How many resolve above SUGGEST — i.e. how many may change the workspace without being asked. */
    aboveSuggest: number;
    /** Capabilities no agent owns. Not a problem; a fact that explains why a flow cannot use one. */
    unowned: number;
  };
  agents: { total: number; enabled: number };
  flows: {
    total: number;
    live: number;
    proposalOnly: number;
    /** Runs in the last seven days, and how many are stuck waiting for a person. */
    runsLastWeek: number;
    waiting: number;
  };
  proposals: { pending: number; appliedLastWeek: number };
  spend: { monthToDateUsd: number; agentDrivenUsd: number; byFlowUsd: number };
  ledger: { entries: number; displacedHours: number; unmeasurableEntries: number };
  /** The one thing most worth doing next, in words, or null when nothing stands out. Deliberately at
   *  most one: a list of five suggestions is a list nobody acts on. */
  nextStep: string | null;
}

export async function getAiOverview(): Promise<AiOverview> {
  const settings = await getGlobalAISettings();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000);

  const [profiles, flows, flowRuns, waiting, pending, appliedLastWeek, usage, ledger] = await Promise.all([
    prisma.agentProfile.findMany({ where: { deletedAt: null }, select: { enabled: true, capabilities: true } }),
    prisma.automationFlow.findMany({ where: { deletedAt: null }, select: { id: true, enabled: true } }),
    prisma.automationFlowRun.count({ where: { startedAt: { gte: weekAgo } } }),
    prisma.automationFlowRun.count({ where: { status: "WAITING" } }),
    prisma.aiProposal.count({ where: { status: "PENDING_REVIEW" } }),
    // `appliedAt` rather than a generic updated-at: "applied this week" is a claim about when the
    // change landed, and a status edit is not that.
    prisma.aiProposal.count({ where: { appliedAt: { gte: weekAgo } } }),
    getMonthlyAIUsageSummary(),
    summariseLedger()
  ]);

  const catalogue = listCapabilityCatalogue();
  const owned = new Set(profiles.filter((p) => p.enabled).flatMap((p) => (Array.isArray(p.capabilities) ? p.capabilities.map(String) : [])));
  // Resolved rather than the registry ceiling: a ceiling nobody has raised to is not authority the
  // runtime grants, and reporting it as such is the mistake the roster page already avoids.
  const resolved = await Promise.all(catalogue.map((c) => resolveAutonomy(c.id)));
  const aboveSuggest = resolved.filter((r) => r.effectiveLevel !== "SUGGEST").length;

  // Proposal-only is a property of a flow's steps, so it needs the authority calculation. Counted from
  // the decorated flows rather than guessed from the count of AI steps.
  const { listFlows } = await import("./automation-flow.service.js");
  const decorated = await listFlows();

  return {
    aiEnabled: Boolean(settings.aiEnabled),
    captureEnabled: Boolean(settings.aiCaptureEnabled),
    capabilities: {
      total: catalogue.length,
      aboveSuggest,
      unowned: catalogue.filter((c) => !owned.has(c.id)).length
    },
    agents: { total: profiles.length, enabled: profiles.filter((p) => p.enabled).length },
    flows: {
      total: flows.length,
      live: flows.filter((f) => f.enabled).length,
      proposalOnly: decorated.filter((f) => f.enabled && f.authority.proposalOnly).length,
      runsLastWeek: flowRuns,
      waiting
    },
    proposals: { pending, appliedLastWeek },
    spend: {
      monthToDateUsd: usage.totalCostUsd,
      agentDrivenUsd: usage.agentDriven.costUsd,
      byFlowUsd: usage.byFlow.reduce((sum, f) => sum + f.costUsd, 0)
    },
    ledger: { entries: ledger.entries, displacedHours: ledger.displacedHours, unmeasurableEntries: ledger.unmeasurableEntries },
    nextStep: pickNextStep({ settings, profiles, flows, waiting, pending })
  };
}

/**
 * The single most useful thing to do next.
 *
 * Ordered by what blocks what: nothing works with AI off; a flow cannot use a capability no enabled
 * agent owns; a run stuck at a gate is somebody's decision, not a configuration problem — but it is the
 * thing most likely to be forgotten, so it outranks the merely unfinished.
 *
 * Exported for its own test: the ORDER is the whole content of this function, and checking it through
 * `getAiOverview` would mean eight mocked queries to assert one string.
 */
export function pickNextStep(params: {
  settings: { aiEnabled?: boolean | null };
  profiles: Array<{ enabled: boolean }>;
  flows: Array<{ enabled: boolean }>;
  waiting: number;
  pending: number;
}): string | null {
  if (!params.settings.aiEnabled) return "AI is switched off for this workspace, so none of the surfaces below do anything yet.";
  if (params.waiting > 0) {
    return `${params.waiting} workflow run${params.waiting === 1 ? "" : "s"} ${params.waiting === 1 ? "is" : "are"} waiting for somebody to approve a step. Nothing after those steps happens until they do.`;
  }
  if (params.profiles.length === 0) return "No AI teammates yet. Install one from the gallery and it takes ownership of the capabilities it needs.";
  if (params.profiles.every((p) => !p.enabled)) return "Every AI teammate is switched off, so no workflow that uses one can run.";
  if (params.flows.length === 0) return "No workflows yet. A workflow joins a trigger to steps you already have, and replays against real history before you switch it on.";
  if (params.flows.every((f) => !f.enabled)) return "Every workflow is still a draft. Replay one, then switch it on.";
  if (params.pending > 10) return `${params.pending} AI suggestions are waiting for review. A queue nobody clears is a queue that stops being read.`;
  return null;
}
