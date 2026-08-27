import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "strong", "em", "u", "s", "code", "pre",
  "blockquote",
  // h4-h6 alongside h1-h3: model-authored answers and generated PRD/BRD sections nest deeper than
  // three levels, and a stripped <h4> silently collapsed a sub-heading into body text.
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  // `del` for ~~strikethrough~~, sup/sub for footnote markers and units — all GFM-reachable, none
  // able to carry behaviour.
  "del", "sup", "sub",
  "a", "span", "div",
  // Tables, for model-authored markdown (Ask AI answers render comparisons as GFM tables through
  // marked). Harmless to the rich-text surfaces sharing this list — the editor never emits them —
  // and without these DOMPurify silently flattened every table into one run of words.
  "table", "thead", "tbody", "tr", "th", "td"
];

// `class` is allowed ONLY so the renderer's own wrapper markup (code-block chrome, callouts)
// survives sanitisation. It cannot carry behaviour, and this app's CSS has no class that grants
// any — the style allow-list below is what actually stops CSS-based UI redress.
const ALLOWED_ATTR = ["href", "rel", "target", "style", "class"];

/**
 * The ONLY CSS this renderer will honour, mirroring `allowedStyles` in
 * apps/api/src/utils/sanitize.ts — which permits `text-align` and nothing else, because
 * `text-align` is the only style the editor's TextAlign extension actually emits.
 *
 * WHY A `style` ALLOW-LIST AND NOT JUST "style is harmless, it cannot run script":
 * CSS does not need to run script to be an attack here. `position:fixed;inset:0;z-index:9999`
 * inside a ticket comment — a field any colleague can write and every colleague renders — floats
 * an invisible layer over the whole application, and the click it captures lands on whatever is
 * underneath. That is UI redress, and this app's approve/reject/decide controls are exactly the
 * one-click irreversible targets it is worth aiming at. The nginx `frame-ancestors 'none'` closes
 * the same attack from OUTSIDE the origin; this closes it from inside a rendered field.
 *
 * WHY IT HAD TO CHANGE HERE SPECIFICALLY, when the server was already strict: the server's
 * `sanitizeRichText` only runs on values that were SAVED through it. Two of this function's
 * callers render content that never passes through it at all — `ui/ai-markdown.tsx` renders
 * `marked.parse()` over MODEL output, and `pages/WhatsNew.tsx` renders release-note markdown
 * fetched from a REMOTE GitHub API. For those, this is not defence in depth; it is the only
 * sanitizer there is.
 */
const ALLOWED_STYLE_PROPERTIES = new Set(["text-align"]);
const ALLOWED_TEXT_ALIGN = new Set(["left", "right", "center", "justify"]);

/**
 * Registered once at module load, not per call: `addHook` appends, so hooking inside `safeHtml`
 * would stack a new copy of these on every render and turn a busy list into a leak.
 */
let hooksRegistered = false;

/**
 * Rebuilds a `style` attribute out of ONLY the declarations above, and returns "" when nothing
 * survives. Built from an allow-list rather than by removing known-bad properties, because a
 * denylist cannot be outflanked only by properties somebody already thought of.
 */
function filterStyleAttribute(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    if (property === "text-align" && !ALLOWED_TEXT_ALIGN.has(value)) continue;
    kept.push(`${property}: ${value}`);
  }
  return kept.join("; ");
}

function registerHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;

    const style = node.getAttribute("style");
    if (style !== null) {
      const filtered = filterStyleAttribute(style);
      if (filtered) node.setAttribute("style", filtered);
      else node.removeAttribute("style");
    }

    // Any link that opens a new context gets the full `rel`, matching the server's
    // `transformTags` for anchors. `noopener` severs `window.opener` (reverse tabnabbing — the
    // opened page rewriting this one's location to a credential-phishing copy); `noreferrer`
    // additionally withholds the Referer, which matters because this app's `/uploads` URLs are
    // signed capabilities and a leaked one IS read access to the file.
    if (node.tagName === "A" && node.hasAttribute("target")) {
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

/**
 * Defense-in-depth: even though the server sanitizes on save, we re-sanitize on render.
 * Returns a value safe to pass to React's `dangerouslySetInnerHTML`.
 */
export function safeHtml(html: string | null | undefined): { __html: string } {
  registerHooks();
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
