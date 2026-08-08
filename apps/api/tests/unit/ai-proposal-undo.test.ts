/**
 * Undo, and the one property that makes it safe rather than merely reversible.
 *
 * `applyProposal` refuses a row whose current value no longer matches the `before` it was computed
 * against, because applying it would silently revert whoever moved it in the meantime. Undo faces
 * the identical hazard from the other direction: if somebody edited a field AFTER the assistant
 * set it, putting it back would clobber that person just as invisibly. So a row is only reverted
 * while it still holds exactly what we wrote.
 *
 * That symmetry is what most of this file is about. The rest is the ordering rule — links come out
 * before the rows they point at — and the refusals that have to stay refusals rather than becoming
 * silent skips.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const { undoProposal } = await import("../../src/services/ai-proposal.service.js");

let client: PrismaClient;

/** One applied UPDATE row: priority was LOW, the assistant set it to HIGH. */
function updateChange(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    op: "UPDATE",
    targetType: "TICKET",
    targetId: "t1",
    before: { priority: "LOW" },
    after: { priority: "HIGH" },
    summary: "Raise TCK-1 to high",
    appliedAt: new Date("2026-08-08T10:00:00Z"),
    undoneAt: null,
    order: 0,
    ...overrides
  };
}

function proposal(changes: Array<Record<string, unknown>>, status = "APPLIED") {
  return { id: "p1", kind: "PLAN_BREAKDOWN", status, scopeProjectId: "proj-1", changes };
}

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.aiProposalChange.update).mockResolvedValue({} as never);
  vi.mocked(client.aiProposal.update).mockResolvedValue({} as never);
  vi.mocked(client.auditLog.create).mockResolvedValue({} as never);
});

describe("the symmetric staleness check", () => {
  it("puts a field back when it still holds exactly what the assistant wrote", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposal([updateChange()]) as never);
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t1", priority: "HIGH", projectId: "proj-1" } as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));

    expect(result).toMatchObject({ undone: 1, status: "UNDONE" });
    expect(client.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1" }, data: expect.objectContaining({ priority: "LOW" }) })
    );
  });

  it("REFUSES to revert a field somebody has changed since — the whole point", async () => {
    // A person moved it to CRITICAL after the assistant set HIGH. Reverting to LOW would erase
    // their edit, and they would never know it had happened.
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposal([updateChange()]) as never);
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t1", priority: "CRITICAL", projectId: "proj-1" } as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));

    expect(result.undone).toBe(0);
    expect(result.status).toBe("PARTIALLY_UNDONE");
    expect(result.refused[0].reason).toMatch(/changed since/i);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("records the refusal on the row, so a half-undone proposal explains itself", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposal([updateChange()]) as never);
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t1", priority: "CRITICAL", projectId: "proj-1" } as never);

    await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));

    expect(client.aiProposalChange.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" }, data: expect.objectContaining({ undoError: expect.stringMatching(/changed since/i) }) })
    );
  });

  it("reverts the good rows even when another refuses", async () => {
    // Per-row independence, matching apply: one stale row is not a reason to abandon the rest.
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([updateChange(), updateChange({ id: "c2", targetId: "t2", order: 1 })]) as never
    );
    vi.mocked(client.ticket.findFirst).mockImplementation((async (args: { where: { id: string } }) =>
      args.where.id === "t1"
        ? { id: "t1", priority: "HIGH", projectId: "proj-1" }
        : { id: "t2", priority: "CRITICAL", projectId: "proj-1" }) as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result).toMatchObject({ undone: 1, status: "PARTIALLY_UNDONE" });
  });
});

describe("what undo will and will not touch", () => {
  it("soft-deletes a ticket the assistant created", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{ id: "c1", op: "CREATE", targetType: "TICKET", targetId: "t9", before: null, after: { title: "New" }, summary: "Create", appliedAt: new Date(), undoneAt: null, order: 0 }]) as never
    );
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t9", projectId: "proj-1" } as never);
    vi.mocked(client.ticket.count).mockResolvedValue(0 as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));

    expect(result.undone).toBe(1);
    // Soft, not hard — a hard delete would take comments and attachments somebody may have added
    // since along with it.
    expect(client.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t9" }, data: { deletedAt: expect.any(Date) } })
    );
  });

  it("refuses to remove a created ticket that now has work filed under it", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{ id: "c1", op: "CREATE", targetType: "TICKET", targetId: "t9", before: null, after: {}, summary: "Create", appliedAt: new Date(), undoneAt: null, order: 0 }]) as never
    );
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t9", projectId: "proj-1" } as never);
    vi.mocked(client.ticket.count).mockResolvedValue(2 as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result.refused[0].reason).toMatch(/orphan/i);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("removes links BEFORE the rows they point at", async () => {
    // Apply creates parents first so children and links can reference them; undo has to run the
    // other way or it would delete a row something still points to.
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([
        { id: "create", op: "CREATE", targetType: "TICKET", targetId: "t9", before: null, after: {}, summary: "Create", appliedAt: new Date(), undoneAt: null, order: 0 },
        { id: "link", op: "LINK", targetType: "LINK", targetId: null, before: null, after: { fromId: "t9", toId: "t8" }, summary: "Link", appliedAt: new Date(), undoneAt: null, order: 1 }
      ]) as never
    );
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t9", projectId: "proj-1" } as never);
    vi.mocked(client.ticket.count).mockResolvedValue(0 as never);
    vi.mocked(client.ticketLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));

    const linkAt = vi.mocked(client.aiProposalChange.update).mock.calls.findIndex((c) => (c[0] as never as { where: { id: string } }).where.id === "link");
    const createAt = vi.mocked(client.aiProposalChange.update).mock.calls.findIndex((c) => (c[0] as never as { where: { id: string } }).where.id === "create");
    expect(linkAt).toBeLessThan(createAt);
  });

  it("refuses a link it cannot identify rather than guessing which one to delete", async () => {
    // Apply resolves index-based ends at apply time and does not write them back. Deleting the
    // wrong dependency is worse than leaving this one in place.
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{ id: "c1", op: "LINK", targetType: "LINK", targetId: null, before: null, after: { fromIndex: 0, toIndex: 1 }, summary: "Link", appliedAt: new Date(), undoneAt: null, order: 0 }]) as never
    );

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result.refused[0].reason).toMatch(/cannot be identified/i);
    expect(client.ticketLink.deleteMany).not.toHaveBeenCalled();
  });
});

describe("what cannot be undone", () => {
  it("refuses a proposal that was never applied", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposal([updateChange()], "PENDING_REVIEW") as never);
    await expect(runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }))).rejects.toMatchObject({
      statusCode: 409
    });
  });

  it("refuses a second undo", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposal([updateChange()], "UNDONE") as never);
    await expect(runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }))).rejects.toMatchObject({
      statusCode: 409
    });
  });

  it("ignores rows that never landed rather than calling them undo failures", async () => {
    // A skipped or failed row has nothing to put back. Counting it as a refusal would be a lie.
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([updateChange({ appliedAt: null })], "PARTIALLY_APPLIED") as never
    );
    await expect(runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }))).rejects.toMatchObject({
      statusCode: 409
    });
  });

  it("404s an unknown proposal", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(null as never);
    await expect(runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }))).rejects.toMatchObject({
      statusCode: 404
    });
  });
});

describe("the audit row", () => {
  it("records a human reversing a machine, with the status transition", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposal([updateChange()]) as never);
    vi.mocked(client.ticket.findFirst).mockResolvedValue({ id: "t1", priority: "HIGH", projectId: "proj-1" } as never);

    await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));

    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ai_proposal.undone",
          actorId: "u1",
          before: { status: "APPLIED" },
          after: { status: "UNDONE" }
        })
      })
    );
  });
});

/**
 * PROJECT and BOOKING targets. `ChangeTarget` declared both from the start but `applyProposal`
 * threw "unsupported change type" for either, so the two kinds of proposal that need them —
 * SCHEDULE_ADJUSTMENT and ASSIGNMENT_REBALANCE — had nowhere to land.
 *
 * The undo side is asserted here rather than only the apply side, because a target that can be
 * applied but not reversed is worse than one that cannot be applied at all: it is the state where
 * "you can always undo it" stops being true without anybody noticing.
 */
describe("the targets beyond TICKET can be put back too", () => {
  it("restores a project's planned dates", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{
        id: "c1", op: "UPDATE", targetType: "PROJECT", targetId: "proj-1",
        before: { plannedEndDate: "2026-09-30" }, after: { plannedEndDate: "2026-10-31" },
        summary: "Push the end date", appliedAt: new Date(), undoneAt: null, order: 0
      }]) as never
    );
    vi.mocked(client.project.findFirst).mockResolvedValue({ id: "proj-1", plannedEndDate: new Date("2026-10-31") } as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result.undone).toBe(1);
    expect(client.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "proj-1" }, data: expect.objectContaining({ plannedEndDate: expect.any(Date) }) })
    );
  });

  it("refuses to restore a project date somebody has moved since", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{
        id: "c1", op: "UPDATE", targetType: "PROJECT", targetId: "proj-1",
        before: { plannedEndDate: "2026-09-30" }, after: { plannedEndDate: "2026-10-31" },
        summary: "Push the end date", appliedAt: new Date(), undoneAt: null, order: 0
      }]) as never
    );
    vi.mocked(client.project.findFirst).mockResolvedValue({ id: "proj-1", plannedEndDate: new Date("2026-12-01") } as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result.refused[0].reason).toMatch(/changed since/i);
    expect(client.project.update).not.toHaveBeenCalled();
  });

  it("moves a booking back to the person it was taken from", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{
        id: "c1", op: "UPDATE", targetType: "BOOKING", targetId: "b1",
        before: { userId: "ana" }, after: { userId: "ben" },
        summary: "Move the booking to Ben", appliedAt: new Date(), undoneAt: null, order: 0
      }]) as never
    );
    vi.mocked(client.resourceBooking.findUnique).mockResolvedValue({ id: "b1", userId: "ben" } as never);

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result.undone).toBe(1);
    expect(client.resourceBooking.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1" }, data: { userId: "ana" } })
    );
  });

  it("hard-deletes a booking it created, because a booking has no soft delete", async () => {
    // Unlike a ticket, which is soft-deleted so its comments and attachments survive. A booking is
    // a scheduling row with nothing hanging off it, and this is how the rest of the app removes one.
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(
      proposal([{
        id: "c1", op: "CREATE", targetType: "BOOKING", targetId: "b9",
        before: null, after: { userId: "ben" }, summary: "Book Ben", appliedAt: new Date(), undoneAt: null, order: 0
      }]) as never
    );

    const result = await runInTenant(client, () => undoProposal({ proposalId: "p1", actorId: "u1" }));
    expect(result.undone).toBe(1);
    expect(client.resourceBooking.deleteMany).toHaveBeenCalledWith({ where: { id: "b9" } });
  });
});
