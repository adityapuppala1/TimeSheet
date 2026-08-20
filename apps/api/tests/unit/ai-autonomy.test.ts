/**
 * The autonomy ladder, and the two invariants it exists to hold.
 *
 *   1. A LEVEL IS A CEILING THE CODE SETS AND AN ADMINISTRATOR LOWERS, NEVER ONE AN ADMINISTRATOR
 *      RAISES. Every test below that writes a level and reads it back is checking this.
 *   2. THE DEFAULT IS THE FLOOR. A migrated workspace, a capability nobody has configured, a
 *      capability this build has never heard of — all SUGGEST.
 *
 * The most important test in this file is the first one: that with the latch off and no policy
 * rows, every capability resolves to SUGGEST. That is the ship gate for the whole phase — it is
 * what makes "this migration changes no behaviour" a checked claim rather than an intention.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const { mockGetEffectiveAiBudgetCeiling } = vi.hoisted(() => ({ mockGetEffectiveAiBudgetCeiling: vi.fn() }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: mockGetEffectiveAiBudgetCeiling
}));

const { resolveAutonomy, assertLevelAtLeast, describeAutonomyCatalogue, setCapabilityLevel } = await import(
  "../../src/services/ai-autonomy.service.js"
);
const { AI_CAPABILITIES, findCapability, levelRank } = await import("../../src/services/ai-capability.registry.js");

let client: PrismaClient;

/** Everything on, so a test that wants the floor has to be *forced* there by the thing under test
 *  rather than getting it for free from a switched-off workspace. */
function settings(overrides: Record<string, unknown> = {}) {
  const allOn: Record<string, unknown> = { id: "global", aiEnabled: true, aiAutonomyEnabled: true };
  for (const spec of AI_CAPABILITIES) allOn[spec.featureToggle] = true;
  return { ...allOn, ...overrides };
}

function withPolicy(rows: Array<Record<string, unknown>>, settingsOverrides: Record<string, unknown> = {}) {
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings(settingsOverrides) as never);
  vi.mocked(client.aiCapabilityPolicy.findMany).mockResolvedValue(rows as never);
  vi.mocked(client.aiCapabilityPolicy.findUnique).mockImplementation((async (args: { where: { capability: string } }) =>
    rows.find((r) => r.capability === args.where.capability) ?? null) as never);
}

beforeEach(() => {
  client = createFakeTenantClient();
  mockGetEffectiveAiBudgetCeiling.mockReset().mockResolvedValue(100);
  withPolicy([]);
});

describe("the floor is the default, everywhere", () => {
  it("resolves SUGGEST for EVERY capability when the latch is off and no policy rows exist", async () => {
    // The ship gate. This is the state a workspace is in the moment the migration finishes.
    withPolicy([], { aiAutonomyEnabled: false });

    const levels = await runInTenant(client, async () =>
      Promise.all(AI_CAPABILITIES.map(async (c) => [c.id, (await resolveAutonomy(c.id)).effectiveLevel] as const))
    );

    expect(levels.filter(([, level]) => level !== "SUGGEST")).toEqual([]);
  });

  it("resolves SUGGEST for a capability this build has never heard of", async () => {
    // A policy row from a newer release. "I don't know what this is" must read as "then it may not
    // act", never as a 500 in somebody's request.
    withPolicy([{ capability: "capability_from_the_future", level: "AUTONOMOUS" }]);
    const resolved = await runInTenant(client, () => resolveAutonomy("capability_from_the_future"));
    expect(resolved.effectiveLevel).toBe("SUGGEST");
  });
});

describe("a stored level can never outrank the code", () => {
  /** A capability the product caps at SUGGEST — identity work, by design. */
  const capped = "face_review_summary";
  /** A capability that may reach AUTO_APPLY but no further. */
  const midCapped = "triage";

  it("clamps a hand-written AUTONOMOUS row down to the product's ceiling", async () => {
    // This is the row somebody edits directly in MySQL, or that an older release wrote.
    withPolicy([{ capability: capped, level: "AUTONOMOUS" }]);

    const resolved = await runInTenant(client, () => resolveAutonomy(capped));
    expect(resolved.requestedLevel).toBe("AUTONOMOUS");
    expect(resolved.effectiveLevel).toBe("SUGGEST");
    // And it says why, rather than silently showing something else than was stored.
    expect(resolved.clampedReason).toBe(findCapability(capped)!.ceilingReason);
  });

  it("clamps to AUTO_APPLY, not to the floor, where that is the ceiling", async () => {
    withPolicy([{ capability: midCapped, level: "AUTONOMOUS" }]);
    expect((await runInTenant(client, () => resolveAutonomy(midCapped))).effectiveLevel).toBe("AUTO_APPLY");
  });

  it("refuses to WRITE a level above the ceiling, so an admin finds out immediately", async () => {
    await expect(
      runInTenant(client, () => setCapabilityLevel({ capability: capped, level: "AUTO_APPLY", updatedById: "u1" }))
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(client.aiCapabilityPolicy.upsert).not.toHaveBeenCalled();
  });

  it("accepts a level at the ceiling", async () => {
    vi.mocked(client.aiCapabilityPolicy.upsert).mockResolvedValue({} as never);
    withPolicy([{ capability: midCapped, level: "AUTO_APPLY" }]);
    const resolved = await runInTenant(client, () =>
      setCapabilityLevel({ capability: midCapped, level: "AUTO_APPLY", updatedById: "u1" })
    );
    expect(resolved.effectiveLevel).toBe("AUTO_APPLY");
  });

  it("404s an unknown capability rather than creating a row for it", async () => {
    await expect(
      runInTenant(client, () => setCapabilityLevel({ capability: "nope", level: "SUGGEST", updatedById: "u1" }))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("three independent switches each force the floor", () => {
  const cap = "plan_breakdown"; // ceiling is AUTO_APPLY

  it("grants the level when everything is on", async () => {
    withPolicy([{ capability: cap, level: "AUTO_APPLY" }]);
    expect((await runInTenant(client, () => resolveAutonomy(cap))).effectiveLevel).toBe("AUTO_APPLY");
  });

  it.each([
    ["AI is off workspace-wide", { aiEnabled: false }],
    ["the capability's own feature toggle is off", { planBreakdownEnabled: false }],
    ["the autonomy master latch is off", { aiAutonomyEnabled: false }]
  ])("falls to SUGGEST when %s", async (_label, override) => {
    withPolicy([{ capability: cap, level: "AUTO_APPLY" }], override);
    const resolved = await runInTenant(client, () => resolveAutonomy(cap));
    expect(resolved.effectiveLevel).toBe("SUGGEST");
    expect(resolved.clampedReason).toBeTruthy();
  });
});

describe("assertLevelAtLeast is what a caller acts on", () => {
  it("throws 403 when the capability only holds SUGGEST", async () => {
    withPolicy([]);
    await expect(runInTenant(client, () => assertLevelAtLeast("plan_breakdown", "AUTO_APPLY"))).rejects.toMatchObject({
      statusCode: 403
    });
  });

  it("passes once the level is high enough", async () => {
    withPolicy([{ capability: "plan_breakdown", level: "AUTO_APPLY" }]);
    await expect(runInTenant(client, () => assertLevelAtLeast("plan_breakdown", "AUTO_APPLY"))).resolves.toBeTruthy();
  });
});

describe("the catalogue is what the settings screen renders", () => {
  it("returns every capability, and the UI never has to re-derive the clamp", async () => {
    withPolicy([{ capability: "face_review_summary", level: "AUTONOMOUS" }]);
    const { capabilities } = await runInTenant(client, () => describeAutonomyCatalogue());

    expect(capabilities).toHaveLength(AI_CAPABILITIES.length);
    const row = capabilities.find((c) => c.capability === "face_review_summary")!;
    // Both values are present so the screen can show what was asked for AND what is in force.
    expect(row.requestedLevel).toBe("AUTONOMOUS");
    expect(row.effectiveLevel).toBe("SUGGEST");
    expect(row.maxLevel).toBe("SUGGEST");
    expect(row.ceilingReason).toBeTruthy();
  });

  it("reads settings ONCE, not once per capability", async () => {
    // getGlobalAISettings is an upsert. Calling it per capability meant rendering a read-only
    // list wrote to the database twenty-two times.
    await runInTenant(client, () => describeAutonomyCatalogue());
    expect(client.globalAISettings.upsert).toHaveBeenCalledTimes(1);
    expect(client.aiCapabilityPolicy.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * THE CHOKEPOINT. `applyProposal` is the only function in this codebase that writes an AI-authored
 * change, and when the applier is an agent it asks the policy ITSELF rather than trusting its
 * caller to have asked. A capability added in a hurry that forgets to check must be refused by the
 * only function it can use to act.
 */
describe("applyProposal refuses an agent applier that lacks the level", () => {
  it("throws 403 before it even loads the proposal", async () => {
    withPolicy([]); // every capability at SUGGEST
    const { applyProposal } = await import("../../src/services/ai-proposal.service.js");

    await expect(
      runInTenant(client, () =>
        applyProposal({
          proposalId: "11111111-1111-4111-8111-111111111111",
          decisions: {},
          actorId: "u1",
          appliedBy: { kind: "AGENT", capability: "plan_breakdown", runId: "run-1" }
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });

    // Refused before any read — the policy check is genuinely first, not a late guard that has
    // already let a partially-applied change through.
    expect(client.aiProposal.findUnique).not.toHaveBeenCalled();
  });

  it("lets a HUMAN applier through untouched, which is every existing call site", async () => {
    withPolicy([]);
    const { applyProposal } = await import("../../src/services/ai-proposal.service.js");
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(null as never);

    // Reaches the proposal lookup (and 404s there) rather than being refused by the policy — the
    // default really is HUMAN, so no existing caller changed behaviour.
    await expect(
      runInTenant(client, () => applyProposal({ proposalId: "p1", decisions: {}, actorId: "u1" }))
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(client.aiProposal.findUnique).toHaveBeenCalled();
  });
});

/**
 * The registry is a product decision, so it gets asserted like one. These are the promises the
 * settings screen makes to whoever reads it.
 */
describe("the ceilings themselves", () => {
  it("never lets anything that leaves the workspace act unattended", async () => {
    // No undo exists for a sent email or a published GitHub comment.
    for (const id of ["pr_inline_review", "stale_ticket_nudge", "email_intake"]) {
      expect(findCapability(id)!.maxLevel, id).toBe("SUGGEST");
    }
  });

  it("caps identity work at SUGGEST", async () => {
    for (const id of ["face_review_summary", "face_policy_copilot"]) {
      expect(findCapability(id)!.maxLevel, id).toBe("SUGGEST");
    }
  });

  it("caps the evaluation judge, so the measuring stick cannot move with the thing measured", async () => {
    expect(findCapability("eval_judge")!.maxLevel).toBe("SUGGEST");
  });

  it("never lets anything reading externally-authored text reach AUTONOMOUS", async () => {
    const offenders = AI_CAPABILITIES.filter((c) => c.actsOnUntrustedInput && c.maxLevel === "AUTONOMOUS");
    expect(offenders.map((c) => c.id)).toEqual([]);
  });

  it("gives every capped capability a reason the UI can show", async () => {
    const silent = AI_CAPABILITIES.filter((c) => c.maxLevel !== "AUTONOMOUS" && !c.ceilingReason);
    expect(silent.map((c) => c.id)).toEqual([]);
  });

  it("only lets capabilities that write nothing reach AUTONOMOUS", async () => {
    // If this list changes, it should be a decision somebody made on purpose, not a default.
    // status_report LEFT it deliberately: gaining ticket-reading tools for the agent loop moved
    // it into the untrusted-input class, and the invariant above priced that at the top rung.
    //
    // change_risk_narrative JOINED it deliberately, on the same terms as its project-shaped sibling:
    // it writes nothing, and it reads only the change's own recorded assessment — no PR bodies, no
    // CI logs, no comments, nothing authored outside this workspace. Worth being explicit that the
    // top rung here is not a licence to APPROVE: there is no capability at any level that can, which
    // is the absence of a capability rather than a ceiling on this one.
    const autonomous = AI_CAPABILITIES.filter((c) => c.maxLevel === "AUTONOMOUS").map((c) => c.id).sort();
    expect(autonomous).toEqual(
      ["bug_pattern_digest", "change_risk_narrative", "project_risk_narrative", "security_weekly_digest", "weekly_digest"].sort()
    );
  });

  it("orders the ladder weakest to strongest", async () => {
    expect(levelRank("SUGGEST")).toBeLessThan(levelRank("AUTO_APPLY"));
    expect(levelRank("AUTO_APPLY")).toBeLessThan(levelRank("AUTONOMOUS"));
  });
});
