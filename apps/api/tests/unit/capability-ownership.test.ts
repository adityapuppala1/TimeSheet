/**
 * ONE CAPABILITY, ONE OWNER — the rule that stops the roster from being decoration.
 *
 * The defect this prevents is subtle enough to be worth stating: there is exactly one
 * `AiCapabilityPolicy` per capability. If two ENABLED profiles both contained `triage`, both would
 * describe the same behaviour, neither would be the reason it happened, and switching one off would
 * change nothing at all. The roster would be a list of names with no relationship to what the
 * workspace does.
 *
 * Drafts are deliberately allowed to overlap: that is what makes it possible to build a replacement
 * teammate before retiring the one it replaces. Enabling is where the claim is staked and therefore
 * where the conflict is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const profileFindMany = vi.fn();
const profileFindFirst = vi.fn();
const profileUpdate = vi.fn();
const userUpdate = vi.fn();

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    agentProfile: { findMany: profileFindMany, findFirst: profileFindFirst, update: profileUpdate },
    user: { update: userUpdate },
    agentRun: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: null } }) },
    aiCapabilityPolicy: { findMany: vi.fn().mockResolvedValue([]) }
  }
}));
vi.mock("../../src/services/ai-autonomy.service.js", () => ({
  resolveAutonomy: vi.fn().mockResolvedValue({
    capability: "x",
    requestedLevel: "SUGGEST",
    effectiveLevel: "SUGGEST",
    maxLevel: "AUTO_APPLY",
    clampedReason: null,
    guardrails: {}
  })
}));
vi.mock("../../src/services/ai.service.js", () => ({
  getGlobalAISettings: vi.fn().mockResolvedValue({ aiEnabled: true, aiTriageEnabled: true })
}));

const { updateProfile } = await import("../../src/services/agent-profile.service.js");
const { findClaimConflicts, getCapabilityClaims } = await import("../../src/services/capability-claims.service.js");

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "p-mine",
  name: "My triage",
  emoji: "🗂️",
  description: null,
  identityUserId: "agent-1",
  identityUser: { id: "agent-1", name: "My triage", email: "my-triage@agents.invalid" },
  capabilities: ["triage", "duplicate_detection"],
  scopeProjectIds: [],
  maxCostUsdPerDay: null,
  enabled: false,
  templateKey: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  profileFindMany.mockResolvedValue([]);
  profileFindFirst.mockResolvedValue(profileRow());
  profileUpdate.mockImplementation(({ data }: any) => Promise.resolve(profileRow({ ...data, capabilities: data.capabilities ?? ["triage", "duplicate_detection"] })));
});

describe("claims are held only by enabled profiles", () => {
  it("asks only for enabled, non-deleted rows", async () => {
    await getCapabilityClaims();
    expect(profileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ enabled: true, deletedAt: null }) })
    );
  });

  it("excludes the profile being examined, so it never conflicts with itself", async () => {
    await getCapabilityClaims("p-mine");
    expect(profileFindMany.mock.calls[0][0].where.id).toEqual({ not: "p-mine" });
  });

  it("maps every capability of an enabled profile to that profile", async () => {
    profileFindMany.mockResolvedValue([{ id: "p-1", name: "Triage", emoji: "🗂️", capabilities: ["triage", "duplicate_detection"] }]);
    const claims = await getCapabilityClaims();
    expect(claims.get("triage")).toMatchObject({ name: "Triage" });
    expect(claims.get("duplicate_detection")).toMatchObject({ name: "Triage" });
    expect(claims.get("plan_breakdown")).toBeUndefined();
  });

  it("groups a conflict by owner so the refusal can name it", async () => {
    profileFindMany.mockResolvedValue([{ id: "p-1", name: "Triage", emoji: "🗂️", capabilities: ["triage", "duplicate_detection"] }]);
    const conflicts = await findClaimConflicts(["triage", "duplicate_detection", "plan_breakdown"], "p-mine");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].owner.name).toBe("Triage");
    expect(conflicts[0].capabilities).toEqual(["triage", "duplicate_detection"]);
  });
});

describe("enabling is where the conflict is refused", () => {
  it("refuses to enable a profile whose capability another enabled one owns, naming both", async () => {
    profileFindMany.mockResolvedValue([{ id: "p-other", name: "Triage", emoji: "🗂️", capabilities: ["triage"] }]);
    await expect(updateProfile("p-mine", { enabled: true })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateProfile("p-mine", { enabled: true })).rejects.toThrow(/Triage already covers triage/);
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it("allows two DRAFTS to overlap, so a replacement can be built before the original retires", async () => {
    profileFindMany.mockResolvedValue([]); // nothing enabled owns anything
    profileFindFirst.mockResolvedValue(profileRow({ enabled: false }));
    await expect(updateProfile("p-mine", { capabilities: ["triage"] })).resolves.toBeTruthy();
    expect(profileUpdate).toHaveBeenCalled();
  });

  it("catches the same conflict arriving as 'add a capability to an already-enabled agent'", async () => {
    // The other route to the same collision: not enabling, but widening a live bundle.
    profileFindFirst.mockResolvedValue(profileRow({ enabled: true, capabilities: ["duplicate_detection"] }));
    profileFindMany.mockResolvedValue([{ id: "p-other", name: "Triage", emoji: "🗂️", capabilities: ["triage"] }]);
    await expect(updateProfile("p-mine", { capabilities: ["duplicate_detection", "triage"] })).rejects.toMatchObject({
      statusCode: 409
    });
  });

  it("lets a profile be DISABLED even while it overlaps, so a conflict is always escapable", async () => {
    // If the check ran on every write regardless of direction, two profiles that overlapped (from
    // before the rule, or by any other route) could each refuse to be switched off — a deadlock.
    profileFindFirst.mockResolvedValue(profileRow({ enabled: true }));
    profileFindMany.mockResolvedValue([{ id: "p-other", name: "Triage", emoji: "🗂️", capabilities: ["triage"] }]);
    await expect(updateProfile("p-mine", { enabled: false })).resolves.toBeTruthy();
    expect(profileUpdate).toHaveBeenCalled();
  });
});
