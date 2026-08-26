/**
 * WHAT: renders a generated RequirementsDocument to PDF — the artifact someone hands to a
 * stakeholder, or attaches to a project kickoff.
 *
 * House style shared with security-report-pdf.service.ts and the timesheet/attestation exports:
 * A4, 36pt margins, #0F9AA8 brand, #0F172A ink, #64748B muted, #E2E8F0 rules, Helvetica only —
 * copied here rather than imported, since that file's helpers are module-local, not exported.
 *
 * `architecture.diagramMermaid` renders as its own Mermaid SOURCE TEXT in a monospaced block, not
 * a rendered diagram image — PDFKit has no Mermaid renderer, and this codebase has no diagram/
 * image-generation infrastructure to lean on for one. The in-app document viewer renders the real
 * diagram (via the `mermaid` npm package); this PDF is the portable/offline copy.
 */
import type { RequirementsDocSections } from "./ai.service.js";

const BRAND = "#0F9AA8";
const INK = "#0F172A";
const MUTED = "#64748B";
const RULE = "#E2E8F0";
const FOOTER = "#94A3B8";

const LEFT = 36;
const RIGHT = 560;
const WIDTH = RIGHT - LEFT;
const PAGE_BREAK_Y = 720;

const BOLD = "Helvetica-Bold";
const REGULAR = "Helvetica";

function rule(doc: PDFKit.PDFDocument, color = RULE, lineWidth = 0.5) {
  doc.strokeColor(color).lineWidth(lineWidth).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
}

function breakIfNeeded(doc: PDFKit.PDFDocument, threshold = PAGE_BREAK_Y): boolean {
  if (doc.y > threshold) {
    doc.addPage();
    return true;
  }
  return false;
}

function sectionHeading(doc: PDFKit.PDFDocument, label: string) {
  breakIfNeeded(doc, PAGE_BREAK_Y - 40);
  doc.moveDown(0.8);
  doc.font(BOLD).fontSize(12).fillColor(INK).text(label, LEFT, doc.y);
  doc.moveDown(0.3);
  rule(doc);
  doc.moveDown(0.4);
}

function paragraph(doc: PDFKit.PDFDocument, text: string) {
  breakIfNeeded(doc);
  doc.font(REGULAR).fontSize(10).fillColor(INK).text(text || "—", LEFT, doc.y, { width: WIDTH });
  doc.moveDown(0.4);
}

function bulletList(doc: PDFKit.PDFDocument, items: string[]) {
  if (items.length === 0) {
    paragraph(doc, "—");
    return;
  }
  for (const item of items) {
    breakIfNeeded(doc);
    doc.font(REGULAR).fontSize(10).fillColor(INK).text(`•  ${item}`, LEFT, doc.y, { width: WIDTH });
    doc.moveDown(0.15);
  }
  doc.moveDown(0.25);
}

function mermaidBlock(doc: PDFKit.PDFDocument, source: string) {
  breakIfNeeded(doc);
  const boxY = doc.y;
  doc.font("Courier").fontSize(8).fillColor(MUTED).text(source || "(no diagram)", LEFT + 8, boxY + 6, { width: WIDTH - 16 });
  const boxHeight = doc.y - boxY + 8;
  doc.rect(LEFT, boxY, WIDTH, boxHeight).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.y = boxY + boxHeight + 10;
}

export function renderRequirementsDocPdf(doc: PDFKit.PDFDocument, requirementsDoc: { title: string; docType: string; createdAt: Date; sections: RequirementsDocSections }) {
  const s = requirementsDoc.sections;

  doc.font(BOLD).fontSize(18).fillColor(INK).text(requirementsDoc.title, LEFT, LEFT);
  doc
    .font(REGULAR)
    .fontSize(9)
    .fillColor(MUTED)
    .text(`${requirementsDoc.docType} · generated ${requirementsDoc.createdAt.toLocaleDateString()}`, LEFT, doc.y + 2);
  doc.moveDown(0.6);
  rule(doc, BRAND, 1.5);
  doc.moveDown(0.6);

  sectionHeading(doc, "Problem");
  paragraph(doc, s.problem);

  sectionHeading(doc, "Goals");
  paragraph(doc, s.goals);

  sectionHeading(doc, "Target users");
  paragraph(doc, s.targetUsers);

  sectionHeading(doc, "Scope — in");
  bulletList(doc, s.scopeIn);
  sectionHeading(doc, "Scope — out");
  bulletList(doc, s.scopeOut);

  sectionHeading(doc, "Features");
  for (const feature of s.features) {
    breakIfNeeded(doc);
    doc.font(BOLD).fontSize(10).fillColor(INK).text(`${feature.title}  (${feature.priority})`, LEFT, doc.y, { width: WIDTH });
    if (feature.description) {
      doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(feature.description, LEFT, doc.y, { width: WIDTH });
    }
    doc.moveDown(0.3);
  }

  sectionHeading(doc, "Tech stack");
  bulletList(doc, s.techStack);

  sectionHeading(doc, "Dependencies");
  bulletList(doc, s.dependencies);

  sectionHeading(doc, "UI/UX");
  paragraph(doc, s.uiUx);

  sectionHeading(doc, "Architecture");
  paragraph(doc, s.architecture.description);
  mermaidBlock(doc, s.architecture.diagramMermaid);

  sectionHeading(doc, "Modules");
  for (const mod of s.modules) {
    breakIfNeeded(doc);
    doc.font(BOLD).fontSize(10).fillColor(INK).text(mod.name, LEFT, doc.y, { width: WIDTH });
    if (mod.description) doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(mod.description, LEFT, doc.y, { width: WIDTH });
    doc.moveDown(0.3);
  }

  sectionHeading(doc, "Non-functional requirements");
  const nfrLines = [
    s.nfr.performance ? `Performance: ${s.nfr.performance}` : null,
    s.nfr.security ? `Security: ${s.nfr.security}` : null,
    s.nfr.compliance ? `Compliance: ${s.nfr.compliance}` : null,
    s.nfr.scalability ? `Scalability: ${s.nfr.scalability}` : null
  ].filter((v): v is string => Boolean(v));
  bulletList(doc, nfrLines);

  sectionHeading(doc, "Timeline");
  bulletList(doc, s.timeline.map((t) => `${t.isMilestone ? "🎯 " : ""}${t.label} — ${t.description}`));

  sectionHeading(doc, "Procedures");
  bulletList(doc, s.procedures);

  sectionHeading(doc, "Risks");
  bulletList(doc, s.risks);

  sectionHeading(doc, "Success metrics");
  bulletList(
    doc,
    s.successMetrics.map((m) => {
      if (m.targetValue == null) return m.title;
      const unit = m.unit ? ` ${m.unit}` : "";
      return `${m.title} — target ${m.targetValue}${unit}`;
    })
  );

  sectionHeading(doc, "Assumptions");
  bulletList(doc, s.assumptions);

  // Footer, every page — same "Page N of M" convention as the other PDF exports.
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc
      .font(REGULAR)
      .fontSize(8)
      .fillColor(FOOTER)
      .text(`Page ${i + 1} of ${pages.count}`, LEFT, 800, { width: WIDTH, align: "center" });
  }
}
