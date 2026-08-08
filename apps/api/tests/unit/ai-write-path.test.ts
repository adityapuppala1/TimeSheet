/**
 * What happens to a model's answer once the app decides to ACT on it.
 *
 * Two write paths, both fed by content this app ingests from outside itself:
 *
 *  - The AI PR-review summary. Its prompt is a pull request's title, description and diff — text
 *    written by whoever opened the PR — and its answer is stored as a ticket comment. The handler
 *    used to build that comment's HTML by interpolation, so a PR description asking the model to
 *    include markup got that markup persisted. The web client re-sanitizes on render, so this was
 *    never a live XSS; it was the one AI comment path with nothing but that single layer, while its
 *    two siblings in security-report.service.ts had escaped all along.
 *
 *  - Applying an AI proposal. `TICKET_WRITABLE` already anticipates `assigneeId`, and
 *    `ProposalKind` already declares `ASSIGNMENT_REBALANCE`. An id inside a proposal's `after`
 *    blob is a suggestion from whatever produced it; whether it names a live row is a question the
 *    apply path has to answer rather than assume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/plan-schedule.service.js", () => ({
  assertNoParentCycle: vi.fn(),
  toDay: (value: string) => new Date(value)
}));

const { renderPrReviewSummaryComment } = await import("../../src/services/git-provider.service.js");
const { applyProposal } = await import("../../src/services/ai-proposal.service.js");
const { createFakeTenantClient } = await import("../helpers/fake-prisma-client.js");
const { runInTenant } = await import("../helpers/tenant-context.js");

describe("renderPrReviewSummaryComment", () => {
  it("escapes markup the model emits instead of storing it as live HTML", () => {
    const body = renderPrReviewSummaryComment({
      summary: '<img src=x onerror="alert(1)">Looks fine to me',
      riskLevel: "LOW",
      reviewFocus: "<script>fetch('//evil')</script>"
    });

    // The model's words survive as readable text…
    expect(body).toContain("Looks fine to me");
    // …but there is no element left for an event handler or a script to hang off: the only tags
    // in the result are the ones this function wrote itself.
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script");
    expect(body).toContain("&lt;img src=x onerror=");
    expect(body.replace(/<\/?(p|strong|em)>/g, "")).not.toMatch(/<[a-z]/i);
  });

  it("still renders the risk badge and both fields", () => {
    const body = renderPrReviewSummaryComment({ summary: "Adds a cache.", riskLevel: "HIGH", reviewFocus: "Invalidation." });
    expect(body).toContain("🔴 HIGH");
    expect(body).toContain("Adds a cache.");
    expect(body).toContain("Invalidation.");
  });
});

describe("applyProposal validates the ids inside a change before writing them", () => {
  /** A fake client with the proposal tables the apply path touches. */
  function proposalClient(change: Record<string, unknown>, proposalOverrides: Record<string, unknown> = {}) {
    const client = createFakeTenantClient() as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
    const row = { id: "chg-1", order: 0, accepted: true, applyError: null, appliedAt: null, ...change };
    client.aiProposal = {
      findUnique: vi.fn().mockResolvedValue({
        id: "prop-1",
        status: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopeProjectId: "proj-1",
        scopeTicketId: null,
        kind: "ASSIGNMENT_REBALANCE",
        changes: [row],
        ...proposalOverrides
      }),
      update: vi.fn().mockResolvedValue({})
    };
    client.aiProposalChange = { update: vi.fn().mockResolvedValue({}) };
    return client as unknown as ReturnType<typeof createFakeTenantClient>;
  }

  const CURRENT_TICKET = { id: "tkt-1", projectId: "proj-1", parentId: null, assigneeId: "old-user", deletedAt: null };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an assignee id that is not an active user, and records why on the row", async () => {
    const client = proposalClient({
      op: "UPDATE",
      targetType: "TICKET",
      targetId: "tkt-1",
      before: { assigneeId: "old-user" },
      after: { assigneeId: "not-a-real-user" },
      summary: "Move TCK-1 to somebody"
    });
    vi.mocked(client.ticket.findFirst).mockResolvedValue(CURRENT_TICKET as never);
    vi.mocked(client.user.findFirst).mockResolvedValue(null as never);

    const result = await runInTenant(client, () => applyProposal({ proposalId: "prop-1", decisions: { "chg-1": true }, actorId: "actor-1" }));

    expect(result.applied).toBe(0);
    expect(result.failed[0].reason).toMatch(/active user/);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("applies the same change once the assignee is a real active user", async () => {
    const client = proposalClient({
      op: "UPDATE",
      targetType: "TICKET",
      targetId: "tkt-1",
      before: { assigneeId: "old-user" },
      after: { assigneeId: "new-user" },
      summary: "Move TCK-1 to Ben"
    });
    vi.mocked(client.ticket.findFirst).mockResolvedValue(CURRENT_TICKET as never);
    vi.mocked(client.user.findFirst).mockResolvedValue({ id: "new-user" } as never);
    vi.mocked(client.ticket.update).mockResolvedValue({} as never);

    const result = await runInTenant(client, () => applyProposal({ proposalId: "prop-1", decisions: { "chg-1": true }, actorId: "actor-1" }));

    expect(result.applied).toBe(1);
    expect(client.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assigneeId: "new-user" }) }));
  });

  it("refuses a parent that lives in another project", async () => {
    const client = proposalClient({
      op: "UPDATE",
      targetType: "TICKET",
      targetId: "tkt-1",
      before: { parentId: null },
      after: { parentId: "tkt-in-another-project" },
      summary: "Re-parent TCK-1"
    });
    vi.mocked(client.ticket.findFirst)
      .mockResolvedValueOnce(CURRENT_TICKET as never) // the row being updated
      .mockResolvedValueOnce(null as never); // the proposed parent, scoped to the same project
    vi.mocked(client.ticket.findMany).mockResolvedValue([] as never);

    const result = await runInTenant(client, () => applyProposal({ proposalId: "prop-1", decisions: { "chg-1": true }, actorId: "actor-1" }));

    expect(result.applied).toBe(0);
    expect(result.failed[0].reason).toMatch(/this project/);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });
});
