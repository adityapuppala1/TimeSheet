/**
 * Stripping the loop's own protocol out of an answer.
 *
 * THE REPORTED BUG, and it is worth describing exactly because the answer underneath was correct.
 * Asked to break tickets down by status and priority, the assistant returned the right table and
 * the right chart — with three paragraphs of narration above them ("First, I will use the
 * search_tickets tool…") and three fenced JSON blocks showing `{"action": "answer"…}`,
 * `{"action": "tool"…}` and `{"action": "refuse"}`. Every one of those is the envelope this loop
 * speaks in, echoed back as content. The data was right and the reply looked broken.
 *
 * Adding a third action made it worse, which is the part worth remembering: `{"action": "refuse"}`
 * began appearing as literal text inside answers to questions that had not been refused, because a
 * third protocol token is a third thing for a small model to narrate.
 *
 * The two halves of the contract this file pins:
 *   - Everything that IS the protocol goes.
 *   - Everything that merely LOOKS like structured data stays. A `json` fence holding real workspace
 *     rows, a table, a chart fence and prose that happens to name a tool are all content.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));

const { stripProtocolEcho } = await import("../../src/services/ai.service.js");

describe("removing the protocol envelope", () => {
  it("drops a fenced block that is our own action object", () => {
    const md = ['Here is the breakdown.', '', '```json', '{ "action": "tool", "tool": "search_tickets", "args": {} }', '```', '', 'Two tickets are open.'].join("\n");
    const out = stripProtocolEcho(md);
    expect(out).not.toContain("action");
    expect(out).toContain("Here is the breakdown.");
    expect(out).toContain("Two tickets are open.");
  });

  it("drops the escaped form, which is how it actually arrived", () => {
    // The screenshot showed `{ \"action\": \"answer\", \"markdown\": \"## Open Tickets…` — the model
    // had escaped its own quotes inside the block. The unescaped pattern alone would have missed it.
    const md = ['```json', '{ \\"action\\": \\"answer\\", \\"markdown\\": \\"## Open Tickets by Status\\" }', '```', '', 'Real content.'].join("\n");
    expect(stripProtocolEcho(md)).toBe("Real content.");
  });

  it("drops a bare refuse object sitting in the prose", () => {
    const md = ['Some lead-in.', '{ "action": "refuse" }', 'The actual answer.'].join("\n");
    const out = stripProtocolEcho(md);
    expect(out).not.toContain("refuse");
    expect(out).toContain("The actual answer.");
  });

  it("drops the narration that introduced the block", () => {
    const md = ['First, I will use the search_tickets tool to get the counts.', '', '| Status | Count |', '| --- | --- |', '| OPEN | 3 |'].join("\n");
    const out = stripProtocolEcho(md);
    expect(out).not.toContain("First, I will use");
    expect(out).toContain("| OPEN | 3 |");
  });
});

describe("leaving the content alone", () => {
  it("keeps a chart fence exactly as written", () => {
    // The single most important negative case: charts are the thing this was reported as breaking,
    // and a strip that ate the fence would be a worse bug than the one it fixed.
    const chart = ['```chart', '{"type": "bar", "title": "Hours", "data": [{"label": "Apollo", "value": 12}]}', '```'].join("\n");
    expect(stripProtocolEcho(`Hours by project:\n\n${chart}`)).toContain(chart);
  });

  it("keeps a json fence holding real data", () => {
    const md = ['```json', '{ "openTickets": 12, "closed": 3 }', '```'].join("\n");
    expect(stripProtocolEcho(md)).toContain('"openTickets"');
  });

  it("keeps a table, headings and bold", () => {
    const md = ['## Open tickets', '', '| Status | Count |', '| --- | --- |', '| OPEN | **26** |'].join("\n");
    expect(stripProtocolEcho(md)).toBe(md);
  });

  it("keeps a sentence that reports a finding while naming a tool", () => {
    // Anchored and length-capped for exactly this: naming a tool is not the same as announcing one.
    const md = "The ticket_metrics tool reports 26 open tickets at low priority, which is the bulk of the queue.";
    expect(stripProtocolEcho(md)).toBe(md);
  });

  it("returns empty rather than nonsense when the reply was ONLY protocol", () => {
    // The caller falls back to the raw markdown on an empty result, so this must be detectable
    // rather than silently producing a blank answer bubble.
    expect(stripProtocolEcho('```json\n{ "action": "refuse" }\n```')).toBe("");
  });
});
