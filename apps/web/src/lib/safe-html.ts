import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "strong", "em", "u", "s", "code", "pre",
  "blockquote",
  "h1", "h2", "h3",
  "ul", "ol", "li",
  "a", "span",
  // Tables, for model-authored markdown (Ask AI answers render comparisons as GFM tables through
  // marked). Harmless to the rich-text surfaces sharing this list — the editor never emits them —
  // and without these DOMPurify silently flattened every table into one run of words.
  "table", "thead", "tbody", "tr", "th", "td"
];

const ALLOWED_ATTR = ["href", "rel", "target", "style"];

/**
 * Defense-in-depth: even though the server sanitizes on save, we re-sanitize on render.
 * Returns a value safe to pass to React's `dangerouslySetInnerHTML`.
 */
export function safeHtml(html: string | null | undefined): { __html: string } {
  const clean = DOMPurify.sanitize(html ?? "", {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_ATTR: ["onerror", "onload", "onclick"],
    ALLOW_DATA_ATTR: false
  });
  return { __html: clean };
}

/**
 * Tag matcher for the plain-text helpers below. `[^<>]` rather than `[^>]` on purpose: with `[^>]`
 * an input carrying many `<` and no `>` — a paste of generics, a comparison chain, half-typed
 * markup — is rescanned from every `<`, which is quadratic and measured ~100ms on a 20k value. It
 * also stops one stray `<` swallowing everything up to the next `>`, which is what silently ate
 * real text out of a length count.
 */
const TAG_RE = /<[^<>]+>/g;

/**
 * The visible text of a rich-text value, with tags removed.
 *
 * Exists once, in one place, because five call sites had grown their own copy of this regex — and
 * a rule that only some copies enforce is the recurring shape of bugs in this codebase.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  return (html ?? "").replace(TAG_RE, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * How much a person actually typed, ignoring markup.
 *
 * The number every "did you write enough?" validation in the app should compare against: an empty
 * paragraph the editor emits as `<p></p>` counts as 0, not 7.
 */
export function plainTextLength(html: string | null | undefined): number {
  return htmlToPlainText(html).length;
}
