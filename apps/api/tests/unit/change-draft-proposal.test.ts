/**
 * What the drafting assistant is allowed to put into a change, and what it is not.
 *
 * This is the only capability in the module that can write words into the record an approver reads,
 * and one of the five fields it drafts is the backout plan — the single most consequential field
 * here. Two things therefore have to be true by construction rather than by the prompt asking
 * nicely, and both are asserted below:
 *
 *   1. The allowlist is exactly the five blocking prose sections. A risk score a model could write
 *      would make the rule that decides whether a backout plan is mandatory unreproducible; a state
 *      it could write would walk the change past its own approver.
 *   2. Nothing is applied to a change whose plan has frozen. Scope and risk are what got approved,
 *      and a section arriving afterwards would rewrite what was agreed.
 *
 * The ceiling is asserted here too. `change_draft_assist` must stay at SUGGEST: it proposes, and a
 * person accepts each row.
 */
import { describe, expect, it } from "vitest";
import { AI_CAPABILITIES } from "../../src/services/ai-capability.registry.js";
import { changeStates } from "@timesheet/shared";

/** Mirrors `CHANGE_WRITABLE` in ai-proposal.service.ts. Duplicated on purpose: a test that imports
 *  the list it is checking asserts only that the list equals itself. */
const EXPECTED_WRITABLE = ["backoutPlan", "communicationPlan", "implementationPlan", "justification", "testPlan"];

/** Mirrors `FROZEN_CHANGE_STATES` there, and `FROZEN_AFTER` in change.controller.ts. */
const EXPECTED_FROZEN = ["APPROVED", "IMPLEMENTING", "PIR", "SCHEDULED", "VALIDATION", "CLOSED"];

describe("what a drafted change proposal may touch", () => {
  it("writes only the five prose sections that block submission", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/services/ai-proposal.service.ts", import.meta.url), "utf8")
    );
    const match = source.match(/const CHANGE_WRITABLE = new Set\(\[([^\]]*)\]\)/);
    expect(match, "CHANGE_WRITABLE has moved or been renamed").toBeTruthy();
    const actual = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(actual).toEqual(EXPECTED_WRITABLE);
  });

  it("keeps every governance field off that list", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/services/ai-proposal.service.ts", import.meta.url), "utf8")
    );
    const match = source.match(/const CHANGE_WRITABLE = new Set\(\[([^\]]*)\]\)/);
    const actual = new Set([...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    // Named individually rather than checked as a group, so a failure says WHICH one got in.
    for (const forbidden of ["state", "riskScore", "riskLevel", "impact", "likelihood", "outcome", "plannedStart", "plannedEnd", "approvedAt", "closedAt"]) {
      expect(actual.has(forbidden), `${forbidden} must never be writable by a drafted proposal`).toBe(false);
    }
  });

  it("refuses to apply into any state where the plan has frozen", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/services/ai-proposal.service.ts", import.meta.url), "utf8")
    );
    const match = source.match(/const FROZEN_CHANGE_STATES = new Set\(\[([^\]]*)\]\)/);
    expect(match, "FROZEN_CHANGE_STATES has moved or been renamed").toBeTruthy();
    const actual = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(actual).toEqual([...EXPECTED_FROZEN].sort());
    // Every frozen state is a real one — a typo here would silently unfreeze that state.
    for (const state of actual) {
      expect(changeStates as readonly string[], `${state} is not a change state`).toContain(state);
    }
  });
});

describe("the drafting capability's ceiling", () => {
  it("stays at SUGGEST, and says why", () => {
    const spec = AI_CAPABILITIES.find((c) => c.id === "change_draft_assist");
    expect(spec, "change_draft_assist is not registered").toBeTruthy();
    // It proposes; a person accepts each row. Raising this would let it write the backout plan an
    // approver relies on with nobody in between.
    expect(spec!.maxLevel).toBe("SUGGEST");
    expect(spec!.ceilingReason, "a capped capability must explain itself in the UI").toBeTruthy();
  });

  it("is marked as reading externally-authored text", () => {
    // Its context comes from linked tickets, and some of that originated outside the workspace — an
    // emailed ticket's title, a scanner's repository string. The marking is what keeps the agent
    // runtime clamping a run that has touched it.
    const spec = AI_CAPABILITIES.find((c) => c.id === "change_draft_assist");
    expect(spec!.actsOnUntrustedInput).toBe(true);
  });

  it("has no capability anywhere that can approve a change", () => {
    // The rule the module exists for, asserted against the whole registry rather than one entry:
    // approving is the ABSENCE of a capability, not a ceiling on one.
    const approvers = AI_CAPABILITIES.filter((c) => /approve|approval/i.test(c.id) || /\bapproves?\b/i.test(c.title));
    expect(approvers.map((c) => c.id)).toEqual([]);
  });
});
