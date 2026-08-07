/**
 * WHAT: three sanitize-html configurations for three different trust levels of HTML this app
 * stores/renders: `sanitizeRichText` (Tiptap-authored ticket/comment/timesheet content),
 * `htmlToText` (plain-text extraction for CSV exports/search), `sanitizeEmailHtml` (admin-authored
 * transactional email templates, which need a much wider tag/attribute allow-list to render
 * correctly across email clients, including preserving Outlook MSO conditional comments).
 * WHY: one shared allow-list per trust level, rather than each caller inventing its own idea of
 * "safe HTML" — a gap in one place would be a gap everywhere that reuses it.
 * WHO calls this: `sanitizeRichText` — ticket/comment/timesheet controllers before persisting
 * user-authored rich text; `sanitizeEmailHtml` — `template-store.service.ts`/
 * `email-templates.controller.ts` before saving an admin-edited template; `htmlToText` —
 * `ai.service.ts` (building AI prompts from HTML content) and CSV export code.
 * Also holds the `htmlToPlainText`/`plainTextToRichText` pair `refineText` round-trips user prose
 * through — see their own comment block for why they aren't just `htmlToText` with a twist.
 */
import sanitizeHtml from "sanitize-html";

/**
 * Whitelisted tags + attributes for rich-text content (Tiptap output).
 * Aligns with the editor's StarterKit + Underline + Link + TextAlign extensions.
 *
 * Defense-in-depth: clients also re-sanitize on render via DOMPurify.
 */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr",
    "strong", "em", "u", "s", "code", "pre",
    "blockquote",
    "h1", "h2", "h3",
    "ul", "ol", "li",
    "a", "span"
  ],
  allowedAttributes: {
    a: ["href", "rel", "target"],
    "*": ["style"]
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {},
  allowedStyles: {
    "*": {
      "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/]
    }
  },
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        rel: "noopener noreferrer nofollow",
        target: "_blank"
      }
    })
  },
  disallowedTagsMode: "discard"
};

export function sanitizeRichText(input: string | null | undefined): string {
  if (!input) return "";
  return sanitizeHtml(input, RICH_TEXT_OPTIONS).trim();
}

/** Returns a plain-text version of HTML (for CSV exports, search indexes, etc.). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const sanitized = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  return sanitized.replace(/\s+/g, " ").trim();
}

/* ============================================================
 * Rich text <-> plain text, for round-tripping user prose through an LLM.
 * ============================================================
 *
 * `htmlToText` above deliberately flattens ALL whitespace to single spaces, which is right for a
 * CSV cell or a search index and wrong here: a five-paragraph description with two bullet lists
 * would reach the model as one unbroken line, and whatever came back could not preserve a
 * structure it was never shown. These two functions are the pair used by the refine capability —
 * out to plain text keeping paragraph/list boundaries, and back to HTML that has been through the
 * SAME `sanitizeRichText` allow-list every other stored rich-text value goes through.
 */

/** Opening/closing tags that end a line of prose. One combined pattern (not a chain of
 *  `.replace` calls) so the callback sees tags in document order and can keep list state. */
const BLOCK_TAG_RE = /<(\/?)(p|br|div|h[1-6]|blockquote|pre|ul|ol|li)\b[^>]*>/gi;

/** The only entities `sanitizeHtml` can have produced, decoded back. `&amp;` goes last so a
 *  literal "&amp;lt;" the author typed stays "&lt;" instead of being decoded twice into a tag. */
function decodeBasicEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/**
 * HTML -> plain text, preserving paragraph breaks and list markers.
 *
 * Ordered-list items come back as "1." etc. rather than bullets, because a numbered list that
 * silently turns into a bulleted one is a change to what the author wrote — small, but this
 * function exists specifically to feed text the user will be asked to compare against.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";

  const listStack: Array<{ ordered: boolean; index: number }> = [];
  const withBreaks = html.replace(BLOCK_TAG_RE, (_match, closing: string, tag: string) => {
    const name = tag.toLowerCase();
    const isClosing = closing === "/";

    if (name === "ul" || name === "ol") {
      if (isClosing) listStack.pop();
      else listStack.push({ ordered: name === "ol", index: 0 });
      return "\n";
    }
    if (name === "li") {
      if (isClosing) return "";
      const list = listStack.at(-1);
      if (!list) return "\n- ";
      list.index += 1;
      return list.ordered ? `\n${list.index}. ` : "\n- ";
    }
    return "\n";
  });

  // sanitize-html strips the remaining tags but re-encodes text on the way out, so "&lt;" survives
  // as "&lt;" — fine for a CSV cell, wrong here: this text is shown back to the author as "what you
  // wrote", and it is only ever re-inserted into HTML through `plainTextToRichText`, which escapes
  // everything again. `&amp;` is decoded last, so "&amp;lt;" ends up as the literal "&lt;" the user
  // typed rather than being decoded twice into a tag.
  const text = decodeBasicEntities(sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} }));

  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Plain text -> rich-text HTML, for text that came from a model and is therefore UNTRUSTED.
 *
 * Two independent defences, because this output is written into an editor and later stored:
 *   1. every character of the model's text is HTML-escaped, so markup it emits is shown as the
 *      literal characters the user can see rather than parsed — `<script>` reads as "<script>";
 *   2. the assembled HTML still goes through `sanitizeRichText`, so it can only ever contain the
 *      same tags/attributes as any other stored rich text.
 * Neither alone is enough to rely on: (1) could be defeated by a future refactor that assembles
 * markup elsewhere, and (2) is an allow-list that would happily keep a well-formed `<a href>` the
 * model invented.
 */
export function plainTextToRichText(text: string | null | undefined): string {
  if (!text?.trim()) return "";

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(escapeHtmlText).join("<br />")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const tag = listOrdered ? "ol" : "ul";
    const items = listItems.map((item) => `<li>${escapeHtmlText(item)}</li>`).join("");
    blocks.push(`<${tag}>${items}</${tag}>`);
    listItems = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    // One `\s` then a greedy capture, not `\s+(.*)`: the two overlap, which is a needless
    // backtracking path on a long run of spaces. The capture is trimmed below anyway.
    const bullet = /^[-*•]\s(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      // A switch between list kinds closes the previous list rather than mixing markers.
      if (listItems.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push((bullet?.[1] ?? numbered?.[1] ?? "").trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return sanitizeRichText(blocks.join(""));
}

/* ============================================================
 * Email-safe sanitizer for admin-edited transactional templates.
 * ============================================================
 *
 * Threat model: only SUPER_ADMIN can author these. Output flows into
 * an outbound email (no JS execution context). We still strip
 * <script>, on* handlers, javascript:/data: URLs.
 *
 * We *preserve* MSO/Outlook conditional comments so admins can ship
 * pixel-perfect rendering on Outlook desktop (VML buttons etc.). We do
 * this by masking the conditional comments before sanitization and
 * restoring them afterwards — sanitize-html drops all comments by default.
 */

const CONDITIONAL_BLOCKS = [
  // Hidden-from-mso block: <!--[if !mso]><!--> ... <!--<![endif]-->
  /<!--\[if [^>]+\]><!-->[\s\S]*?<!--<!\[endif\]-->/g,
  // Standard mso conditional: <!--[if mso]> ... <![endif]-->
  /<!--\[if [^>]+\]>[\s\S]*?<!\[endif\]-->/g
];

function maskConditionalComments(html: string): { masked: string; map: Map<string, string> } {
  const map = new Map<string, string>();
  let masked = html;
  let counter = 0;
  for (const regex of CONDITIONAL_BLOCKS) {
    masked = masked.replace(regex, (match) => {
      const token = `__TS_COND_${counter++}__`;
      map.set(token, match);
      return token;
    });
  }
  return { masked, map };
}

function restoreConditionalComments(html: string, map: Map<string, string>): string {
  let restored = html;
  for (const [token, value] of map) {
    restored = restored.split(token).join(value);
  }
  return restored;
}

const EMAIL_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "html", "head", "body", "title", "meta", "style",
    "div", "span", "p", "br", "hr", "center", "font",
    "a", "img",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
    "ul", "ol", "li",
    "strong", "em", "b", "i", "u", "s", "small", "sub", "sup",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "code", "pre", "label"
  ],
  allowedAttributes: {
    "*": ["style", "class", "id", "align", "valign", "bgcolor", "width", "height", "border", "role", "lang", "dir", "title"],
    a: ["href", "rel", "target", "title", "name"],
    img: ["src", "alt", "width", "height", "border", "title"],
    table: ["border", "cellpadding", "cellspacing", "width", "align", "bgcolor", "role"],
    td: ["valign", "align", "bgcolor", "width", "height", "colspan", "rowspan"],
    th: ["valign", "align", "bgcolor", "width", "height", "colspan", "rowspan"],
    meta: ["charset", "name", "content", "http-equiv"],
    style: ["type"]
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  allowVulnerableTags: false,
  // Style attribute is intentionally not narrowed: inline CSS is the only
  // reliable way to ship email styling across clients (Outlook/Gmail/Yahoo/iOS).
  // We rely on disallowed tag list to keep <script>/<iframe> etc. out.
  allowedSchemesAppliedToAttributes: ["href", "src"],
  disallowedTagsMode: "discard",
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        rel: attribs.rel ?? "noopener noreferrer",
        target: attribs.target ?? "_blank"
      }
    })
  }
};

export function sanitizeEmailHtml(input: string | null | undefined): string {
  if (!input) return "";
  const { masked, map } = maskConditionalComments(input);
  const sanitized = sanitizeHtml(masked, EMAIL_OPTIONS);
  return restoreConditionalComments(sanitized, map).trim();
}
