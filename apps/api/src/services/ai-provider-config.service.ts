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
  createdAt: true,
  updatedAt: true
} as const;

/** Never returns the key itself — same masking convention as GlobalAISettings.apiKey and every
 *  other BYOK-shaped secret in this app: the client sees `apiKeySet`, never the ciphertext or the
 *  plaintext. */
export async function listProviderConfigs() {
  const rows = await prisma.aIProviderConfig.findMany({
    orderBy: { priority: "asc" },
    select: { ...SELECT_PUBLIC, apiKey: true }
  });
  return rows.map(({ apiKey, ...rest }) => ({ ...rest, apiKeySet: Boolean(apiKey) }));
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
  await prisma.$transaction(orderedIds.map((id, index) => prisma.aIProviderConfig.update({ where: { id }, data: { priority: index } })));
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
