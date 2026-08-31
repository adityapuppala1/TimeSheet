/**
 * The per-org feature override, and the one thing it must never do: grant something the plan
 * forbids without an operator seeing that is what they did.
 *
 * WHY THAT IS THE PROPERTY WORTH A TEST FILE. Restricting a workspace below its tier is
 * unremarkable and fails in the safe direction. Granting is different: it hands out something the
 * customer has not paid for, it is invisible on every screen that reads `planTier`, and six months
 * later nobody can tell a considered exception from a typo. Three mechanisms stand in the way —
 * the classification, the acknowledgement, and the audit row — and all three are exercised below.
 *
 * The second half of the file is the other half of the promise: an override is worthless unless the
 * resolver actually reads it, so `plan-limits.service.ts` is driven directly to prove that a
 * granted capability comes back true and a revoked one comes back false.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyOverrides, grantingKeys, MAX_QUOTA_OVERRIDE, readFeatureOverrides, validateOverrideInput } from "../../src/utils/feature-overrides.js";

/* --------------------------------- the fake control plane -------------------------------- */

const STARTER = {
  tier: "STARTER",
  seatLimit: 5,
  aiMonthlyBudgetCeilingUsd: 0,
  faceVerificationEnabled: false,
  ganttEnabled: false,
  resourceMgmtEnabled: false,
  approvalsEnabled: false,
  proofingEnabled: false,
  customWorkflowsEnabled: false,
  aiPmCopilotEnabled: false,
  goalsEnabled: false,
  changeManagementEnabled: false,
  practiceUpdateEnabled: false,
  maxPortfolios: 0,
  maxRequestForms: 0,
  maxBlueprints: 0,
  maxCustomFields: 0,
  maxDashboards: 0,
  maxGoals: 0,
  maxChangePolicies: 0
};
const TEAM = { ...STARTER, tier: "TEAM", seatLimit: 25, ganttEnabled: true, goalsEnabled: true, maxGoals: 20, maxDashboards: 5 };

let orgRow: Record<string, unknown> | null = null;
let tierRows: Record<string, Record<string, unknown>> = { STARTER, TEAM };

const control = {
  organization: {
    findUnique: vi.fn(async () => (orgRow ? { ...orgRow } : null)),
    findUniqueOrThrow: vi.fn(async () => {
      if (!orgRow) throw new Error("no org");
      return { ...orgRow };
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      orgRow = { ...(orgRow ?? {}), ...data };
      return { ...orgRow };
    })
  },
  planTierLimit: {
    findUnique: vi.fn(async ({ where }: { where: { tier: string } }) => tierRows[where.tier] ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { tier: string } }) => {
      const row = tierRows[where.tier];
      if (!row) throw new Error("no tier");
      return row;
    })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const platformAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit }));

// `Prisma.DbNull` is the only thing the service needs from the generated client, and importing the
// real client into a unit test drags a whole engine in for one sentinel value.
vi.mock("../../src/generated/control-client/index.js", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));

const { getOrgFeatureOverrides, setOrgFeatureOverrides } = await import("../../src/services/platform-feature-overrides.service.js");
const { isPlanningCapabilityAllowed, getPlanningQuota, getPlanningEntitlements, isFaceVerificationAllowed } = await import(
  "../../src/services/plan-limits.service.js"
);

const org = (over: Record<string, unknown> = {}) => ({
  id: "org-1",
  slug: "acme",
  planTier: "STARTER",
  trialTier: null,
  trialEndsAt: null,
  featureOverrides: null,
  ...over
});

beforeEach(() => {
  orgRow = org();
  tierRows = { STARTER, TEAM };
  platformAudit.mockClear();
});

/* ================================ the pure rule ==================================== */

describe("classifyOverrides — what an override actually DOES", () => {
  it("calls turning a capability on beyond the tier a GRANT", () => {
    const classified = classifyOverrides(STARTER, { goalsEnabled: true });
    expect(classified[0].effect).toBe("grant");
    expect(grantingKeys(classified)).toEqual(["goalsEnabled"]);
  });

  it("calls turning one off a RESTRICT, which needs no ceremony", () => {
    expect(classifyOverrides(TEAM, { ganttEnabled: false })[0].effect).toBe("restrict");
    expect(grantingKeys(classifyOverrides(TEAM, { ganttEnabled: false }))).toEqual([]);
  });

  it("calls a matching value a NO-OP rather than either", () => {
    expect(classifyOverrides(TEAM, { ganttEnabled: true })[0].effect).toBe("noop");
    expect(classifyOverrides(TEAM, { maxGoals: 20 })[0].effect).toBe("noop");
  });

  it("reads a bigger quota as a grant and a smaller one as a restriction", () => {
    expect(classifyOverrides(TEAM, { maxGoals: 500 })[0].effect).toBe("grant");
    expect(classifyOverrides(TEAM, { maxGoals: 2 })[0].effect).toBe("restrict");
  });

  it("classifies against the tier it is given, so the same override reads differently per plan", () => {
    // The single most important property of this function: `{ ganttEnabled: true }` is a grant on
    // Starter and a no-op on Team, and judging it against the wrong tier is how a real grant gets
    // waved through as harmless.
    expect(classifyOverrides(STARTER, { ganttEnabled: true })[0].effect).toBe("grant");
    expect(classifyOverrides(TEAM, { ganttEnabled: true })[0].effect).toBe("noop");
  });
});

describe("readFeatureOverrides — fails quiet and closed", () => {
  it("drops a key outside the allowlist rather than honouring it", () => {
    // A key from a build that has since been rolled back, or a typo. Either must not entitle
    // anybody — and must not throw either, because this runs inside every entitlement check.
    expect(readFeatureOverrides({ seatLimit: 9999, goalsEnabled: true })).toEqual({ goalsEnabled: true });
    expect(readFeatureOverrides({ ganttEnabledd: true })).toEqual({});
  });

  it("drops a value of the wrong shape", () => {
    expect(readFeatureOverrides({ goalsEnabled: "yes", maxGoals: true })).toEqual({});
    expect(readFeatureOverrides({ maxGoals: -1 })).toEqual({});
    expect(readFeatureOverrides({ maxGoals: 1.5 })).toEqual({});
  });

  it("survives null, a string and an array without throwing", () => {
    for (const bad of [null, undefined, "{}", 7, [1, 2, 3]]) expect(readFeatureOverrides(bad)).toEqual({});
  });
});

describe("validateOverrideInput — the WRITE path, which refuses what the read path drops", () => {
  /* THE TWO FUNCTIONS ARE DELIBERATELY DIFFERENT, and this block is what stops somebody
     "simplifying" them into one. `readFeatureOverrides` runs inside every entitlement check against
     a column that is already stored, so its only safe move is to ignore a bad value. This one runs
     on a person's click, on input they can still fix — and an operator who types `-5`, sees a saved
     card with no override on it, and walks away believing it worked has been told nothing at all. */

  it("accepts a sound quota and a sound capability", () => {
    expect(validateOverrideInput({ maxGoals: 50, goalsEnabled: true })).toEqual({ clean: { maxGoals: 50, goalsEnabled: true }, errors: [] });
    // Zero is a legitimate quota — "this workspace may create none" — and is not the same as absent.
    expect(validateOverrideInput({ maxGoals: 0 }).errors).toEqual([]);
  });

  it("REFUSES a negative quota, naming the key", () => {
    const { clean, errors } = validateOverrideInput({ maxGoals: -5 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/maxGoals/);
    expect(errors[0]).toMatch(/negative/i);
    expect(clean).toEqual({});
  });

  it("REFUSES a fraction, because the entitlement counts rows", () => {
    expect(validateOverrideInput({ maxDashboards: 2.5 }).errors[0]).toMatch(/whole number/i);
  });

  it("REFUSES a quota past the ceiling, and the ceiling is one constant", () => {
    expect(validateOverrideInput({ maxPortfolios: MAX_QUOTA_OVERRIDE }).errors).toEqual([]);
    expect(validateOverrideInput({ maxPortfolios: MAX_QUOTA_OVERRIDE + 1 }).errors[0]).toMatch(/cannot exceed/i);
    // Infinity and NaN both pass a bare `typeof value === "number"`, which is why the check is
    // `Number.isFinite` and not that.
    expect(validateOverrideInput({ maxPortfolios: Number.POSITIVE_INFINITY }).errors).toHaveLength(1);
    expect(validateOverrideInput({ maxPortfolios: Number.NaN }).errors).toHaveLength(1);
  });

  it("REFUSES a value of the wrong shape for its key, in both directions", () => {
    expect(validateOverrideInput({ maxGoals: true }).errors[0]).toMatch(/must be a number/i);
    expect(validateOverrideInput({ goalsEnabled: 1 }).errors[0]).toMatch(/true or false/i);
  });

  it("still DROPS an unknown key silently, which is the one thing it does not refuse", () => {
    // Deliberate and documented: the allowlist is the authority, nothing reads an unknown key, and
    // a key from a rolled-back build must not be able to fail somebody's save.
    expect(validateOverrideInput({ seatLimit: 9999, maxGoals: 4 })).toEqual({ clean: { maxGoals: 4 }, errors: [] });
  });

  it("reports every bad value, not just the first", () => {
    expect(validateOverrideInput({ maxGoals: -1, maxDashboards: 1.5 }).errors).toHaveLength(2);
  });
});

/* ============================== granting and revoking ============================== */

describe("setOrgFeatureOverrides", () => {
  it("REFUSES a grant that was not acknowledged, and names the key", async () => {
    await expect(
      setOrgFeatureOverrides({ orgId: "org-1", overrides: { goalsEnabled: true }, acknowledgeGrants: false, actorLabel: "ops@x.test" })
    ).rejects.toMatchObject({ statusCode: 422, code: "OVERRIDE_GRANTS_BEYOND_PLAN" });
    // Nothing was written, and nothing was recorded — a refusal is not a half-applied change.
    expect(orgRow!.featureOverrides).toBeNull();
    expect(platformAudit).not.toHaveBeenCalled();
  });

  it("names the granting key in the message, because the operator has to know what they are saying yes to", async () => {
    await expect(
      setOrgFeatureOverrides({ orgId: "org-1", overrides: { aiPmCopilotEnabled: true }, acknowledgeGrants: false, actorLabel: "ops@x.test" })
    ).rejects.toThrow(/aiPmCopilotEnabled/);
  });

  it("GRANTS when acknowledged, and writes an audit row naming the grant", async () => {
    const result = await setOrgFeatureOverrides({
      orgId: "org-1",
      overrides: { goalsEnabled: true },
      acknowledgeGrants: true,
      actorLabel: "ops@x.test",
      reason: "design partner beta, ticket OPS-412"
    });
    expect(result.grants).toEqual(["goalsEnabled"]);
    expect(platformAudit).toHaveBeenCalledTimes(1);

    const [actorType, actorLabel, action, entity, entityId, metadata, provenance] = platformAudit.mock.calls[0];
    expect(actorType).toBe("PLATFORM_ADMIN");
    expect(actorLabel).toBe("ops@x.test");
    expect(action).toBe("organization.feature_overrides_set");
    expect(entity).toBe("Organization");
    expect(entityId).toBe("org-1");
    expect(metadata).toMatchObject({ grants: ["goalsEnabled"], tier: "STARTER" });
    // The reason and the diff, which is what makes the row readable six months later.
    expect(provenance).toMatchObject({ reason: "design partner beta, ticket OPS-412", before: {}, after: { goalsEnabled: true } });
  });

  it("REVOKES without ceremony — restricting is not a grant", async () => {
    orgRow = org({ planTier: "TEAM", featureOverrides: { goalsEnabled: true } });
    const result = await setOrgFeatureOverrides({ orgId: "org-1", overrides: { ganttEnabled: false }, acknowledgeGrants: false, actorLabel: "ops@x.test" });
    expect(result.grants).toEqual([]);
    expect(result.classified[0].effect).toBe("restrict");
    expect(platformAudit).toHaveBeenCalledTimes(1);
  });

  it("REPLACES rather than merging, so an override can actually be removed", async () => {
    orgRow = org({ featureOverrides: { goalsEnabled: true, maxGoals: 99 } });
    const result = await setOrgFeatureOverrides({ orgId: "org-1", overrides: {}, acknowledgeGrants: false, actorLabel: "ops@x.test" });
    expect(result.overrides).toEqual({});
    // A merge would leave `goalsEnabled` set forever, invisibly, because nobody who could not see
    // it would think to unset it.
    expect(platformAudit.mock.calls[0][6]).toMatchObject({ before: { goalsEnabled: true, maxGoals: 99 }, after: {} });
  });

  it("never lets an unknown key reach the stored column, acknowledged or not", async () => {
    const result = await setOrgFeatureOverrides({
      orgId: "org-1",
      overrides: { seatLimit: 9999, goalsEnabled: true } as never,
      acknowledgeGrants: true,
      actorLabel: "ops@x.test"
    });
    expect(result.overrides).toEqual({ goalsEnabled: true });
  });

  it("judges the grant against the TRIAL tier while a trial is running", async () => {
    // A trialling Starter workspace is entitled to Team right now, so `ganttEnabled: true` is not a
    // grant today. Judging against `planTier` here would demand an acknowledgement for something
    // the workspace already has — and, worse, would wave through a real grant once the trial ended.
    orgRow = org({ planTier: "STARTER", trialTier: "TEAM", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const result = await setOrgFeatureOverrides({ orgId: "org-1", overrides: { ganttEnabled: true }, acknowledgeGrants: false, actorLabel: "ops@x.test" });
    expect(result.effectiveTier).toBe("TEAM");
    expect(result.grants).toEqual([]);
  });

  /* ---------------------- a NUMERIC QUOTA can be SET, not just cleared ---------------------- */

  it("SETS a numeric quota below the plan's, with no ceremony — that is a restriction", async () => {
    orgRow = org({ planTier: "TEAM" });
    const result = await setOrgFeatureOverrides({ orgId: "org-1", overrides: { maxGoals: 5 }, acknowledgeGrants: false, actorLabel: "ops@x.test" });
    expect(result.overrides).toEqual({ maxGoals: 5 });
    expect(result.classified[0].effect).toBe("restrict");
    expect(orgRow!.featureOverrides).toEqual({ maxGoals: 5 });
  });

  it("REFUSES a numeric quota ABOVE the plan's without an acknowledgement, exactly like a capability grant", async () => {
    // The whole reason making quotas settable is safe: a bigger ceiling IS a grant, and it goes
    // through the same gate rather than round it.
    orgRow = org({ planTier: "TEAM" });
    await expect(
      setOrgFeatureOverrides({ orgId: "org-1", overrides: { maxGoals: 500 }, acknowledgeGrants: false, actorLabel: "ops@x.test" })
    ).rejects.toMatchObject({ statusCode: 422, code: "OVERRIDE_GRANTS_BEYOND_PLAN" });
    expect(orgRow!.featureOverrides).toBeNull();
    expect(platformAudit).not.toHaveBeenCalled();
  });

  it("SETS it when acknowledged, and the audit row still records the grant", async () => {
    orgRow = org({ planTier: "TEAM" });
    const result = await setOrgFeatureOverrides({
      orgId: "org-1",
      overrides: { maxGoals: 500 },
      acknowledgeGrants: true,
      actorLabel: "ops@x.test",
      reason: "design partner, ticket OPS-901"
    });
    expect(result.overrides).toEqual({ maxGoals: 500 });
    expect(result.grants).toEqual(["maxGoals"]);
    expect(platformAudit).toHaveBeenCalledTimes(1);
    const [, , action, , , metadata, provenance] = platformAudit.mock.calls[0];
    expect(action).toBe("organization.feature_overrides_set");
    expect(metadata).toMatchObject({ grants: ["maxGoals"], keys: ["maxGoals"] });
    expect(provenance).toMatchObject({ reason: "design partner, ticket OPS-901", before: {}, after: { maxGoals: 500 } });
  });

  it("REFUSES nonsense clearly rather than storing it, and writes nothing", async () => {
    orgRow = org({ planTier: "TEAM" });
    for (const bad of [{ maxGoals: -1 }, { maxGoals: 2.5 }, { maxGoals: MAX_QUOTA_OVERRIDE + 1 }, { maxGoals: true }]) {
      await expect(
        setOrgFeatureOverrides({ orgId: "org-1", overrides: bad as never, acknowledgeGrants: true, actorLabel: "ops@x.test" })
      ).rejects.toMatchObject({ statusCode: 422, code: "OVERRIDE_INVALID" });
    }
    // A refusal is not a half-applied change: nothing stored, nothing recorded.
    expect(orgRow!.featureOverrides).toBeNull();
    expect(platformAudit).not.toHaveBeenCalled();
  });

  it("names the offending key in the refusal, so the operator knows which box to fix", async () => {
    orgRow = org({ planTier: "TEAM" });
    await expect(
      setOrgFeatureOverrides({ orgId: "org-1", overrides: { maxDashboards: -3 } as never, acknowledgeGrants: true, actorLabel: "ops@x.test" })
    ).rejects.toThrow(/maxDashboards/);
  });

  it("reads back what it wrote, with the effect of each key", async () => {
    orgRow = org({ featureOverrides: { goalsEnabled: true } });
    const view = await getOrgFeatureOverrides("org-1");
    expect(view.overrides).toEqual({ goalsEnabled: true });
    expect(view.grants).toEqual(["goalsEnabled"]);
    expect(view.effectiveTier).toBe("STARTER");
  });
});

/* ====================== the resolver actually reads them =========================== */

describe("plan-limits resolves the override, which is the whole point", () => {
  it("grants a capability the tier forbids", async () => {
    orgRow = org({ featureOverrides: { goalsEnabled: true } });
    expect(await isPlanningCapabilityAllowed("org-1", "goalsEnabled")).toBe(true);
    // …and the neighbouring capability is untouched, which is exactly what moving the whole tier
    // could never promise.
    expect(await isPlanningCapabilityAllowed("org-1", "ganttEnabled")).toBe(false);
  });

  it("revokes one the tier allows", async () => {
    orgRow = org({ planTier: "TEAM", featureOverrides: { ganttEnabled: false } });
    expect(await isPlanningCapabilityAllowed("org-1", "ganttEnabled")).toBe(false);
  });

  it("raises and lowers a quota", async () => {
    orgRow = org({ planTier: "TEAM", featureOverrides: { maxGoals: 500 } });
    expect(await getPlanningQuota("org-1", "maxGoals")).toBe(500);
    orgRow = org({ planTier: "TEAM", featureOverrides: { maxGoals: 1 } });
    expect(await getPlanningQuota("org-1", "maxGoals")).toBe(1);
  });

  it("shows the same answer in the whole-matrix read as in the single check", async () => {
    // The matrix is what the settings screen renders and the single check is what runs a second
    // later. A screen that disagrees with the enforcement is the worst way to ship an override.
    orgRow = org({ featureOverrides: { goalsEnabled: true, maxGoals: 7 } });
    const matrix = await getPlanningEntitlements("org-1");
    expect(matrix.goalsEnabled).toBe(true);
    expect(matrix.maxGoals).toBe(7);
    expect(matrix.ganttEnabled).toBe(await isPlanningCapabilityAllowed("org-1", "ganttEnabled"));
  });

  it("covers face verification, which lives outside the planning block", async () => {
    orgRow = org({ featureOverrides: { faceVerificationEnabled: true } });
    expect(await isFaceVerificationAllowed("org-1")).toBe(true);
  });

  it("ignores a malformed column entirely rather than failing the check", async () => {
    // Fails CLOSED to the tier value. A workspace with a corrupt override loses the override, not
    // its ability to answer an entitlement question at all.
    orgRow = org({ planTier: "TEAM", featureOverrides: { ganttEnabled: "yes" } });
    expect(await isPlanningCapabilityAllowed("org-1", "ganttEnabled")).toBe(true);
  });
});
