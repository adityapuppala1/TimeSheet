/**
 * WHAT: renders a generated RequirementsDocument to PDF — the artifact someone hands to a
 * stakeholder or attaches to a project kickoff. Cover page, table of contents with real page
 * numbers, numbered sections, tables, colour-coded priorities, a diagonal TimeSphere watermark on
 * every page, and running headers/footers.
 *
 * House style shared with security-report-pdf.service.ts and the timesheet/attestation exports:
 * A4, #0F9AA8 brand, #0F172A ink, Helvetica only — copied here rather than imported, since that
 * file's helpers are module-local.
 *
 * ── THE ARCHITECTURE DIAGRAM ────────────────────────────────────────────────────────────────
 * PDFKit cannot render Mermaid, and pulling a headless browser into the API for one diagram is a
 * ~300MB dependency for a picture. But the BROWSER already renders it — the document view has a
 * live Mermaid diagram on screen. So the export route accepts an optional PNG that the frontend
 * rasterises from that already-rendered SVG, and embeds it. When it's absent (a direct API call, or
 * a diagram Mermaid could not parse) this falls back to the previous behaviour: the Mermaid source
 * in a monospaced block. Never a blank space.
 *
 * ── EVERY POST-RELEASE SECTION IS OPTIONAL ──────────────────────────────────────────────────
 * Documents generated before the industry-standard sections existed have a `sections` JSON without
 * those keys. Every one of them is guarded and simply omitted — including from the contents page —
 * rather than rendering an empty heading or throwing.
 */
import type { RequirementsDocSections } from "./ai.service.js";

const BRAND = "#0F9AA8";
const BRAND_DARK = "#0B7683";
const INK = "#0F172A";
const MUTED = "#64748B";
const RULE = "#E2E8F0";
const FOOTER = "#94A3B8";
const ZEBRA = "#F8FAFC";
const WATERMARK = "#0F9AA8";

/** Priority pill fills — the app's own semantic palette, so a CRITICAL row reads the same here as
 *  it does on screen. */
const PRIORITY_COLOR: Record<string, string> = {
  CRITICAL: "#DC2626",
  HIGH: "#EA580C",
  MEDIUM: "#0F9AA8",
  LOW: "#64748B"
};

const DOC_TYPE_SUBTITLE: Record<string, string> = {
  PRD: "Product Requirements Document",
  BRD: "Business Requirements Document",
  BOTH: "Product & Business Requirements Document"
};

const LEFT = 48;
const RIGHT = 548;
const WIDTH = RIGHT - LEFT;
const TOP = 64;
const PAGE_BREAK_Y = 730;

const BOLD = "Helvetica-Bold";
const REGULAR = "Helvetica";
const MONO = "Courier";

/** Where each numbered section landed, filled in as we render and replayed onto the reserved
 *  contents page at the end — PDFKit can only know a page number after the content is on it. */
interface TocEntry {
  number: string;
  label: string;
  page: number;
}

export interface RequirementsPdfInput {
  title: string;
  docType: string;
  createdAt: Date;
  sections: RequirementsDocSections;
  /** Base64 PNG of the already-rendered Mermaid diagram, supplied by the browser. See the header. */
  diagramPng?: string | null;
  /** Shown on the cover's document-control block. */
  preparedBy?: string | null;
  status?: string | null;
}

/** "12 %" / "12" / "—" — a metric with no target is a real state, not a zero. */
function formatTarget(value: number | undefined, unit: string | undefined): string {
  if (value == null) return "—";
  return unit ? `${value} ${unit}` : String(value);
}

function rule(doc: PDFKit.PDFDocument, color = RULE, lineWidth = 0.5) {
  doc.strokeColor(color).lineWidth(lineWidth).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
}

function breakIfNeeded(doc: PDFKit.PDFDocument, threshold = PAGE_BREAK_Y): boolean {
  if (doc.y > threshold) {
    doc.addPage();
    doc.y = TOP;
    return true;
  }
  return false;
}

function paragraph(doc: PDFKit.PDFDocument, text: string) {
  breakIfNeeded(doc);
  doc.font(REGULAR).fontSize(10).fillColor(INK).text(text || "—", LEFT, doc.y, { width: WIDTH, align: "left" });
  doc.moveDown(0.5);
}

function bulletList(doc: PDFKit.PDFDocument, items: string[] | undefined) {
  if (!items || items.length === 0) {
    paragraph(doc, "—");
    return;
  }
  for (const item of items) {
    breakIfNeeded(doc);
    doc.font(REGULAR).fontSize(10).fillColor(BRAND).text("•", LEFT, doc.y, { width: 10, continued: false });
    const bulletY = doc.y;
    doc.y = bulletY - doc.currentLineHeight();
    doc.fillColor(INK).text(item, LEFT + 14, doc.y, { width: WIDTH - 14 });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.3);
}

/** A coloured pill, used for priorities and RACI codes. Returns the width it consumed. */
function pill(doc: PDFKit.PDFDocument, text: string, x: number, y: number, color: string): number {
  doc.font(BOLD).fontSize(7);
  const textWidth = doc.widthOfString(text);
  const w = textWidth + 10;
  doc.roundedRect(x, y - 1, w, 12, 3).fillColor(color).fill();
  doc.fillColor("#FFFFFF").text(text, x + 5, y + 1.5, { width: textWidth, lineBreak: false });
  return w;
}

/**
 * A real table with a header row, zebra striping and page breaks that repeat the header.
 *
 * `widths` are fractions of the content width so callers describe proportion rather than points.
 * Cell heights are measured before drawing so a wrapping cell doesn't overlap the row below — the
 * single hardest thing about hand-rolled PDF tables, and the reason this helper exists at all.
 */
function table(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  widths: number[],
  options: { pillColumn?: number; pillColors?: Record<string, string> } = {}
) {
  if (rows.length === 0) {
    paragraph(doc, "—");
    return;
  }
  const cols = widths.map((fraction) => fraction * WIDTH);
  const padding = 6;

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(LEFT, y, WIDTH, 20).fillColor(BRAND).fill();
    doc.font(BOLD).fontSize(8).fillColor("#FFFFFF");
    let x = LEFT;
    headers.forEach((header, i) => {
      doc.text(header.toUpperCase(), x + padding, y + 6, { width: cols[i] - padding * 2, lineBreak: false });
      x += cols[i];
    });
    doc.y = y + 20;
  };

  breakIfNeeded(doc, PAGE_BREAK_Y - 60);
  drawHeader();

  rows.forEach((row, rowIndex) => {
    doc.font(REGULAR).fontSize(8.5);
    // Measure first: the tallest cell decides the row height, so nothing overlaps.
    const heights = row.map((value, i) => doc.heightOfString(value || "—", { width: cols[i] - padding * 2 }));
    const rowHeight = Math.max(...heights, 12) + padding * 2;

    if (doc.y + rowHeight > PAGE_BREAK_Y) {
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
        doc.font(REGULAR).fontSize(8.5).fillColor(INK).text(value || "—", x + padding, y + padding, { width: cols[i] - padding * 2 });
      }
      x += cols[i];
    });

    doc.strokeColor(RULE).lineWidth(0.4).moveTo(LEFT, y + rowHeight).lineTo(RIGHT, y + rowHeight).stroke();
    doc.y = y + rowHeight;
  });

  doc.moveDown(0.6);
}

/** The Mermaid diagram: the browser-rasterised PNG when we have one, its source otherwise. */
function architectureDiagram(doc: PDFKit.PDFDocument, source: string, png?: string | null) {
  if (png) {
    try {
      const base64 = png.replace(/^data:image\/png;base64,/, "");
      const buffer = Buffer.from(base64, "base64");
      breakIfNeeded(doc, PAGE_BREAK_Y - 200);
      // `fit` preserves aspect ratio inside the box; a tall diagram gets its own page first.
      doc.image(buffer, LEFT, doc.y, { fit: [WIDTH, 320], align: "center" });
      doc.y += 330;
      return;
    } catch {
      // A corrupt/unsupported PNG must not lose the diagram entirely — fall through to the source.
    }
  }
  breakIfNeeded(doc);
  const boxY = doc.y;
  doc.font(MONO).fontSize(8).fillColor(MUTED).text(source || "(no diagram)", LEFT + 8, boxY + 8, { width: WIDTH - 16 });
  const boxHeight = doc.y - boxY + 10;
  doc.rect(LEFT, boxY, WIDTH, boxHeight).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.y = boxY + boxHeight + 12;
}

function coverPage(doc: PDFKit.PDFDocument, input: RequirementsPdfInput) {
  // Brand band across the top — the one piece of full-bleed colour in the document.
  doc.rect(0, 0, 595, 160).fillColor(BRAND).fill();
  doc.font(BOLD).fontSize(11).fillColor("#FFFFFF").text("TIMESPHERE", LEFT, 52, { characterSpacing: 2 });
  doc.font(REGULAR).fontSize(9).fillColor("#D6F2F5").text("Requirements Studio", LEFT, 70);

  doc.font(BOLD).fontSize(30).fillColor(INK).text(input.title, LEFT, 230, { width: WIDTH });

  const typeLabel = input.docType === "BOTH" ? "PRD + BRD" : input.docType;
  const pillY = doc.y + 12;
  pill(doc, typeLabel, LEFT, pillY + 4, BRAND_DARK);
  doc.y = pillY + 28;

  doc.font(REGULAR).fontSize(11).fillColor(MUTED).text(DOC_TYPE_SUBTITLE[input.docType] ?? DOC_TYPE_SUBTITLE.BOTH, LEFT, doc.y, { width: WIDTH });

  // Document control — the block a reader checks before trusting anything above it.
  const controlY = 560;
  doc.strokeColor(RULE).lineWidth(0.5).moveTo(LEFT, controlY).lineTo(RIGHT, controlY).stroke();
  const controls: Array<[string, string]> = [
    ["Version", "1.0"],
    ["Status", input.status ?? "Draft"],
    ["Generated", input.createdAt.toLocaleDateString()],
    ["Prepared by", input.preparedBy ?? "TimeSphere Requirements Studio"],
    ["Classification", "Confidential"]
  ];
  let y = controlY + 16;
  for (const [label, value] of controls) {
    doc.font(BOLD).fontSize(8).fillColor(MUTED).text(label.toUpperCase(), LEFT, y, { width: 120, characterSpacing: 0.5 });
    doc.font(REGULAR).fontSize(10).fillColor(INK).text(value, LEFT + 130, y - 1, { width: WIDTH - 130 });
    y += 22;
  }
}

/**
 * Draws the diagonal watermark, the running header and the page footer on every page.
 *
 * Runs LAST, over the buffered page range, for two reasons: the total page count isn't knowable
 * until the content is laid out, and `save()`/`restore()` around the rotation guarantees the
 * transform can't leak into content that was already drawn.
 */
function decoratePages(doc: PDFKit.PDFDocument, title: string, skipFirst: number) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    if (i >= skipFirst) {
      doc.save();
      doc.rotate(-45, { origin: [297, 420] });
      doc.font(BOLD).fontSize(64).fillColor(WATERMARK).fillOpacity(0.05).text("TimeSphere", 0, 390, { width: 595, align: "center" });
      doc.restore();

      doc.font(REGULAR).fontSize(8).fillColor(FOOTER).text(title, LEFT, 32, { width: WIDTH - 100, lineBreak: false });
      doc.strokeColor(RULE).lineWidth(0.5).moveTo(LEFT, 46).lineTo(RIGHT, 46).stroke();
    }

    doc.font(REGULAR).fontSize(8).fillColor(FOOTER);
    doc.text("TimeSphere · Confidential", LEFT, 792, { width: WIDTH / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, LEFT + WIDTH / 2, 792, { width: WIDTH / 2, align: "right", lineBreak: false });
  }
}

export function renderRequirementsDocPdf(doc: PDFKit.PDFDocument, input: RequirementsPdfInput) {
  const s = input.sections;
  const toc: TocEntry[] = [];
  let sectionNumber = 0;

  /** Opens a numbered section, recording where it landed for the contents page. */
  const heading = (label: string) => {
    breakIfNeeded(doc, PAGE_BREAK_Y - 60);
    sectionNumber += 1;
    const number = String(sectionNumber);
    toc.push({ number, label, page: doc.bufferedPageRange().count });

    doc.moveDown(0.9);
    doc.font(BOLD).fontSize(13).fillColor(BRAND_DARK).text(`${number}.  ${label}`, LEFT, doc.y, { width: WIDTH });
    doc.moveDown(0.25);
    rule(doc, BRAND, 1.2);
    doc.moveDown(0.5);
  };

  coverPage(doc, input);

  // Reserve the contents page now; it's filled in at the end once page numbers are known.
  doc.addPage();
  const tocPageIndex = doc.bufferedPageRange().count - 1;

  doc.addPage();
  doc.y = TOP;

  if (s.executiveSummary?.trim()) {
    heading("Executive summary");
    paragraph(doc, s.executiveSummary);
  }

  heading("Problem");
  paragraph(doc, s.problem);

  heading("Goals");
  paragraph(doc, s.goals);

  heading("Target users");
  paragraph(doc, s.targetUsers);

  if (s.personas?.length) {
    heading("User personas");
    table(
      doc,
      ["Persona", "Role", "Needs", "Pain points"],
      s.personas.map((p) => [p.name, p.role, p.needs, p.painPoints]),
      [0.18, 0.2, 0.31, 0.31]
    );
  }

  if (s.stakeholders?.length) {
    heading("Stakeholders (RACI)");
    table(
      doc,
      ["Name", "Role", "RACI"],
      s.stakeholders.map((st) => [st.name, st.role, st.raci]),
      [0.35, 0.45, 0.2],
      { pillColumn: 2, pillColors: { A: BRAND_DARK, R: BRAND, C: MUTED, I: FOOTER } }
    );
  }

  heading("Scope");
  doc.font(BOLD).fontSize(10).fillColor(INK).text("In scope", LEFT, doc.y);
  doc.moveDown(0.2);
  bulletList(doc, s.scopeIn);
  doc.font(BOLD).fontSize(10).fillColor(INK).text("Out of scope", LEFT, doc.y);
  doc.moveDown(0.2);
  bulletList(doc, s.scopeOut);

  heading("Features");
  table(
    doc,
    ["Feature", "Priority", "Module", "Est.", "Description"],
    s.features.map((f) => [f.title, f.priority, f.moduleName ?? "—", f.estimatedHours ? `${f.estimatedHours}h` : "—", f.description]),
    [0.22, 0.11, 0.15, 0.08, 0.44],
    { pillColumn: 1, pillColors: PRIORITY_COLOR }
  );

  if (s.functionalRequirements?.length) {
    heading("Functional requirements");
    table(
      doc,
      ["ID", "Requirement", "Priority", "Accepted when"],
      s.functionalRequirements.map((fr) => [fr.id, fr.requirement, fr.priority, fr.acceptanceCriteria]),
      [0.09, 0.4, 0.12, 0.39],
      { pillColumn: 2, pillColors: PRIORITY_COLOR }
    );
  }

  heading("Tech stack");
  bulletList(doc, s.techStack);

  heading("Dependencies");
  bulletList(doc, s.dependencies);

  if (s.constraints?.length) {
    heading("Constraints");
    bulletList(doc, s.constraints);
  }

  heading("UI/UX");
  paragraph(doc, s.uiUx);

  heading("Architecture");
  paragraph(doc, s.architecture.description);
  architectureDiagram(doc, s.architecture.diagramMermaid, input.diagramPng);

  heading("Modules");
  table(doc, ["Module", "Description"], s.modules.map((m) => [m.name, m.description]), [0.28, 0.72]);

  heading("Non-functional requirements");
  const nfrRows: string[][] = [
    ["Performance", s.nfr.performance ?? ""],
    ["Security", s.nfr.security ?? ""],
    ["Compliance", s.nfr.compliance ?? ""],
    ["Scalability", s.nfr.scalability ?? ""]
  ].filter((row) => Boolean(row[1]));
  table(doc, ["Attribute", "Requirement"], nfrRows, [0.24, 0.76]);

  heading("Timeline");
  table(
    doc,
    ["Phase", "Milestone", "Description"],
    s.timeline.map((t) => [t.label, t.isMilestone ? "Yes" : "—", t.description]),
    [0.28, 0.14, 0.58]
  );

  heading("Procedures");
  bulletList(doc, s.procedures);

  if (s.costBenefit?.costs?.trim() || s.costBenefit?.benefits?.trim()) {
    heading("Cost & benefit");
    doc.font(BOLD).fontSize(10).fillColor(INK).text("Costs", LEFT, doc.y);
    paragraph(doc, s.costBenefit.costs);
    doc.font(BOLD).fontSize(10).fillColor(INK).text("Benefits", LEFT, doc.y);
    paragraph(doc, s.costBenefit.benefits);
    if (s.costBenefit.notes) paragraph(doc, s.costBenefit.notes);
  }

  heading("Risks");
  bulletList(doc, s.risks);

  heading("Success metrics");
  table(
    doc,
    ["Metric", "Target", "Notes"],
    s.successMetrics.map((m) => [m.title, formatTarget(m.targetValue, m.unit), m.description ?? "—"]),
    [0.34, 0.2, 0.46]
  );

  if (s.openQuestions?.length) {
    heading("Open questions");
    bulletList(doc, s.openQuestions);
  }

  heading("Assumptions");
  bulletList(doc, s.assumptions);

  // ── Contents page, now that every section's page number is known ──────────────────────────
  doc.switchToPage(tocPageIndex);
  doc.y = TOP;
  doc.font(BOLD).fontSize(18).fillColor(INK).text("Contents", LEFT, TOP);
  doc.moveDown(0.4);
  rule(doc, BRAND, 1.2);
  doc.moveDown(0.8);

  for (const entry of toc) {
    const y = doc.y;
    doc.font(REGULAR).fontSize(10).fillColor(INK).text(`${entry.number}.  ${entry.label}`, LEFT, y, { width: WIDTH - 40, lineBreak: false });
    doc.fillColor(MUTED).text(String(entry.page), RIGHT - 30, y, { width: 30, align: "right", lineBreak: false });
    // A dotted leader, so the eye tracks from title to number.
    doc.strokeColor(RULE).lineWidth(0.5).dash(1, { space: 3 }).moveTo(LEFT + doc.widthOfString(`${entry.number}.  ${entry.label}`) + 8, y + 9)
      .lineTo(RIGHT - 36, y + 9)
      .stroke()
      .undash();
    doc.y = y + 18;
  }

  decoratePages(doc, input.title, 1);
}
