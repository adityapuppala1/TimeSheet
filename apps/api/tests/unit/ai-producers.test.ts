/**
 * The three producers that completed the declared ProposalKind set.
 *
 * The pattern under test is the one the rebalance producer established: pure arithmetic decides,
 * `createProposalAndMaybeApply` asks the policy, every UPDATE carries the before-state that makes
 * it stale-checkable and undoable. None of these files may contain a model call, and the tests
 * would notice if one appeared — `createProposalAndMaybeApply` is asserted to receive no `model`
 * and no `confidence`, because claiming a confidence score for arithmetic is inventing a number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

vi.mock("../../src/services/ai-proposal.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProposalAndMaybeApply: vi.fn().mockResolvedValue({ proposalId: "p1", autoApplied: false, applied: 0, heldForReview: null })
}));
vi.mock("../../src/services/project-risk.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assessProject: vi.fn(),
  saveSnapshot: vi.fn().mockResolvedValue({ id: "snap-1" })
}));

const { createProposalAndMaybeApply } = await import("../../src/services/ai-proposal.service.js");
const { assessProject, saveSnapshot } = await import("../../src/services/project-risk.service.js");
const { proposeScheduleAdjustment } = await import("../../src/services/ai-schedule-adjust.service.js");
const { proposeRiskMitigation } = await import("../../src/services/ai-risk-mitigation.service.js");
const { proposeBlueprintInstantiation } = await import("../../src/services/ai-blueprint-propose.service.js");

let client: PrismaClient;

function draft() {
  return vi.mocked(createProposalAndMaybeApply).mock.calls.at(-1)?.[0] as never as {
    capability: string;
    kind: string;
    model?: string;
    confidence?: number;
    changes: Array<{ targetType: string; targetId?: string | null; op: string; before?: Record<string, unknown> | null; after: Record<string, unknown> }>;
  };
}

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(createProposalAndMaybeApply).mockClear();
  vi.mocked(client.globalPlanningSettings.findUnique).mockResolvedValue(null as never); // default Mon–Fri
});

/* ------------------------------- SCHEDULE_ADJUSTMENT ------------------------------- */

describe("proposeScheduleAdjustment", () => {
  function planTicket(over: Record<string, unknown>) {
    return {
      id: "t", key: "T-1", title: "t", parentId: null, startDate: null, endDate: null,
      isMilestone: false, progressPct: null, estimatedHours: null, status: "OPEN",
      workflowStatus: null, baselineStartDate: null, baselineEndDate: null,
      ...over
    };
  }

  beforeEach(() => {
    vi.mocked(client.project.findFirst).mockResolvedValue({ id: "proj", name: "Apollo" } as never);
    vi.mocked(client.timesheet.groupBy).mockResolvedValue([] as never);
    // A finishes Tuesday; B explicitly starts the same Monday it depends on A finishing — the
    // classic self-contradicting plan the solver reports and refuses to silently fix.
    vi.mocked(client.ticket.findMany).mockResolvedValue([
      planTicket({ id: "a", key: "T-1", startDate: new Date("2026-08-10"), endDate: new Date("2026-08-11") }),
      planTicket({ id: "b", key: "T-2", startDate: new Date("2026-08-10"), endDate: new Date("2026-08-11") })
    ] as never);
    vi.mocked(client.ticketLink.findMany).mockResolvedValue([
      { id: "l1", sourceTicketId: "a", targetTicketId: "b", type: "FINISH_TO_START", lagDays: 0 }
    ] as never);
  });

  it("moves only the violating item, to dates the solver itself computed", async () => {
    const outcome = await runInTenant(client, () => proposeScheduleAdjustment({ projectId: "proj", requestedById: "u1" }));

    expect(outcome.proposalId).toBe("p1");
    const d = draft();
    expect(d.capability).toBe("schedule_adjustment");
    expect(d.kind).toBe("SCHEDULE_ADJUSTMENT");
    expect(d.model).toBeUndefined();
    expect(d.confidence).toBeUndefined();
    // One correction — for B, the item in violation. A stays where a human put it.
    expect(d.changes).toHaveLength(1);
    const change = d.changes[0];
    expect(change).toMatchObject({ targetType: "TICKET", targetId: "b", op: "UPDATE" });
    // The before-state is what makes this stale-checkable and undoable.
    expect(change.before).toMatchObject({ startDate: "2026-08-10" });
    // Moved past its predecessor's Tuesday finish — never earlier.
    expect(String(change.after.startDate) > "2026-08-11").toBe(true);
  });

  it("proposes nothing when every date already agrees with its dependencies", async () => {
    vi.mocked(client.ticketLink.findMany).mockResolvedValue([] as never);

    const outcome = await runInTenant(client, () => proposeScheduleAdjustment({ projectId: "proj", requestedById: "u1" }));

    expect(outcome.proposalId).toBeNull();
    expect(outcome.reason).toContain("already agrees");
    expect(createProposalAndMaybeApply).not.toHaveBeenCalled();
  });
});

/* -------------------------------- RISK_MITIGATION -------------------------------- */

describe("proposeRiskMitigation", () => {
  function assessment(over: Record<string, unknown> = {}) {
    return {
      projectId: "proj", projectName: "Apollo", projectCode: "APO",
      riskScore: 48, band: "AMBER",
      signals: [{ key: "scheduleSlip", severity: 0.5, points: 12, detail: { plannedEndOverrunDays: 3 }, note: "slipping" }],
      topConcerns: ["The schedule runs 3 working day(s) past the planned end date."],
      facts: {},
      ...over
    };
  }

  beforeEach(() => {
    vi.mocked(client.project.findFirst).mockResolvedValue({
      id: "proj", name: "Apollo", plannedEndDate: new Date("2026-08-14")
    } as never);
    vi.mocked(saveSnapshot).mockClear();
  });

  it("realigns the committed end date with the measured overrun, and links the snapshot", async () => {
    vi.mocked(assessProject).mockResolvedValue(assessment() as never);

    const outcome = await runInTenant(client, () => proposeRiskMitigation({ projectId: "proj", requestedById: "u1" }));

    const d = draft();
    expect(d.capability).toBe("risk_mitigation");
    expect(d.kind).toBe("RISK_MITIGATION");
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ targetType: "PROJECT", targetId: "proj", op: "UPDATE" });
    expect(d.changes[0].before).toMatchObject({ plannedEndDate: "2026-08-14" });
    expect(String(d.changes[0].after.plannedEndDate) > "2026-08-14").toBe(true);
    // ProjectRiskSnapshot.aiProposalId — migrated with the risk feature, written for the first
    // time here: the score's history now names the proposal it produced.
    expect(saveSnapshot).toHaveBeenCalledWith(expect.anything(), null, "p1");
    expect(outcome.snapshotId).toBe("snap-1");
  });

  it("proposes nothing for a green project", async () => {
    vi.mocked(assessProject).mockResolvedValue(assessment({ band: "GREEN", riskScore: 10 }) as never);

    const outcome = await runInTenant(client, () => proposeRiskMitigation({ projectId: "proj", requestedById: "u1" }));

    expect(outcome.proposalId).toBeNull();
    expect(createProposalAndMaybeApply).not.toHaveBeenCalled();
  });

  it("refuses to invent a change when the risk drivers need human decisions", async () => {
    // Amber from reopen rate — no overrun, nothing a date change would honestly mitigate.
    vi.mocked(assessProject).mockResolvedValue(
      assessment({ signals: [{ key: "reopenRate", severity: 0.6, points: 6, detail: {}, note: "reopens" }], topConcerns: ["30% of resolved work has been reopened."] }) as never
    );

    const outcome = await runInTenant(client, () => proposeRiskMitigation({ projectId: "proj", requestedById: "u1" }));

    expect(outcome.proposalId).toBeNull();
    expect(outcome.reason).toContain("human decisions");
  });
});

/* ------------------------------ BLUEPRINT_SUGGESTION ------------------------------ */

describe("proposeBlueprintInstantiation", () => {
  beforeEach(() => {
    vi.mocked(client.project.findFirst).mockResolvedValue({ id: "proj", name: "Apollo" } as never);
    vi.mocked(client.blueprint.findFirst).mockResolvedValue({
      id: "bp", name: "Onboarding", isActive: true,
      payload: {
        items: [
          { title: "Kickoff", offsetStartDays: 0, durationDays: 1 },
          { title: "Design", offsetStartDays: 1, durationDays: 2, parentIndex: 0, dependsOn: [0], priority: "HIGH" }
        ]
      }
    } as never);
  });

  it("emits CREATEs in item order, then dependency LINKs referencing those orders", async () => {
    const outcome = await runInTenant(client, () =>
      proposeBlueprintInstantiation({ blueprintId: "bp", projectId: "proj", startDate: "2026-08-10", requestedById: "u1" })
    );

    expect(outcome).toMatchObject({ proposalId: "p1", items: 2, dependencies: 1 });
    const d = draft();
    expect(d.capability).toBe("blueprint_instantiate");
    expect(d.kind).toBe("BLUEPRINT_SUGGESTION");
    // CREATE-first ordering is what makes parentIndex/fromIndex resolvable at apply time:
    // applyProposal keys createdByOrder by change order, and here item index IS change order.
    expect(d.changes.map((c) => c.op)).toEqual(["CREATE", "CREATE", "LINK"]);
    expect(d.changes[1].after).toMatchObject({ title: "Design", parentIndex: 0, priority: "HIGH" });
    expect(d.changes[2].after).toMatchObject({ fromIndex: 0, toIndex: 1, type: "FINISH_TO_START" });
    // The expansion dated both items from the chosen start — real dates, not offsets.
    expect(String(d.changes[0].after.startDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses an expansion too large to review as one proposal", async () => {
    vi.mocked(client.blueprint.findFirst).mockResolvedValue({
      id: "bp", name: "Mega", isActive: true,
      payload: { items: Array.from({ length: 201 }, (_, i) => ({ title: `Item ${i + 1}` })) }
    } as never);

    await expect(
      runInTenant(client, () => proposeBlueprintInstantiation({ blueprintId: "bp", projectId: "proj", startDate: "2026-08-10", requestedById: "u1" }))
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(createProposalAndMaybeApply).not.toHaveBeenCalled();
  });
});
