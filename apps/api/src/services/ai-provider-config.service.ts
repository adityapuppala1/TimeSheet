/**
 * WHAT: CRUD + reordering for `AIProviderConfig` — the ranked BYOK list a Super Admin manages in
 * Workspace Settings → AI (V9, provider-priority). Reading the ENABLED subset in priority order
 * for actual dispatch lives in `ai.service.ts#getEnabledProviderConfigs` (the function `callChat`
 * calls); this file is the admin-facing management surface over the same table.
 *
 * WHY A SEPARATE FILE FROM `ai.service.ts`: that file is already the largest in the codebase and
 * is the one place every AI capability calls through — CRUD for a settings list is a different
 * concern (who can add/reorder/remove a provider) from dispatch (which provider answers a call),
 * the same separation `ai-usage-export.service.ts` already draws from it.
 */
import { resolveProviderLabel } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { encryptSecret } from "../utils/encryption.js";

const SELECT_PUBLIC = {
  id: true,
  provider: true,
  label: true,
  baseUrl: true,
  model: true,
  enabled: true,
  priority: true,
  consecutiveFailures: true,
  autoDemotedAt: true,
  createdAt: true,
  updatedAt: true
} as const;

/** "is it working RIGHT NOW", derived from the most recent real traffic — not the 30-day history
 *  {@link getSuggestedProviderOrder} ranks on. `unknown` means no attempts in the window, not a
 *  problem: a freshly-added row, or one sitting disabled/low-priority long enough not to have been
 *  tried recently. */
export type ProviderHealthStatus = "healthy" | "degraded" | "down" | "unknown";

const STATUS_WINDOW_MINUTES = 15;
/** Per-label cap on how many recent attempts feed the status, not a query LIMIT — a provider
 *  taking 200 calls in the window should be judged on its last 20, not diluted by the other 180. */
const STATUS_WINDOW_MAX_CALLS_PER_LABEL = 20;

/**
 * Buckets the last {@link STATUS_WINDOW_MINUTES} of `AIUsageLog` by resolved provider label (the
 * same join key {@link getSuggestedProviderOrder} uses, and the same limitation: two configs
 * sharing one label are indistinguishable) and scores each: `healthy` at ≥80% success,
 * `degraded` above 0%, `down` at exactly 0% with at least one attempt. A single flat query rather
 * than a groupBy, because "last N per group" isn't expressible as one — acceptable here since a
 * 15-minute window at real AI call volumes is a small row count, not a hot path.
 */
export async function computeRecentStatusByLabel(): Promise<Map<string, ProviderHealthStatus>> {
  const since = new Date(Date.now() - STATUS_WINDOW_MINUTES * 60_000);
  const rows = await prisma.aIUsageLog.findMany({
    where: { createdAt: { gte: since } },
    select: { provider: true, success: true },
    orderBy: { createdAt: "desc" },
    take: 500
  });

  const outcomesByLabel = new Map<string, boolean[]>();
  for (const row of rows) {
    const label = row.provider ?? "Unknown";
    const outcomes = outcomesByLabel.get(label) ?? [];
    if (outcomes.length < STATUS_WINDOW_MAX_CALLS_PER_LABEL) {
      outcomes.push(row.success);
      outcomesByLabel.set(label, outcomes);
    }
  }

  const statusByLabel = new Map<string, ProviderHealthStatus>();
  for (const [label, outcomes] of outcomesByLabel) {
    const successRate = outcomes.filter(Boolean).length / outcomes.length;
    let status: ProviderHealthStatus = "down";
    if (successRate >= 0.8) status = "healthy";
    else if (successRate > 0) status = "degraded";
    statusByLabel.set(label, status);
  }
  return statusByLabel;
}

/** Never returns the key itself — same masking convention as GlobalAISettings.apiKey and every
 *  other BYOK-shaped secret in this app: the client sees `apiKeySet`, never the ciphertext or the
 *  plaintext. Adds the derived `status` (see {@link computeRecentStatusByLabel}) so the settings
 *  UI can show it without a second round trip. */
export async function listProviderConfigs() {
  const [rows, statusByLabel] = await Promise.all([
    prisma.aIProviderConfig.findMany({ orderBy: { priority: "asc" }, select: { ...SELECT_PUBLIC, apiKey: true } }),
    computeRecentStatusByLabel()
  ]);
  return rows.map(({ apiKey, ...rest }) => ({
    ...rest,
    apiKeySet: Boolean(apiKey),
    status: statusByLabel.get(resolveProviderLabel(rest.provider, rest.baseUrl)) ?? ("unknown" as ProviderHealthStatus)
  }));
}

export interface ProviderConfigInput {
  provider: "ANTHROPIC" | "OPENAI_COMPATIBLE";
  label?: string | null;
  baseUrl?: string | null;
  apiKey?: string;
  model: string;
  enabled?: boolean;
}

/** New rows append to the end of the priority order — an admin adding a provider is adding a
 *  fallback, not silently promoting it ahead of whatever they already trusted more. */
export async function createProviderConfig(input: ProviderConfigInput, actorId: string) {
  const last = await prisma.aIProviderConfig.findFirst({ orderBy: { priority: "desc" }, select: { priority: true } });
  const created = await prisma.aIProviderConfig.create({
    data: {
      provider: input.provider,
      label: input.label ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKey: input.apiKey ? encryptSecret(input.apiKey) : null,
      model: input.model,
      enabled: input.enabled ?? true,
      priority: (last?.priority ?? -1) + 1
    },
    select: SELECT_PUBLIC
  });
  await audit(actorId, "settings.ai_provider_added", "AIProviderConfig", created.id, { provider: created.provider, model: created.model });
  return { ...created, apiKeySet: Boolean(input.apiKey) };
}

export async function updateProviderConfig(id: string, input: Partial<ProviderConfigInput>, actorId: string) {
  const existing = await prisma.aIProviderConfig.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "That provider configuration no longer exists — refresh and retry.");

  const data: Record<string, unknown> = {};
  if (input.provider !== undefined) data.provider = input.provider;
  if (input.label !== undefined) data.label = input.label;
  if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl;
  if (input.model !== undefined) data.model = input.model;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  // Write-only, same convention as GlobalAISettings.apiKey: absent = leave the stored key
  // untouched, "" clears it, anything else replaces it.
  if (typeof input.apiKey === "string") data.apiKey = input.apiKey.length > 0 ? encryptSecret(input.apiKey) : null;
  // A human just touched this row — whatever the breaker did to it stops being the last word.
  data.autoDemotedAt = null;

  const updated = await prisma.aIProviderConfig.update({ where: { id }, data, select: { ...SELECT_PUBLIC, apiKey: true } });
  await audit(actorId, "settings.ai_provider_updated", "AIProviderConfig", id, { fields: Object.keys(input) });
  const { apiKey, ...rest } = updated;
  return { ...rest, apiKeySet: Boolean(apiKey) };
}

export async function deleteProviderConfig(id: string, actorId: string) {
  const existing = await prisma.aIProviderConfig.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "That provider configuration no longer exists — refresh and retry.");
  // Not "the last enabled one" — a workspace with zero configured rows still works via the
  // implicit ANTHROPIC/env-key default (see ai.service.ts#getEnabledProviderConfigs), so refusing
  // to delete the last row would be protecting against a state that was never actually unsafe.
  await prisma.aIProviderConfig.delete({ where: { id } });
  await audit(actorId, "settings.ai_provider_removed", "AIProviderConfig", id, { provider: existing.provider, model: existing.model });
}

/**
 * Rewrites priority to match `orderedIds`' position — the whole list, not a delta, because a
 * drag-reorder UI always knows the full resulting order and a partial "move X above Y" API would
 * need to re-derive exactly the same thing from two positions anyway.
 */
export async function reorderProviderConfigs(orderedIds: string[], actorId: string) {
  const existing = await prisma.aIProviderConfig.findMany({ select: { id: true } });
  const existingIds = new Set(existing.map((row) => row.id));
  if (orderedIds.length !== existing.length || orderedIds.some((id) => !existingIds.has(id))) {
    throw new AppError(422, "That reorder doesn't match the current provider list — refresh and retry.");
  }
  // A human just chose this order — any position the breaker set automatically stops being the
  // last word the moment a person picks one instead, applied or not.
  await prisma.$transaction(
    orderedIds.map((id, index) => prisma.aIProviderConfig.update({ where: { id }, data: { priority: index, autoDemotedAt: null } }))
  );
  await audit(actorId, "settings.ai_providers_reordered", "AIProviderConfig", undefined, { order: orderedIds });
  return listProviderConfigs();
}

/** Recent-history window the suggestion is scored over — long enough to smooth out a single bad
 *  day, short enough that a provider's rank keeps up with how it's actually been performing. */
const SUGGESTION_LOOKBACK_DAYS = 30;

export interface SuggestedProviderOrderEntry {
  id: string;
  label: string;
  successRatePct: number | null;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  calls: number;
}

/**
 * Ranks the CURRENT provider list by how it's actually performed over the last 30 days — the data
 * `callChat`'s failure logging (AIUsageLog.success) and latency capture exist to make possible.
 * Returns a SUGGESTION (an ordered id list an admin applies with the existing reorder endpoint),
 * never an automatic change — this product's own autonomy ladder treats "act on my own" as the
 * rung requiring explicit opt-in for everything else it touches, and re-prioritizing which
 * provider handles every AI call in the workspace is not a place to make an exception.
 *
 * Ranked by success rate first (a fast, cheap provider that fails a quarter of the time is not
 * actually a good primary), then avg latency, then avg cost — lexicographic, not a single blended
 * score, so the reasoning is legible rather than an opaque number. A provider with no calls in the
 * window (successRatePct: null) is neither rewarded nor penalized: it's placed after every proven
 * provider rather than competing with them on no evidence, but ranked among itself by the list's
 * current relative order (a stable sort), not alphabetically or arbitrarily.
 *
 * KNOWN LIMITATION: `AIUsageLog.provider` is the resolved DISPLAY label (see resolveProviderLabel),
 * not a foreign key to a specific config row — two configs pointing at the exact same
 * provider+baseUrl (e.g. two Groq keys as failover) are indistinguishable in the usage ledger and
 * will be scored identically. Rare in practice (why configure two rows for the same endpoint?),
 * and the degradation is a tie broken by existing order, not a wrong or crashing answer.
 */
export async function getSuggestedProviderOrder(): Promise<{ suggestedOrderIds: string[]; reasoning: SuggestedProviderOrderEntry[] }> {
  const configs = await prisma.aIProviderConfig.findMany({
    orderBy: { priority: "asc" },
    select: { id: true, provider: true, label: true, baseUrl: true }
  });
  if (configs.length === 0) return { suggestedOrderIds: [], reasoning: [] };

  const since = new Date();
  since.setDate(since.getDate() - SUGGESTION_LOOKBACK_DAYS);

  const [successSplit, successStats] = await Promise.all([
    prisma.aIUsageLog.groupBy({ by: ["provider", "success"], where: { createdAt: { gte: since } }, _count: true }),
    // Latency/cost only meaningful for calls that actually went through — a failed attempt's 0
    // cost and null duration would just dilute the average toward "cheap and fast", which is
    // exactly backwards for a provider that mostly fails.
    prisma.aIUsageLog.groupBy({
      by: ["provider"],
      where: { createdAt: { gte: since }, success: true },
      _avg: { durationMs: true, costUsdEstimate: true }
    })
  ]);

  const successByLabel = new Map<string, { successCount: number; failureCount: number }>();
  for (const row of successSplit) {
    const key = row.provider ?? "Unknown";
    const entry = successByLabel.get(key) ?? { successCount: 0, failureCount: 0 };
    if (row.success) entry.successCount += row._count;
    else entry.failureCount += row._count;
    successByLabel.set(key, entry);
  }
  const statsByLabel = new Map(successStats.map((row) => [row.provider ?? "Unknown", row]));

  const reasoning: SuggestedProviderOrderEntry[] = configs.map((config) => {
    // The join key MUST match what logAIUsage actually wrote (resolveProviderLabel on the
    // config's provider/baseUrl) — an admin's custom label is display-only and never reaches the
    // usage ledger, so it cannot be part of this lookup.
    const resolvedLabel = resolveProviderLabel(config.provider, config.baseUrl);
    const split = successByLabel.get(resolvedLabel);
    const stats = statsByLabel.get(resolvedLabel);
    const calls = (split?.successCount ?? 0) + (split?.failureCount ?? 0);
    return {
      id: config.id,
      label: config.label?.trim() || resolvedLabel,
      successRatePct: calls === 0 ? null : Number((((split?.successCount ?? 0) / calls) * 100).toFixed(1)),
      avgLatencyMs: stats?._avg.durationMs == null ? null : Math.round(stats._avg.durationMs),
      avgCostUsd: stats?._avg.costUsdEstimate == null ? null : Number(stats._avg.costUsdEstimate),
      calls
    };
  });

  const ranked = [...reasoning].sort((a, b) => {
    if (a.successRatePct === null && b.successRatePct === null) return 0;
    if (a.successRatePct === null) return 1;
    if (b.successRatePct === null) return -1;
    if (a.successRatePct !== b.successRatePct) return b.successRatePct - a.successRatePct;
    if (a.avgLatencyMs !== b.avgLatencyMs) return (a.avgLatencyMs ?? Infinity) - (b.avgLatencyMs ?? Infinity);
    return (a.avgCostUsd ?? Infinity) - (b.avgCostUsd ?? Infinity);
  });

  return { suggestedOrderIds: ranked.map((r) => r.id), reasoning };
}

/** 30-day avg cost per successful call, by resolved provider label — the same stat
 *  {@link getSuggestedProviderOrder} computes for its own reasoning, factored out so
 *  `getEnabledProviderConfigsForTask`'s economy-tier ordering (ai.service.ts) can reuse it
 *  without a second, subtly-different query. Success-only for the same reason as there: a failed
 *  attempt costs nothing, and its 0 would drag the average toward "cheap" for exactly the
 *  providers that are actually failing. */
export async function computeRecentAvgCostByLabel(): Promise<Map<string, number>> {
  const since = new Date();
  since.setDate(since.getDate() - SUGGESTION_LOOKBACK_DAYS);
  const stats = await prisma.aIUsageLog.groupBy({
    by: ["provider"],
    where: { createdAt: { gte: since }, success: true },
    _avg: { costUsdEstimate: true }
  });
  const costByLabel = new Map<string, number>();
  for (const row of stats) {
    if (row._avg.costUsdEstimate != null) costByLabel.set(row.provider ?? "Unknown", Number(row._avg.costUsdEstimate));
  }
  return costByLabel;
}

/** Consecutive-failure threshold that trips the circuit breaker. Small and fixed rather than
 *  admin-tunable: this exists to react fast to a genuinely broken provider, and a knob invites
 *  tuning it into uselessness the first time a normally-fine provider has one bad afternoon. */
const AUTO_FAILOVER_THRESHOLD = 3;

/**
 * The circuit breaker's only entry point — called once per attempt from `callChat`'s dispatch
 * loop (ai.service.ts), for every real config it tries. A success always resets the counter to 0;
 * a failure increments it and, once it reaches {@link AUTO_FAILOVER_THRESHOLD} AND
 * `GlobalAISettings.aiAutoFailoverEnabled` is on, demotes the row to the back of the ENABLED
 * priority order with no human involved — see the schema comment on `aiAutoFailoverEnabled` for
 * why this never promotes a row back automatically afterward.
 *
 * `configId` is null for the synthesized implicit default (no real `AIProviderConfig` row exists,
 * see `getEnabledProviderConfigs`) — nothing to track for a row that isn't real, so this is a
 * no-op in that case.
 */
export async function recordProviderAttemptOutcome(configId: string | null, success: boolean): Promise<void> {
  if (!configId) return;

  if (success) {
    // Only write when there's actually something to reset — the overwhelming majority of calls
    // succeed, and bumping updatedAt on every one of them for a no-op reset is pure waste.
    await prisma.aIProviderConfig.updateMany({ where: { id: configId, consecutiveFailures: { gt: 0 } }, data: { consecutiveFailures: 0 } });
    return;
  }

  let updated;
  try {
    updated = await prisma.aIProviderConfig.update({
      where: { id: configId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { consecutiveFailures: true }
    });
  } catch {
    // Deleted between the failed attempt and this write (an admin removing a provider mid-flight)
    // — nothing left to track.
    return;
  }
  if (updated.consecutiveFailures < AUTO_FAILOVER_THRESHOLD) return;

  const settings = await prisma.globalAISettings.findUnique({ where: { id: "global" }, select: { aiAutoFailoverEnabled: true } });
  if (!settings?.aiAutoFailoverEnabled) return;

  await demoteToBackOfEnabledOrder(configId);
}

/** Moves one row to the end of the currently ENABLED priority order, leaving disabled rows'
 *  priority untouched — dispatch only ever reads the enabled subset, so this is correct for
 *  behavior even though it can leave priority numbers non-contiguous across the full (enabled +
 *  disabled) list. Self-heals the next time a human reorders: `reorderProviderConfigs` always
 *  renumbers everything it's given from scratch. */
async function demoteToBackOfEnabledOrder(configId: string): Promise<void> {
  const enabled = await prisma.aIProviderConfig.findMany({ where: { enabled: true }, orderBy: { priority: "asc" }, select: { id: true } });
  const index = enabled.findIndex((row) => row.id === configId);
  // Not found (disabled or deleted since the failure), or already last: nothing to move.
  if (index === -1 || index === enabled.length - 1) return;

  const reordered = [...enabled.slice(0, index), ...enabled.slice(index + 1), enabled[index]];
  await prisma.$transaction([
    ...reordered.map((row, i) => prisma.aIProviderConfig.update({ where: { id: row.id }, data: { priority: i } })),
    prisma.aIProviderConfig.update({ where: { id: configId }, data: { consecutiveFailures: 0, autoDemotedAt: new Date() } })
  ]);
  // No actorId — this is the one write in this file a human didn't make. actorType: SYSTEM (not
  // the default USER) records that on the row itself, same convention as the SLA sweeps; the
  // "auto-demoted" tag in the UI reads autoDemotedAt to say so explicitly too, rather than looking
  // like a silent manual reorder.
  await audit(undefined, "settings.ai_provider_auto_demoted", "AIProviderConfig", configId, {
    reason: `${AUTO_FAILOVER_THRESHOLD} consecutive failures`
  }, {
    actorType: "SYSTEM",
    actorLabel: "ai-provider-circuit-breaker"
  });
}
