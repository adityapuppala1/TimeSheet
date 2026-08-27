/**
 * The written sections became rich text, so the email has to RENDER them rather than escape them.
 *
 * The failure this guards against is the exact one the PDF exports were fixed for: HTML printed to
 * the reader as `<p>` and `<strong>` instead of as a paragraph and bold. It is the kind of bug that
 * ships because the sender never reads their own email.
 *
 * Two properties are pinned per section type, and the difference between them is the point:
 *   - The SUMMARY is a document. Headings, lists and quotes belong there, and each needs an inline
 *     style, because mail clients ignore stylesheets to varying and unpredictable degrees.
 *   - A BULLET ITEM is one line inside a `<ul>` this code builds. A block element nested in an
 *     `<li>` renders as a stray break in some clients and as nothing in others, so a model that
 *     ignores the "no headings" guidance must degrade to a readable sentence, not a broken list.
 */
import { describe, expect, it } from "vitest";
import { buildPracticeUpdateEmail } from "../../src/services/practice-update-mail.service.js";
import type { PracticeUpdateData } from "../../src/services/practice-update.service.js";

const DATA = {
  period: { from: "2026-08-17", to: "2026-08-23", label: "17 Aug – 23 Aug 2026" },
  previous: { from: "2026-08-10", to: "2026-08-16" },
  metrics: { ticketsClosed: 3, ticketsRaised: 4, hours: 11.5, contributors: 2, overdue: 0, slaBreaches: 0, amber: 0, red: 0 },
  previousMetrics: { ticketsClosed: 1, ticketsRaised: 2, hours: 9, contributors: 2, overdue: 0, slaBreaches: 0, amber: 0, red: 0 },
  initiatives: [],
  releases: [],
  isEmpty: false
} as unknown as PracticeUpdateData;

function render(narrative: Record<string, unknown>) {
  return buildPracticeUpdateEmail(DATA, narrative as never).sectionsHtml;
}

describe("the executive summary renders as a document", () => {
  it("keeps headings, bold, lists and quotes instead of printing their tags", () => {
    const html = render({
      executiveSummary:
        "<h3>Delivery</h3><p>Shipped <strong>3 tickets</strong>.</p><ul><li>Portal work landed</li></ul><blockquote>Needs a decision on scope.</blockquote>",
      risks: [],
      nextWeekPriorities: [],
      decisionsRequired: [],
      nextSteps: []
    });

    // Rendered, not escaped. `&lt;h3&gt;` appearing here is the whole bug.
    expect(html).not.toContain("&lt;h3&gt;");
    expect(html).toContain("<strong>3 tickets</strong>");
    expect(html).toMatch(/<h3[^>]*style="[^"]+"[^>]*>Delivery<\/h3>/);
    expect(html).toMatch(/<blockquote[^>]*style="[^"]+"/);
    expect(html).toMatch(/<ul[^>]*style="[^"]+"/);
  });

  it("styles a link, which is the case a broken escape silently missed", () => {
    // `<a>` is the only tag here that arrives WITH attributes, so it is the one that stops being
    // styled when the tag pattern cannot match an attribute list. Nothing looks broken when that
    // happens — the link is simply the wrong colour — which is why it gets its own test.
    const html = render({ executiveSummary: '<p>See <a href="https://example.com">the board</a>.</p>', risks: [], nextWeekPriorities: [], decisionsRequired: [], nextSteps: [] });
    expect(html).toMatch(/<a\s+[^>]*href="https:\/\/example\.com"[^>]*style="[^"]+"/);
  });

  it("strips anything the sanitiser refuses, even inside prose somebody typed", () => {
    const html = render({
      executiveSummary: '<p>Fine.</p><script>alert(1)</script><img src=x onerror="alert(1)">',
      risks: [],
      nextWeekPriorities: [],
      decisionsRequired: [],
      nextSteps: []
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).toContain("Fine.");
  });

  it("falls back to the counted figures when nothing was written", () => {
    const html = render({ executiveSummary: "", risks: [], nextWeekPriorities: [], decisionsRequired: [], nextSteps: [] });
    // The fallback is plain text this service composes, so it must still be escaped, and it must
    // still say something — an update sent with the model unavailable is a complete update.
    expect(html.length).toBeGreaterThan(200);
  });
});

describe("a bullet item stays one line", () => {
  it("keeps inline emphasis", () => {
    const html = render({
      executiveSummary: "",
      risks: ["<p>Archive Drill is at risk — <strong>43 overdue</strong>.</p>"],
      nextWeekPriorities: [],
      decisionsRequired: [],
      nextSteps: []
    });
    expect(html).toContain("<strong>43 overdue</strong>");
  });

  it("flattens a block element the model added against instructions", () => {
    const html = render({
      executiveSummary: "",
      risks: ["<h2>Risk</h2><p>Two overdue items.</p>"],
      nextWeekPriorities: [],
      decisionsRequired: [],
      nextSteps: []
    });
    const item = /<li[^>]*>(.*?)<\/li>/s.exec(html)?.[1] ?? "";
    expect(item).not.toMatch(/<h2|<p[\s>]/);
    expect(item).toContain("Two overdue items.");
  });

  it("still renders a plain-text item, which is what every older draft holds", () => {
    // Everything written before rich text shipped is a bare string. It must not come out blank.
    const html = render({
      executiveSummary: "",
      risks: ["Plain sentence with <angle> brackets"],
      nextWeekPriorities: [],
      decisionsRequired: [],
      nextSteps: []
    });
    expect(html).toContain("Plain sentence with");
  });
});
