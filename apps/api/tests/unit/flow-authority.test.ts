/**
 * The Workflow Studio's entire safety argument, pinned.
 *
 * This is the most test-worthy file in V8 for the reason plan-schedule.service.test.ts is the most
 * test-worthy file in V6: every failure available here is arithmetic that renders plausibly and is
 * wrong. A minimum computed as a maximum promotes a propose-only capability by putting it in good
 * company. A taint clamp that walks backwards instead of forwards silently trusts inbound email. A
 * `proposalOnly` that is false when it should be true routes a flow's writes around the review path
 * every other AI write in this product goes through. None of those throw.
 *
 * The rules under test (docs/AGENTIC_WORK_MANAGEMENT.md §5 phase 4):
 *   1. Composed authority is the MINIMUM of the capability steps'.
 *   2. Taint propagates FORWARD, so step order changes what a flow may do.
 *   3. Anything above SUGGEST writes through a proposal.
 */
import { describe, expect, it } from "vitest";
import { computeFlowAuthority, validateFlow, type FlowStepInput } from "../../src/services/flow-authority.service.js";

const cap = (order: number, capability: string, level: "SUGGEST" | "AUTO_APPLY" | "AUTONOMOUS", untrusted = false): FlowStepInput => ({
  order,
  kind: "CAPABILITY",
  capability,
  effectiveLevel: level,
  actsOnUntrustedInput: untrusted
});
const action = (order: number): FlowStepInput => ({ order, kind: "ACTION" });
const gate = (order: number): FlowStepInput => ({ order, kind: "HUMAN_GATE" });
const branch = (order: number): FlowStepInput => ({ order, kind: "BRANCH" });

describe("rule 1 — authority is the MINIMUM of the capability steps", () => {
  it("takes the lowest of two capability levels, not the highest", () => {
    const a = computeFlowAuthority([cap(1, "plan_breakdown", "AUTO_APPLY"), cap(2, "risk_mitigation", "SUGGEST")]);
    expect(a.effectiveLevel).toBe("SUGGEST");
    expect(a.limitedBy).toMatchObject({ order: 2, capability: "risk_mitigation" });
  });

  it("never produces authority neither step had", () => {
    // The failure this rule exists for: two AUTO_APPLY steps must not compose into AUTONOMOUS.
    const a = computeFlowAuthority([cap(1, "triage", "AUTO_APPLY"), cap(2, "duplicate_detection", "AUTO_APPLY")]);
    expect(a.effectiveLevel).toBe("AUTO_APPLY");
  });

  it("is not lowered by a step order — the minimum is over VALUES, not positions", () => {
    const ascending = computeFlowAuthority([cap(1, "a", "SUGGEST"), cap(2, "b", "AUTONOMOUS")]);
    const descending = computeFlowAuthority([cap(1, "b", "AUTONOMOUS"), cap(2, "a", "SUGGEST")]);
    expect(ascending.effectiveLevel).toBe("SUGGEST");
    expect(descending.effectiveLevel).toBe("SUGGEST");
  });

  it("leaves a purely deterministic flow unclamped — the rules engine has always applied those", () => {
    const a = computeFlowAuthority([action(1), action(2)]);
    expect(a.effectiveLevel).toBe("AUTONOMOUS");
    expect(a.limitedBy).toBeNull();
    expect(a.proposalOnly).toBe(false);
  });

  it("treats a capability with no resolved level as the floor rather than assuming the best", () => {
    const a = computeFlowAuthority([{ order: 1, kind: "CAPABILITY", capability: "mystery" }]);
    expect(a.effectiveLevel).toBe("SUGGEST");
  });

  it("sorts by order rather than trusting the caller's array", () => {
    // A builder that reorders rows in the UI without renumbering would otherwise compute the
    // authority of a flow nobody can see.
    const a = computeFlowAuthority([cap(2, "late", "SUGGEST"), cap(1, "early", "AUTONOMOUS")]);
    expect(a.steps.map((s) => s.order)).toEqual([1, 2]);
    expect(a.effectiveLevel).toBe("SUGGEST");
  });
});

describe("rule 2 — taint propagates FORWARD, so order changes what a flow may do", () => {
  it("clamps a later writing step when an earlier step reads outside text", () => {
    const a = computeFlowAuthority([
      cap(1, "triage", "AUTO_APPLY", true), // reads inbound email
      cap(2, "schedule_adjustment", "AUTO_APPLY")
    ]);
    expect(a.taintedFrom).toMatchObject({ order: 1, capability: "triage" });
    expect(a.effectiveLevel).toBe("SUGGEST");
    expect(a.steps[1].effectiveLevel).toBe("SUGGEST");
    expect(a.steps[1].clampedReason).toMatch(/outside the workspace/);
  });

  it("does NOT clamp the reading step itself — it is the source, not a victim", () => {
    const a = computeFlowAuthority([cap(1, "triage", "AUTO_APPLY", true)]);
    expect(a.steps[0].effectiveLevel).toBe("AUTO_APPLY");
    expect(a.steps[0].taintedByEarlierStep).toBe(false);
    // The flow reports the taint, so anything added AFTER it will be clamped — but a lone reading
    // step does not make the flow proposal-only. Composing one step must not be stricter than
    // running that same capability on its own, which the runtime already allows at AUTO_APPLY.
    expect(a.taintedFrom).not.toBeNull();
    expect(a.effectiveLevel).toBe("AUTO_APPLY");
    expect(a.proposalOnly).toBe(false);
  });

  it("leaves the same two steps unclamped in the other order", () => {
    // The asymmetry IS the rule: assign-then-read is safe, read-then-assign is not.
    const safe = computeFlowAuthority([
      cap(1, "schedule_adjustment", "AUTO_APPLY"),
      cap(2, "triage", "AUTO_APPLY", true)
    ]);
    expect(safe.steps[0].effectiveLevel).toBe("AUTO_APPLY");
    expect(safe.steps[1].effectiveLevel).toBe("AUTO_APPLY");
    // The flow still reports itself tainted, because anything appended would be clamped.
    expect(safe.taintedFrom).toMatchObject({ order: 2 });
  });

  it("clamps a deterministic ACTION that follows tainted input", () => {
    // An ACTION is not a model call, but the VALUES it acts on came from one that read a stranger's
    // text. Applying directly there would be the injection path the whole rule exists to close.
    const a = computeFlowAuthority([cap(1, "triage", "AUTO_APPLY", true), action(2)]);
    expect(a.steps[1].effectiveLevel).toBe("SUGGEST");
    expect(a.steps[1].clampedReason).toMatch(/outside the workspace/);
  });

  it("does not clamp a BRANCH or a GATE, which write nothing", () => {
    const a = computeFlowAuthority([cap(1, "triage", "AUTO_APPLY", true), branch(2), gate(3)]);
    expect(a.steps[1].clampedReason).toBeNull();
    expect(a.steps[2].clampedReason).toBeNull();
  });

  it("names the FIRST tainting step, not the last", () => {
    const a = computeFlowAuthority([
      cap(1, "ci_failure_triage", "AUTO_APPLY", true),
      cap(2, "security_finding_triage", "AUTO_APPLY", true)
    ]);
    expect(a.taintedFrom).toMatchObject({ order: 1, capability: "ci_failure_triage" });
  });
});

describe("rule 3 — anything above SUGGEST writes through a proposal", () => {
  it("marks a flow at the floor as proposal-only", () => {
    expect(computeFlowAuthority([cap(1, "risk_mitigation", "SUGGEST")]).proposalOnly).toBe(true);
  });

  it("does not mark an applying flow proposal-only", () => {
    expect(computeFlowAuthority([cap(1, "triage", "AUTO_APPLY")]).proposalOnly).toBe(false);
  });

  it("makes a tainted flow proposal-only however high its steps were", () => {
    const a = computeFlowAuthority([cap(1, "pr_review_summary", "AUTONOMOUS", true), cap(2, "triage", "AUTONOMOUS")]);
    expect(a.proposalOnly).toBe(true);
  });
});

describe("a human gate is the cheapest way to make an ambitious flow acceptable", () => {
  it("reports gatedBeforeWrites when the gate precedes every write", () => {
    const a = computeFlowAuthority([gate(1), cap(2, "triage", "AUTO_APPLY"), action(3)]);
    expect(a.gatedBeforeWrites).toBe(true);
  });

  it("reports false when a write happens before the gate", () => {
    // A gate after the write protects nothing — it only asks somebody to bless what already happened.
    const a = computeFlowAuthority([cap(1, "triage", "AUTO_APPLY"), gate(2), action(3)]);
    expect(a.gatedBeforeWrites).toBe(false);
  });

  it("is vacuously true for a flow that writes nothing", () => {
    expect(computeFlowAuthority([cap(1, "weekly_digest", "SUGGEST"), branch(2)]).gatedBeforeWrites).toBe(true);
  });
});

describe("validation refuses flows that would not do what they read as doing", () => {
  const base = { trigger: "MANUAL", triggerConfig: {} as Record<string, unknown> };
  const errors = (issues: ReturnType<typeof validateFlow>) => issues.filter((i) => i.severity === "error").map((i) => i.message);

  it("refuses an empty flow", () => {
    expect(errors(validateFlow({ ...base, steps: [] }))).toContainEqual(expect.stringMatching(/at least one step/i));
  });

  it("refuses a branch as the last step, because it can never skip anything", () => {
    expect(errors(validateFlow({ ...base, steps: [cap(1, "triage", "SUGGEST"), branch(2)] }))).toContainEqual(
      expect.stringMatching(/never skip anything/i)
    );
  });

  it("refuses a gate as the last step, because nothing is left to approve", () => {
    expect(errors(validateFlow({ ...base, steps: [cap(1, "triage", "SUGGEST"), gate(2)] }))).toContainEqual(
      expect.stringMatching(/nothing left for anyone to approve/i)
    );
  });

  it("requires the trigger's own configuration", () => {
    expect(errors(validateFlow({ steps: [action(1)], trigger: "EVENT", triggerConfig: {} }))).toContainEqual(
      expect.stringMatching(/event to listen for/i)
    );
    expect(errors(validateFlow({ steps: [action(1)], trigger: "SCHEDULE", triggerConfig: {} }))).toContainEqual(
      expect.stringMatching(/cron/i)
    );
    expect(errors(validateFlow({ steps: [action(1)], trigger: "FORM_SUBMISSION", triggerConfig: {} }))).toContainEqual(
      expect.stringMatching(/form/i)
    );
    expect(errors(validateFlow({ steps: [action(1)], trigger: "EVENT", triggerConfig: { event: "ticket.created" } }))).toEqual([]);
  });

  it("refuses a capability the flow's teammate does not own", () => {
    // Otherwise the Studio is a way around "one capability, one owner".
    const issues = validateFlow({
      ...base,
      steps: [cap(1, "triage", "SUGGEST"), cap(2, "schedule_adjustment", "SUGGEST")],
      agentCapabilities: ["triage"],
      agentName: "Triage"
    });
    expect(errors(issues)).toContainEqual(expect.stringMatching(/does not have "schedule_adjustment"/));
  });

  it("warns rather than blocks when the teammate is switched off", () => {
    const issues = validateFlow({
      ...base,
      steps: [cap(1, "triage", "SUGGEST")],
      agentCapabilities: ["triage"],
      agentName: "Triage",
      agentEnabled: false
    });
    expect(errors(issues)).toEqual([]);
    expect(issues.some((i) => i.severity === "warning" && /switched off/.test(i.message))).toBe(true);
  });

  it("warns about taint and about ungated applying, without blocking either", () => {
    const issues = validateFlow({ ...base, steps: [cap(1, "triage", "AUTO_APPLY", true), action(2)] });
    expect(errors(issues)).toEqual([]);
    expect(issues.some((i) => /outside the workspace/.test(i.message))).toBe(true);
  });
});
