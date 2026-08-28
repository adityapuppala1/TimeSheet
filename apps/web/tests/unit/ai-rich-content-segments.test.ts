/**
 * `splitSegments` — the parser that decides which parts of a model's answer become a chart, a
 * diagram or a code block, and which stay ordinary markdown.
 *
 * The case that matters most is the LINK form. The answer reaches us inside a JSON string, where a
 * real ``` fence has to be escaped and a markdown link does not, so models write
 * `[Bar chart of hours]( {"type":"bar", …} )` instead of a fence — and before this was recognised
 * the chart rendered as a broken link and the numbers were silently lost. Widening what is accepted
 * has an obvious hazard, so the negative cases here matter as much as the positive ones: an
 * ordinary link must survive as a link.
 */
import { describe, expect, it } from "vitest";

import { splitSegments } from "../../src/components/ui/ai-rich-content.js";

const BAR = '{"type": "bar", "title": "Hours by project", "data": [{"label": "Apollo", "value": 12}, {"label": "Borealis", "value": 7}]}';

const kinds = (markdown: string) => splitSegments(markdown).map((s) => s.kind);

describe("splitSegments — fenced blocks", () => {
  it("renders a chart fence as a chart", () => {
    const segments = splitSegments("Here:\n\n```chart\n" + BAR + "\n```\n");
    const chart = segments.find((s) => s.kind === "chart");
    expect(chart).toBeDefined();
    expect(chart && chart.kind === "chart" && chart.spec.type).toBe("bar");
    expect(chart && chart.kind === "chart" && chart.spec.data).toHaveLength(2);
  });

  it("keeps a malformed chart fence visible as JSON rather than hiding it", () => {
    expect(kinds("```chart\n{not json at all}\n```")).toEqual(["code"]);
  });

  it("recognises mermaid and json fences, and leaves other languages to markdown", () => {
    expect(kinds("```mermaid\nflowchart TD\n  A-->B\n```")).toEqual(["mermaid"]);
    expect(kinds('```json\n{"a":1}\n```')).toEqual(["code"]);
    expect(kinds("```python\nprint(1)\n```")).toEqual(["markdown"]);
  });
});

describe("splitSegments — a chart mislabelled as json", () => {
  it("draws a json fence whose body IS a chart spec", () => {
    /*
     * Observed: asked for user stats by role, the model produced a correct chart spec and fenced it
     * ```json, so the person saw a wall of JSON where the picture should have been. The spec is
     * shape-checked exactly as a ```chart fence is — the label was the only thing wrong.
     */
    const md = ['```json', '{"type": "bar", "title": "User Stats by Role", "data": [{"label": "Admin", "value": 5}]}', '```'].join("\n");
    const segments = splitSegments(md);
    expect(segments.map((s) => s.kind)).toEqual(["chart"]);
  });

  it("still shows a json fence of ordinary data as code", () => {
    // The widening is by SHAPE, not by fence: anything that is not exactly a chart spec renders as
    // the code block it always was.
    const md = ['```json', '{ "openTickets": 12, "closed": 3 }', '```'].join("\n");
    const segments = splitSegments(md);
    expect(segments.map((s) => s.kind)).toEqual(["code"]);
  });
});

describe("splitSegments — the markdown-link chart form", () => {
  it("draws a chart written as a link", () => {
    const segments = splitSegments(`Hours by project:\n\n[Bar chart of hours](${BAR})\n`);
    expect(segments.map((s) => s.kind)).toContain("chart");
    const chart = segments.find((s) => s.kind === "chart");
    expect(chart && chart.kind === "chart" && chart.spec.title).toBe("Hours by project");
  });

  it("draws it in the image form too, without leaving a stray `!` behind", () => {
    const segments = splitSegments(`![Bar chart](${BAR})`);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("chart");
  });

  it("tolerates whitespace padding inside the parentheses", () => {
    expect(kinds(`[Chart](   ${BAR}   )`)).toEqual(["chart"]);
  });

  it("tolerates NEWLINES inside the parentheses, which is what the model actually writes", () => {
    // Taken verbatim from a stored answer in the dev database, not invented: the model pretty-prints
    // the spec across lines, so `(` is followed by a newline and `)` is preceded by one. An earlier
    // pass of this matcher used a newline-excluding class here and silently matched nothing at all
    // in production while every hand-written test passed.
    const pretty = `{
  "type": "bar",
  "title": "Ticket metrics",
  "data": [
    {
      "label": "Open",
      "value": 10
    }
  ]
}`;
    expect(kinds(`[Bar chart of ticket metrics](
${pretty}
)`)).toEqual(["chart"]);
  });

  it("leaves an ORDINARY link completely alone", () => {
    // The whole risk of accepting the link form: this must never become a chart, or every link in
    // every AI answer breaks.
    const md = "See [the timesheet docs](https://example.com/docs) for more.";
    expect(kinds(md)).toEqual(["markdown"]);
    expect(splitSegments(md)[0]).toMatchObject({ text: md });
  });

  it("leaves a link whose target is unrelated JSON alone", () => {
    // Recognising the shape is not the same as trusting it — the target still has to survive the
    // full chart shape-check, which this does not.
    expect(kinds('[config]({"retries": 3, "timeout": 5})')).toEqual(["markdown"]);
  });

  it("rejects a spec with no usable data points", () => {
    expect(kinds('[chart]({"type": "bar", "data": []})')).toEqual(["markdown"]);
    expect(kinds('[chart]({"type": "donut", "data": [{"label": "a", "value": 1}]})')).toEqual(["markdown"]);
  });
});

describe("splitSegments — mixed content", () => {
  it("keeps both forms in the order the model wrote them", () => {
    const md = "Intro.\n\n```mermaid\nflowchart TD\n  A-->B\n```\n\nAnd the numbers:\n\n[Chart](" + BAR + ")\n\nOutro.";
    expect(kinds(md)).toEqual(["markdown", "mermaid", "markdown", "chart", "markdown"]);
  });

  it("is not stateful across calls", () => {
    // The regex is module-level and /g, so a leaked `lastIndex` would make the second call skip
    // the block entirely — a bug that only ever shows on the second render.
    const md = `[Chart](${BAR})`;
    expect(kinds(md)).toEqual(["chart"]);
    expect(kinds(md)).toEqual(["chart"]);
  });
});
