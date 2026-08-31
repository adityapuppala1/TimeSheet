/**
 * Pins the invariant that lets the control-plane seed write a plan tier with one spread.
 *
 * WHY THIS EXISTS. `seed.ts` used to name every column by hand, and the list fell behind twice:
 * goals and change management each landed with a schema column, a migration and runtime
 * enforcement, and never reached that object. Nothing caught it, because the `*_entitlements`
 * migrations carry a guarded `UPDATE` that runs BEFORE the seed — correct for an upgrade, and a
 * no-op on a fresh database, where the seed's `create` is what the row ends up being. So every
 * existing install was fine and every NEW customer on Team or Enterprise was told goals and change
 * management were not in their plan.
 *
 * The seed now writes `{ tier, ...limits }`. That is only exhaustive while `PlanTierLimits` and the
 * `PlanTierLimit` model agree on their field names, which is what this file asserts. A divergence
 * fails here, in a suite that runs in 30 seconds, instead of on somebody's first install.
 *
 * WHY IT READS THE .prisma FILE. The generated client's types are erased at runtime, so there is no
 * value to compare against — and the schema is the artefact that actually produces the columns.
 * Reading it is the only check that can fail for the real reason.
 *
 * This is deliberately about KEYS, not values. `plan-tier-claims.test.ts` pins what each tier
 * grants; this pins that every grant has somewhere to be written.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLAN_TIER_LIMITS, PLAN_TIER_LIST_PRICES, planTiers } from "@timesheet/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(here, "..", "..", "prisma", "control", "schema.prisma");

/** The scalar field names declared on one Prisma model, in declaration order. */
function modelFields(model: string): string[] {
  const schema = readFileSync(SCHEMA, "utf8");
  const start = schema.indexOf(`model ${model} {`);
  expect(start, `model ${model} should exist in ${SCHEMA}`).toBeGreaterThan(-1);
  const body = schema.slice(start, schema.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}(\w+)\s+\S/gm)]
    .map((match) => match[1])
    // Block attributes (`@@index`, `@@map`) do not match the pattern above, but relation and
    // bookkeeping columns would — none exist on this model today, and if one is added the
    // assertion below should fail loudly and be updated deliberately rather than filtered away.
    .filter((name) => name !== "id" && name !== "createdAt" && name !== "updatedAt");
}

/**
 * The two commercial columns (4.2.0), which are deliberately NOT entitlements.
 *
 * Everything `PlanTierLimits` describes is something the server ENFORCES — a ceiling, an
 * allowlist, a capability that fails closed. A list price enforces nothing, so it is not on that
 * interface and cannot be filled by the seed's spread. It is filled explicitly, from
 * `PLAN_TIER_LIST_PRICES`, and the second assertion below is what keeps "every column has somewhere
 * to be written" true for these two as well — excluding them without checking them would be exactly
 * the hole this file exists to close.
 */
const COMMERCIAL_FIELDS = ["listPricePerSeatMinor", "listPriceCurrency"];

describe("PlanTierLimits ↔ PlanTierLimit", () => {
  it("declares exactly the same entitlement fields, so the seed's spread is exhaustive", () => {
    const shared = Object.keys(PLAN_TIER_LIMITS.ENTERPRISE).sort();
    // `tier` is the model's own key and is passed explicitly by the seed, so it is the one field
    // the shared shape does not carry. The commercial columns are passed explicitly too, and are
    // checked on their own below.
    const model = modelFields("PlanTierLimit")
      .filter((f) => f !== "tier" && !COMMERCIAL_FIELDS.includes(f))
      .sort();

    expect(model, "a column the shared limits cannot fill would be seeded at its schema default").toEqual(shared);
  });

  it("has a source for the commercial columns too, so nothing is excluded without a filler", () => {
    const model = modelFields("PlanTierLimit");
    for (const field of COMMERCIAL_FIELDS) {
      expect(model, `${field} is excluded from the entitlement parity check but is not on the model`).toContain(field);
    }
    // The shape `PLAN_TIER_LIST_PRICES` supplies, which is what the seed spreads into those two
    // columns. A third price column added to the model with nothing to fill it fails the check
    // above instead of shipping at its schema default.
    for (const tier of planTiers) {
      expect(Object.keys(PLAN_TIER_LIST_PRICES[tier]).sort()).toEqual(["currency", "perSeatMinor"]);
    }
    expect(model.filter((f) => COMMERCIAL_FIELDS.includes(f)).length, "an unlisted commercial column").toBe(COMMERCIAL_FIELDS.length);
  });

  it("gives every tier the same key set, so no tier can omit an entitlement", () => {
    const reference = Object.keys(PLAN_TIER_LIMITS.STARTER).sort();
    for (const tier of planTiers) {
      expect(Object.keys(PLAN_TIER_LIMITS[tier]).sort(), `${tier} should declare every entitlement`).toEqual(reference);
    }
  });
});
