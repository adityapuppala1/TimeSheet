/**
 * The rules that make change management a control rather than a form.
 *
 * Three of these would be silent if they broke. The RISK MATRIX decides which approval policy a
 * change earns, so a wrong cell routes a dangerous change to a lenient board. The READINESS rules
 * are the only thing making a backout plan non-optional — the single reason the module exists. And
 * the TRANSITION table is what stops a caller PATCHing a change straight past its own approval.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveChangeRisk, changeStateTransitions } from "@timesheet/shared";

const userFindMany = vi.fn().mockResolvedValue([]);
const userFindFirst = vi.fn().mockResolvedValue(null);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: (...a: unknown[]) => userFindMany(...a), findFirst: (...a: unknown[]) => userFindFirst(...a) },
    globalChangeSettings: { upsert: vi.fn().mockResolvedValue({ enableChangeManagement: true }) }
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));

const {
  assertLegalChangeTransition,
  bandForScore,
  canDecideChange,
  computeRiskScore,
  missingForTransition,
  resolveChangeApprovers,
  scoreRisk,
  ticketStatusFor
} = await import("../../src/services/change.service.js");

const BASE = {
  changeKind: "NORMAL" as const,
  riskLevel: "LOW" as const,
  dataMigration: false,
  requiresDowntime: false,
  justification: "because",
  implementationPlan: "steps",
  plannedStart: new Date(),
  plannedEnd: new Date()
};

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockResolvedValue([]);
  userFindFirst.mockResolvedValue(null);
});

describe("the risk matrix", () => {
  it("is conservative on the middle diagonal", () => {
    // The cell that matters most: MEDIUM x MEDIUM is the commonest change in any workspace. A
    // matrix that rounds it down lets the ordinary case skip the board, which is how change
    // control quietly stops being a control.
    expect(deriveChangeRisk("MEDIUM", "MEDIUM")).toBe("HIGH");
  });

  it("never reports HIGH for a change that can barely hurt", () => {
    expect(deriveChangeRisk("LOW", "LOW")).toBe("LOW");
    expect(deriveChangeRisk("LOW", "MEDIUM")).toBe("LOW");
  });

  it("treats a rare catastrophe and a likely nuisance differently", () => {
    // Not symmetric on purpose: high impact at low likelihood still deserves a look (MEDIUM),
    // while low impact however likely does not (LOW).
    expect(deriveChangeRisk("HIGH", "LOW")).toBe("MEDIUM");
    expect(deriveChangeRisk("LOW", "HIGH")).toBe("MEDIUM");
  });

  it("is derived and stamped, never accepted from a caller", () => {
    const scored = scoreRisk("HIGH", "HIGH");
    expect(scored.riskLevel).toBe("HIGH");
    expect(scored.riskScoredAt).toBeInstanceOf(Date);
  });
});

describe("what a change owes before it can be submitted", () => {
  it("demands a backout plan for a HIGH risk change", () => {
    expect(missingForTransition({ ...BASE, riskLevel: "HIGH", testPlan: "t" }, "SUBMITTED")).toContain("Backout plan");
  });

  it("demands one for a MAJOR change whatever its risk", () => {
    expect(missingForTransition({ ...BASE, changeKind: "MAJOR" }, "SUBMITTED")).toContain("Backout plan");
  });

  it("demands one for anything that moves data", () => {
    expect(missingForTransition({ ...BASE, dataMigration: true }, "SUBMITTED")).toContain("Backout plan");
  });

  it("does NOT demand one for a low-risk routine change", () => {
    expect(missingForTransition(BASE, "SUBMITTED")).toEqual([]);
  });

  it("demands a comms plan and a duration only when there is downtime", () => {
    const missing = missingForTransition({ ...BASE, requiresDowntime: true }, "SUBMITTED");
    expect(missing).toContain("Communication plan");
    expect(missing).toContain("Expected downtime");
    expect(missingForTransition(BASE, "SUBMITTED")).not.toContain("Communication plan");
  });

  it("reports every gap at once rather than one per attempt", () => {
    // Somebody filling a long form deserves the whole list, not four round trips.
    const missing = missingForTransition(
      { ...BASE, riskLevel: "HIGH", requiresDowntime: true, justification: "", implementationPlan: "", plannedStart: null },
      "SUBMITTED"
    );
    expect(missing.length).toBeGreaterThanOrEqual(6);
  });

  it("treats empty rich text as empty, not as filled", () => {
    // The editor stores markup even when the author typed nothing, so a naive truthiness check
    // would accept "<p></p>" as a backout plan.
    expect(missingForTransition({ ...BASE, implementationPlan: "<p><br></p>" }, "SUBMITTED")).toContain("Implementation plan");
  });
});

describe("the risk assessment must be complete before submission", () => {
  const KEYS = ["businessImpact", "dataRisk", "rollbackComplexity"];

  it("REFUSES a half-filled assessment, and says how much is left", () => {
    // The hole this closes, measured on real data: high business impact plus high data risk with the
    // other nine parameters blank scored 27 and banded LOW — and the band is what decides whether a
    // backout plan is mandatory. Leaving fields empty was a way to skip the module's central rule.
    const missing = missingForTransition({ ...BASE, riskInputs: { businessImpact: "HIGH" } }, "AWAITING_APPROVAL", KEYS);
    expect(missing.join(" ")).toMatch(/Risk assessment \(2 of 3 unanswered\)/);
  });

  it("says just Risk assessment when none of it has been touched", () => {
    const missing = missingForTransition({ ...BASE, riskInputs: {} }, "AWAITING_APPROVAL", KEYS);
    expect(missing).toContain("Risk assessment");
  });

  it("is satisfied once every active parameter has an answer", () => {
    const complete = { businessImpact: "LOW", dataRisk: "LOW", rollbackComplexity: "LOW" };
    expect(missingForTransition({ ...BASE, riskInputs: complete }, "AWAITING_APPROVAL", KEYS)).toEqual([]);
  });

  it("asks for nothing when the workspace has switched every parameter off", () => {
    // An empty required set is a configuration choice, not a reason to block every submission.
    expect(missingForTransition({ ...BASE, riskInputs: {} }, "AWAITING_APPROVAL", [])).toEqual([]);
  });

  it("does not apply to a DRAFT save — the rules bite at the transition", () => {
    expect(missingForTransition({ ...BASE, riskInputs: {} }, "DRAFT", KEYS)).toEqual([]);
  });
});

describe("what a change owes before it can close", () => {
  it("always needs an outcome", () => {
    expect(missingForTransition({ ...BASE, outcome: null }, "CLOSED")).toContain("Outcome");
  });

  it("lets a clean routine change close on its outcome alone", () => {
    expect(missingForTransition({ ...BASE, outcome: "SUCCESSFUL" }, "CLOSED")).toEqual([]);
  });

  it("demands a review when it did not go cleanly", () => {
    for (const outcome of ["FAILED", "ROLLED_BACK", "SUCCESSFUL_WITH_ISSUES"]) {
      expect(missingForTransition({ ...BASE, outcome }, "CLOSED")).toContain("Post-implementation review");
    }
  });

  it("demands a review for every MAJOR change, however well it went", () => {
    expect(missingForTransition({ ...BASE, changeKind: "MAJOR", outcome: "SUCCESSFUL" }, "CLOSED")).toContain(
      "Post-implementation review"
    );
  });
});

describe("the lifecycle", () => {
  it("refuses a move that is not on the table", () => {
    expect(() => assertLegalChangeTransition("DRAFT", "IMPLEMENTING")).toThrow(/cannot move/i);
  });

  it("REFUSES a manual jump to APPROVED or REJECTED from the board", () => {
    // The load-bearing one. Only a settled approval chain writes these two, which is why they are
    // absent from AWAITING_APPROVAL's edges — otherwise a determined caller could PATCH past the
    // whole point of the module.
    expect(() => assertLegalChangeTransition("AWAITING_APPROVAL", "APPROVED")).toThrow();
    expect(() => assertLegalChangeTransition("AWAITING_APPROVAL", "REJECTED")).toThrow();
  });

  it("lets a change be cancelled from every live state", () => {
    for (const state of ["DRAFT", "SUBMITTED", "RISK_ASSESSMENT", "AWAITING_APPROVAL", "APPROVED", "SCHEDULED", "IMPLEMENTING"] as const) {
      expect(changeStateTransitions[state]).toContain("CANCELLED");
    }
  });

  it("leaves CLOSED terminal", () => {
    expect(changeStateTransitions.CLOSED).toEqual([]);
  });

  it("sends a submitted change straight to its approver, with nothing in between", () => {
    // The requirement is that submission reaches the manager immediately. Modelling that as an edge
    // straight from DRAFT is what makes it true by construction rather than by a well-behaved caller.
    expect(changeStateTransitions.DRAFT).toContain("AWAITING_APPROVAL");
  });

  it("maps every state onto a real ticket status", () => {
    // The compatibility hinge: ~40 existing readers of Ticket.status stay correct only because
    // every change state has a defined partner here.
    for (const state of Object.keys(changeStateTransitions) as Array<keyof typeof changeStateTransitions>) {
      expect(["OPEN", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]).toContain(ticketStatusFor(state));
    }
  });
});

describe("quorum on the shared approval engine", () => {
  const steps = (decisions: string[]) =>
    decisions.map((d, i) => ({ id: String(i), order: i, approverId: `u${i}`, guestEmail: null, decision: d as never }));

  it("still means ALL when no quorum is set — the behaviour every existing chain had", async () => {
    const { requestStatusAfter } = await import("../../src/services/approval.service.js");
    expect(requestStatusAfter(steps(["APPROVED", "PENDING"]))).toBe("PENDING");
    expect(requestStatusAfter(steps(["APPROVED", "APPROVED"]))).toBe("APPROVED");
    // Explicit null is the column's value on every pre-existing row, so it must behave identically.
    expect(requestStatusAfter(steps(["APPROVED", "PENDING"]), null)).toBe("PENDING");
  });

  it("settles on the first yes at a quorum of one — the emergency path", async () => {
    const { requestStatusAfter } = await import("../../src/services/approval.service.js");
    expect(requestStatusAfter(steps(["APPROVED", "PENDING", "PENDING"]), 1)).toBe("APPROVED");
  });

  it("keeps rejection terminal at any quorum", async () => {
    // One "no" is a decision about the change, not a vote to be outnumbered.
    const { requestStatusAfter } = await import("../../src/services/approval.service.js");
    expect(requestStatusAfter(steps(["APPROVED", "REJECTED", "PENDING"]), 1)).toBe("REJECTED");
  });

  it("clamps a quorum larger than the chain rather than stranding it forever", async () => {
    const { requestStatusAfter } = await import("../../src/services/approval.service.js");
    expect(requestStatusAfter(steps(["APPROVED", "APPROVED"]), 5)).toBe("APPROVED");
  });

  it("supersedes the people still pending when a quorum settles it", async () => {
    // Nobody should keep being chased for a decision that no longer changes anything.
    const { applyDecision } = await import("../../src/services/approval.service.js");
    const out = applyDecision({ steps: steps(["PENDING", "PENDING"]), stepId: "0", decision: "APPROVED", isSequential: false, quorum: 1 });
    expect(out.completed).toBe(true);
    expect(out.supersededSteps.map((s) => s.id)).toEqual(["1"]);
  });
});
