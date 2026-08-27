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
import { PLAN_TIER_LIMITS, planTiers } from "@timesheet/shared";

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

describe("PlanTierLimits ↔ PlanTierLimit", () => {
  it("declares exactly the same entitlement fields, so the seed's spread is exhaustive", () => {
    const shared = Object.keys(PLAN_TIER_LIMITS.ENTERPRISE).sort();
    // `tier` is the model's own key and is passed explicitly by the seed, so it is the one field
    // the shared shape does not carry.
    const model = modelFields("PlanTierLimit").filter((f) => f !== "tier").sort();

    expect(model, "a column the shared limits cannot fill would be seeded at its schema default").toEqual(shared);
  });

  it("gives every tier the same key set, so no tier can omit an entitlement", () => {
    const reference = Object.keys(PLAN_TIER_LIMITS.STARTER).sort();
    for (const tier of planTiers) {
      expect(Object.keys(PLAN_TIER_LIMITS[tier]).sort(), `${tier} should declare every entitlement`).toEqual(reference);
    }
  });
});
