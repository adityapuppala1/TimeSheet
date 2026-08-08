/**
 * Proposal decisions reach the dataset promotion path.
 *
 * `ai-proposal.service.ts` has called per-row accept/reject "far richer than the thumbs-up/down"
 * since it was written; until sourceInteractionId landed, nothing could act on it. These tests pin
 * the join: an interaction whose proposal a human refused (rejected, undone, or rows declined)
 * surfaces as a promotable problem, labelled with WHY it is on the list.
 *
 * Test-by-breaking: verified by removing the `id: { in: problemIds }` OR-branch — the first two
 * tests fail, the onlyProblems:false test keeps passing, which is exactly the split expected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const { listPromotableInteractions } = await import("../../src/services/ai-dataset.service.js");

let client: PrismaClient;

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.aiProposal.findMany).mockResolvedValue([{ sourceInteractionId: "int-undone" }] as never);
  vi.mocked(client.aIInteraction.findMany).mockResolvedValue([
    { id: "int-undone", feature: "plan_breakdown", parseOk: true, feedback: null, outputText: "…", paramsJson: {}, createdAt: new Date() }
  ] as never);
});

describe("refused proposals as promotable problems", () => {
  it("includes interactions whose proposal a human refused in the problems filter", async () => {
    await runInTenant(client, () => listPromotableInteractions({ feature: "plan_breakdown" }));

    const where = (vi.mocked(client.aIInteraction.findMany).mock.calls[0][0] as never as { where: { OR: unknown[] } }).where;
    // parse failures, thumbs-down, AND proposal refusals — three signals, one list.
    expect(JSON.stringify(where.OR)).toContain("int-undone");
  });

  it("asks for the proposals a human actually refused, not merely reviewed", async () => {
    await runInTenant(client, () => listPromotableInteractions({ feature: "plan_breakdown" }));

    const where = JSON.stringify((vi.mocked(client.aiProposal.findMany).mock.calls[0][0] as never as { where: unknown }).where);
    // Undo — a human explicitly reversing the machine — is the strongest negative signal there is.
    expect(where).toContain("UNDONE");
    expect(where).toContain("REJECTED");
    // A row declined at review time counts too; an APPLIED proposal with every row accepted does not.
    expect(where).toContain('"accepted":false');
  });

  it("labels the rows so the UI can say why each one is on the list", async () => {
    const rows = await runInTenant(client, () => listPromotableInteractions({ feature: "plan_breakdown" }));
    expect(rows[0]).toMatchObject({ id: "int-undone", proposalRefused: true, replayable: true });
  });
});

describe("the unfiltered view", () => {
  it("skips the proposal query entirely when problems are not being filtered for", async () => {
    await runInTenant(client, () => listPromotableInteractions({ feature: "plan_breakdown", onlyProblems: false }));
    expect(client.aiProposal.findMany).not.toHaveBeenCalled();
  });
});
