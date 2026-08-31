/**
 * WHAT: the vocabulary of per-org feature overrides, and the one rule that decides whether an
 * override GRANTS something the plan does not include.
 *
 * WHY IT IS A UTIL AND NOT PART OF THE SERVICE. Two modules need this and they sit on opposite
 * sides of a dependency: `plan-limits.service.ts` applies overrides on every entitlement check, and
 * `platform-feature-overrides.service.ts` writes them (and has to ask `plan-limits` what tier the
 * workspace is effectively on to judge them). Putting the rule in either service makes the two
 * import each other. It is pure, it has no database and no clock, so it belongs here.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE THAT MATTERS: AN OVERRIDE MAY NEVER SILENTLY GRANT PAST THE PLAN.
 *
 * Restricting is unremarkable — a workspace held below its tier is a decision with no commercial
 * consequence, and it fails in the safe direction. GRANTING is different: it hands out something
 * the plan says the customer does not have, it is invisible on every screen that reads the tier,
 * and six months later nobody remembers whether it was a considered exception or a typo.
 *
 * `classifyOverrides` is the single definition of "grants" in this codebase. The write route uses
 * it to decide whether to demand an explicit acknowledgement, the audit row uses it to name what
 * was handed out, and the console uses it to paint the row — three readers, one rule, so the
 * warning and the enforcement cannot disagree about which keys are the dangerous ones.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE KEYS ARE AN ALLOWLIST, AND IT IS EXACTLY WHAT `plan-limits.service.ts` READS. Not one key
 * more. An override for something no resolver consults would be a switch in the console that does
 * nothing, which is worse than no switch: an operator would set it, tell a customer, and be wrong.
 * `seatLimitOverride` and `aiMonthlyBudgetCeilingOverride` are deliberately NOT here either — they
 * already have their own columns and their own reader, and two places to set one number is a bug
 * waiting for the day they disagree.
 */

/**
 * Every overridable entitlement, and its shape.
 *
 * `"boolean"` keys are capabilities: true is more entitled than false.
 * `"quota"` keys are ceilings: a bigger number is more entitled than a smaller one.
 * That one sentence is the whole definition of "grants", which is why the map carries the kind
 * rather than each call site knowing it.
 */
export const OVERRIDABLE_FEATURES = {
  faceVerificationEnabled: "boolean",
  ganttEnabled: "boolean",
  resourceMgmtEnabled: "boolean",
  approvalsEnabled: "boolean",
  proofingEnabled: "boolean",
  customWorkflowsEnabled: "boolean",
  aiPmCopilotEnabled: "boolean",
  goalsEnabled: "boolean",
  changeManagementEnabled: "boolean",
  practiceUpdateEnabled: "boolean",
  maxPortfolios: "quota",
  maxRequestForms: "quota",
  maxBlueprints: "quota",
  maxCustomFields: "quota",
  maxDashboards: "quota",
  maxGoals: "quota",
  maxChangePolicies: "quota"
} as const;

export type FeatureOverrideKey = keyof typeof OVERRIDABLE_FEATURES;
export type FeatureOverrideValue = boolean | number;
export type FeatureOverrides = Partial<Record<FeatureOverrideKey, FeatureOverrideValue>>;

export const FEATURE_OVERRIDE_KEYS = Object.keys(OVERRIDABLE_FEATURES) as FeatureOverrideKey[];

const isOverridableKey = (key: string): key is FeatureOverrideKey => key in OVERRIDABLE_FEATURES;

/**
 * The largest quota an override may set.
 *
 * WHY THERE IS A CEILING AT ALL. Every quota here is a COUNT of things a workspace may create —
 * portfolios, dashboards, custom fields. "Unlimited" is not spelled with a big number in this
 * product, and a typed `100000000` is far more likely to be a slipped keyboard than a decision;
 * stored, it is indistinguishable from one. A million is comfortably beyond any real workspace and
 * near enough to be obviously wrong when somebody meant fifty.
 *
 * ONE CONSTANT, TWO READERS. The route's zod schema and `validateOverrideInput` below both use it,
 * so the number the API advertises and the number it enforces cannot drift apart.
 */
export const MAX_QUOTA_OVERRIDE = 1_000_000;

/**
 * Whatever is in the JSON column, reduced to overrides this build understands.
 *
 * FAILS QUIET AND CLOSED. A key outside the allowlist, a value of the wrong shape, a quota that is
 * negative or not an integer — all dropped, none thrown. This runs inside every entitlement check
 * in the product, so a malformed column must cost the workspace its override and nothing else: a
 * throw here would turn one bad JSON value into a workspace-wide outage, and honouring an unknown
 * key would let a typo — or a key from a build that has since been rolled back — entitle somebody.
 */
export function readFeatureOverrides(raw: unknown): FeatureOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FeatureOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isOverridableKey(key)) continue;
    if (OVERRIDABLE_FEATURES[key] === "boolean") {
      if (typeof value === "boolean") out[key] = value;
    } else if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

export interface OverrideValidation {
  /** The overrides that survived — exactly what `readFeatureOverrides` would have kept. */
  clean: FeatureOverrides;
  /** One readable sentence per rejected value, naming the key. Empty means the input was sound. */
  errors: string[];
}

/**
 * The WRITE path's reading of the same input, which REFUSES what the read path quietly drops.
 *
 * WHY THE TWO ARE DIFFERENT, AND WHY THAT IS NOT A DUPLICATED RULE. `readFeatureOverrides` runs
 * inside every entitlement check in the product against a column that is already stored; the only
 * safe thing it can do with a bad value is ignore it, because throwing would turn one malformed
 * JSON value into a workspace-wide outage. This function runs once, on a person's click, against
 * input they can still fix — and there, silence is the wrong answer. An operator who types `-5`
 * into a quota and is shown a saved card with no override on it has been told nothing; they will
 * assume it worked and find out when a customer cannot create a portfolio.
 *
 * WHAT IT REFUSES, and each one has happened to somebody: a negative ceiling, a fraction where the
 * entitlement is a count of rows, a number so large it is obviously a slipped keypress, and a value
 * of the wrong SHAPE for its key — a number typed into a capability, or a boolean into a quota.
 *
 * WHAT IT STILL DROPS SILENTLY: a key outside the allowlist. That is deliberate and is the same
 * decision the route's schema documents — the allowlist in this file is the authority, so a key
 * from a build that has since been rolled back must not be able to fail somebody's save. It cannot
 * entitle anybody either way, because nothing reads it.
 */
export function validateOverrideInput(raw: unknown): OverrideValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { clean: {}, errors: ["Overrides must be an object of key → value."] };
  }
  const clean: FeatureOverrides = {};
  const errors: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isOverridableKey(key)) continue;
    if (OVERRIDABLE_FEATURES[key] === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`${key} is a capability, so it must be true or false.`);
        continue;
      }
      clean[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${key} is a quota, so it must be a number.`);
    } else if (!Number.isInteger(value)) {
      // The underlying entitlement counts rows. Half a dashboard is not a thing anybody can be
      // granted, and rounding it here would store something the operator did not type.
      errors.push(`${key} must be a whole number — it is a count, not a rate.`);
    } else if (value < 0) {
      errors.push(`${key} cannot be negative. Use 0 to allow none, or remove the override to fall back to the plan.`);
    } else if (value > MAX_QUOTA_OVERRIDE) {
      errors.push(`${key} cannot exceed ${MAX_QUOTA_OVERRIDE.toLocaleString("en-US")}.`);
    } else {
      clean[key] = value;
    }
  }

  return { clean, errors };
}

export type OverrideEffect = "grant" | "restrict" | "noop";

export interface ClassifiedOverride {
  key: FeatureOverrideKey;
  kind: "boolean" | "quota";
  tierValue: FeatureOverrideValue;
  overrideValue: FeatureOverrideValue;
  effect: OverrideEffect;
}

/** "More entitled than the tier", in one place. `true` beats `false`; a bigger ceiling beats a
 *  smaller one. Both directions of both shapes, and nothing else counts as a change. */
function effectOf(kind: "boolean" | "quota", tierValue: FeatureOverrideValue, overrideValue: FeatureOverrideValue): OverrideEffect {
  if (kind === "boolean") {
    if (overrideValue === tierValue) return "noop";
    return overrideValue === true ? "grant" : "restrict";
  }
  if (typeof overrideValue !== "number" || typeof tierValue !== "number" || overrideValue === tierValue) return "noop";
  return overrideValue > tierValue ? "grant" : "restrict";
}

/** What each override actually DOES against the tier this workspace is on. Pure — see the header. */
export function classifyOverrides(tierLimit: Record<string, unknown>, overrides: FeatureOverrides): ClassifiedOverride[] {
  return FEATURE_OVERRIDE_KEYS.filter((key) => overrides[key] !== undefined).map((key) => {
    const kind = OVERRIDABLE_FEATURES[key];
    const tierValue = tierLimit[key] as FeatureOverrideValue;
    const overrideValue = overrides[key]!;
    return { key, kind, tierValue, overrideValue, effect: effectOf(kind, tierValue, overrideValue) };
  });
}

/** The keys that hand out something the plan does not include. Named separately because this list
 *  is what the operator is shown, what they acknowledge, and what the audit row records. */
export const grantingKeys = (classified: ClassifiedOverride[]): FeatureOverrideKey[] =>
  classified.filter((entry) => entry.effect === "grant").map((entry) => entry.key);

/** One entitlement, with the workspace's own override applied if it has one. Here rather than
 *  inlined at each call site in `plan-limits.service.ts` so "the override wins" is stated once. */
export function resolveEntitlement<T extends FeatureOverrideValue>(
  tierLimit: Record<string, unknown>,
  overrides: FeatureOverrides,
  key: FeatureOverrideKey
): T {
  const override = overrides[key];
  return (override === undefined ? tierLimit[key] : override) as T;
}
