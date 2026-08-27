/**
 * `pdf-kit.ts` — the shared PDF house style. These cover the two pure parts, which are the parts a
 * layout bug actually hides in: the markdown block parser and the chart-spec shape check.
 *
 * The DRAWING is verified by rendering real documents and looking at them (`pdf-shot.mjs` renders a
 * PDF through Chrome), because a test asserting "a rectangle was filled" tells you nothing about
 * whether the page reads correctly — and `pdf-parse` cannot read PDFKit's output in this repo's ESM
 * runtime anyway (see requirements-doc-import.service.test.ts's header for that whole story).
 *
 * What these DO pin is the behaviour that decides what gets drawn at all: a `### heading` becoming a
 * heading rather than literal text is the entire bug this module was written for.
 */
import { describe, expect, it } from "vitest";

import { inlineRuns, parseChartSpec, parseMarkdownBlocks, stripInline } from "../../src/services/pdf-kit.js";

describe("parseMarkdownBlocks", () => {
  it("reads headings at every level", () => {
    const blocks = parseMarkdownBlocks("# One\n\n## Two\n\n#### Four");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 2, text: "Two" },
      { kind: "heading", level: 4, text: "Four" }
    ]);
  });

  it("joins a wrapped paragraph into one block and splits on the blank line", () => {
    const blocks = parseMarkdownBlocks("A sentence that\nwrapped in the source.\n\nA second paragraph.");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "A sentence that wrapped in the source." },
      { kind: "paragraph", text: "A second paragraph." }
    ]);
  });

  it("reads bulleted and numbered lists, and folds a continuation line into its item", () => {
    expect(parseMarkdownBlocks("- one\n- two\n  still two")).toEqual([
      { kind: "list", ordered: false, items: ["one", "two still two"] }
    ]);
    expect(parseMarkdownBlocks("1. first\n2. second")).toEqual([
      { kind: "list", ordered: true, items: ["first", "second"] }
    ]);
  });

  it("reads a GFM table", () => {
    const blocks = parseMarkdownBlocks("| Area | Today |\n| --- | --- |\n| Invoicing | 6 h |\n| Disputes | 4% |");
    expect(blocks).toEqual([
      { kind: "table", headers: ["Area", "Today"], rows: [["Invoicing", "6 h"], ["Disputes", "4%"]] }
    ]);
  });

  it("pads a ragged table row instead of letting it shift every cell after it", () => {
    const blocks = parseMarkdownBlocks("| A | B | C |\n| --- | --- | --- |\n| 1 |");
    expect(blocks[0]).toMatchObject({ kind: "table", rows: [["1", "", ""]] });
  });

  it("does NOT turn a sentence containing pipes into a table", () => {
    // The divider line is what makes it a table. Without this check, prose like "use a | b | c"
    // became a one-column table, which reads as a rendering fault.
    expect(parseMarkdownBlocks("Pick a shell: bash | zsh | fish.")).toEqual([
      { kind: "paragraph", text: "Pick a shell: bash | zsh | fish." }
    ]);
    // A pipe row with no divider under it is still prose.
    expect(parseMarkdownBlocks("| not | a table |\nplain follow-up")[0].kind).toBe("paragraph");
  });

  it("reads GitHub callouts, and a plain blockquote as a quote", () => {
    expect(parseMarkdownBlocks("> [!WARNING]\n> Rates are per person.\n> Not per project.")).toEqual([
      { kind: "callout", type: "WARNING", text: "Rates are per person. Not per project." }
    ]);
    expect(parseMarkdownBlocks("> Just a quotation.")).toEqual([{ kind: "quote", text: "Just a quotation." }]);
  });

  it("keeps a fenced block's language, and survives a fence the model never closed", () => {
    expect(parseMarkdownBlocks("```chart\n{}\n```")).toEqual([{ kind: "code", lang: "chart", text: "{}" }]);
    // Token-cap truncation mid-fence must not lose the content that is there.
    expect(parseMarkdownBlocks("```mermaid\nflowchart TD\n  A-->B")).toEqual([
      { kind: "code", lang: "mermaid", text: "flowchart TD\n  A-->B" }
    ]);
  });

  it("treats plain prose as plain prose — the no-markdown case", () => {
    // Most narrative fields contain no markup at all. They must render exactly as before.
    const prose = "Churn is on an increasing trend and needs automation support.";
    expect(parseMarkdownBlocks(prose)).toEqual([{ kind: "paragraph", text: prose }]);
  });

  it("stays fast on adversarial input", () => {
    // The divider check used to be a regex whose `\s*` and `[\s:|-]+` overlapped: ~3000ms on this
    // exact input. It parses text a model wrote, so that was reachable.
    const started = Date.now();
    parseMarkdownBlocks(`| a |\n${"|-".repeat(30000)}`);
    parseMarkdownBlocks(`| a |\n${" ".repeat(60000)}`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("inlineRuns", () => {
  it("splits bold, italic and mono into their own runs", () => {
    expect(inlineRuns("plain **bold** and *italic* and `code`").map((r) => [r.text, r.font])).toEqual([
      ["plain ", "Helvetica"],
      ["bold", "Helvetica-Bold"],
      [" and ", "Helvetica"],
      ["italic", "Helvetica-Oblique"],
      [" and ", "Helvetica"],
      ["code", "Courier"]
    ]);
  });

  it("keeps a link's target rather than dropping it or printing raw brackets", () => {
    expect(stripInline("See [the runbook](https://example.com/r) for more.")).toBe(
      "See the runbook (https://example.com/r) for more."
    );
  });

  it("returns one plain run when there is no markup", () => {
    expect(inlineRuns("nothing special here")).toEqual([{ text: "nothing special here", font: "Helvetica" }]);
  });
});

describe("parseChartSpec", () => {
  it("accepts a well-formed spec", () => {
    const spec = parseChartSpec('{"type":"bar","title":"Hours","data":[{"label":"Apollo","value":12}]}');
    expect(spec).toEqual({ type: "bar", title: "Hours", data: [{ label: "Apollo", value: 12 }] });
  });

  it("rejects anything that would not draw", () => {
    expect(parseChartSpec('{"type":"donut","data":[{"label":"a","value":1}]}')).toBeNull();
    expect(parseChartSpec('{"type":"bar","data":[]}')).toBeNull();
    expect(parseChartSpec("not json")).toBeNull();
    expect(parseChartSpec('{"type":"bar","data":[{"label":"a","value":"lots"}]}')).toBeNull();
  });

  it("repairs the doubled-brace artifact, matching the browser renderer", () => {
    // A spec the app draws must export as a chart too — the export disagreeing with the screen it
    // came from is the whole point of this work.
    expect(parseChartSpec('{{"type":"pie","data":[{"label":"a","value":1}]}')).toMatchObject({ type: "pie" });
  });
});
