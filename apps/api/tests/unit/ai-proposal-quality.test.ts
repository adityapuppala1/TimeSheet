/**
 * Per-row proposal decisions as a quality signal.
 *
 * `ai-proposal.service.ts` has said since it was written that per-row accept/reject is "a far
 * richer signal than the thumbs-up/down on AIInteraction, and produced as a by-product of people
 * doing their normal work rather than as a favour to the model". Nothing read it. Thumbs are
 * self-selected and rare; every reviewed proposal produces a decision on every row whether anybody
 * feels like rating it or not.
 *
 * The distinctions this file pins are the ones that make the number honest:
 *   - an undecided row is not a rejection;
 *   - a row REFUSED at apply time is the envelope working, not the model being wrong;
 *   - an UNDONE row is worse than a rejected one and is counted apart from it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const { getProposalDecisionStats } = await import("../../src/services/ai-quality.service.js");

let client: PrismaClient;

function change(over: Record<string, unknown> = {}) {
  return {
    accepted: null,
    appliedAt: null,
    undoneAt: null,
    applyError: null,
    proposal: { kind: "PLAN_BREAKDOWN" },
    ...over
  };
}

beforeEach(() => {
  client = createFakeTenantClient();
});

const SINCE = new Date("2026-07-01");

describe("what a decision counts as", () => {
  it("counts accepted and rejected rows apart", async () => {
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([
      change({ accepted: true, appliedAt: new Date() }),
      change({ accepted: true, appliedAt: new Date() }),
      change({ accepted: false })
    ] as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats).toMatchObject({ kind: "PLAN_BREAKDOWN", accepted: 2, rejected: 1, undone: 0, refused: 0 });
  });

  it("does not count an undecided row as a rejection", async () => {
    // Every unreviewed proposal would otherwise look like a failure, and the number would fall
    // whenever people were merely busy.
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([change(), change(), change()] as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats).toMatchObject({ accepted: 0, rejected: 0, undone: 0, refused: 0 });
  });

  it("counts a row refused at apply time as refused, not rejected", async () => {
    // A stale before-state means somebody else moved the row first. That is the envelope doing its
    // job — scoring it against the model would punish it for a protection working.
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([
      change({ accepted: true, applyError: '"priority" has changed since this was suggested' })
    ] as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats).toMatchObject({ refused: 1, rejected: 0, accepted: 0 });
  });

  it("counts an undone row apart from a rejected one", async () => {
    // Rejecting is "I read this and disagreed". Undoing is "I let it happen and then took it
    // back", which is a worse outcome and worth seeing on its own.
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([
      change({ accepted: true, appliedAt: new Date(), undoneAt: new Date() })
    ] as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats).toMatchObject({ undone: 1, accepted: 0, rejected: 0 });
  });
});

describe("the rate", () => {
  it("is null below the threshold, like the thumbs rate", async () => {
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([
      change({ accepted: true, appliedAt: new Date() }),
      change({ accepted: false })
    ] as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats.acceptRate).toBeNull();
  });

  it("counts undone rows against the rate once there are enough decisions", async () => {
    const rows = [
      ...Array.from({ length: 8 }, () => change({ accepted: true, appliedAt: new Date() })),
      ...Array.from({ length: 2 }, () => change({ accepted: true, appliedAt: new Date(), undoneAt: new Date() }))
    ];
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue(rows as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    // 8 accepted of 10 decided — the two undone rows pull it down, which is the point.
    expect(stats.acceptRate).toBe(0.8);
  });

  it("does not let refused rows distort it", async () => {
    const rows = [
      ...Array.from({ length: 10 }, () => change({ accepted: true, appliedAt: new Date() })),
      ...Array.from({ length: 5 }, () => change({ accepted: true, applyError: "stale" }))
    ];
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue(rows as never);

    const [stats] = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats.acceptRate).toBe(1);
    expect(stats.refused).toBe(5);
  });
});

describe("grouping", () => {
  it("splits by proposal kind, busiest first", async () => {
    vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([
      change({ accepted: true, appliedAt: new Date(), proposal: { kind: "ASSIGNMENT_REBALANCE" } }),
      change({ accepted: true, appliedAt: new Date() }),
      change({ accepted: false }),
      change({ accepted: true, appliedAt: new Date() })
    ] as never);

    const stats = await runInTenant(client, () => getProposalDecisionStats(SINCE));
    expect(stats.map((s) => s.kind)).toEqual(["PLAN_BREAKDOWN", "ASSIGNMENT_REBALANCE"]);
  });
});
