import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "strong", "em", "u", "s", "code", "pre",
  "blockquote",
  "h1", "h2", "h3",
  "ul", "ol", "li",
  "a", "span"
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
