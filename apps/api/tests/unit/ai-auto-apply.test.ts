/**
 * AUTO_APPLY — the rung where a capability applies its own change set.
 *
 * The claim this file has to hold up is that AUTO_APPLY is not a second way to write to the
 * database. It is `applyProposal` with every row accepted and an agent as the applier, so
 * everything that makes a human-applied proposal safe applies unchanged, and the result is a real
 * proposal that `undoProposal` works on exactly as it does on a person's.
 *
 * Everything else here is the guardrails, and the property they all share: they DEGRADE rather
 * than fail. A capability that exceeded its change budget has not done something wrong — it has
 * produced something that needs a person, which is the state the product had before autonomy
 * existed. Falling back to "a human decides" is never an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const resolveAutonomyMock = vi.fn();
const assertLevelAtLeastMock = vi.fn().mockResolvedValue({});
vi.mock("../../src/services/ai-autonomy.service.js", () => ({
  resolveAutonomy: resolveAutonomyMock,
  assertLevelAtLeast: assertLevelAtLeastMock
}));

const dispatchNotificationMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: dispatchNotificationMock }));

const { createProposalAndMaybeApply } = await import("../../src/services/ai-proposal.service.js");

let client: PrismaClient;

function autonomy(level: string, guardrails: Record<string, unknown> = {}) {
  return {
    effectiveLevel: level,
    guardrails: { maxChangesPerRun: null, maxRunsPerDay: null, maxCostUsdPerRun: null, undoWindowHours: null, scopeProjectIds: null, ...guardrails }
  };
}

/** A created proposal with `n` UPDATE rows. */
function created(n: number, scopeProjectId: string | null = "proj-1") {
  return {
    id: "prop-1",
    scopeProjectId,
    status: "PENDING_REVIEW",
    kind: "ASSIGNMENT_REBALANCE",
    expiresAt: new Date(Date.now() + 3_600_000),
    changes: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      op: "UPDATE",
      targetType: "BOOKING",
      targetId: `b${i}`,
      before: { userId: "ana" },
      after: { userId: "ben" },
      summary: `Move ${i}`,
      order: i,
      accepted: null,
      appliedAt: null
    }))
  };
}

const DRAFT = {
  capability: "assignment_rebalance",
  kind: "ASSIGNMENT_REBALANCE" as const,
  title: "Rebalance",
  scopeProjectId: "proj-1",
  requestedById: "u1",
  changes: [{ targetType: "BOOKING" as const, targetId: "b0", op: "UPDATE" as const, before: { userId: "ana" }, after: { userId: "ben" }, summary: "Move 0" }]
};

beforeEach(() => {
  client = createFakeTenantClient();
  resolveAutonomyMock.mockReset();
  dispatchNotificationMock.mockClear();
  vi.mocked(client.aiProposal.create).mockResolvedValue(created(1) as never);
  vi.mocked(client.aiProposal.findUnique).mockResolvedValue(created(1) as never);
  vi.mocked(client.aiProposal.update).mockResolvedValue({} as never);
  vi.mocked(client.aiProposalChange.update).mockResolvedValue({} as never);
  vi.mocked(client.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(client.resourceBooking.findUnique).mockResolvedValue({ id: "b0", userId: "ana" } as never);
  vi.mocked(client.resourceBooking.update).mockResolvedValue({} as never);
  vi.mocked(client.user.findFirst).mockResolvedValue({ id: "ben" } as never);
});

describe("at SUGGEST, nothing changes", () => {
  it("creates the proposal and applies nothing", async () => {
    resolveAutonomyMock.mockResolvedValue(autonomy("SUGGEST"));

    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(result).toMatchObject({ proposalId: "prop-1", autoApplied: false, applied: 0 });
    expect(client.resourceBooking.update).not.toHaveBeenCalled();
    // No notification either: nothing happened, and telling somebody nothing happened is noise.
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
  });
});

describe("at AUTO_APPLY, it applies its own change set", () => {
  beforeEach(() => resolveAutonomyMock.mockResolvedValue(autonomy("AUTO_APPLY")));

  it("goes through applyProposal, so every existing protection still runs", async () => {
    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(result).toMatchObject({ autoApplied: true, applied: 1 });
    expect(client.resourceBooking.update).toHaveBeenCalled();
    // The audit row records the delegating person as actor and AGENT as the type — the whole
    // point of the provenance work: whose authority, and that they did not press anything.
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ai_proposal.applied",
          actorId: "u1",
          actorType: "AGENT",
          actorLabel: "agent:assignment_rebalance"
        })
      })
    );
  });

  it("still refuses a row somebody moved since — autonomy does not buy past the staleness check", async () => {
    // The booking now belongs to somebody else. A human applier would be refused here; so is this.
    vi.mocked(client.resourceBooking.findUnique).mockResolvedValue({ id: "b0", userId: "carl" } as never);

    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(result.applied).toBe(0);
    expect(client.resourceBooking.update).not.toHaveBeenCalled();
  });

  it("tells the person, because a veto nobody is told about is not a veto", async () => {
    await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(dispatchNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", category: "ai.autonomy_applied", link: "/app/proposals" })
    );
  });

  it("still tells them when some rows were refused, and says so", async () => {
    vi.mocked(client.resourceBooking.findUnique).mockResolvedValue({ id: "b0", userId: "carl" } as never);
    await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(dispatchNotificationMock.mock.calls[0][0].body).toMatch(/left 1 alone/i);
  });

  it("does not let a failed notification undo a change that already landed", async () => {
    // The database and somebody's inbox disagreeing is bad; a change rolling back because an
    // email bounced is worse.
    dispatchNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));
    expect(result.applied).toBe(1);
  });
});

describe("guardrails degrade to review rather than failing", () => {
  it("holds a proposal bigger than the change budget", async () => {
    resolveAutonomyMock.mockResolvedValue(autonomy("AUTO_APPLY", { maxChangesPerRun: 2 }));
    vi.mocked(client.aiProposal.create).mockResolvedValue(created(5) as never);

    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(result.autoApplied).toBe(false);
    expect(result.heldForReview).toMatch(/more than the 2/);
    // The proposal still exists and is reviewable — it did not fail, it needs a person.
    expect(result.proposalId).toBe("prop-1");
    expect(client.resourceBooking.update).not.toHaveBeenCalled();
  });

  it("holds a proposal outside the projects it may act on", async () => {
    resolveAutonomyMock.mockResolvedValue(autonomy("AUTO_APPLY", { scopeProjectIds: ["proj-other"] }));

    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));

    expect(result.autoApplied).toBe(false);
    expect(result.heldForReview).toMatch(/specific projects/i);
  });

  it("holds a workspace-wide proposal when a project allowlist is set", async () => {
    // No scope means it could land anywhere, which is precisely what an allowlist rules out.
    resolveAutonomyMock.mockResolvedValue(autonomy("AUTO_APPLY", { scopeProjectIds: ["proj-1"] }));
    vi.mocked(client.aiProposal.create).mockResolvedValue(created(1, null) as never);

    const result = await runInTenant(client, () => createProposalAndMaybeApply({ ...DRAFT, scopeProjectId: null }));
    expect(result.autoApplied).toBe(false);
  });

  it("applies when the proposal is inside the allowlist and within budget", async () => {
    resolveAutonomyMock.mockResolvedValue(autonomy("AUTO_APPLY", { maxChangesPerRun: 5, scopeProjectIds: ["proj-1"] }));

    const result = await runInTenant(client, () => createProposalAndMaybeApply(DRAFT));
    expect(result).toMatchObject({ autoApplied: true, applied: 1, heldForReview: null });
  });
});
