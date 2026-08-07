/**
 * Sanitizer behaviour, pinned.
 *
 * WHY IT EXISTS NOW: `sanitize-html` carried advisory GHSA-vccv-cmxp-4j9h — `javascript:` URIs
 * slipping through `action`, `formaction`, `data`, `poster` and `background`. Tracing it showed the
 * advisory does NOT reach this codebase, because none of those five attributes appear in either
 * allowlist, so they are stripped before the scheme check matters. That analysis was worth having;
 * it was not worth having only as a paragraph in a chat log. These cases pin it.
 *
 * The output of this function is rendered with `dangerouslySetInnerHTML` (History.tsx, the ticket
 * detail sheet), so it is a security boundary, not a formatting helper. Anything that widens
 * `allowedTags` or `allowedAttributes` should have to break a test here first.
 */
import { describe, expect, it } from "vitest";
import { htmlToPlainText, htmlToText, plainTextToRichText, sanitizeRichText } from "../../src/utils/sanitize.js";

describe("sanitizeRichText", () => {
  it("keeps the formatting the rich-text editor produces", () => {
    // `strong`/`em`, not `b`/`i` — the allowlist tracks what Tiptap's StarterKit actually emits,
    // so the presentational legacy tags are correctly dropped.
    expect(sanitizeRichText("<p>Hello <strong>world</strong></p>")).toContain("<strong>world</strong>");
    expect(sanitizeRichText("<ul><li>one</li><li>two</li></ul>")).toContain("<li>one</li>");
    expect(sanitizeRichText('<a href="https://example.com">link</a>')).toContain('href="https://example.com"');
  });

  it("drops presentational tags the editor never produces", () => {
    // Not a bug — a narrower allowlist is a smaller attack surface. Pinned so nobody "fixes" it by
    // widening the list to match what a pasted email happens to contain.
    expect(sanitizeRichText("<p>Hello <b>world</b></p>")).toBe("<p>Hello world</p>");
  });

  it("strips script tags and inline event handlers", () => {
    const out = sanitizeRichText('<script>alert(1)</script><p onclick="alert(1)">safe</p>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("safe");
  });

  it("refuses javascript: in an href", () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("drops the five attributes named in GHSA-vccv-cmxp-4j9h", () => {
    // The advisory's bypass needs one of these to be allowed. None is, on either allowlist — which
    // is precisely why the advisory does not reach this application. If someone adds one of them to
    // `allowedAttributes` later, this test is the thing that should stop them.
    for (const markup of [
      '<form action="javascript:alert(1)"><input /></form>',
      '<button formaction="javascript:alert(1)">x</button>',
      '<object data="javascript:alert(1)"></object>',
      '<video poster="javascript:alert(1)"></video>',
      '<table background="javascript:alert(1)"><tr><td>x</td></tr></table>'
    ]) {
      const out = sanitizeRichText(markup);
      expect(out, markup).not.toContain("javascript:");
      for (const attribute of ["action=", "formaction=", "data=", "poster=", "background="]) {
        expect(out, `${markup} kept ${attribute}`).not.toContain(attribute);
      }
    }
  });

  it("does not let an iframe or object through", () => {
    const out = sanitizeRichText('<iframe src="https://evil.test"></iframe><object data="x"></object><p>ok</p>');
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("object");
    expect(out).toContain("ok");
  });
});

describe("htmlToText", () => {
  it("reduces markup to readable text for prompts and plain-text email", () => {
    // Used to build AI prompts — markup reaching a model wastes tokens and adds nothing.
    expect(htmlToText("<p>Hello <b>world</b></p>").trim()).toBe("Hello world");
  });
});

describe("htmlToPlainText", () => {
  it("keeps paragraph breaks that htmlToText deliberately flattens", () => {
    expect(htmlToPlainText("<p>First para</p><p>Second para</p>")).toBe("First para\n\nSecond para");
    // The contrast is the point: htmlToText doesn't just lose the break, it runs the two
    // paragraphs together — right for a search index, wrong for prose a model is asked to rewrite
    // without losing its shape.
    expect(htmlToText("<p>First para</p><p>Second para</p>")).toBe("First paraSecond para");
  });

  it("marks list items, numbering ordered lists rather than bulleting them", () => {
    expect(htmlToPlainText("<ul><li>alpha</li><li>beta</li></ul>")).toBe("- alpha\n- beta");
    expect(htmlToPlainText("<ol><li>first</li><li>second</li></ol>")).toBe("1. first\n2. second");
  });

  it("turns <br> into a single newline", () => {
    expect(htmlToPlainText("<p>line one<br>line two</p>")).toBe("line one\nline two");
  });

  it("decodes entities without reanimating markup", () => {
    expect(htmlToPlainText("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe("<script>alert(1)</script>");
  });
});

describe("plainTextToRichText", () => {
  // This is the return leg for AI-generated text, so its input is untrusted by definition.
  it("escapes markup a model emits instead of letting it become live HTML", () => {
    const out = plainTextToRichText("<script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("neutralizes an event handler and a javascript: URL", () => {
    const out = plainTextToRichText('<img src=x onerror="alert(1)"> and <a href="javascript:alert(1)">click</a>');
    // The strings survive as VISIBLE TEXT — that's the point, the author can see what the model
    // produced. What must not survive is any of it being markup: no live tag, so no attribute
    // (and therefore no onerror, no javascript: href) can exist to fire.
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&lt;a href=");
    expect(out.replace(/<\/?p>|<br \/>/g, "")).not.toMatch(/<[a-z]/i);
  });

  it("builds paragraphs and lists the rich-text editor understands", () => {
    expect(plainTextToRichText("Para one\n\nPara two")).toBe("<p>Para one</p><p>Para two</p>");
    expect(plainTextToRichText("- alpha\n- beta")).toBe("<ul><li>alpha</li><li>beta</li></ul>");
    expect(plainTextToRichText("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
    expect(plainTextToRichText("Intro\n\n- alpha\n\nOutro")).toBe("<p>Intro</p><ul><li>alpha</li></ul><p>Outro</p>");
  });

  it("keeps single newlines inside a paragraph as line breaks", () => {
    expect(plainTextToRichText("line one\nline two")).toBe("<p>line one<br />line two</p>");
  });

  it("round-trips editor content without inventing or losing structure", () => {
    const original = "<p>Fixed the login bug</p><ul><li>WEB-12</li><li>3.5 hours</li></ul>";
    expect(plainTextToRichText(htmlToPlainText(original))).toBe(original);
  });

  it("returns empty for empty or whitespace-only text", () => {
    expect(plainTextToRichText("")).toBe("");
    expect(plainTextToRichText("   \n  ")).toBe("");
  });
});
