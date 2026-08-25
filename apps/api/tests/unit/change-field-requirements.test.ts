/**
 * The conditional submission requirements, and the fields the drafting assistant may touch.
 *
 * TWO DRIFTS THIS FILE EXISTS TO CATCH:
 *
 *   1. The form's required markers and the API's submission gate read the same three predicates from
 *      @timesheet/shared. If either side grows its own copy of "when is a backout plan mandatory",
 *      the form starts promising what the server refuses — asserted here by driving the gate and the
 *      predicates with the same inputs and demanding they agree.
 *
 *   2. The inline draft route validates its `field` against `CHANGE_DRAFTABLE_FIELDS`, the same spec
 *      the drafter reads. That list is what stands between "AI helps fill the form" and "AI can
 *      write a risk score" — so its exact membership is pinned, and the governance fields are named
 *      individually as absent.
 */
import { describe, expect, it, vi } from "vitest";
import {
  changeNeedsBackoutPlan,
  changeNeedsCommunicationPlan,
  changeNeedsTestPlan
} from "@timesheet/shared";

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    globalChangeSettings: { upsert: vi.fn().mockResolvedValue({ enableChangeManagement: true }) }
  }
}));

const { missingForTransition } = await import("../../src/services/change.service.js");
const { CHANGE_DRAFTABLE_FIELDS } = await import("../../src/services/ai.service.js");

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

describe("the three conditional requirements, decided in one place", () => {
  it("demands a backout plan exactly when the shared predicate says so", () => {
    const cases = [
      { ...BASE, riskLevel: "HIGH" as const, testPlan: "t" },
      { ...BASE, changeKind: "MAJOR" as const },
      { ...BASE, dataMigration: true },
      { ...BASE }
    ];
    for (const change of cases) {
      const gateDemands = missingForTransition(change, "SUBMITTED").includes("Backout plan");
      expect(gateDemands, JSON.stringify(change)).toBe(changeNeedsBackoutPlan(change));
    }
  });

  it("demands a test plan exactly when the shared predicate says so", () => {
    for (const riskLevel of ["LOW", "MEDIUM", "HIGH"] as const) {
      const change = { ...BASE, riskLevel, backoutPlan: "b" };
      const gateDemands = missingForTransition(change, "SUBMITTED").includes("Test plan");
      expect(gateDemands, riskLevel).toBe(changeNeedsTestPlan(change));
    }
  });

  it("demands a communication plan exactly when the shared predicate says so", () => {
    for (const requiresDowntime of [true, false]) {
      const change = { ...BASE, requiresDowntime };
      const gateDemands = missingForTransition(change, "SUBMITTED").includes("Communication plan");
      expect(gateDemands, String(requiresDowntime)).toBe(changeNeedsCommunicationPlan(change));
    }
  });
});

describe("what the drafting assistant may write", () => {
  it("is exactly the ten prose fields, no more", () => {
    // Pinned as a set: adding a field here is a decision about what a model may put in front of an
    // approver, not a convenience edit.
    expect(CHANGE_DRAFTABLE_FIELDS.map((s) => s.field).sort()).toEqual(
      [
        "backoutPlan",
        "businessBenefits",
        "communicationPlan",
        "currentSituation",
        "expectedOutcome",
        "implementationPlan",
        "justification",
        "problemStatement",
        "reasonForChange",
        "testPlan"
      ].sort()
    );
  });

  it("marks as blocking exactly the sections the submission gate demands", () => {
    const blocking = CHANGE_DRAFTABLE_FIELDS.filter((s) => s.blocking).map((s) => s.field).sort();
    expect(blocking).toEqual(["backoutPlan", "communicationPlan", "implementationPlan", "justification", "testPlan"].sort());
  });

  it("keeps every governance field out of reach", () => {
    const fields = new Set<string>(CHANGE_DRAFTABLE_FIELDS.map((s) => s.field));
    for (const forbidden of ["state", "riskScore", "riskLevel", "impact", "likelihood", "outcome", "plannedStart", "plannedEnd", "pirNotes"]) {
      expect(fields.has(forbidden), `${forbidden} must never be inline-draftable`).toBe(false);
    }
  });

  it("tells the model to omit what it cannot ground, never to pad it", async () => {
    // The regression this rule comes from: told to "admit what is not known", the model answered a
    // backout-plan request with "a backout procedure has not been documented at this time" — text
    // which, accepted, would satisfy the mandatory-backout gate while containing no plan. The gate
    // checks that the field has words; only a human can check that the words are a plan.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/services/ai.service.ts", import.meta.url), "utf8")
    );
    expect(source).toContain("THE OMISSION RULE");
    expect(source).toContain("OMIT this section");
  });
});
