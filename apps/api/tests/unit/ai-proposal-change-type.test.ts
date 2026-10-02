/**
 * An AI proposal cannot create a ticket of the CHANGE type.
 *
 * A change IS a ticket, but only the change module may create one: a CHANGE-typed ticket with no
 * change request behind it shows up as a change nobody raised, with no plan, no approval and no
 * lifecycle. Every human and API create path refuses the type (ticket.service.ts#assertValidTicketType);
 * the proposal applier — the one other way a ticket comes into being — did not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { applyProposal } = await import("../../src/services/ai-proposal.service.js");

let client: ReturnType<typeof createFakeTenantClient>;

function proposalCreating(after: Record<string, unknown>) {
  return {
    id: "p1",
    status: "PENDING",
    expiresAt: null,
    scopeProjectId: "proj-1",
    scopeTicketId: null,
    requestedById: "u1",
    changes: [{ id: "c1", op: "CREATE", targetType: "TICKET", targetId: null, before: null, after, summary: "Create", accepted: true, order: 0 }]
  };
}

beforeEach(() => {
  client = createFakeTenantClient();
  // The shared fake has no ticket.create; the assertion below is that it is never reached.
  (client.ticket as unknown as Record<string, unknown>).create = vi.fn().mockResolvedValue({ id: "new-ticket" });
  vi.mocked(client.project.findFirst).mockResolvedValue({ id: "proj-1" } as never);
  vi.mocked(client.project.update).mockResolvedValue({ id: "proj-1", code: "WEB", ticketSeq: 7 } as never);
  const settings = { id: "global", slaLowHours: 168, slaMediumHours: 72, slaHighHours: 24, slaCriticalHours: 4 };
  vi.mocked(client.globalTicketSettings.upsert).mockResolvedValue(settings as never);
  vi.mocked(client.globalTicketSettings.findUnique).mockResolvedValue(settings as never);
  vi.mocked(client.aiProposalChange.update).mockResolvedValue({} as never);
  vi.mocked(client.aiProposal.update).mockResolvedValue({} as never);
});

describe("applying a proposal that creates a ticket", () => {
  it("refuses the CHANGE type and creates nothing", async () => {
    vi.mocked(client.aiProposal.findUnique).mockResolvedValue(proposalCreating({ title: "Rotate the cert", type: "CHANGE" }) as never);

    const result = await runInTenant(client as unknown as PrismaClient, () => applyProposal({ proposalId: "p1", decisions: { c1: true }, actorId: "u1" }));

    expect((client.ticket as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
    expect(result.failed).toEqual([expect.objectContaining({ id: "c1", reason: expect.stringMatching(/CHANGE type/) })]);
  });
});
