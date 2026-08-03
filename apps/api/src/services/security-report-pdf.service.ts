/**
 * WHAT: renders a ticket's Security Assessment Report to PDF — the artifact an engineer hands
 * to a security reviewer, or a lead attaches to a release sign-off.
 *
 * WHY it's its own service: same reason as attestation-pdf.service.ts — a document someone may
 * forward outside the team earns real layout code, and ticket.controller.ts is a routing file,
 * not a typesetting one. The first version drew a flat text list: no severity visual hierarchy,
 * no summary a reader could absorb in five seconds, descriptions dropped entirely, and the AI
 * triage columns (verdict, fix suggestion) never printed at all.
 *
 * STRUCTURE (the "universal" security-report shape reviewers expect):
 *   1. Header — brand, ticket, generated-at.
 *   2. Executive summary — the verdict banner (color = the answer), open counts by severity,
 *      latest CI run. A reader who stops after this section still leaves with the truth.
 *   3. Findings by assessment type — severity-chipped rows with location, CWE, tool, status,
 *      the finding's own description, and the AI triage verdict when one exists.
 *   4. Methodology appendix — what each assessment type actually covers, because this document
 *      travels to people who don't know the acronyms.
 *
 * House style shared with attestation-pdf.service.ts and the timesheet export: A4, 36pt
 * margins, #0F9AA8 brand, #0F172A ink, #64748B muted, #E2E8F0 rules, #94A3B8 footer,
 * Helvetica-Bold headings, page-break guards with re-drawn table headers, Page N of M.
 */
import type PDFKit from "pdfkit";
import type { TicketSecurityReport } from "./security-report.service.js";

const BRAND = "#0F9AA8";
const INK = "#0F172A";
const MUTED = "#64748B";
const RULE = "#E2E8F0";
const FOOTER = "#94A3B8";
const DANGER = "#DC2626";
const SUCCESS = "#16A34A";
const AMBER = "#D97706";

const LEFT = 36;
const RIGHT = 560;
const WIDTH = RIGHT - LEFT;
const PAGE_BREAK_Y = 720;

const BOLD = "Helvetica-Bold";
const REGULAR = "Helvetica";

const SEVERITY_COLOR: Record<string, string> = { CRITICAL: DANGER, HIGH: AMBER, MEDIUM: BRAND, LOW: MUTED };

const TYPE_LABEL: Record<string, string> = {
  SAST: "Static analysis (SAST)",
  DAST: "Dynamic analysis (DAST)",
  SSAT: "Secrets scanning (SSAT)",
  SSCT: "Supply-chain testing (SSCT)",
  VAPT: "Penetration test (VAPT)"
};

/** The appendix a non-security reader needs — what each assessment type actually proves. */
const TYPE_EXPLAINER: Record<string, string> = {
  SAST: "Source code scanned for vulnerable patterns without running it — catches injection risks, unsafe APIs and logic flaws at the line level.",
  DAST: "The running application probed from outside, the way an attacker would — catches issues only visible at runtime.",
  SSAT: "Repository and history scanned for committed credentials, tokens and keys.",
  SSCT: "Dependencies checked against known-vulnerable versions and license risks (supply chain).",
  VAPT: "A human-led penetration test — periodic, adversarial, and broader than any automated scan."
};

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

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

/** Filled banner whose COLOR is the answer — red "needs attention", amber "minor items",
 *  green "clean". The one element a reader who never scrolls still absorbs. */
function verdictBanner(doc: PDFKit.PDFDocument, verdict: string) {
  const needsAttention = verdict.startsWith("Needs attention");
  const clean = verdict.startsWith("Clean");
  const color = needsAttention ? DANGER : clean ? SUCCESS : AMBER;
  const bg = needsAttention ? "#FEF2F2" : clean ? "#F0FDF4" : "#FFFBEB";

  const boxY = doc.y;
  doc.rect(LEFT, boxY, WIDTH, 34).fillColor(bg).fill();
  doc.rect(LEFT, boxY, 3, 34).fillColor(color).fill();
  doc.font(BOLD).fontSize(11).fillColor(color).text(verdict, LEFT + 12, boxY + 11, { width: WIDTH - 24, lineBreak: false });
  doc.y = boxY + 42;
}

/** One stat cell of the severity strip. Zero prints muted — "0 CRITICAL" is good news, not noise. */
function severityCell(doc: PDFKit.PDFDocument, x: number, y: number, width: number, label: string, count: number) {
  const active = count > 0;
  doc.font(BOLD).fontSize(16).fillColor(active ? SEVERITY_COLOR[label] ?? INK : "#CBD5E1");
  doc.text(String(count), x, y, { width, align: "center", lineBreak: false });
  doc.font(REGULAR).fontSize(7.5).fillColor(active ? MUTED : "#CBD5E1");
  doc.text(`OPEN ${label}`, x, y + 19, { width, align: "center", lineBreak: false });
}

export function renderSecurityReportPdf(doc: PDFKit.PDFDocument, report: TicketSecurityReport): void {
  // ---- 1. Header --------------------------------------------------------------------------
  doc.font(BOLD).fontSize(20).fillColor(BRAND).text("TimeSphere", LEFT, doc.y);
  doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(`Generated ${report.generatedAt.toLocaleString()}`);
  doc.moveDown(0.6);
  doc.font(BOLD).fontSize(16).fillColor(INK).text("Security Assessment Report");
  doc.font(REGULAR).fontSize(10).fillColor(MUTED).text(`${report.ticket.key} — ${truncate(report.ticket.title, 90)}`);
  doc.moveDown(0.6);

  // ---- 2. Executive summary ---------------------------------------------------------------
  verdictBanner(doc, report.riskVerdict);

  // Severity strip — four fixed cells.
  const stripY = doc.y;
  const cellW = WIDTH / 4;
  (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).forEach((severity, i) => {
    severityCell(doc, LEFT + i * cellW, stripY + 8, cellW, severity, report.openCountBySeverity[severity] ?? 0);
  });
  doc.y = stripY + 40;
  rule(doc);
  doc.moveDown(0.4);

  // Latest CI run — provider, colored status, counts, duration. "none recorded" is a statement
  // about coverage, not an error, and prints as such.
  const run = report.latestTestRun;
  doc.font(BOLD).fontSize(9).fillColor(INK).text("Latest test run:  ", LEFT, doc.y, { continued: true });
  if (run) {
    const statusColor = run.status === "PASSED" ? SUCCESS : run.status === "FAILED" ? DANGER : AMBER;
    doc.font(BOLD).fillColor(statusColor).text(run.status, { continued: true });
    doc.font(REGULAR).fillColor(MUTED).text(
      `   via ${run.provider}` +
        (run.passCount !== null || run.failCount !== null ? `   ${run.passCount ?? 0} passed / ${run.failCount ?? 0} failed` : "") +
        (run.durationMs ? `   in ${Math.round(run.durationMs / 1000)}s` : "") +
        (run.branch ? `   on ${truncate(run.branch, 40)}` : "")
    );
  } else {
    doc.font(REGULAR).fillColor(MUTED).text("none recorded for this ticket");
  }
  doc.moveDown(0.2);

  // ---- 3. Findings by assessment type ------------------------------------------------------
  if (report.findings.length === 0) {
    sectionHeading(doc, "Findings");
    doc.font(REGULAR).fontSize(10).fillColor(MUTED).text("No findings have been ingested for this ticket.", LEFT);
  }

  for (const type of ["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const) {
    const items = report.findingsByType[type];
    if (!items || items.length === 0) continue;

    sectionHeading(doc, `${TYPE_LABEL[type]} — ${items.length} finding${items.length === 1 ? "" : "s"}`);

    for (const finding of items) {
      // Each finding needs ~3-6 lines; break BEFORE starting one so a row never splits.
      breakIfNeeded(doc, PAGE_BREAK_Y - 50);

      const rowY = doc.y;
      // Severity chip column (fixed), then the title taking the rest of the width.
      doc.font(BOLD).fontSize(9).fillColor(SEVERITY_COLOR[finding.severity] ?? INK);
      doc.text(finding.severity, LEFT, rowY, { width: 62, lineBreak: false });
      doc.font(BOLD).fontSize(9.5).fillColor(INK);
      doc.text(truncate(finding.title, 170), LEFT + 66, rowY, { width: WIDTH - 66 - 120 });
      // Right-aligned meta on the first line: tool + non-OPEN status.
      doc.font(REGULAR).fontSize(8).fillColor(MUTED);
      doc.text(
        `${finding.tool}${finding.status !== "OPEN" ? ` · ${finding.status}` : ""}`,
        RIGHT - 120,
        rowY + 1,
        { width: 120, align: "right", lineBreak: false }
      );

      // Location line — file:line, CWE, repository. Only what exists prints.
      const locationParts = [
        finding.filePath ? `${finding.filePath}${finding.lineNumber ? `:${finding.lineNumber}` : ""}` : null,
        finding.cwe ?? null,
        finding.repository ? truncate(finding.repository, 50) : null
      ].filter(Boolean);
      if (locationParts.length > 0) {
        doc.font(REGULAR).fontSize(7.5).fillColor(FOOTER).text(locationParts.join("   ·   "), LEFT + 66, doc.y, { width: WIDTH - 66 });
      }

      // The finding's own words — the first version dropped these entirely, leaving readers a
      // title and nothing to act on.
      if (finding.description) {
        doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text(truncate(finding.description.replace(/\s+/g, " "), 320), LEFT + 66, doc.y + 2, {
          width: WIDTH - 66
        });
      }

      // AI triage, when it ran — clearly labelled as AI, never blended into the tool's output.
      if (finding.aiVerdict) {
        doc.font(BOLD).fontSize(8).fillColor(finding.aiVerdict === "TRUE_POSITIVE" ? DANGER : MUTED);
        doc.text(`AI triage: ${finding.aiVerdict.replace(/_/g, " ").toLowerCase()}`, LEFT + 66, doc.y + 2, {
          width: WIDTH - 66,
          continued: Boolean(finding.aiFixSuggestion)
        });
        if (finding.aiFixSuggestion) {
          doc.font(REGULAR).fillColor(MUTED).text(` — ${truncate(finding.aiFixSuggestion.replace(/\s+/g, " "), 180)}`);
        }
      }

      doc.moveDown(0.55);
      doc.strokeColor("#F1F5F9").lineWidth(0.5).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
      doc.moveDown(0.35);
    }
  }

  // ---- 4. Methodology appendix -------------------------------------------------------------
  sectionHeading(doc, "About the assessment types");
  for (const type of ["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const) {
    breakIfNeeded(doc, PAGE_BREAK_Y - 20);
    doc.font(BOLD).fontSize(8.5).fillColor(INK).text(`${TYPE_LABEL[type]}.  `, LEFT, doc.y, { continued: true });
    doc.font(REGULAR).fillColor(MUTED).text(TYPE_EXPLAINER[type]);
    doc.moveDown(0.25);
  }
  doc.moveDown(0.5);
  doc
    .font(REGULAR)
    .fontSize(7.5)
    .fillColor(FOOTER)
    .text(
      "Ingest-only report: findings reflect whatever CI/security tooling this workspace has connected — this platform never runs a scanner itself. AI triage lines are model-generated aids, not human review.",
      LEFT,
      doc.y,
      { width: WIDTH }
    );

  // ---- Page numbers (bufferPages: true on the document) -------------------------------------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(REGULAR).fontSize(7.5).fillColor(FOOTER);
    doc.text(`${report.ticket.key} · Security Assessment Report`, LEFT, 790, { width: 260, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, RIGHT - 80, 790, { width: 80, align: "right", lineBreak: false });
  }
}
