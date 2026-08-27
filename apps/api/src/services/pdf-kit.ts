/**
 * WHAT: the house style for every PDF this app produces, in one place — palette, page furniture
 * (watermark, running header, footers), tables, pills, bullet lists, and a small markdown renderer.
 *
 * WHY IT EXISTS: four services rendered PDFs and each had its own copy of the same constants and
 * the same hand-rolled helpers. `requirements-doc-pdf.service.ts` said so out loud — "copied here
 * rather than imported, since that file's helpers are module-local" — and the copies had already
 * drifted: only one drew the watermark, only one had a running header, only one had a table helper
 * that measured row heights before drawing. A customer receiving a timesheet report and a
 * requirements document from the same product got two visibly different documents.
 *
 * WHY IT'S A FACTORY AND NOT BARE FUNCTIONS: the four documents genuinely disagree about geometry.
 * The requirements document is inset (48/548) because it has a cover page and a contents page to
 * balance; the three operational reports are wider (36/560) because they are dense tables and the
 * extra 24pt is a whole column. Passing geometry to every call would be noise, so it's bound once.
 *
 * WHAT'S DELIBERATELY NOT HERE: each document's own structure. Cover pages, section order, which
 * columns a report has and what its totals mean are the documents' business, not the kit's.
 */

/* ------------------------------------ Palette ---------------------------------------------- */

/** `--primary` in apps/web/src/index.css — the same teal the app uses on screen. */
export const BRAND = "#0F9AA8";
export const BRAND_DARK = "#0B7683";
export const BRAND_TINT = "#E6F5F7";
export const INK = "#0F172A";
export const MUTED = "#64748B";
export const RULE = "#E2E8F0";
export const RULE_LIGHT = "#F1F5F9";
export const FOOTER = "#94A3B8";
export const ZEBRA = "#F8FAFC";
export const DANGER = "#DC2626";
export const SUCCESS = "#16A34A";
export const AMBER = "#D97706";

export const BOLD = "Helvetica-Bold";
export const REGULAR = "Helvetica";
export const ITALIC = "Helvetica-Oblique";
export const MONO = "Courier";

/** The app's semantic priority/severity palette, so a CRITICAL row reads the same on paper as on
 *  screen. Shared because three of the four documents rank something. */
export const PRIORITY_COLOR: Record<string, string> = {
  CRITICAL: DANGER,
  HIGH: "#EA580C",
  MEDIUM: BRAND,
  LOW: MUTED
};

/** GitHub-style callout accents, matching `ai-rich-content.tsx` so a callout the model wrote looks
 *  the same in the app and in the exported document. */
const CALLOUT_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  NOTE: { color: BRAND, bg: BRAND_TINT, label: "Note" },
  TIP: { color: SUCCESS, bg: "#F0FDF4", label: "Tip" },
  IMPORTANT: { color: "#7C3AED", bg: "#F5F3FF", label: "Important" },
  WARNING: { color: AMBER, bg: "#FFFBEB", label: "Warning" },
  CAUTION: { color: DANGER, bg: "#FEF2F2", label: "Caution" }
};

/* ------------------------------------ Geometry --------------------------------------------- */

export interface PdfGeometry {
  left: number;
  right: number;
  /** Where content starts on a fresh page. */
  top: number;
  /** Start a new page once `doc.y` has passed this. */
  pageBreakY: number;
  /**
   * The last y a drawn row may still OCCUPY. Distinct from `pageBreakY`, and the distinction is
   * load-bearing: `pageBreakY` is checked BEFORE a block starts, `contentBottom` is checked against
   * the block's measured height. Conflating them is what let a tall row hang past the margin.
   */
  contentBottom: number;
}

/** A4 at 36pt margins — the three operational reports (timesheet, attestation, security). */
export const REPORT_GEOMETRY: PdfGeometry = { left: 36, right: 560, top: 36, pageBreakY: 720, contentBottom: 756 };

/** A4 inset — the requirements document, which has a cover and a contents page. */
export const DOCUMENT_GEOMETRY: PdfGeometry = { left: 48, right: 548, top: 64, pageBreakY: 730, contentBottom: 756 };

export interface TableOptions {
  /** Render this column's value as a coloured pill instead of text. */
  pillColumn?: number;
  pillColors?: Record<string, string>;
  /** Right-align these column indices — numbers read wrong ragged-left. */
  alignRight?: number[];
}

export interface FooterLine {
  left?: string;
  right?: string;
  /** Overrides FOOTER for the right-hand text — used for a caveat that must not read as furniture. */
  rightColor?: string;
}

export interface DecorateOptions {
  /** Diagonal TimeSphere mark. On by default: these documents leave the building. */
  watermark?: boolean;
  /** Running header, drawn with a rule under it. Omitted when absent. */
  headerText?: string;
  /** Leading pages to leave undecorated — a cover page carries its own branding. */
  skipFirst?: number;
  /** Footer content per page. The last line sits on the baseline; earlier lines stack above it. */
  footer?: (page: number, total: number) => FooterLine[];
}

export interface PdfKit {
  geom: PdfGeometry;
  width: number;
  rule(doc: PDFKit.PDFDocument, color?: string, lineWidth?: number): void;
  breakIfNeeded(doc: PDFKit.PDFDocument, threshold?: number): boolean;
  sectionHeading(doc: PDFKit.PDFDocument, label: string, right?: string): void;
  paragraph(doc: PDFKit.PDFDocument, text: string): void;
  bulletList(doc: PDFKit.PDFDocument, items: string[] | undefined): void;
  pill(doc: PDFKit.PDFDocument, text: string, x: number, y: number, color: string): number;
  table(doc: PDFKit.PDFDocument, headers: string[], rows: string[][], widths: number[], options?: TableOptions): void;
  codeBlock(doc: PDFKit.PDFDocument, source: string): void;
  markdown(doc: PDFKit.PDFDocument, source: string | undefined): void;
  decoratePages(doc: PDFKit.PDFDocument, options?: DecorateOptions): void;
}

/* ------------------------------- Markdown block parsing ------------------------------------ */

type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "callout"; type: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" };

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  data: Array<{ label: string; value: number }>;
}

/** The categorical ramp `ai-rich-content.tsx` uses on screen, so a chart in the app and the same
 *  chart in the exported PDF are recognisably the same chart. */
const CHART_FILLS = [BRAND, "#3B82F6", "#10B981", AMBER, DANGER, "#8B5CF6", "#EC4899", "#14B8A6"];

/**
 * Shape-checks a ```chart fence. Mirrors the browser renderer's check deliberately: a spec that
 * would not draw in the app must not draw here either, and one that draws in the app should draw
 * here — a document that disagrees with the screen it was exported from is the bug this whole
 * phase is about.
 */
export function parseChartSpec(raw: string): ChartSpec | null {
  try {
    let parsed: Partial<ChartSpec>;
    try {
      parsed = JSON.parse(raw) as Partial<ChartSpec>;
    } catch {
      // The same bounded doubled-brace repair as the web renderer, and bounded for the same
      // measured reason — the unbounded form is quadratic on adversarial input.
      parsed = JSON.parse(raw.replace(/\{{2,8}[ \t]{0,8}"/g, '{"')) as Partial<ChartSpec>;
    }
    if (parsed.type !== "bar" && parsed.type !== "line" && parsed.type !== "pie") return null;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0 || parsed.data.length > 40) return null;
    const data = parsed.data
      .filter((d) => d && typeof d === "object" && typeof d.label === "string" && Number.isFinite(Number(d.value)))
      .map((d) => ({ label: String(d.label).slice(0, 60), value: Number(d.value) }));
    if (data.length === 0) return null;
    return { type: parsed.type, title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : undefined, data };
  } catch {
    return null;
  }
}

/**
 * `| --- | --- |`, the line that turns the row above it into a table header.
 *
 * A CHARACTER SCAN AND NOT A REGEX, deliberately. The regex this replaces —
 * `/^\s*\|?[\s:|-]+\|[\s:|-]*$/` — was measured at ~3000ms on 60k pipes and ~3100ms on 60k
 * spaces: `\s*` and `[\s:|-]+` both match whitespace, so the engine retried every way of splitting
 * the run between them. This parses a narrative field a model wrote, so that is reachable. The scan
 * is linear, and stricter for free: a real divider must contain a dash, which the regex never asked
 * for.
 */
function isTableDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  for (const ch of trimmed) {
    if (ch !== "|" && ch !== "-" && ch !== ":" && ch !== " " && ch !== "\t") return false;
  }
  return true;
}

// Hoisted so each shape is written once rather than twice — the list scan below needs the same two
// as the block scan, and two copies of a pattern are two things to keep in step.
// Measured on 60k-character adversarial input rather than assumed: 0.10ms, 0.16ms and 0.11ms
// respectively. All three are fully anchored with a bounded prefix, so there is nothing to retry.
// eslint-disable-next-line sonarjs/slow-regex -- measured: 0.10ms on 60k hashes
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
// eslint-disable-next-line sonarjs/slow-regex -- measured: 0.16ms on 60k spaces
const BULLET_RE = /^[-*+]\s+(.*)$/;
// eslint-disable-next-line sonarjs/slow-regex -- measured: 0.11ms on 60k digits
const ORDERED_RE = /^(\d{1,3})[.)]\s+(.*)$/;
const CALLOUT_OPEN = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/** `| a | b |` → `["a", "b"]`. Leading/trailing pipes are optional in GFM. */
function tableCells(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

/**
 * Splits markdown into the handful of block types a spec field actually contains.
 *
 * Deliberately NOT a markdown engine. Anything unrecognised falls through as a paragraph, so a
 * construct nobody anticipated degrades to readable prose instead of blanking a section — which is
 * the failure mode that matters when the document is the deliverable.
 */
export function parseMarkdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    // Fenced code — consume to the closing fence, or to the end if the model never closed it.
    if (/^```/.test(trimmed)) {
      flush();
      const lang = trimmed.slice(3).trim().toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    // A GFM table is only a table if the NEXT line is the divider — otherwise a sentence that
    // happens to contain pipes becomes a one-column table, which looks like a rendering bug.
    if (trimmed.startsWith("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flush();
      const headers = tableCells(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = tableCells(lines[i].trim());
        // Pad or clip to the header width so a ragged row can't shift every cell after it.
        rows.push(Array.from({ length: headers.length }, (_, c) => cells[c] ?? ""));
        i++;
      }
      i--;
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flush();
      const open = CALLOUT_OPEN.exec(trimmed);
      const body: string[] = [];
      if (!open) body.push(trimmed.replace(/^>\s?/, ""));
      i++;
      while (i < lines.length && lines[i].trim().startsWith(">")) body.push(lines[i++].trim().replace(/^>\s?/, ""));
      i--;
      const text = body.join(" ").trim();
      blocks.push(open ? { kind: "callout", type: open[1].toUpperCase(), text } : { kind: "quote", text });
      continue;
    }

    const bullet = BULLET_RE.exec(trimmed);
    const ordered = ORDERED_RE.exec(trimmed);
    if (bullet || ordered) {
      flush();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const b = BULLET_RE.exec(t);
        const o = ORDERED_RE.exec(t);
        if (b && !isOrdered) items.push(b[1]);
        else if (o && isOrdered) items.push(o[2]);
        else if (t && items.length > 0 && !/^[-*+#>|]/.test(t) && !/^\d{1,3}[.)]\s/.test(t)) {
          // A wrapped continuation line belongs to the item above it, not to a new paragraph.
          items[items.length - 1] += ` ${t}`;
        } else break;
        i++;
      }
      i--;
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(trimmed);
  }

  flush();
  return blocks;
}

/* ------------------------------- Markdown inline parsing ----------------------------------- */

interface InlineRun {
  text: string;
  font: string;
}

/**
 * Splits one line into bold/italic/mono runs.
 *
 * Every quantifier is bounded. This renders text a model wrote, and an unbounded lazy group either
 * side of a literal delimiter is the classic quadratic-backtracking shape — the same discipline
 * `ai-rich-content.tsx` follows for the same reason.
 */
export function inlineRuns(line: string): InlineRun[] {
  // `[label](url)` → "label (url)". Dropping the URL loses information the reader may need, and
  // printing the raw brackets looks like a rendering failure.
  const text = line.replace(/\[([^\]\n]{0,200})\]\(([^)\s]{0,400})\)/g, (_m, label: string, url: string) =>
    label && label !== url ? `${label} (${url})` : label || url
  );

  const runs: InlineRun[] = [];
  const token = /\*\*([^*\n]{1,400})\*\*|__([^_\n]{1,400})__|\*([^*\n]{1,400})\*|`([^`\n]{1,400})`/g;
  let cursor = 0;

  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m.index > cursor) runs.push({ text: text.slice(cursor, m.index), font: REGULAR });
    if (m[1] !== undefined || m[2] !== undefined) runs.push({ text: m[1] ?? m[2], font: BOLD });
    else if (m[3] !== undefined) runs.push({ text: m[3], font: ITALIC });
    else runs.push({ text: m[4], font: MONO });
    cursor = m.index + m[0].length;
  }

  if (cursor < text.length) runs.push({ text: text.slice(cursor), font: REGULAR });
  return runs.length > 0 ? runs : [{ text, font: REGULAR }];
}

/** Inline markup stripped rather than styled — for a table cell, where `continued` runs cannot be
 *  used because the cell's own width and clipping have to hold. */
export function stripInline(line: string): string {
  return inlineRuns(line)
    .map((r) => r.text)
    .join("");
}

/** Axis and value labels. Grouped, and trimmed to at most two decimals — an axis reading
 *  "1234567.891" is noise, and one reading "1,234,567.89" is a number. */
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

/* --------------------------------------- The kit -------------------------------------------- */

export function createPdfKit(geom: PdfGeometry): PdfKit {
  const { left: LEFT, right: RIGHT, top: TOP, pageBreakY: BREAK_Y, contentBottom: BOTTOM } = geom;
  const WIDTH = RIGHT - LEFT;

  const rule: PdfKit["rule"] = (doc, color = RULE, lineWidth = 0.5) => {
    doc.strokeColor(color).lineWidth(lineWidth).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
  };

  const breakIfNeeded: PdfKit["breakIfNeeded"] = (doc, threshold = BREAK_Y) => {
    if (doc.y > threshold) {
      doc.addPage();
      doc.y = TOP;
      return true;
    }
    return false;
  };

  const sectionHeading: PdfKit["sectionHeading"] = (doc, label, right) => {
    breakIfNeeded(doc, BREAK_Y - 60);
    doc.moveDown(0.7);
    const y = doc.y;
    doc.font(BOLD).fontSize(11).fillColor(INK).text(label, LEFT, y, { width: WIDTH - 190, lineBreak: false });
    if (right) {
      doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(right, RIGHT - 190, y + 1, { width: 190, align: "right", lineBreak: false });
    }
    doc.y = y + 14;
    rule(doc);
    doc.moveDown(0.3);
  };

  const paragraph: PdfKit["paragraph"] = (doc, text) => {
    breakIfNeeded(doc);
    doc.font(REGULAR).fontSize(10).fillColor(INK).text(text || "—", LEFT, doc.y, { width: WIDTH, align: "left" });
    doc.moveDown(0.5);
  };

  const pill: PdfKit["pill"] = (doc, text, x, y, color) => {
    doc.font(BOLD).fontSize(7);
    const textWidth = doc.widthOfString(text);
    const w = textWidth + 10;
    doc.roundedRect(x, y - 1, w, 12, 3).fillColor(color).fill();
    // NO `width` here. Passing the measured text width — which is what the per-document copies of
    // this helper did — makes PDFKit wrap at the last space even with `lineBreak: false`, because
    // the available width and the required width are equal to within a rounding error. Single-word
    // pills survived it, so it only showed on multi-word ones: "IDENTITY VERIFIED" printed as
    // "IDENTITY" with the rest in white on white below the pill. The rect is already sized to the
    // text, so there is nothing for a width to protect.
    doc.fillColor("#FFFFFF").text(text, x + 5, y + 1.5, { lineBreak: false });
    return w;
  };

  const bulletList: PdfKit["bulletList"] = (doc, items) => {
    if (!items || items.length === 0) {
      paragraph(doc, "—");
      return;
    }
    for (const item of items) {
      breakIfNeeded(doc);
      // Restore the EXACT y rather than subtracting `currentLineHeight()`, which is what the
      // per-document copies of this helper did: `text()` advances by the line height plus the line
      // gap, so subtracting the height alone leaves y a few points low and every bullet floats
      // above its own text. Visible in a rendered page, invisible in the code.
      const markerY = doc.y;
      doc.font(REGULAR).fontSize(10).fillColor(BRAND).text("•", LEFT, markerY, { width: 10, lineBreak: false });
      doc.y = markerY;
      doc.font(REGULAR).fillColor(INK).text(item, LEFT + 14, doc.y, { width: WIDTH - 14 });
      doc.moveDown(0.2);
    }
    doc.moveDown(0.3);
  };

  /**
   * A real table: header band, zebra striping, and page breaks that repeat the header.
   *
   * `widths` are fractions of the content width, so callers describe proportion rather than points
   * and a geometry change cannot silently misalign them. Cell heights are MEASURED before drawing —
   * the single hardest thing about hand-rolled PDF tables and the reason this helper exists.
   */
  const table: PdfKit["table"] = (doc, headers, rows, widths, options = {}) => {
    if (rows.length === 0) {
      paragraph(doc, "—");
      return;
    }
    const cols = widths.map((fraction) => fraction * WIDTH);
    const padding = 6;
    const rightAligned = new Set(options.alignRight ?? []);

    const drawHeader = () => {
      const y = doc.y;
      doc.rect(LEFT, y, WIDTH, 20).fillColor(BRAND).fill();
      doc.font(BOLD).fontSize(8).fillColor("#FFFFFF");
      let x = LEFT;
      headers.forEach((header, i) => {
        doc.text(header.toUpperCase(), x + padding, y + 6, {
          width: cols[i] - padding * 2,
          align: rightAligned.has(i) ? "right" : "left",
          lineBreak: false
        });
        x += cols[i];
      });
      doc.y = y + 20;
    };

    breakIfNeeded(doc, BREAK_Y - 60);
    drawHeader();

    rows.forEach((row, rowIndex) => {
      doc.font(REGULAR).fontSize(8.5);
      const heights = row.map((value, i) => doc.heightOfString(value || "—", { width: cols[i] - padding * 2 }));
      const rowHeight = Math.max(...heights, 12) + padding * 2;

      if (doc.y + rowHeight > BOTTOM) {
        doc.addPage();
        doc.y = TOP;
        drawHeader();
      }

      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(LEFT, y, WIDTH, rowHeight).fillColor(ZEBRA).fill();

      let x = LEFT;
      row.forEach((value, i) => {
        if (options.pillColumn === i && options.pillColors?.[value]) {
          pill(doc, value, x + padding, y + padding + 1, options.pillColors[value]);
        } else {
          doc.font(REGULAR).fontSize(8.5).fillColor(INK).text(value || "—", x + padding, y + padding, {
            width: cols[i] - padding * 2,
            align: rightAligned.has(i) ? "right" : "left"
          });
        }
        x += cols[i];
      });

      doc.strokeColor(RULE).lineWidth(0.4).moveTo(LEFT, y + rowHeight).lineTo(RIGHT, y + rowHeight).stroke();
      doc.y = y + rowHeight;
    });

    doc.moveDown(0.6);
  };

  const codeBlock: PdfKit["codeBlock"] = (doc, source) => {
    breakIfNeeded(doc);
    const boxY = doc.y;
    doc.font(MONO).fontSize(8).fillColor(MUTED).text(source || "—", LEFT + 8, boxY + 8, { width: WIDTH - 16 });
    const boxHeight = doc.y - boxY + 10;
    doc.rect(LEFT, boxY, WIDTH, boxHeight).fillColor(ZEBRA).fill();
    // Re-drawn over the fill: PDFKit paints in call order, so the fill would otherwise hide it.
    doc.font(MONO).fontSize(8).fillColor(MUTED).text(source || "—", LEFT + 8, boxY + 8, { width: WIDTH - 16 });
    doc.rect(LEFT, boxY, WIDTH, boxHeight).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y = boxY + boxHeight + 10;
  };

  /**
   * Draws a ```chart fence as an actual chart, with PDFKit primitives.
   *
   * WHY NOT RASTERISE IT: the same reason the architecture diagram doesn't — a headless browser is
   * a ~300MB dependency for a picture. Unlike Mermaid, a bar/line/pie chart is a handful of
   * rectangles and arcs, so it can simply be drawn. Before this, an export printed the chart's raw
   * JSON in a mono box: the numbers were technically present and completely unreadable.
   */
  function chart(doc: PDFKit.PDFDocument, spec: ChartSpec) {
    const HEIGHT = 150;
    const titleHeight = spec.title ? 16 : 0;
    const total = titleHeight + HEIGHT + 26;

    if (doc.y + total > BOTTOM) {
      doc.addPage();
      doc.y = TOP;
    }
    const top = doc.y;

    if (spec.title) {
      doc.font(BOLD).fontSize(9).fillColor(INK).text(spec.title, LEFT, top, { width: WIDTH, lineBreak: false });
    }
    const plotTop = top + titleHeight;

    if (spec.type === "pie") {
      const totalValue = spec.data.reduce((sum, d) => sum + Math.max(0, d.value), 0);
      const radius = HEIGHT / 2 - 4;
      const cx = LEFT + radius + 8;
      const cy = plotTop + HEIGHT / 2;
      let angle = -Math.PI / 2; // start at 12 o'clock, the way a reader expects a pie to begin

      spec.data.forEach((point, i) => {
        const share = totalValue > 0 ? Math.max(0, point.value) / totalValue : 1 / spec.data.length;
        const sweep = share * Math.PI * 2;
        const x1 = cx + radius * Math.cos(angle);
        const y1 = cy + radius * Math.sin(angle);
        const x2 = cx + radius * Math.cos(angle + sweep);
        const y2 = cy + radius * Math.sin(angle + sweep);
        const largeArc = sweep > Math.PI ? 1 : 0;
        // A full circle has identical start and end points, which an SVG arc renders as nothing —
        // draw the degenerate single-slice case as a plain circle instead.
        if (share >= 0.9999) doc.circle(cx, cy, radius).fillColor(CHART_FILLS[i % CHART_FILLS.length]).fill();
        else {
          doc
            .path(`M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`)
            .fillColor(CHART_FILLS[i % CHART_FILLS.length])
            .fill();
        }
        angle += sweep;
      });

      // Legend — a pie with no legend is decoration.
      let legendY = plotTop + 4;
      const legendX = cx + radius + 20;
      spec.data.slice(0, 8).forEach((point, i) => {
        doc.rect(legendX, legendY + 1, 7, 7).fillColor(CHART_FILLS[i % CHART_FILLS.length]).fill();
        const share = totalValue > 0 ? (Math.max(0, point.value) / totalValue) * 100 : 0;
        doc.font(REGULAR).fontSize(7.5).fillColor(INK);
        doc.text(`${point.label}  ${formatNumber(point.value)} (${share.toFixed(0)}%)`, legendX + 12, legendY, {
          width: RIGHT - legendX - 12,
          lineBreak: false
        });
        legendY += 12;
      });
      doc.y = top + total;
      return;
    }

    // Bar and line share the axes.
    const axisWidth = 34;
    const plotLeft = LEFT + axisWidth;
    const plotWidth = WIDTH - axisWidth;
    const plotBottom = plotTop + HEIGHT - 14; // leave room for the category labels
    const plotHeight = plotBottom - plotTop;

    const values = spec.data.map((d) => d.value);
    const maxValue = Math.max(...values, 0);
    const minValue = Math.min(...values, 0);
    // A flat series (every value equal, including all-zero) has no range to scale against; without
    // this it divides by zero and every bar renders at full height, which reads as a real result.
    const span = maxValue - minValue || 1;
    const yFor = (value: number) => plotBottom - ((value - minValue) / span) * plotHeight;

    // A flat series has no range, so its gridline labels would count DOWN from the value through
    // invented negatives — an axis reading 0, -0.25, -0.5 under a row of all-zero bars states
    // something the data never said. Label the baseline with the one real value instead.
    const flat = maxValue === minValue;
    for (let g = 0; g <= 4; g++) {
      const y = plotTop + (plotHeight / 4) * g;
      doc.strokeColor(RULE).lineWidth(0.4).moveTo(plotLeft, y).lineTo(RIGHT, y).stroke();
      if (flat && g !== 4) continue;
      doc.font(REGULAR).fontSize(6.5).fillColor(MUTED);
      doc.text(formatNumber(flat ? maxValue : maxValue - (span / 4) * g), LEFT, y - 3, {
        width: axisWidth - 6,
        align: "right",
        lineBreak: false
      });
    }

    const slot = plotWidth / spec.data.length;
    if (spec.type === "bar") {
      const barWidth = Math.max(3, Math.min(slot * 0.62, 46));
      spec.data.forEach((point, i) => {
        const x = plotLeft + slot * i + (slot - barWidth) / 2;
        const y = yFor(point.value);
        const zeroY = yFor(0);
        const height = Math.abs(zeroY - y);
        doc.rect(x, Math.min(y, zeroY), barWidth, Math.max(1, height)).fillColor(BRAND).fill();
        doc.font(BOLD).fontSize(6.5).fillColor(INK);
        doc.text(formatNumber(point.value), x - 6, Math.min(y, zeroY) - 8, { width: barWidth + 12, align: "center", lineBreak: false });
      });
    } else {
      doc.strokeColor(BRAND).lineWidth(1.4);
      spec.data.forEach((point, i) => {
        const x = plotLeft + slot * i + slot / 2;
        const y = yFor(point.value);
        if (i === 0) doc.moveTo(x, y);
        else doc.lineTo(x, y);
      });
      doc.stroke();
      spec.data.forEach((point, i) => {
        const x = plotLeft + slot * i + slot / 2;
        doc.circle(x, yFor(point.value), 2).fillColor(BRAND).fill();
      });
    }

    // Category labels. Every other one when they would collide — a row of overlapping labels is
    // less informative than half a row of readable ones.
    doc.font(REGULAR).fontSize(6.5).fillColor(MUTED);
    const step = slot < 26 ? Math.ceil(26 / slot) : 1;
    spec.data.forEach((point, i) => {
      if (i % step !== 0) return;
      doc.text(point.label, plotLeft + slot * i, plotBottom + 5, { width: slot * step, align: "center", lineBreak: false, ellipsis: true });
    });

    doc.y = top + total;
  }

  /** One paragraph of mixed bold/italic/mono runs, chained with `continued` so they flow as one. */
  function inlineParagraph(doc: PDFKit.PDFDocument, text: string, size: number, color: string, indent = 0) {
    breakIfNeeded(doc);
    const runs = inlineRuns(text);
    const x = LEFT + indent;
    const width = WIDTH - indent;
    doc.fontSize(size).fillColor(color);
    runs.forEach((run, i) => {
      const isLast = i === runs.length - 1;
      // Only the first call positions; the rest continue the flow. Passing x/y to a continued run
      // restarts it at that point instead of where the previous run ended.
      if (i === 0) doc.font(run.font).text(run.text, x, doc.y, { width, continued: !isLast });
      else doc.font(run.font).text(run.text, { width, continued: !isLast });
    });
  }

  function calloutBox(doc: PDFKit.PDFDocument, type: string, text: string) {
    const style = CALLOUT_STYLE[type] ?? CALLOUT_STYLE.NOTE;
    doc.font(REGULAR).fontSize(9);
    const bodyHeight = doc.heightOfString(text || style.label, { width: WIDTH - 28 });
    const boxHeight = bodyHeight + 26;

    if (doc.y + boxHeight > BOTTOM) {
      doc.addPage();
      doc.y = TOP;
    }
    const y = doc.y;
    doc.rect(LEFT, y, WIDTH, boxHeight).fillColor(style.bg).fill();
    doc.rect(LEFT, y, 3, boxHeight).fillColor(style.color).fill();
    doc.font(BOLD).fontSize(8).fillColor(style.color).text(style.label.toUpperCase(), LEFT + 14, y + 7, { width: WIDTH - 28, characterSpacing: 0.4 });
    doc.font(REGULAR).fontSize(9).fillColor(INK).text(text, LEFT + 14, y + 19, { width: WIDTH - 28 });
    doc.y = y + boxHeight + 8;
  }

  /** Proportional to the longest cell, clamped so no column can vanish or swallow the table. An
   *  equal split makes a table with one long description column unreadable. */
  function columnWidths(headers: string[], rows: string[][]): number[] {
    const longest = headers.map((header, i) => Math.max(header.length, ...rows.map((r) => (r[i] ?? "").length), 1));
    const total = longest.reduce((sum, n) => sum + n, 0);
    const raw = longest.map((n) => Math.min(0.5, Math.max(0.08, n / total)));
    const scale = raw.reduce((sum, n) => sum + n, 0);
    return raw.map((n) => n / scale);
  }

  /**
   * Renders a markdown string.
   *
   * WHY THIS EXISTS: the requirements generation prompt tells the model its narrative fields may
   * contain markdown, and the document view renders it as such — but the PDF drew those same fields
   * with a plain paragraph call, so a reader who exported the document got `### Heading` and raw
   * `| pipe | tables |` printed literally. The on-screen document and the artifact people actually
   * circulate disagreed about what the content was.
   */
  const markdown: PdfKit["markdown"] = (doc, source) => {
    const text = (source ?? "").trim();
    if (!text) {
      paragraph(doc, "—");
      return;
    }

    for (const block of parseMarkdownBlocks(text)) {
      switch (block.kind) {
        case "heading": {
          breakIfNeeded(doc, BREAK_Y - 40);
          doc.moveDown(block.level <= 2 ? 0.5 : 0.35);
          // Sized to stay UNDER the caller's own section heading — these are subheadings inside a
          // section, and a markdown `#` that outranked the section title would invert the document.
          const size = [11.5, 10.5, 10, 9.5][Math.min(block.level, 4) - 1];
          const color = block.level <= 2 ? BRAND_DARK : INK;
          doc.font(BOLD).fontSize(size).fillColor(color).text(stripInline(block.text), LEFT, doc.y, { width: WIDTH });
          doc.moveDown(0.25);
          break;
        }
        case "paragraph":
          inlineParagraph(doc, block.text, 10, INK);
          doc.moveDown(0.45);
          break;
        case "list":
          for (const [index, item] of block.items.entries()) {
            breakIfNeeded(doc);
            const marker = block.ordered ? `${index + 1}.` : "•";
            // See `bulletList` — restore the exact y; `currentLineHeight()` under-counts the gap.
            const markerY = doc.y;
            doc.font(block.ordered ? REGULAR : BOLD).fontSize(10).fillColor(BRAND);
            doc.text(marker, LEFT + 2, markerY, { width: 16, lineBreak: false });
            doc.y = markerY;
            inlineParagraph(doc, item, 10, INK, 20);
            doc.moveDown(0.15);
          }
          doc.moveDown(0.35);
          break;
        case "table":
          table(
            doc,
            block.headers.map(stripInline),
            block.rows.map((row) => row.map(stripInline)),
            columnWidths(block.headers, block.rows)
          );
          break;
        case "callout":
          calloutBox(doc, block.type, stripInline(block.text));
          break;
        case "quote": {
          breakIfNeeded(doc);
          const y = doc.y;
          doc.font(ITALIC).fontSize(9.5).fillColor(MUTED).text(stripInline(block.text), LEFT + 14, y, { width: WIDTH - 14 });
          doc.rect(LEFT, y - 1, 2.5, doc.y - y + 2).fillColor(RULE).fill();
          doc.moveDown(0.5);
          break;
        }
        case "code": {
          // A ```chart fence draws; a ```mermaid fence cannot (no renderer in the API — see the
          // requirements PDF's header for why a headless browser is not worth it) and keeps its
          // source, which at least says what the diagram was.
          const spec = block.lang === "chart" ? parseChartSpec(block.text) : null;
          if (spec) chart(doc, spec);
          else codeBlock(doc, block.text);
          break;
        }
        case "rule":
          doc.moveDown(0.4);
          rule(doc);
          doc.moveDown(0.4);
          break;
      }
    }
  };

  /**
   * Draws the watermark, running header and footers over every buffered page.
   *
   * Runs LAST for two reasons: the total page count is not knowable until the content is laid out,
   * and `save()`/`restore()` around the rotation guarantees the transform cannot leak into content
   * that was already drawn. The caller must create the document with `bufferPages: true`.
   */
  const decoratePages: PdfKit["decoratePages"] = (doc, options = {}) => {
    const { watermark = true, headerText, skipFirst = 0, footer } = options;
    const range = doc.bufferedPageRange();

    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);

      if (i >= skipFirst) {
        if (watermark) {
          doc.save();
          doc.rotate(-45, { origin: [297, 420] });
          doc.font(BOLD).fontSize(64).fillColor(BRAND).fillOpacity(0.05).text("TimeSphere", 0, 390, { width: 595, align: "center" });
          doc.restore();
        }
        if (headerText) {
          // Sits at 16/28, not 24/38: the three operational reports start their content at the 36pt
          // margin, and a rule at 38 crossed the first line of it. 8pt of clearance, and the inset
          // requirements document (content from 64) has room to spare either way.
          doc.font(REGULAR).fontSize(8).fillColor(FOOTER).text(headerText, LEFT, 16, { width: WIDTH - 100, lineBreak: false });
          doc.strokeColor(RULE).lineWidth(0.5).moveTo(LEFT, 28).lineTo(RIGHT, 28).stroke();
        }
      }

      const lines = footer?.(i + 1, range.count) ?? [];
      // Stacked upward from the baseline so a one-line footer and a two-line footer both sit at the
      // same bottom edge — otherwise two documents in the same pack have footers at different heights.
      lines.forEach((line, index) => {
        const y = 792 - (lines.length - 1 - index) * 10;
        doc.font(REGULAR).fontSize(7).fillColor(FOOTER);
        if (line.left) doc.text(line.left, LEFT, y, { width: WIDTH - 90, lineBreak: false });
        if (line.right) {
          doc.fillColor(line.rightColor ?? FOOTER).text(line.right, RIGHT - 200, y, { width: 200, align: "right", lineBreak: false });
        }
      });
    }
  };

  return {
    geom,
    width: WIDTH,
    rule,
    breakIfNeeded,
    sectionHeading,
    paragraph,
    bulletList,
    pill,
    table,
    codeBlock,
    markdown,
    decoratePages
  };
}
