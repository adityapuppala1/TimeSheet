/**
 * `safeHtml` is the browser-side sanitizer every `dangerouslySetInnerHTML` in this app goes
 * through. For most of its callers it is defence in depth — the server already sanitized the value
 * on save. For two of them it is the ONLY sanitizer there is:
 *
 *   - `ui/ai-markdown.tsx` renders `marked.parse()` over MODEL output.
 *   - `pages/WhatsNew.tsx` renders release-note markdown fetched from a REMOTE GitHub API.
 *
 * Neither of those values was ever seen by `apps/api/src/utils/sanitize.ts`.
 *
 * WHAT THESE TESTS PIN, and why each earns its place:
 *
 *  1. Script execution, in all the shapes DOMPurify is expected to strip. Table stakes.
 *  2. The `style` ALLOW-LIST. CSS does not need to run script to be an attack here:
 *     `position:fixed;inset:0;z-index:9999` inside a ticket comment — a field any colleague can
 *     write and every colleague renders — floats an invisible layer over the whole application, and
 *     the click it captures lands on whatever is underneath. The server's `sanitizeRichText`
 *     restricts `style` to `text-align`; this side used to allow every property.
 *  3. The forced `rel` on any link that opens a new context. `noopener` severs `window.opener`
 *     (reverse tabnabbing); `noreferrer` withholds the Referer, which matters because this app's
 *     `/uploads` URLs are signed capabilities and a leaked one IS read access to the file.
 *
 * These run under happy-dom rather than node — see vitest.config.ts for why that environment
 * exists at all.
 */
import { describe, expect, it } from "vitest";
import { htmlToPlainText, plainTextLength, safeHtml } from "../../src/lib/safe-html";

/** The rendered string, for assertions. `safeHtml` returns React's `{ __html }` wrapper. */
const clean = (html: string | null | undefined) => safeHtml(html).__html;

describe("safeHtml — script execution", () => {
  it.each([
    ["<script>alert(1)</script>", "a bare script tag"],
    ['<img src=x onerror="alert(1)">', "an inline error handler"],
    ['<svg onload="alert(1)"></svg>', "an SVG load handler"],
    ['<a href="javascript:alert(1)">x</a>', "a javascript: URL"],
    ['<iframe src="https://evil.example"></iframe>', "an embedded frame"],
    ['<object data="evil.swf"></object>', "an embedded object"],
    ["<form action='/steal'><input name='p'></form>", "a form that could post elsewhere"]
  ])("strips %s (%s)", (payload) => {
    const out = clean(payload);
    expect(out).not.toMatch(/<script|onerror|onload|javascript:|<iframe|<object|<form/i);
  });

  it("keeps the ordinary rich text the editor actually produces", () => {
    const out = clean("<p><strong>Bold</strong> and <em>italic</em> and <a href='https://example.com'>a link</a>.</p>");
    expect(out).toContain("<strong>Bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('href="https://example.com"');
  });

  it("keeps tables, which Ask AI's markdown renders", () => {
    const out = clean("<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>");
    expect(out).toContain("<table>");
    expect(out).toContain("<td>1</td>");
  });
});

describe("safeHtml — the style allow-list", () => {
  it("drops the overlay a UI-redress attack needs", () => {
    // The whole point. Every one of these properties is what turns a comment into a click-trap.
    const out = clean('<p style="position:fixed;inset:0;z-index:9999;width:100vw;height:100vh">x</p>');
    expect(out).not.toMatch(/position|inset|z-index|100vw|100vh/i);
  });

  it.each([
    "display:none",
    "opacity:0",
    "transform:scale(40)",
    "background:url(https://tracker.example/pixel.png)",
    "pointer-events:none",
    "margin-left:-9999px"
  ])("drops %s", (declaration) => {
    expect(clean(`<p style="${declaration}">x</p>`)).not.toContain(declaration.split(":")[0]);
  });

  it("keeps text-align, which is the one style the editor emits", () => {
    for (const value of ["left", "right", "center", "justify"]) {
      expect(clean(`<p style="text-align:${value}">x</p>`)).toContain(`text-align: ${value}`);
    }
  });

  it("keeps text-align even when smuggled in beside a banned property", () => {
    // Rebuilt from an allow-list, not scrubbed of known-bad names — so the good half survives and
    // the bad half cannot ride along with it.
    const out = clean('<p style="position:fixed;text-align:center;z-index:9">x</p>');
    expect(out).toContain("text-align: center");
    expect(out).not.toMatch(/position|z-index/i);
  });

  it("drops a text-align value that is not one of the four", () => {
    expect(clean('<p style="text-align:-webkit-center">x</p>')).not.toContain("text-align");
  });

  it("removes the attribute entirely when nothing survives", () => {
    expect(clean('<p style="position:fixed">x</p>')).not.toContain("style");
  });
});

describe("safeHtml — link hardening", () => {
  it("forces the full rel on any link that opens a new context", () => {
    const out = clean('<a href="https://evil.example" target="_blank">x</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("overwrites a rel the author supplied rather than trusting it", () => {
    // An attacker-authored `rel="opener"` must not survive — the point is that this side decides.
    const out = clean('<a href="https://evil.example" target="_blank" rel="opener">x</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toMatch(/rel="opener"/);
  });

  it("leaves a same-tab link alone", () => {
    const out = clean('<a href="https://example.com">x</a>');
    expect(out).not.toContain("noopener");
  });
});

describe("safeHtml — hook registration", () => {
  it("does not accumulate hooks across calls", () => {
    // `DOMPurify.addHook` APPENDS. Registering inside `safeHtml` rather than once at module load
    // would stack a new copy on every render and turn a busy list into a leak — and the style
    // filter would run N times per node. A stable result over many calls is what pins that.
    const payload = '<p style="position:fixed;text-align:center">x</p>';
    const first = clean(payload);
    for (let i = 0; i < 50; i += 1) clean(payload);
    expect(clean(payload)).toBe(first);
  });

  it("handles null and undefined without throwing", () => {
    expect(clean(null)).toBe("");
    expect(clean(undefined)).toBe("");
  });
});

describe("htmlToPlainText / plainTextLength", () => {
  it("counts what a person actually typed, not the markup", () => {
    // An empty paragraph the editor emits as `<p></p>` must count as 0, not 7.
    expect(plainTextLength("<p></p>")).toBe(0);
    expect(plainTextLength("<p>hello</p>")).toBe(5);
    expect(htmlToPlainText("<p>a</p><p>b</p>")).toBe("a b");
  });

  it("stays linear on a value full of unclosed angle brackets", () => {
    // `[^<>]` rather than `[^>]` in the tag matcher is deliberate: with `[^>]` an input carrying
    // many `<` and no `>` is rescanned from every `<`, which is quadratic and was measured at
    // ~100ms on a 20k value. Pinned as a time bound so a "simplification" cannot quietly undo it.
    const nasty = `${"<".repeat(40_000)}text`;
    const started = performance.now();
    const out = htmlToPlainText(nasty);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).toContain("text");
  });
});
