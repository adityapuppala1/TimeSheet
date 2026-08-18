/**
 * WHAT: how much authority one AI capability actually has, right now, in this workspace.
 *
 * TWO INVARIANTS, AND EVERYTHING HERE IS ONE OF THEM:
 *
 *   1. AN AUTONOMY LEVEL IS A CEILING THE CODE SETS AND AN ADMINISTRATOR LOWERS, NEVER ONE AN
 *      ADMINISTRATOR RAISES. `AiCapabilityPolicy.level` is what the workspace asked for;
 *      `AiCapabilitySpec.maxLevel` is what the product permits; the effective level is the
 *      minimum, recomputed on every read — so a row written by an older release, or edited by
 *      hand in the database, cannot outrank the code that has to defend it.
 *
 *   2. AUTONOMY IS AUTHORITY, AND AUTHORITY IS DELEGATED, NEVER HELD. A capability acting above
 *      SUGGEST still acts as a named person and is refused exactly what they are refused. This
 *      file decides how much rope; it never decides whose.
 *
 * WHY THE CLAMP IS APPLIED ON READ AND NOT ONLY ON WRITE: writing is where a mistake is *made*,
 * reading is where it is *used*. The settings route refuses an over-ceiling value, and this
 * refuses it again on the way out, because those two defend against different things — the first
 * against a bad request, the second against a row that got there some other way. Redundancy is the
 * house style here: the AI budget is bounded three times, and the MCP disabled-tool gate exists in
 * both the registry and the dispatcher.
 */
import { Prisma, type AiAutonomyLevel } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { getCapabilityClaims } from "./capability-claims.service.js";
import { AppError } from "../middleware/error.js";
import { getGlobalAISettings } from "./ai.service.js";
import { AI_CAPABILITIES, findCapability, levelRank, type AiCapabilitySpec } from "./ai-capability.registry.js";

export interface ResolvedAutonomy {
  capability: string;
  /** What the workspace asked for (SUGGEST when no row exists). */
  requestedLevel: AiAutonomyLevel;
  /** What it actually gets, after every clamp below. This is the only value a caller should act on. */
  effectiveLevel: AiAutonomyLevel;
  /** The product's ceiling for this capability, for the UI to render the locked rungs. */
  maxLevel: AiAutonomyLevel;
  /** Populated when effectiveLevel is below requestedLevel — the UI says why rather than
   *  silently showing a different value than the administrator selected. */
  clampedReason: string | null;
  guardrails: {
    maxChangesPerRun: number | null;
    maxRunsPerDay: number | null;
    maxCostUsdPerRun: number | null;
    undoWindowHours: number | null;
    scopeProjectIds: string[] | null;
  };
}

const FLOOR: AiAutonomyLevel = "SUGGEST";

function min(a: AiAutonomyLevel, b: AiAutonomyLevel): AiAutonomyLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

function toStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

/**
 * The one function anything should ask "may this capability act?".
 *
 * Returns the FLOOR — never throws — for an unrecognised capability id. A policy row naming a
 * capability this build does not have is a stale row from a newer or older release, and the safe
 * reading of "I don't know what this is" is "then it may not act", not a 500 in someone's request.
 */
export async function resolveAutonomy(capabilityId: string): Promise<ResolvedAutonomy> {
  const [settings, row] = await Promise.all([
    getGlobalAISettings(),
    prisma.aiCapabilityPolicy.findUnique({ where: { capability: capabilityId } })
  ]);
  return computeAutonomy(capabilityId, row, settings);
}

/**
 * The rule itself, with no I/O — so the catalogue can evaluate twenty-two capabilities from ONE
 * settings read and ONE query instead of forty-four. Splitting it out is not just efficiency:
 * `getGlobalAISettings` is an upsert, and calling it once per capability meant the settings screen
 * wrote to the database twenty-two times to render a read-only list.
 */
function computeAutonomy(
  capabilityId: string,
  row: { level: AiAutonomyLevel; maxChangesPerRun: number | null; maxRunsPerDay: number | null; maxCostUsdPerRun: unknown; undoWindowHours: number | null; scopeProjectIds: unknown } | null,
  settings: Awaited<ReturnType<typeof getGlobalAISettings>>
): ResolvedAutonomy {
  const spec = findCapability(capabilityId);

  const requestedLevel = row?.level ?? FLOOR;
  const maxLevel = spec?.maxLevel ?? FLOOR;

  const guardrails = {
    maxChangesPerRun: row?.maxChangesPerRun ?? null,
    maxRunsPerDay: row?.maxRunsPerDay ?? null,
    maxCostUsdPerRun: row?.maxCostUsdPerRun == null ? null : Number(row.maxCostUsdPerRun),
    undoWindowHours: row?.undoWindowHours ?? null,
    scopeProjectIds: toStringArray(row?.scopeProjectIds)
  };

  const base = { capability: capabilityId, requestedLevel, maxLevel, guardrails };
  const clamp = (reason: string): ResolvedAutonomy =>
    ({ ...base, effectiveLevel: FLOOR, clampedReason: requestedLevel === FLOOR ? null : reason });

  // Order matters only for which reason the UI shows; each of these independently forces the floor.
  if (!spec) return clamp("This build does not recognise that capability.");
  if (!settings.aiEnabled) return clamp("AI is switched off for this workspace.");
  // A capability with no toggle reaches no model, so there is no AI switch that could be off.
  if (spec.featureToggle && !settings[spec.featureToggle]) return clamp("This capability itself is switched off.");
  if (!settings.aiAutonomyEnabled) return clamp("Autonomy is switched off for this workspace.");

  /*
   * COMPATIBILITY: `autoTriageAutoApply` predates this ladder and is the same decision wearing a
   * different name — its own schema comment says "AI triage suggestions are applied directly".
   * Left independent, a workspace could have the toggle on and the level at SUGGEST and the two
   * would disagree about whether triage applies itself, which is exactly the confusion two
   * controls for one thing produces.
   *
   * Read as a FLOOR, not an override: it can raise triage to AUTO_APPLY for a workspace that
   * already had it on, and it can never lower a level somebody has since chosen deliberately.
   */
  const legacyFloor: AiAutonomyLevel =
    capabilityId === "triage" && (settings as Record<string, unknown>).autoTriageAutoApply === true ? "AUTO_APPLY" : FLOOR;
  const asked = levelRank(legacyFloor) > levelRank(requestedLevel) ? legacyFloor : requestedLevel;

  const effectiveLevel = min(asked, maxLevel);
  return {
    ...base,
    effectiveLevel,
    clampedReason:
      levelRank(effectiveLevel) < levelRank(asked)
        ? spec.ceilingReason ?? "This capability is capped by the product."
        : null
  };
}

/**
 * Throws unless the capability currently holds at least `required`.
 *
 * This is what `ai-proposal.service.ts#applyProposal` calls on its own behalf when the applier is
 * an agent. That placement is the point: there is exactly ONE function in this codebase that
 * writes an AI-authored change, and it interrogates the policy itself rather than trusting its
 * caller to have done so — the same discipline that makes `invokeMcpTool` the one door for tools.
 * A capability added in a hurry that forgets to check gets refused by the only function it can use
 * to act.
 */
export async function assertLevelAtLeast(capabilityId: string, required: AiAutonomyLevel): Promise<ResolvedAutonomy> {
  const resolved = await resolveAutonomy(capabilityId);
  if (levelRank(resolved.effectiveLevel) < levelRank(required)) {
    throw new AppError(
      403,
      resolved.clampedReason
        ? `"${capabilityId}" may only suggest — ${resolved.clampedReason}`
        : `"${capabilityId}" is set to ${resolved.effectiveLevel} and this action needs ${required}.`
    );
  }
  return resolved;
}

export interface AutonomyCatalogueEntry extends ResolvedAutonomy {
  title: string;
  description: string;
  ceilingReason: string | null;
  actsOnUntrustedInput: boolean;
  /** Whether the underlying feature is on at all — the UI greys the whole row when it is not,
   *  rather than showing a level that cannot currently apply to anything. */
  featureEnabled: boolean;
  /** Which agent on the roster owns this capability, when one does (V8 phase 3 fix).
   *
   *  WHY THE SETTINGS SCREEN NEEDS TO SAY THIS: once the roster existed, the same twenty-two
   *  capabilities appeared on two screens with no cross-reference, so an administrator lowering a
   *  level here had no way to know a named teammate depends on it. The claim is display-only —
   *  `AiCapabilityPolicy` remains the single lever — but it turns "some capability" into
   *  "🗂️ Triage's ticket triage", which is what makes the consequence of the edit visible. */
  claimedBy: { profileId: string; name: string; emoji: string } | null;
  /** The GlobalAISettings switch that turns this capability on, so ONE row can carry both
   *  controls. Null for a capability that reaches no model and therefore has no switch.
   *
   *  WHY THE UI NEEDS THIS: "does it run" and "how much authority when it runs" are different
   *  questions, but they are questions about the SAME capability — and asking them in two separate
   *  lists of twenty-odd rows made the screen look like it held two copies of everything. */
  featureToggle: string | null;
}

/**
 * The whole ladder, for the settings screen.
 *
 * Returns `effectiveLevel` alongside `requestedLevel` deliberately: the UI must never re-derive
 * the clamping rule. Two implementations of "what is this actually set to" is how a screen ends up
 * confidently showing an administrator a level the server does not agree with.
 *
 * Mirrors `mcp.service.ts#describeMcpCatalogue`, which exists for the same reason.
 */
export async function describeAutonomyCatalogue(): Promise<{ autonomyEnabled: boolean; capabilities: AutonomyCatalogueEntry[] }> {
  const [settings, rows, claims] = await Promise.all([
    getGlobalAISettings(),
    prisma.aiCapabilityPolicy.findMany(),
    getCapabilityClaims()
  ]);
  const byCapability = new Map(rows.map((r) => [r.capability, r]));

  const capabilities = AI_CAPABILITIES.map((spec: AiCapabilitySpec): AutonomyCatalogueEntry => ({
    ...computeAutonomy(spec.id, byCapability.get(spec.id) ?? null, settings),
    title: spec.title,
    description: spec.description,
    ceilingReason: spec.ceilingReason,
    actsOnUntrustedInput: spec.actsOnUntrustedInput,
    claimedBy: claims.get(spec.id) ?? null,
    featureToggle: spec.featureToggle,
    // A capability with no toggle reaches no model, so nothing about the AI switches
    // determines whether it is available.
    featureEnabled: spec.featureToggle ? Boolean(settings.aiEnabled && settings[spec.featureToggle]) : true
  }));

  return { autonomyEnabled: Boolean(settings.aiAutonomyEnabled), capabilities };
}

/**
 * Write what a workspace asked for, refusing anything above the product's ceiling.
 *
 * The 422 here is the FIRST of the two clamps — `resolveAutonomy` applies the same rule again on
 * read. Refusing loudly at write time is what lets an administrator find out immediately, rather
 * than saving a value that silently does nothing.
 */
export async function setCapabilityLevel(params: {
  capability: string;
  level: AiAutonomyLevel;
  updatedById: string;
  guardrails?: Partial<{
    maxChangesPerRun: number | null;
    maxRunsPerDay: number | null;
    maxCostUsdPerRun: number | null;
    undoWindowHours: number | null;
    scopeProjectIds: string[] | null;
  }>;
}): Promise<ResolvedAutonomy> {
  const spec = findCapability(params.capability);
  if (!spec) throw new AppError(404, `Unknown AI capability "${params.capability}".`);

  if (levelRank(params.level) > levelRank(spec.maxLevel)) {
    const why = spec.ceilingReason ?? `The highest level this capability allows is ${spec.maxLevel}.`;
    throw new AppError(422, `"${spec.title}" cannot be set to ${params.level}. ${why}`);
  }

  // `scopeProjectIds` is a nullable Json column, and Prisma will not take a bare `null` for one —
  // it needs `DbNull` to mean "store SQL NULL", because `null` is ambiguous with the JSON value
  // `null`. Pulled out so the rest can spread untouched.
  const { scopeProjectIds, ...scalarGuardrails } = params.guardrails ?? {};
  const data = {
    level: params.level,
    updatedById: params.updatedById,
    // Spreading `undefined` contributes nothing, so an omitted guardrails object leaves every
    // guardrail column exactly as it was rather than blanking it.
    ...scalarGuardrails,
    ...(scopeProjectIds === undefined ? {} : { scopeProjectIds: scopeProjectIds ?? Prisma.DbNull })
  };
  await prisma.aiCapabilityPolicy.upsert({
    where: { capability: params.capability },
    update: data,
    create: { capability: params.capability, ...data }
  });

  return resolveAutonomy(params.capability);
}
