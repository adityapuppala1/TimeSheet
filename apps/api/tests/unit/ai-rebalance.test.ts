/**
 * The rebalance producer — and the reason it contains no model call.
 *
 * Who is overloaded and by how much is arithmetic that `workload.service.ts` already does. The
 * tests that matter here are therefore not "did it call the AI" but "did it do the sums right, and
 * does it refuse when the honest answer is no":
 *
 *   - it never moves work onto somebody it would thereby overload (including via its OWN earlier
 *     moves in the same proposal — the bug that would otherwise pile everything onto whoever is
 *     emptiest);
 *   - it says nothing rather than something when there is nothing useful to say;
 *   - every row carries the before-state, because that is what makes it applicable and reversible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const loadWorkloadMock = vi.fn();
vi.mock("../../src/services/workload.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/workload.service.js")>()),
  loadWorkload: loadWorkloadMock
}));

// The producer goes through createProposalAndMaybeApply, not createProposal — it does not decide
// for itself whether it may act, so the thing to mock is the function that asks the policy.
const createProposalMock = vi.fn().mockResolvedValue({ proposalId: "prop-1", autoApplied: false, applied: 0, heldForReview: null });
vi.mock("../../src/services/ai-proposal.service.js", () => ({ createProposalAndMaybeApply: createProposalMock }));

const { proposeAssignmentRebalance } = await import("../../src/services/ai-rebalance.service.js");

let client: PrismaClient;

/** allocationPct drives who is overloaded; capacity/booked drive whether a move fits. */
function person(id: string, name: string, allocationPct: number, capacityHours = 40, bookedHours = 0) {
  return { person: { id, name }, cells: [], totals: { capacityHours, bookedHours, loggedHours: 0, timeOffHours: 0, allocationPct, overAllocatedBuckets: 0 } };
}

function booking(id: string, userId: string, hoursPerDay: number, note: string | null = null) {
  return { id, userId, hoursPerDay, startDate: new Date("2026-08-10"), endDate: new Date("2026-08-14"), note };
}

const WINDOW = { from: new Date("2026-08-10"), to: new Date("2026-08-21"), requestedById: "u1", projectId: "proj-1" };

beforeEach(() => {
  client = createFakeTenantClient();
  createProposalMock.mockClear().mockResolvedValue({ proposalId: "prop-1", autoApplied: false, applied: 0, heldForReview: null });
  loadWorkloadMock.mockReset();
  vi.mocked(client.project.findFirst).mockResolvedValue({ id: "proj-1", name: "Web" } as never);
  vi.mocked(client.resourceBooking.findMany).mockResolvedValue([] as never);
});

describe("it proposes moves that actually help", () => {
  it("moves a booking from the overloaded person to the one with room", async () => {
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 140, 40, 56), person("ben", "Ben", 40, 40, 16)] });
    vi.mocked(client.resourceBooking.findMany).mockResolvedValue([booking("b1", "ana", 4, "SSO work")] as never);

    const result = await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));

    expect(result).toMatchObject({ proposalId: "prop-1", moves: 1 });
    const changes = createProposalMock.mock.calls[0][0].changes;
    expect(changes[0]).toMatchObject({
      targetType: "BOOKING",
      targetId: "b1",
      op: "UPDATE",
      before: { userId: "ana" },
      after: { userId: "ben" }
    });
    // The summary is what a reviewer reads instead of JSON.
    expect(changes[0].summary).toBe('Move "SSO work" from Ana to Ben');
  });

  it("claims no model and no confidence, because nothing here came from one", async () => {
    // Inventing a confidence score for arithmetic would be inventing a number.
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 140, 40, 56), person("ben", "Ben", 40, 40, 16)] });
    vi.mocked(client.resourceBooking.findMany).mockResolvedValue([booking("b1", "ana", 4)] as never);

    await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));

    const call = createProposalMock.mock.calls[0][0];
    expect(call.kind).toBe("ASSIGNMENT_REBALANCE");
    expect(call.model).toBeUndefined();
    expect(call.confidence).toBeUndefined();
  });

  it("does not pile every move onto whoever is emptiest", async () => {
    // The bug this guards: without tracking what has already been handed out WITHIN the proposal,
    // every booking targets the same person and applying it recreates the overload elsewhere.
    // Ben has 40h capacity and 16h booked — room for 24h, so only two 12h/day bookings fit.
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 200, 40, 80), person("ben", "Ben", 40, 40, 16)] });
    vi.mocked(client.resourceBooking.findMany).mockResolvedValue([
      booking("b1", "ana", 12),
      booking("b2", "ana", 12),
      booking("b3", "ana", 12)
    ] as never);

    const result = await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));

    expect(result.moves).toBeLessThan(3);
    const targets = createProposalMock.mock.calls[0][0].changes.map((c: { after: { userId: string } }) => c.after.userId);
    expect(targets.every((t: string) => t === "ben")).toBe(true);
  });

  it("never moves a booking onto its own owner", async () => {
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 140, 40, 56), person("ben", "Ben", 10, 40, 4)] });
    vi.mocked(client.resourceBooking.findMany).mockResolvedValue([booking("b1", "ana", 2)] as never);

    await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));
    expect(createProposalMock.mock.calls[0][0].changes[0].after.userId).not.toBe("ana");
  });
});

describe("it says nothing rather than something", () => {
  it("when nobody is over capacity", async () => {
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 80), person("ben", "Ben", 60)] });
    const result = await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));

    expect(result).toMatchObject({ proposalId: null, moves: 0 });
    expect(result.reason).toMatch(/over capacity/i);
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it("when everyone is overloaded, and says so rather than shuffling", async () => {
    // Moving work from 140% to 130% is not a rebalance, it is theatre. This needs more people or a
    // later deadline, and saying that is more useful than a proposal that helps nobody.
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 140), person("ben", "Ben", 130)] });
    const result = await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));

    expect(result.proposalId).toBeNull();
    expect(result.reason).toMatch(/more people or a later deadline/i);
  });

  it("when the work is in blocks too big for anyone's remaining room", async () => {
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 200, 40, 80), person("ben", "Ben", 70, 40, 28)] });
    vi.mocked(client.resourceBooking.findMany).mockResolvedValue([booking("b1", "ana", 30)] as never);

    const result = await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));
    expect(result.proposalId).toBeNull();
    expect(result.reason).toMatch(/too large/i);
  });

  it("when there is only one person on the project", async () => {
    loadWorkloadMock.mockResolvedValue({ rows: [person("ana", "Ana", 200)] });
    const result = await runInTenant(client, () => proposeAssignmentRebalance(WINDOW));
    expect(result.reason).toMatch(/only one person/i);
  });

  it("404s a project that does not exist, rather than proposing into the void", async () => {
    vi.mocked(client.project.findFirst).mockResolvedValue(null as never);
    await expect(runInTenant(client, () => proposeAssignmentRebalance(WINDOW))).rejects.toMatchObject({ statusCode: 404 });
  });
});
