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
import { htmlToText, sanitizeRichText } from "../../src/utils/sanitize.js";

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
