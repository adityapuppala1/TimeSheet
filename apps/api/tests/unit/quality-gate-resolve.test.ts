/**
 * A FAILING QUALITY GATE AS A RESOLVE GATE — the sibling of
 * `GlobalTicketSettings.blockResolveOnFailingTests`, tested against the same three risks that switch
 * has:
 *
 *   1. IT MUST BE OFF UNTIL SOMEBODY TURNS IT ON. A rule that stops people mid-workflow, arriving
 *      switched on in an upgrade, is an outage with a changelog entry. Every existing workspace has
 *      `false` and must behave exactly as it did yesterday.
 *   2. ONLY THE LATEST GATE COUNTS. An older failure does not outvote a newer pass; the gate is a
 *      statement about the code as it stands, not a history to be searched for the answer you want.
 *   3. IT MUST NOT BLOCK ON THE ABSENCE OF EVIDENCE. No linked branch, no gate on that branch, or an
 *      analysis that crashed before producing a verdict — none of those is a failing gate, and
 *      treating silence as guilt is how a control like this gets switched off for good.
 *
 * Driven through `assertQualityGateAllowsResolve` directly rather than through the ticket route:
 * that function IS the gate, all three surfaces that can resolve a ticket call it, and testing it
 * here means the assertion holds for the public REST API and the MCP tool as well as for the app's
 * own route — which is precisely the bug shape (a rule enforced in one caller and forgotten in two)
 * that made it a shared function in the first place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface GateRow {
  id: string;
  branch: string | null;
  projectKey: string;
  analysisStatus: string;
  status: string;
  analysedAt: Date;
  conditions: unknown;
}

const state = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  branches: [] as Array<{ branch: string }>,
  gates: [] as Array<Record<string, unknown>>
}));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    globalTicketSettings: { findUnique: vi.fn(async () => state.settings) },
    ticketBranch: { findMany: vi.fn(async () => state.branches) },
    qualityGateRun: {
      // `branch: { in: [...] }` plus an equality on `analysisStatus`, ordered by `analysedAt desc` —
      // the slice of Prisma the gate actually uses. Modelled rather than stubbed, because "the most
      // recent one wins" is the behaviour under test and a stub that returns a fixed row cannot
      // prove it.
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, any>; orderBy: Record<string, string> }) => {
        const rows = (state.gates as GateRow[]).filter(
          (row) =>
            (where.branch?.in as string[]).includes(row.branch ?? "") &&
            (where.analysisStatus === undefined || row.analysisStatus === where.analysisStatus)
        );
        const sorted = [...rows].sort((a, b) =>
          orderBy.analysedAt === "desc" ? b.analysedAt.getTime() - a.analysedAt.getTime() : a.analysedAt.getTime() - b.analysedAt.getTime()
        );
        return sorted[0] ?? null;
      })
    }
  }
}));

const { assertQualityGateAllowsResolve } = await import("../../src/services/ticket.service.js");

const TICKET = { id: "ticket-1", key: "WEB-123" };

function gate(over: Partial<GateRow> = {}): Record<string, unknown> {
  return {
    id: `gate-${state.gates.length + 1}`,
    branch: "feature/WEB-123-intake",
    projectKey: "com.acme:my-module",
    analysisStatus: "SUCCESS",
    status: "ERROR",
    analysedAt: new Date("2026-08-30T09:00:00Z"),
    conditions: [{ metric: "new_coverage", status: "ERROR", operator: "LESS_THAN", value: "62.1", errorThreshold: "80" }],
    ...over
  };
}

beforeEach(() => {
  state.settings = { blockResolveOnFailingQualityGate: true };
  state.branches = [{ branch: "feature/WEB-123-intake" }];
  state.gates = [];
});

describe("with the setting ON", () => {
  it("blocks RESOLVED when the latest gate on the ticket's branch failed", async () => {
    state.gates = [gate()];
    await expect(assertQualityGateAllowsResolve(TICKET)).rejects.toThrow(/Cannot resolve WEB-123/);
  });

  it("names the failing metric, because knowing WHICH condition failed is the whole point", async () => {
    state.gates = [gate()];
    await expect(assertQualityGateAllowsResolve(TICKET)).rejects.toThrow(/new_coverage/);
  });

  it("allows RESOLVED when the gate passed", async () => {
    state.gates = [gate({ status: "OK" })];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });

  it("uses only the LATEST gate — a newer pass settles an older failure", async () => {
    state.gates = [
      gate({ status: "ERROR", analysedAt: new Date("2026-08-30T09:00:00Z") }),
      gate({ status: "OK", analysedAt: new Date("2026-08-30T11:00:00Z") })
    ];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });

  it("and an older pass does not excuse a newer failure", async () => {
    state.gates = [
      gate({ status: "OK", analysedAt: new Date("2026-08-30T09:00:00Z") }),
      gate({ status: "ERROR", analysedAt: new Date("2026-08-30T11:00:00Z") })
    ];
    await expect(assertQualityGateAllowsResolve(TICKET)).rejects.toThrow(/Cannot resolve WEB-123/);
  });

  it("ignores a gate on a branch this ticket is not linked to", async () => {
    state.gates = [gate({ branch: "main" })];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });

  it("does not block a ticket with no linked branch at all", async () => {
    // Nothing to judge it against. Blocking on the absence of evidence is the failure mode the whole
    // verification design refuses, and it would make this switch unusable for every ticket that is
    // not a code change.
    state.branches = [];
    state.gates = [gate({ branch: null })];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });

  it("does not block because Sonar's own analysis crashed", async () => {
    // `status: "FAILED"` at the top of Sonar's payload means the analysis task died, not that the
    // code is bad — its gate block is absent or meaningless. Blocking here would make this gate a
    // source of outages rather than of quality.
    state.gates = [gate({ analysisStatus: "FAILED", status: "WARN" })];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });

  it("does not block on WARN, only on ERROR", async () => {
    state.gates = [gate({ status: "WARN" })];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });
});

describe("with the setting OFF, which is every existing workspace", () => {
  it("does not block, even with a failing gate sitting right there", async () => {
    state.settings = { blockResolveOnFailingQualityGate: false };
    state.gates = [gate()];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });

  it("does not block when the settings row does not exist yet", async () => {
    // A workspace that has never opened Workspace Settings has no row. Reading `undefined` as "on"
    // would turn a fresh install into a blocked one.
    state.settings = null;
    state.gates = [gate()];
    await expect(assertQualityGateAllowsResolve(TICKET)).resolves.toBeUndefined();
  });
});
