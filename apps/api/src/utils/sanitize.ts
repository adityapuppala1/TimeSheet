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
 * A `<pre>` block, lifted out of the document before the whitespace normalisation below can touch
 * it and parked behind one of these tokens.
 *
 * WHY: the last three `.replace` calls in `htmlToPlainText` collapse runs of spaces and strip the
 * indentation around every newline. That is exactly right for prose and catastrophic for code —
 * a pasted stack trace or snippet came back with its indentation flattened, which is both a
 * change to what the author wrote and the reason a model asked to "tidy this up" would return
 * prose where code had been. The token is deliberately shaped like nothing anyone types: no
 * spaces (so the space-collapsing rules ignore it), no HTML (so `sanitizeHtml` passes it
 * through), and no regex metacharacters in the parts that vary.
 */
const CODE_TOKEN_PREFIX = "⁣TIMESPHERE_CODE_";
const CODE_TOKEN_RE = /⁣TIMESPHERE_CODE_(\d+)⁣/g;
/** `<pre>` with its optional inner `<code>` — Tiptap emits the pair, other sources emit bare
 *  `<pre>`, and both have to round-trip. */
const PRE_BLOCK_RE = /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;

const HEADING_TAG_RE = /^h[1-6]$/;

/** What `htmlToPlainText` has to remember while walking the block tags in document order: which
 *  list it is inside (and how far down it), and whether it is inside a quote. */
interface BlockPassState {
  listStack: Array<{ ordered: boolean; index: number }>;
  quoteDepth: number;
}

/**
 * One block-level tag -> the plain-text marker that stands for it.
 *
 * Headings and quotes carry a marker for the same reason list items always have: this text is
 * shown to the author as "what you wrote" and handed to a model asked to preserve the structure.
 * An unmarked heading is indistinguishable from a short paragraph, so it reliably came back as
 * one. `#` is capped at three because `sanitizeRichText` allows h1–h3 and nothing deeper.
 */
function blockTagToMarkers(name: string, isClosing: boolean, state: BlockPassState): string {
  if (name === "ul" || name === "ol") {
    if (isClosing) state.listStack.pop();
    else state.listStack.push({ ordered: name === "ol", index: 0 });
    return "\n";
  }
  if (name === "li") {
    if (isClosing) return "";
    const list = state.listStack.at(-1);
    if (!list) return "\n- ";
    list.index += 1;
    return list.ordered ? `\n${list.index}. ` : "\n- ";
  }
  if (HEADING_TAG_RE.test(name)) {
    return isClosing ? "\n" : `\n\n${"#".repeat(Math.min(Number(name[1]), 3))} `;
  }
  if (name === "blockquote") {
    state.quoteDepth = isClosing ? Math.max(0, state.quoteDepth - 1) : state.quoteDepth + 1;
    return "\n\n";
  }
  // A quote's text lives in the `<p>`s inside it, so the marker is emitted per paragraph rather
  // than once per quote — otherwise a two-paragraph quote comes back with only its first
  // paragraph quoted.
  if (name === "p" && !isClosing && state.quoteDepth > 0) return "\n> ";
  return "\n";
}

/**
 * HTML -> plain text, preserving paragraph breaks, list markers and code blocks.
 *
 * Ordered-list items come back as "1." etc. rather than bullets, because a numbered list that
 * silently turns into a bulleted one is a change to what the author wrote — small, but this
 * function exists specifically to feed text the user will be asked to compare against.
 *
 * Code blocks come back as ``` fences, which is the notation a language model both recognises on
 * the way in and reproduces on the way out — and which `plainTextToRichText` turns back into a
 * real `<pre><code>` node. Without the pair, every refinement of a description containing a
 * snippet silently demoted the snippet to a paragraph.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";

  // Lifted FIRST, so nothing downstream — neither the block-tag pass nor the whitespace
  // normalisation — can see inside a code block.
  const codeBlocks: string[] = [];
  const withoutCode = html.replace(PRE_BLOCK_RE, (_match, inner: string) => {
    // The inner text is already HTML-escaped in stored content (`&lt;div&gt;` for a typed
    // `<div>`), so stripping tags and then decoding gives back exactly what was typed.
    const code = decodeBasicEntities(
      sanitizeHtml(String(inner).replace(/<\/?code\b[^>]*>/gi, ""), { allowedTags: [], allowedAttributes: {} })
    );
    // `trimEnd()` rather than a `/\s+$/` replace: identical result, no backtracking on a block
    // that ends in a long run of whitespace.
    codeBlocks.push(code.replace(/^\n+/, "").trimEnd());
    return `\n\n${CODE_TOKEN_PREFIX}${codeBlocks.length - 1}⁣\n\n`;
  });

  const state: BlockPassState = { listStack: [], quoteDepth: 0 };
  const withBreaks = withoutCode.replace(BLOCK_TAG_RE, (_match, closing: string, tag: string) =>
    blockTagToMarkers(tag.toLowerCase(), closing === "/", state)
  );

  // sanitize-html strips the remaining tags but re-encodes text on the way out, so "&lt;" survives
  // as "&lt;" — fine for a CSV cell, wrong here: this text is shown back to the author as "what you
  // wrote", and it is only ever re-inserted into HTML through `plainTextToRichText`, which escapes
  // everything again. `&amp;` is decoded last, so "&amp;lt;" ends up as the literal "&lt;" the user
  // typed rather than being decoded twice into a tag.
  const text = decodeBasicEntities(sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} }));

  return text
    // U+00A0 written as an escape, not as the literal character it used to be: a NO-BREAK
    // SPACE inside a character class is invisible in every diff and every review, and one
    // reformat or paste that drops it silently stops &nbsp; from pasted HTML normalising.
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    // Fences go back LAST, after every whitespace rule has run and can no longer reach inside
    // them. A token whose block is missing (impossible unless this function is re-entered on its
    // own output) resolves to an empty fence rather than leaking the token into the user's text.
    .replace(CODE_TOKEN_RE, (_match, index: string) => "```\n" + (codeBlocks[Number(index)] ?? "") + "\n```");
}

/**
 * Escapes text being interpolated into an HTML string this code is building itself.
 *
 * Exported because it is NOT only a `plainTextToRichText` detail: several places assemble a small
 * HTML fragment around model output or third-party text and store it (AI CI-failure triage and
 * finding triage in security-report.service.ts, the AI PR-review summary in
 * git-provider.service.ts). Those had a private copy each, and the one that did not have a copy
 * was the one that shipped raw model output into a stored comment. One implementation, so a new
 * caller has something to reach for besides a template literal.
 *
 * Not a substitute for `sanitizeRichText` — that decides which tags survive in HTML somebody
 * AUTHORED; this makes text that must not be markup at all incapable of being any. Escapes the
 * three characters that matter between tags and deliberately not quotes: every caller
 * interpolates into TEXT position, and quote-escaping would change what
 * `plainTextToRichText` already round-trips through `sanitizeRichText` below.
 */
export function escapeHtmlText(value: string): string {
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
 *
 * Understands the same four notations `htmlToPlainText` emits — ``` fences, `#` headings, `>`
 * quotes and `-`/`1.` lists — so the pair is a round trip rather than a one-way flattening. A
 * fence is the important one: without it, refining a description that contained a snippet handed
 * the snippet back as a paragraph with its indentation gone.
 */
export function plainTextToRichText(text: string | null | undefined): string {
  if (!text?.trim()) return "";

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  /** Non-null while inside a ``` fence. Lines are collected verbatim — no trimming, no list or
   *  heading interpretation — because inside a code block those characters are code. */
  let codeLines: string[] | null = null;

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
  const flushCode = () => {
    if (!codeLines) return;
    // `<pre><code>` — the exact node shape Tiptap's CodeBlock emits, so an accepted suggestion
    // loads back into the editor as a real code block a user can edit, not as inert markup.
    // Trailing blank lines dropped; interior ones and all leading indentation kept. Popped from
    // the array rather than trimmed off the joined string — a `/\n+$/` replace backtracks
    // super-linearly on a block that is nothing but newlines.
    const lines = [...codeLines];
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    const body = lines.join("\n");
    if (body.trim()) blocks.push(`<pre><code>${escapeHtmlText(body)}</code></pre>`);
    codeLines = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // A fence marker toggles the mode and is never itself content. Checked before the blank-line
    // rule so a fence that opens on the first line still registers.
    if (/^\s*```/.test(rawLine)) {
      if (codeLines) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(rawLine);
      continue;
    }

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

    // Capped at h3 because that is where the editor's own toolbar and the sanitizer's allow-list
    // both stop; `####` would otherwise be discarded by `sanitizeRichText` and lose its text.
    const heading = /^(#{1,3})\s(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${escapeHtmlText(heading[2].trim())}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${escapeHtmlText(quote[1].trim())}</p></blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  // An unterminated fence still becomes a code block — the model closing one and not the other is
  // a formatting slip, and throwing the lines away would lose the user's content.
  flushCode();

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
