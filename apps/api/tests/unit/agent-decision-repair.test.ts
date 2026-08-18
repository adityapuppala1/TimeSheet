/**
 * The one repair the agent loop makes to a model's reply, and the four things it must refuse to do.
 *
 * Found on a live BYOK workspace: `allam-2-7b` answered `{"action":"list_projects","why":"..."}` — the
 * right intent with the two levels collapsed — and the run died on the shape after paying for the
 * tokens. This file's own product claim is that the loop works on every provider including small local
 * models, so accepting the near-miss is the difference between that claim being true and being
 * marketing.
 *
 * The refusals matter more than the repair: a coercion that can invent a tool call is a hole in the
 * allowlist, so every case here checks that the repair changes SHAPE and never AUTHORITY.
 */
import { describe, expect, it, vi } from "vitest";

const { describeDecisionFailure, repairAgentDecision } = await import("../../src/services/ai.service.js");

const tools = [{ name: "list_projects" }, { name: "search_tickets" }];

describe("the flattened decision a small model emits", () => {
  it("reads an offered tool name in `action` as a call to that tool", () => {
    expect(repairAgentDecision('{"action":"list_projects","why":"see what exists"}', tools)).toEqual({
      action: "tool",
      tool: "list_projects",
      args: {},
      why: "see what exists"
    });
  });

  it("keeps the args when they are there", () => {
    expect(repairAgentDecision('{"action":"search_tickets","args":{"q":"login"}}', tools)).toMatchObject({
      tool: "search_tickets",
      args: { q: "login" }
    });
  });

  it("fills in the args the schema demanded and the model omitted", () => {
    expect(repairAgentDecision('{"action":"tool","tool":"list_projects"}', tools)).toMatchObject({ tool: "list_projects", args: {} });
  });

  it("survives a fenced reply, which is how half of them arrive", () => {
    expect(repairAgentDecision('```json\n{"action":"list_projects"}\n```', tools)).toMatchObject({ tool: "list_projects" });
  });
});

describe("what it must never do", () => {
  it("refuses a tool that was not offered for this step", () => {
    // The whole safety of the repair: it can change the shape of a decision, never its reach.
    expect(repairAgentDecision('{"action":"delete_everything","why":"tidying"}', tools)).toBeNull();
    expect(repairAgentDecision('{"action":"tool","tool":"delete_everything"}', tools)).toBeNull();
  });

  it("refuses a finish with nothing to say", () => {
    expect(repairAgentDecision('{"action":"finish"}', tools)).toBeNull();
    expect(repairAgentDecision('{"action":"finish","summary":"   "}', tools)).toBeNull();
  });

  it("refuses prose, and anything that is not an object", () => {
    expect(repairAgentDecision("I think I should list the projects first.", tools)).toBeNull();
    expect(repairAgentDecision("[1,2,3]", tools)).toBeNull();
    expect(repairAgentDecision("", tools)).toBeNull();
  });

  it("accepts a finish whose answer arrived under a neighbouring key", () => {
    expect(repairAgentDecision('{"action":"finish","answer":"Three projects are active."}', tools)).toEqual({
      action: "finish",
      summary: "Three projects are active."
    });
  });
});

/**
 * The diagnosis, which is the part that would have saved a wrong conclusion. Every message must name
 * the MODEL, because on a BYOK deployment choosing it is the operator's job and the previous message
 * ("could not be parsed as a decision") sent them to check an API key that was working perfectly.
 */
describe("why a decision could not be read", () => {
  it("recognises a model echoing the schema back instead of an instance of it", () => {
    const echoed = '{"type":"object","properties":{"action":{"type":"string","enum":["tool","finish"]}}}';
    const msg = describeDecisionFailure(echoed, "allam-2-7b");
    expect(msg).toMatch(/JSON SCHEMA instead of an answer/i);
    expect(msg).toContain("allam-2-7b");
    // And says what still works, so nobody switches AI off over it.
    expect(msg).toMatch(/every other AI feature here will keep working/i);
  });

  it("tells prose apart from malformed JSON", () => {
    expect(describeDecisionFailure("I should probably list the projects.", "tiny-1b")).toMatch(/in prose/i);
    expect(describeDecisionFailure('{"action":', "tiny-1b")).toMatch(/not a valid decision/i);
  });

  it("has something to say about an empty reply", () => {
    expect(describeDecisionFailure("   ", "tiny-1b")).toMatch(/returned nothing/i);
  });
});
