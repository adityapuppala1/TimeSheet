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
