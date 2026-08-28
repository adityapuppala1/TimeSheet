/**
 * The four shapes Ask AI's answers actually arrive in, and what each should become.
 *
 * EVERY FIXTURE BELOW IS TRANSCRIBED FROM A REAL RUN, not invented. That matters because the first
 * two attempts at this were regexes written against imagined output: they passed their own tests
 * and missed every case a person actually saw. The screenshots that prompted this showed a table
 * rendered correctly underneath `{ "action": "answer", "markdown": "…` printed as text.
 *
 * The recurring detail the earlier passes missed: the envelopes are UNTERMINATED. They start with
 * `{` and simply stop, so strict JSON parsing fails AND the loop's "starts with { and ends with }"
 * check fails too — which is how the raw envelope reached the page.
 */
import { describe, expect, it } from "vitest";
import { cleanAnswer, recoverEnvelopeMarkdown, stripProtocolEcho } from "../../src/services/ai-answer-format.js";

/* ── Shape 2: an unterminated envelope, answer inside ─────────────────────────────────────────── */

const UNTERMINATED_USER_STATS =
  '{ "action": "answer", "markdown": "Here are the user statistics\\n\\n| Role | Active | Inactive |\\n| --- | --- | --- |\\n| Admin | 10 | 0 |\\n| Team Lead | 5 | 1 |\\n\\nThis table shows the number of active and inactive users for each role.';

describe("an envelope that never closed", () => {
  it("recovers the answer instead of printing the envelope", () => {
    const out = cleanAnswer(UNTERMINATED_USER_STATS);
    expect(out).not.toContain('"action"');
    expect(out).not.toContain('"markdown"');
    expect(out.startsWith("Here are the user statistics")).toBe(true);
  });

  it("turns the escaped newlines back into real ones, so the table renders", () => {
    const out = cleanAnswer(UNTERMINATED_USER_STATS);
    // A literal backslash-n is what made the table print as one long line.
    expect(out).not.toContain("\\n");
    expect(out.split("\n").filter((l) => l.startsWith("| "))).toHaveLength(4);
  });

  it("recovers the timesheet case, tool name and all", () => {
    const raw =
      '{ "action": "answer", "markdown": "Based on the timesheet_stats tool, here is the count and status:\\n\\n| Status | Count |\\n| --- | --- |\\n| Approved | 1 |';
    const out = cleanAnswer(raw);
    expect(out.startsWith("Based on the timesheet_stats tool")).toBe(true);
    expect(out).toContain("| Approved | 1 |");
  });
});

describe("adjacent-string joins inside a recovered body", () => {
  it("turns quote-space-quote runs back into the newlines they stood for", () => {
    /*
     * Observed after the first recovery shipped: the table arrived as pipe rows joined by `" "` —
     * the model wrote its markdown as several quoted fragments side by side, Python-concatenation
     * style. Inside a JSON string an unescaped quote would have ENDED the string, so within a
     * recovered body that run can only be the join.
     */
    const raw =
      '{ "action": "answer", "markdown": "| Status | LOW | MEDIUM |" "| --- | --- | --- |" "| OPEN | 26 | 290 |" "| CLOSED | 3 | N/A |';
    const out = cleanAnswer(raw);
    const rows = out.split("\n").filter((l) => l.startsWith("| "));
    expect(rows).toHaveLength(4);
    expect(out).not.toContain('" "');
  });

  it("does NOT rewrite quotes in ordinary prose that was never an envelope", () => {
    // The rewrite is scoped to recovery on purpose — this sentence must come through intact.
    const md = 'The ticket titled "login broken" and the one titled "slow page" are both open.';
    expect(cleanAnswer(md, md)).toBe(md);
  });
});

/* ── Shape 3: prose wrapping a fenced envelope ────────────────────────────────────────────────── */

describe("prose wrapping a fenced envelope", () => {
  it("recovers the markdown from inside the fence", () => {
    const raw = [
      "Here is the markdown object that includes the ticket metrics:",
      "",
      "```json",
      '{',
      '   "action": "answer",',
      '   "markdown": "Based on the tools returned so far:\\n\\n**Open Tickets:** 319\\n| Status | Count |\\n| --- | --- |\\n| OPEN | 306 |'
    ].join("\n");
    const out = cleanAnswer(raw);
    expect(out).toContain("**Open Tickets:** 319");
    expect(out).toContain("| OPEN | 306 |");
    expect(out).not.toContain('"action"');
  });
});

/* ── Shape 4: prose narrating the whole protocol ──────────────────────────────────────────────── */

describe("prose narrating the protocol", () => {
  const NARRATED = [
    "First, I'll answer the secondary question. The features switched on are:",
    "",
    "- AI capabilities: Yes",
    "- Planning: Yes",
    "",
    "Here is the JSON object with the answer:",
    "",
    "```json",
    '{ "action": "answer", "markdown": "The features currently switched on are…" }',
    "```",
    "",
    "Now, I'll call the tool that fits the question.",
    "",
    "```json",
    '{ "action": "tool", "tool": "tickets", "args": { "format": "bar" } }',
    "```",
    "",
    "If this is a general-knowledge question that no tool here can touch, I'll reply with:",
    "",
    "```json",
    '{ "action": "refuse" }',
    "```"
  ].join("\n");

  it("keeps the real content and drops every protocol block", () => {
    const out = stripProtocolEcho(NARRATED);
    expect(out).toContain("- AI capabilities: Yes");
    expect(out).toContain("- Planning: Yes");
    for (const leak of ['"action"', '"tool"', "refuse", "Here is the JSON object", "I'll call the tool", "general-knowledge question"]) {
      expect(out, `leaked: ${leak}`).not.toContain(leak);
    }
  });
});

/* ── The negatives, which matter more than the positives ──────────────────────────────────────── */

describe("what must never be touched", () => {
  it("leaves a chart fence exactly as written", () => {
    const chart = ['```chart', '{"type": "bar", "title": "Hours", "data": [{"label": "Apollo", "value": 12}]}', '```'].join("\n");
    const md = `Hours by project:\n\n${chart}`;
    expect(cleanAnswer(md, md)).toContain(chart);
  });

  it("leaves a json fence holding real workspace data", () => {
    const md = ['Here is the raw shape:', '', '```json', '{ "openTickets": 12, "closed": 3 }', '```'].join("\n");
    expect(cleanAnswer(md, md)).toContain('"openTickets"');
  });

  it("leaves a mermaid fence alone", () => {
    const md = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");
    expect(cleanAnswer(md, md)).toBe(md);
  });

  it("leaves tables, headings and bold untouched", () => {
    const md = ["## Open tickets", "", "| Status | Count |", "| --- | --- |", "| OPEN | **26** |"].join("\n");
    expect(cleanAnswer(md, md)).toBe(md);
  });

  it("keeps a sentence that REPORTS a finding while naming a tool", () => {
    // "I will call ticket_metrics" is narration; "ticket_metrics reports 26" is an answer. The
    // filter is anchored to the announcing form so the second survives.
    const md = "The ticket_metrics tool reports 26 open tickets at low priority, the bulk of the queue.";
    expect(cleanAnswer(md, md)).toBe(md);
  });

  it("never returns empty, whatever it is handed", () => {
    // An empty bubble tells a person less than an ugly one, so every stage falls back.
    const onlyProtocol = '```json\n{ "action": "refuse" }\n```';
    expect(cleanAnswer(onlyProtocol, onlyProtocol).length).toBeGreaterThan(0);
  });

  it("declines to recover from text with no envelope at all", () => {
    expect(recoverEnvelopeMarkdown("There are 26 open tickets.")).toBeNull();
  });
});
