import { describe, expect, it } from "vitest";
import { flowDraftPrompt, parseFlowDraft } from "../../src/lib/flow-draft";
import type { FlowCatalogue } from "../../src/services/api";

const catalogue = {
  capabilities: [], events: [], people: [], labels: [], projects: [],
  actions: [{ key: "notify", label: "Notify", target: "notifyUserId", options: "people" }],
  branchFields: [{ key: "priority", label: "Priority", values: ["HIGH", "LOW"] }, { key: "projectId", label: "Project", options: "projects" }, { key: "senderDomain", label: "Sender", freeText: true }]
} satisfies FlowCatalogue;
const answer = { name: "Escalate urgent work", description: "Review and notify.", steps: [{ kind: "ACTION", action: "notify" }] };

describe("AI workflow draft", () => {
  it("fills only supported condition values and defaults the operator", () => {
    const result = parseFlowDraft(JSON.stringify({ ...answer, steps: [{ kind: "BRANCH", field: "priority", value: "HIGH" }, ...answer.steps] }), catalogue);
    expect(result.steps[1].config).toEqual({ field: "priority", op: "is", value: "HIGH" });
  });
  it("rejects invented priorities, project IDs, operators and URL-shaped domains", () => {
    for (const condition of [{ field: "priority", value: "URGENT" }, { field: "projectId", value: "invented-id" }, { field: "senderDomain", value: "example.com/path" }, { field: "priority", op: "execute" }]) {
      expect(() => parseFlowDraft(JSON.stringify({ ...answer, steps: [{ kind: "BRANCH", ...condition }] }), catalogue)).toThrow();
    }
  });
  it("creates a manual, unassigned draft with an unconfigured approval gate first", () => {
    expect(parseFlowDraft(JSON.stringify(answer), catalogue)).toMatchObject({
      trigger: "MANUAL", triggerConfig: {}, agentProfileId: null,
      steps: [{ kind: "HUMAN_GATE", config: {} }, { kind: "ACTION", config: { action: "notify" } }]
    });
  });
  it("accepts a JSON fence and preserves an existing first approval gate", () => {
    const value = { ...answer, steps: [{ kind: "HUMAN_GATE" }, ...answer.steps] };
    expect(parseFlowDraft(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, catalogue).steps).toHaveLength(2);
  });
  it("refuses invented actions, capabilities, and conditions", () => {
    for (const step of [{ kind: "ACTION", action: "delete" }, { kind: "CAPABILITY", capability: "invented" }, { kind: "BRANCH", field: "secret" }]) {
      expect(() => parseFlowDraft(JSON.stringify({ ...answer, steps: [step] }), catalogue)).toThrow();
    }
  });
  it("rejects activation, identities and arbitrary step settings from the model", () => {
    expect(() => parseFlowDraft(JSON.stringify({ ...answer, enabled: true }), catalogue)).toThrow();
    expect(() => parseFlowDraft(JSON.stringify({ ...answer, steps: [{ ...answer.steps[0], config: { notifyUserId: "someone" } }] }), catalogue)).toThrow();
  });
  it("limits generated steps so the mandatory gate fits the existing twenty-step cap", () => {
    expect(parseFlowDraft(JSON.stringify({ ...answer, steps: Array(19).fill(answer.steps[0]) }), catalogue).steps).toHaveLength(20);
    expect(() => parseFlowDraft(JSON.stringify({ ...answer, steps: Array(20).fill(answer.steps[0]) }), catalogue)).toThrow();
  });
  it("does not send workspace people and refuses over-budget prompts", () => {
    const prompt = flowDraftPrompt("Notify about urgent work", { ...catalogue, people: [{ id: "private-id", name: "Private", email: "private@example.com" }] });
    expect(prompt).not.toContain("private@example.com");
    expect(prompt).toContain("Actions: notify");
    expect(() => flowDraftPrompt("x".repeat(2000), catalogue)).toThrow(/Shorten/);
  });
});
