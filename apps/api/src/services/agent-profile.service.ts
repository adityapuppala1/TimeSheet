/**
 * WHAT: the agent roster — named, scoped, budgeted bundles of capabilities that already run.
 *
 * WHY THIS IS PACKAGING AND NOT AUTHORITY, stated once because every function here depends on it:
 * a profile grants nothing. `AiCapabilitySpec.maxLevel` is the product's ceiling, an administrator
 * may only lower it via `AiCapabilityPolicy`, and `AgentRun.level` remains the record of what a run
 * was actually permitted. A profile adds three things on top: a name a human recognises, a project
 * scope that can only NARROW what the policy already allows, and a daily spend ceiling that sits
 * under every existing one. If a profile could raise a level, it would be a second permission
 * system — and the first thing a second permission system does is disagree with the first.
 *
 * WHY THE PREBUILT ROSTER IS A CODE CATALOGUE AND NOT SEEDED ROWS: rows created by a migration are
 * rows an upgrade switched on, and "nothing turns on by itself" is the rule the MCP write latches
 * were built around. The gallery is inert until an administrator instantiates one, at which point
 * it becomes an ordinary row they own and can edit.
 *
 * WHO CALLS THIS: `controllers/agent.controller.ts`.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { createAgentIdentity } from "./agent-identity.js";
import { AI_CAPABILITIES, findCapability } from "./ai-capability.registry.js";
import { findClaimConflicts, getCapabilityClaims } from "./capability-claims.service.js";
import { resolveAutonomy, type ResolvedAutonomy } from "./ai-autonomy.service.js";
import { getGlobalAISettings } from "./ai.service.js";

/**
 * The built-in gallery. Each template is a bundle of capabilities that genuinely belong to one job,
 * assembled ONLY from ids already in the registry — a template naming a capability that does not
 * exist would be a roster entry that silently does nothing, so `validateCapabilities` refuses it at
 * creation and the test asserts every template survives that check.
 */
export interface AgentTemplate {
  key: string;
  name: string;
  emoji: string;
  description: string;
  capabilities: string[];
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: "triage",
    name: "Triage",
    emoji: "🗂️",
    description:
      "Reads what arrives and files it: sets type, priority and module on new tickets, spots duplicates, and explains the assignee ranking. Everything it touches is a judgement a human can overturn in one click.",
    capabilities: ["triage", "duplicate_detection", "assignee_suggestion_explanation"]
  },
  {
    key: "planner",
    name: "Planner",
    emoji: "🗓️",
    description:
      "Turns an epic into a plan and keeps the schedule honest — proposes child tasks with estimates, suggests date adjustments, and instantiates blueprints. It proposes; it does not move forty dates overnight.",
    capabilities: ["plan_breakdown", "schedule_adjustment", "blueprint_instantiate"]
  },
  {
    key: "risk-watch",
    name: "Risk watch",
    emoji: "📉",
    description:
      "Explains why a project's risk score moved and drafts mitigations for a human to accept. The score itself is arithmetic — this narrates a number it cannot change.",
    capabilities: ["project_risk_narrative", "risk_mitigation"]
  },
  {
    key: "security-desk",
    name: "Security desk",
    emoji: "🛡️",
    description:
      "Triages ingested scanner findings and failing builds, and summarises pull requests. Its input is authored outside the workspace, so its authority is capped and drops to propose-only the moment it reads any.",
    capabilities: ["security_finding_triage", "ci_failure_triage", "pr_review_summary"]
  },
  {
    key: "reporter",
    name: "Reporter",
    emoji: "📰",
    description:
      "Writes the recaps nobody has time to write: the weekly digest, the security digest, the monthly what-keeps-breaking correlation, and stakeholder status reports. Sends mail; changes no records.",
    capabilities: ["weekly_digest", "security_weekly_digest", "bug_pattern_digest", "status_report"]
  },
  {
    key: "load-balancer",
    name: "Load balancer",
    emoji: "⚖️",
    description:
      "Moves bookings off people who are over capacity and onto people with room. Uses no AI at all — the figures are arithmetic over real approved hours — but the question 'how much may this act alone' applies just the same.",
    capabilities: ["assignment_rebalance"]
  }
];

/** Refused rather than silently dropped: a bundle naming an unknown capability is a roster entry
 *  that would appear to do something and do nothing. */
export function validateCapabilities(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new AppError(422, "Capabilities must be a list.");
  const unique = [...new Set(ids.map(String))];
  const unknown = unique.filter((id) => !findCapability(id));
  if (unknown.length > 0) {
    throw new AppError(422, `Unknown capabilit${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}.`);
  }
  if (unique.length === 0) throw new AppError(422, "An agent needs at least one capability.");
  return unique;
}

const asStringArray = (value: Prisma.JsonValue | null): string[] =>
  Array.isArray(value) ? value.map(String) : [];

export interface RosterEntry {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  enabled: boolean;
  templateKey: string | null;
  identity: { id: string; name: string; email: string };
  scopeProjectIds: string[];
  maxCostUsdPerDay: number | null;
  /** Today's spend by this identity's runs, against the ceiling above. */
  spentTodayUsd: number;
  /** Per capability, the level it ACTUALLY has — resolved through the same clamps every caller
   *  reads, so the roster cannot advertise authority a run would not get. */
  capabilities: Array<{
    id: string;
    title: string;
    description: string;
    actsOnUntrustedInput: boolean;
    autonomy: ResolvedAutonomy;
    /** Whether this capability can actually do anything right now: its feature switch is on AND its
     *  effective level is above OFF. Without it, a card could read "On" over a bundle where every
     *  entry was inert — an agent promising work it cannot perform. */
    runnable: boolean;
    /** Set when ANOTHER enabled profile owns this capability. Only possible for a draft, since
     *  enabling with an overlap is refused — a draft showing it is how somebody sees why. */
    claimedByOther: { profileId: string; name: string; emoji: string } | null;
  }>;
  /** Honest summary of the switch. `enabled` says what an administrator asked for; this says what
   *  the workspace can currently deliver. */
  readiness: {
    runnableCount: number;
    /** True when the profile is on but nothing in it can act — the state a green badge would lie
     *  about. The UI says so in words rather than showing a confident "On". */
    enabledButInert: boolean;
  };
  runs: {
    total: number;
    /** The last few, newest first — enough to answer "what has this thing been doing". */
    recent: Array<{
      id: string;
      capability: string;
      status: string;
      trigger: string;
      level: string;
      stepCount: number;
      costUsd: number | null;
      tainted: boolean;
      createdAt: Date;
      finishedAt: Date | null;
      error: string | null;
    }>;
  };
}

/**
 * The roster, with every number resolved rather than stored.
 *
 * Sequential per profile rather than one big `Promise.all`: each entry runs a handful of queries and
 * a roster of ten would otherwise fire fifty at the tenant pool at once — the same per-tenant
 * connection ceiling the goals list is careful about.
 */
export async function listRoster(): Promise<RosterEntry[]> {
  const profiles = await prisma.agentProfile.findMany({
    where: { deletedAt: null },
    include: { identityUser: { select: { id: true, name: true, email: true } } },
    orderBy: [{ enabled: "desc" }, { name: "asc" }]
  });

  // Claims and the AI settings are workspace-wide, so they are fetched ONCE and threaded down.
  // Resolving them inside decorateProfile made the roster N+1 in two dimensions at the same time.
  const shared: DecorateContext = { claims: await getCapabilityClaims(), aiSettings: await getGlobalAISettings() };

  const entries: RosterEntry[] = [];
  for (const profile of profiles) entries.push(await decorateProfile(profile, shared));
  return entries;
}

/** Workspace-wide facts every entry needs. Optional on `decorateProfile` so the single-entry paths
 *  (create, update) stay one call, while the list path fetches them once. */
interface DecorateContext {
  claims: Awaited<ReturnType<typeof getCapabilityClaims>>;
  aiSettings: Awaited<ReturnType<typeof getGlobalAISettings>>;
}

type ProfileRow = Prisma.AgentProfileGetPayload<{ include: { identityUser: { select: { id: true; name: true; email: true } } } }>;

export async function decorateProfile(profile: ProfileRow, ctx?: DecorateContext): Promise<RosterEntry> {
  const capabilityIds = asStringArray(profile.capabilities);
  // Who else owns what, so a draft can explain why enabling it would be refused. The shared map
  // covers every profile, so this one's own claims are filtered out below rather than re-queried.
  const claims = ctx?.claims ?? (await getCapabilityClaims(profile.id));
  // The same AND `describeAutonomyCatalogue` computes for the settings screen: a capability can act
  // only if AI is on for the workspace and its own feature switch is on.
  const aiSettings = ctx?.aiSettings ?? (await getGlobalAISettings());

  const capabilities = [];
  for (const id of capabilityIds) {
    const spec = findCapability(id);
    if (!spec) continue; // Defensive: a capability removed from the registry by a later release.
    const autonomy = await resolveAutonomy(spec.id);
    const owner = claims.get(spec.id) ?? null;
    // A profile never conflicts with itself: when the shared map is used it includes this profile's
    // own claims, so they are discarded here.
    const claim = owner && owner.profileId !== profile.id ? owner : null;
    capabilities.push({
      id: spec.id,
      title: spec.title,
      description: spec.description,
      actsOnUntrustedInput: spec.actsOnUntrustedInput,
      autonomy,
      // A capability with no feature toggle reaches no model (the rebalance producer is arithmetic),
      // so nothing about the AI switches decides whether it can act.
      runnable: spec.featureToggle
        ? Boolean(aiSettings.aiEnabled && (aiSettings as Record<string, unknown>)[spec.featureToggle])
        : true,
      claimedByOther: claim
    });
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const [runTotal, recentRuns, spendToday] = await Promise.all([
    prisma.agentRun.count({ where: { onBehalfOfId: profile.identityUserId } }),
    prisma.agentRun.findMany({
      where: { onBehalfOfId: profile.identityUserId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true, capability: true, status: true, trigger: true, level: true, stepCount: true,
        costUsd: true, taintedAt: true, createdAt: true, finishedAt: true, error: true
      }
    }),
    prisma.agentRun.aggregate({
      _sum: { costUsd: true },
      where: { onBehalfOfId: profile.identityUserId, createdAt: { gte: since } }
    })
  ]);

  return {
    id: profile.id,
    name: profile.name,
    emoji: profile.emoji,
    description: profile.description,
    enabled: profile.enabled,
    templateKey: profile.templateKey,
    identity: profile.identityUser,
    scopeProjectIds: asStringArray(profile.scopeProjectIds),
    maxCostUsdPerDay: profile.maxCostUsdPerDay == null ? null : Number(profile.maxCostUsdPerDay),
    spentTodayUsd: Number(spendToday._sum.costUsd ?? 0),
    capabilities,
    readiness: {
      runnableCount: capabilities.filter((c) => c.runnable).length,
      enabledButInert: profile.enabled && capabilities.length > 0 && capabilities.every((c) => !c.runnable)
    },
    runs: {
      total: runTotal,
      recent: recentRuns.map((r) => ({
        id: r.id,
        capability: r.capability,
        status: r.status,
        trigger: r.trigger,
        level: r.level,
        stepCount: r.stepCount,
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
        // Surfaced because it explains an otherwise baffling "why did this only propose?" — the run
        // read externally-authored text and its authority dropped to SUGGEST for the rest of its life.
        tainted: r.taintedAt !== null,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        error: r.error
      }))
    }
  };
}

export async function createProfile(params: {
  name: string;
  emoji?: string;
  description?: string | null;
  capabilities: unknown;
  scopeProjectIds?: string[];
  maxCostUsdPerDay?: number | null;
  templateKey?: string | null;
  createdById: string;
}): Promise<RosterEntry> {
  const capabilities = validateCapabilities(params.capabilities);
  const identity = await createAgentIdentity({ name: params.name, emoji: params.emoji ?? "🤖" });

  const profile = await prisma.agentProfile.create({
    data: {
      name: params.name,
      emoji: params.emoji ?? "🤖",
      description: params.description ?? null,
      identityUserId: identity.id,
      capabilities,
      scopeProjectIds: params.scopeProjectIds ?? [],
      maxCostUsdPerDay: params.maxCostUsdPerDay ?? null,
      templateKey: params.templateKey ?? null,
      // Never enabled on creation, whatever the caller asks: an administrator reviews the resolved
      // autonomy of the bundle first, on the roster page, and then switches it on deliberately.
      enabled: false,
      createdById: params.createdById
    },
    include: { identityUser: { select: { id: true, name: true, email: true } } }
  });
  return decorateProfile(profile);
}

export async function updateProfile(
  id: string,
  patch: {
    name?: string;
    emoji?: string;
    description?: string | null;
    capabilities?: unknown;
    scopeProjectIds?: string[];
    maxCostUsdPerDay?: number | null;
    enabled?: boolean;
  }
): Promise<RosterEntry> {
  const existing = await prisma.agentProfile.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new AppError(404, "Agent not found.");

  const data: Prisma.AgentProfileUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.emoji !== undefined) data.emoji = patch.emoji;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.capabilities !== undefined) data.capabilities = validateCapabilities(patch.capabilities);
  if (patch.scopeProjectIds !== undefined) data.scopeProjectIds = patch.scopeProjectIds;
  if (patch.maxCostUsdPerDay !== undefined) data.maxCostUsdPerDay = patch.maxCostUsdPerDay;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;

  /**
   * ONE CAPABILITY, ONE OWNER — checked here because ENABLING is where a claim is staked.
   *
   * Two enabled profiles containing the same capability would both describe one
   * `AiCapabilityPolicy`: neither would be the reason it behaved as it did, and switching one off
   * would change nothing. Drafts may overlap as much as they like, which is what makes it possible
   * to build a replacement teammate before retiring the one it replaces.
   *
   * The check runs when the profile will be enabled AFTER this patch — so it catches both "enable
   * me" and "add a capability to an already-enabled me", which is the same conflict arriving by a
   * different route.
   */
  const willBeEnabled = patch.enabled ?? existing.enabled;
  const nextCapabilities = (data.capabilities as string[] | undefined) ?? asStringArray(existing.capabilities);
  if (willBeEnabled && nextCapabilities.length > 0) {
    const conflicts = await findClaimConflicts(nextCapabilities, existing.id);
    if (conflicts.length > 0) {
      const described = conflicts
        .map((c) => `${c.owner.emoji} ${c.owner.name} already covers ${c.capabilities.join(", ")}`)
        .join("; ");
      throw new AppError(
        409,
        `${described}. Two teammates cannot own the same capability — switch that one off first, or remove the overlap here.`
      );
    }
  }

  const profile = await prisma.agentProfile.update({
    where: { id: existing.id },
    data,
    include: { identityUser: { select: { id: true, name: true, email: true } } }
  });

  // The name is the agent's face everywhere it acts, so the identity row follows it — otherwise an
  // audit trail keeps naming a teammate the roster has since renamed.
  if (patch.name !== undefined) {
    await prisma.user.update({ where: { id: profile.identityUserId }, data: { name: patch.name } });
  }
  return decorateProfile(profile);
}

/**
 * Soft delete, and the identity is DEACTIVATED rather than removed: `AuditLog` rows, ticket
 * comments and past runs all point at it, and hard-deleting would either cascade them away or
 * leave them naming nobody. A retired agent should read as "no longer active", not as a gap.
 */
export async function retireProfile(id: string): Promise<void> {
  const profile = await prisma.agentProfile.findFirst({ where: { id, deletedAt: null } });
  if (!profile) throw new AppError(404, "Agent not found.");
  await prisma.$transaction([
    prisma.agentProfile.update({ where: { id: profile.id }, data: { deletedAt: new Date(), enabled: false } }),
    prisma.user.update({ where: { id: profile.identityUserId }, data: { status: "INACTIVE" } })
  ]);
}

/** The gallery, with the templates an administrator has already instantiated marked as such. */
export async function listTemplates(): Promise<Array<AgentTemplate & { installed: boolean }>> {
  const installed = new Set(
    (await prisma.agentProfile.findMany({ where: { deletedAt: null, templateKey: { not: null } }, select: { templateKey: true } }))
      .map((p) => p.templateKey)
      .filter((k): k is string => Boolean(k))
  );
  return AGENT_TEMPLATES.map((t) => ({ ...t, installed: installed.has(t.key) }));
}

/** Every capability the picker can offer, with its ceiling — so a UI cannot present a level the
 *  product does not allow. */
export function listCapabilityCatalogue() {
  return AI_CAPABILITIES.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    maxLevel: c.maxLevel,
    ceilingReason: c.ceilingReason,
    actsOnUntrustedInput: c.actsOnUntrustedInput
  }));
}
