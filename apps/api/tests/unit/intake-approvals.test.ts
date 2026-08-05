/**
 * Pins the three pure cores behind phase 4: request-form conditional logic, blueprint expansion,
 * and approval-chain ordering.
 *
 * WHY THESE THREE TOGETHER: each has the same shape — an authored structure, a rule about what it
 * means, and a failure mode that is quiet rather than loud. A conditional field that stays
 * "required" while hidden blocks a submitter with no way to report it. A blueprint offset counted
 * in calendar days lands work on a Saturday. An approval chain that lets step 3 decide before
 * step 1 produces a signed-off deliverable nobody senior actually saw.
 */
import { describe, expect, it } from "vitest";
import {
  normaliseSubmission,
  renderAnswers,
  validateFormSchema,
  visibleFields,
  type RequestFormSchema
} from "../../src/services/request-form.service.js";
import { expandBlueprint, validateBlueprint, type BlueprintPayload } from "../../src/services/blueprint.service.js";
import {
  activeSteps,
  applyDecision,
  requestStatusAfter,
  validateChain,
  type ApprovalStepState
} from "../../src/services/approval.service.js";

/* ================================================================== *
 * Request forms
 * ================================================================== */

const baseSchema = (over: Partial<RequestFormSchema> = {}): RequestFormSchema => ({
  fields: [
    { key: "summary", label: "What do you need?", type: "TEXT", required: true, mapsTo: "title" },
    { key: "kind", label: "Type", type: "SELECT", options: ["Bug", "Feature"], required: true },
    // Only asked when they said "Bug".
    { key: "steps", label: "Steps to reproduce", type: "TEXTAREA", required: true, showWhen: [{ field: "kind", operator: "equals", value: "Bug" }] }
  ],
  ...over
});

describe("request form schema validation", () => {
  it("accepts a well-formed form", () => {
    expect(() => validateFormSchema(baseSchema())).not.toThrow();
  });

  it("requires exactly one question to become the ticket title", () => {
    // Without it every request arrives called "Untitled".
    const noTitle = baseSchema({ fields: baseSchema().fields.map((f) => ({ ...f, mapsTo: undefined })) });
    expect(() => validateFormSchema(noTitle)).toThrow(/title/i);
  });

  it("refuses a rule that points at a later question", () => {
    // The earlier-only rule is what makes conditional cycles impossible by construction rather
    // than something to detect at runtime.
    const forward = baseSchema({
      fields: [
        { key: "a", label: "A", type: "TEXT", mapsTo: "title", showWhen: [{ field: "b", operator: "isAnswered" }] },
        { key: "b", label: "B", type: "TEXT" }
      ]
    });
    expect(() => validateFormSchema(forward)).toThrow(/not a question above it/i);
  });

  it("refuses duplicate keys, bad keys, and choice questions with no options", () => {
    expect(() =>
      validateFormSchema(baseSchema({ fields: [
        { key: "a", label: "A", type: "TEXT", mapsTo: "title" },
        { key: "a", label: "Again", type: "TEXT" }
      ] }))
    ).toThrow(/share the key/i);

    expect(() =>
      validateFormSchema(baseSchema({ fields: [{ key: "Bad Key", label: "X", type: "TEXT", mapsTo: "title" }] }))
    ).toThrow(/not a valid field key/i);

    expect(() =>
      validateFormSchema(baseSchema({ fields: [{ key: "a", label: "Pick", type: "SELECT", mapsTo: "title" }] }))
    ).toThrow(/at least one option/i);
  });
});

describe("conditional visibility", () => {
  it("hides a branch until its condition is met", () => {
    const schema = baseSchema();
    expect(visibleFields(schema, { kind: "Feature" }).map((f) => f.key)).toEqual(["summary", "kind"]);
    expect(visibleFields(schema, { kind: "Bug" }).map((f) => f.key)).toEqual(["summary", "kind", "steps"]);
  });

  it("hides a field whose CONTROLLER is itself hidden", () => {
    // Otherwise answering a question, then hiding the branch that contained it, leaves its
    // children visible and orphaned.
    const schema: RequestFormSchema = {
      fields: [
        { key: "a", label: "A", type: "SELECT", options: ["yes", "no"], mapsTo: "title" },
        { key: "b", label: "B", type: "SELECT", options: ["x"], showWhen: [{ field: "a", operator: "equals", value: "yes" }] },
        { key: "c", label: "C", type: "TEXT", showWhen: [{ field: "b", operator: "equals", value: "x" }] }
      ]
    };
    // b is hidden (a is "no"), so c must be hidden too even though its own rule would pass.
    expect(visibleFields(schema, { a: "no", b: "x" }).map((f) => f.key)).toEqual(["a"]);
  });

  it("treats equals on a multi-select as includes", () => {
    // Requiring an exact list match would make the rule impossible to satisfy in practice.
    const schema: RequestFormSchema = {
      fields: [
        { key: "areas", label: "Areas", type: "MULTISELECT", options: ["web", "api"], mapsTo: "title" },
        { key: "detail", label: "Detail", type: "TEXT", showWhen: [{ field: "areas", operator: "equals", value: "api" }] }
      ]
    };
    expect(visibleFields(schema, { areas: ["web", "api"] }).map((f) => f.key)).toContain("detail");
    expect(visibleFields(schema, { areas: ["web"] }).map((f) => f.key)).not.toContain("detail");
  });
});

describe("submission normalisation", () => {
  it("does not enforce required on a question that was never shown", () => {
    // The bug this prevents: a conditional field stays "required" while hidden, and an honest
    // submitter is blocked by a question they were routed away from and cannot see.
    const result = normaliseSubmission(baseSchema(), { summary: "Login is slow", kind: "Feature" });
    expect(result.title).toBe("Login is slow");
    expect(result.answers.steps).toBeUndefined();
  });

  it("enforces required once the question IS shown", () => {
    expect(() => normaliseSubmission(baseSchema(), { summary: "Crash", kind: "Bug" })).toThrow(/steps to reproduce.*required/i);
  });

  it("DROPS answers to hidden questions rather than accepting or rejecting them", () => {
    // Accepting would let anyone POST past a branch they were routed away from; rejecting would
    // fail an honest submitter whose browser posted a stale answer. Dropping is the only option
    // that is both forgiving to people and closed to abuse.
    const result = normaliseSubmission(baseSchema(), { summary: "X", kind: "Feature", steps: "smuggled" });
    expect(result.answers).not.toHaveProperty("steps");
  });

  it("coerces and validates by type", () => {
    const schema: RequestFormSchema = {
      fields: [
        { key: "t", label: "T", type: "TEXT", mapsTo: "title" },
        { key: "n", label: "N", type: "NUMBER" },
        { key: "d", label: "D", type: "DATE" },
        { key: "e", label: "E", type: "EMAIL" },
        { key: "c", label: "C", type: "CHECKBOX" }
      ]
    };
    const ok = normaliseSubmission(schema, { t: "Title", n: "1,250", d: "2026-03-15T22:00:00Z", e: " a@b.co ", c: "true" });
    expect(ok.answers.n).toBe(1250);
    // A calendar day, not an instant — the same rule every other date in the layer follows.
    expect(ok.answers.d).toBe("2026-03-15");
    expect(ok.answers.e).toBe("a@b.co");
    expect(ok.answers.c).toBe(true);

    expect(() => normaliseSubmission(schema, { t: "T", n: "abc" })).toThrow(/must be a number/i);
    expect(() => normaliseSubmission(schema, { t: "T", e: "not-an-email" })).toThrow(/email address/i);
  });

  it("refuses a choice that is not on the list", () => {
    expect(() => normaliseSubmission(baseSchema(), { summary: "X", kind: "Sideways" })).toThrow(/not an option/i);
  });

  it("routes mapped answers to the title, description and custom fields", () => {
    const schema: RequestFormSchema = {
      fields: [
        { key: "t", label: "T", type: "TEXT", mapsTo: "title" },
        { key: "d", label: "D", type: "TEXTAREA", mapsTo: "description" },
        { key: "cc", label: "Cost centre", type: "TEXT", mapsTo: "custom:cost_centre" }
      ]
    };
    const result = normaliseSubmission(schema, { t: "Title", d: "Body", cc: "R&D" });
    expect(result.title).toBe("Title");
    expect(result.description).toBe("Body");
    expect(result.customFields).toEqual({ cost_centre: "R&D" });
  });

  it("fails clearly when the title question was left unanswered", () => {
    const schema: RequestFormSchema = { fields: [{ key: "t", label: "T", type: "TEXT", mapsTo: "title" }] };
    expect(() => normaliseSubmission(schema, {})).toThrow(/title wasn't answered/i);
  });

  it("renders answers as plain text, never markup", () => {
    // The content is written by an unauthenticated stranger; the reliable way to stop it becoming
    // stored XSS on a ticket page is never to treat it as markup at all.
    const schema = baseSchema();
    const text = renderAnswers(schema, { summary: "X", kind: "Bug", steps: "<script>alert(1)</script>" });
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).not.toContain("What do you need?"); // the title field is not repeated in the body
    expect(text.split("\n")).toHaveLength(2);
  });
});

/* ================================================================== *
 * Blueprints
 * ================================================================== */

const blueprint = (over: Partial<BlueprintPayload> = {}): BlueprintPayload => ({
  items: [
    { title: "Kickoff", isMilestone: true, offsetStartDays: 0 },
    { title: "Design", offsetStartDays: 0, durationDays: 5, estimatedHours: 40 },
    { title: "Build", offsetStartDays: 5, durationDays: 10, dependsOn: [1] },
    { title: "Sub-task", parentIndex: 2, offsetStartDays: 5, durationDays: 2 }
  ],
  ...over
});

describe("blueprint validation", () => {
  it("accepts a well-formed blueprint", () => {
    expect(() => validateBlueprint(blueprint())).not.toThrow();
  });

  it("refuses a parent or dependency that appears later in the list", () => {
    // Makes cycles impossible by construction, and keeps a blueprint readable top to bottom.
    expect(() => validateBlueprint({ items: [{ title: "A", parentIndex: 1 }, { title: "B" }] })).toThrow(/above it/i);
    expect(() => validateBlueprint({ items: [{ title: "A", dependsOn: [1] }, { title: "B" }] })).toThrow(/above it/i);
    expect(() => validateBlueprint({ items: [{ title: "A", parentIndex: 0 }] })).toThrow(/above it/i);
  });

  it("refuses implausible offsets and durations", () => {
    expect(() => validateBlueprint({ items: [{ title: "A", durationDays: 0 }] })).toThrow(/duration/i);
    expect(() => validateBlueprint({ items: [{ title: "A", offsetStartDays: -1 }] })).toThrow(/offset/i);
  });
});

describe("blueprint expansion", () => {
  it("turns relative offsets into real dates against a chosen start", () => {
    // 2026-03-02 is a Monday.
    const out = expandBlueprint(blueprint(), "2026-03-02");
    const byTitle = new Map(out.items.map((i) => [i.title, i]));
    expect(byTitle.get("Kickoff")!.startDate).toBe("2026-03-02");
    // A milestone has no span.
    expect(byTitle.get("Kickoff")!.endDate).toBe("2026-03-02");
    // 5 working days from Monday is Mon-Fri inclusive.
    expect(byTitle.get("Design")!.startDate).toBe("2026-03-02");
    expect(byTitle.get("Design")!.endDate).toBe("2026-03-06");
  });

  it("counts offsets in WORKING days, so nothing lands on a weekend", () => {
    // Offset 5 from a Monday is the following Monday, not Saturday.
    const out = expandBlueprint(blueprint(), "2026-03-02");
    expect(out.items.find((i) => i.title === "Build")!.startDate).toBe("2026-03-09");
  });

  it("honours a six-day working week", () => {
    const out = expandBlueprint(blueprint(), "2026-03-02", [1, 2, 3, 4, 5, 6]);
    // With Saturday working, offset 5 lands on the Saturday.
    expect(out.items.find((i) => i.title === "Build")!.startDate).toBe("2026-03-07");
  });

  it("pulls a start date on a non-working day forward", () => {
    // 2026-03-07 is a Saturday.
    const out = expandBlueprint({ items: [{ title: "A", offsetStartDays: 0, durationDays: 1 }] }, "2026-03-07");
    expect(out.items[0].startDate).toBe("2026-03-09");
  });

  it("leaves an item with no offset AND no duration unscheduled", () => {
    // A blueprint that lists work without saying when is expressing that it has no date yet;
    // inventing one would put a commitment on the timeline nobody made.
    const out = expandBlueprint({ items: [{ title: "Release notes" }, { title: "A", offsetStartDays: 0, durationDays: 1 }] }, "2026-03-02");
    expect(out.items[0].startDate).toBeNull();
    expect(out.items[0].endDate).toBeNull();
  });

  it("computes depth from the parent chain and reports the overall span", () => {
    const out = expandBlueprint(blueprint(), "2026-03-02");
    expect(out.items.find((i) => i.title === "Sub-task")!.depth).toBe(1);
    expect(out.items.find((i) => i.title === "Design")!.depth).toBe(0);
    expect(out.start).toBe("2026-03-02");
    expect(out.end).toBe("2026-03-20");
  });
});

/* ================================================================== *
 * Approval chains
 * ================================================================== */

const step = (id: string, order: number, decision: ApprovalStepState["decision"] = "PENDING"): ApprovalStepState => ({
  id,
  order,
  approverId: `u-${id}`,
  guestEmail: null,
  decision
});

describe("approval chain validation", () => {
  it("requires exactly one approver per step", () => {
    // "Both" is ambiguous about who owns the decision; "neither" is a step nobody can ever
    // action, which silently wedges the whole request.
    expect(() => validateChain([{ approverId: "u1", guestEmail: "a@b.co" }])).toThrow(/exactly one approver/i);
    expect(() => validateChain([{}])).toThrow(/exactly one approver/i);
    expect(() => validateChain([{ approverId: "u1" }])).not.toThrow();
    expect(() => validateChain([{ guestEmail: "a@b.co" }])).not.toThrow();
  });

  it("refuses a malformed guest address and a repeated approver", () => {
    expect(() => validateChain([{ guestEmail: "nope" }])).toThrow(/valid email/i);
    expect(() => validateChain([{ approverId: "u1" }, { approverId: "u1" }])).toThrow(/appears twice/i);
  });
});

describe("approval ordering", () => {
  it("asks only the lowest outstanding step in a sequential chain", () => {
    const steps = [step("a", 0), step("b", 1), step("c", 2)];
    expect(activeSteps(steps, true).map((s) => s.id)).toEqual(["a"]);
  });

  it("asks everyone at once in a parallel chain", () => {
    const steps = [step("a", 0), step("b", 1)];
    expect(activeSteps(steps, false).map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("runs a tie at the same order together even when sequential", () => {
    // Two people given the same step number were deliberately put side by side.
    const steps = [step("a", 0), step("b", 0), step("c", 1)];
    expect(activeSteps(steps, true).map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("refuses a decision from a step whose turn has not come", () => {
    const steps = [step("a", 0), step("b", 1)];
    expect(() => applyDecision({ steps, stepId: "b", decision: "APPROVED", isSequential: true })).toThrow(/isn't this approver's turn/i);
    // The same step is decidable in a parallel chain.
    expect(() => applyDecision({ steps, stepId: "b", decision: "APPROVED", isSequential: false })).not.toThrow();
  });

  it("is idempotent about an already-decided step", () => {
    // Approval links are emailed. A client that pre-fetches links, or a person who clicks twice,
    // must not produce a different outcome or a confusing error about their own decision.
    const steps = [step("a", 0, "APPROVED"), step("b", 1)];
    expect(() => applyDecision({ steps, stepId: "a", decision: "APPROVED", isSequential: true })).toThrow(/already approved/i);
  });
});

describe("approval outcomes", () => {
  it("advances to the next step on approval and completes on the last", () => {
    const steps = [step("a", 0), step("b", 1)];
    const first = applyDecision({ steps, stepId: "a", decision: "APPROVED", isSequential: true });
    expect(first.status).toBe("PENDING");
    expect(first.completed).toBe(false);
    expect(first.nextSteps.map((s) => s.id)).toEqual(["b"]);

    const decided = [step("a", 0, "APPROVED"), step("b", 1)];
    const last = applyDecision({ steps: decided, stepId: "b", decision: "APPROVED", isSequential: true });
    expect(last.status).toBe("APPROVED");
    expect(last.completed).toBe(true);
    expect(last.nextSteps).toHaveLength(0);
  });

  it("makes ONE rejection terminal, and stops asking everyone else", () => {
    // The asymmetry is the point: one "no" is a decision about the deliverable, so nobody else
    // should spend time on something already turned down. One "yes" is only a step.
    const steps = [step("a", 0), step("b", 1), step("c", 2)];
    const out = applyDecision({ steps, stepId: "a", decision: "REJECTED", isSequential: true });
    expect(out.status).toBe("REJECTED");
    expect(out.completed).toBe(true);
    expect(out.nextSteps).toHaveLength(0);
    // Superseded, NOT marked decided — nobody decided them.
    expect(out.supersededSteps.map((s) => s.id).sort()).toEqual(["b", "c"]);
  });

  it("reports the request status from the steps alone", () => {
    expect(requestStatusAfter([step("a", 0, "APPROVED"), step("b", 1, "APPROVED")])).toBe("APPROVED");
    expect(requestStatusAfter([step("a", 0, "APPROVED"), step("b", 1, "REJECTED")])).toBe("REJECTED");
    expect(requestStatusAfter([step("a", 0, "APPROVED"), step("b", 1)])).toBe("PENDING");
    // An empty chain is not "approved" — nothing has been agreed.
    expect(requestStatusAfter([])).toBe("PENDING");
  });
});
