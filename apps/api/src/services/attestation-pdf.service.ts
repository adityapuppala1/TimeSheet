/**
 * WHAT: renders a Verified Work Attestation to PDF.
 *
 * WHY it's its own service rather than living in the controller: this is the artifact a customer
 * may hand to their own client or produce in a billing dispute, so it earns real layout code —
 * and `attestation.controller.ts` is a routing file, not a typesetting one.
 *
 * WHY the layout rules below matter (they fix real defects in the first version):
 *  - **Page breaks.** The original drew one continuous flow with no `doc.y` guards, so any
 *    attestation longer than a page silently clipped. Every section and row now checks remaining
 *    space, and the work table redraws its header after a break.
 *  - **Real columns.** The original indented entries with literal spaces, which drifts as soon as
 *    a name or date is a different width. Fixed x-positions, like the timesheet report.
 *  - **Actual bold.** No PDF in this repo had ever called `doc.font()` — hierarchy came only from
 *    size and colour, which reads as washed-out on print. Headings are Helvetica-Bold now.
 *  - **Grouped money.** `toFixed(2)` alone prints "1234567.00"; thousands separators are the
 *    difference between a document that looks issued and one that looks dumped.
 *
 * House style is shared with the ticket security report and the timesheet export: A4, 36pt
 * margins, `#0F9AA8` brand, `#0F172A` headings, `#64748B` meta, `#E2E8F0` rules, `#94A3B8` footer.
 */
import type { AttestationPayload } from "./attestation.service.js";

const BRAND = "#0F9AA8";
const INK = "#0F172A";
const MUTED = "#64748B";
const RULE = "#E2E8F0";
const RULE_LIGHT = "#F1F5F9";
const FOOTER = "#94A3B8";
const DANGER = "#DC2626";
const SUCCESS = "#16A34A";

/** Page geometry — A4 at 36pt margins. `RIGHT` is where rules stop; `WIDTH` is usable text width. */
const LEFT = 36;
const RIGHT = 560;
const WIDTH = RIGHT - LEFT;
/** Start a new page past this y. A4 is 842pt tall; 36pt bottom margin plus footer room. */
const PAGE_BREAK_Y = 720;

const BOLD = "Helvetica-Bold";
const REGULAR = "Helvetica";

function money(value: number, currency: string): string {
  // Intl gives thousands separators; the currency code is appended rather than symbolised because
  // an attestation may be issued in a currency whose symbol is ambiguous across locales.
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

function rule(doc: PDFKit.PDFDocument, color = RULE, lineWidth = 0.5) {
  doc.strokeColor(color).lineWidth(lineWidth).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
}

/** Page break helper — returns true if a break happened, so callers can redraw table headers. */
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

export function renderAttestationPdf(
  doc: PDFKit.PDFDocument,
  payload: AttestationPayload,
  status: string,
  payloadHash: string
): void {
  const a = payload.attestation;
  const s = payload.summary;
  const currency = a.currency;

  // ---- Header -----------------------------------------------------------------------------
  doc.font(BOLD).fontSize(20).fillColor(BRAND).text("TimeSphere", LEFT, doc.y);
  doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(0.6);
  doc.font(BOLD).fontSize(16).fillColor(INK).text("Verified Work Attestation");
  doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(`Reference ${a.reference}`);
  doc.moveDown(0.5);

  // A withdrawn document must say so unmissably and at the top — a reader who skims past this and
  // relies on the numbers is exactly the failure this feature exists to prevent.
  if (status === "VOID") {
    const boxY = doc.y;
    doc.rect(LEFT, boxY, WIDTH, 30).fillColor("#FEF2F2").fill();
    doc.rect(LEFT, boxY, 3, 30).fillColor(DANGER).fill();
    doc
      .font(BOLD)
      .fontSize(10)
      .fillColor(DANGER)
      .text("VOID — this attestation has been withdrawn and must not be relied upon.", LEFT + 12, boxY + 10, { width: WIDTH - 20 });
    doc.y = boxY + 38;
  }

  // ---- Parties ----------------------------------------------------------------------------
  doc.font(REGULAR).fontSize(10).fillColor(INK);
  const labelled = (label: string, value: string) => {
    doc.font(BOLD).fontSize(9).fillColor(MUTED).text(label, LEFT, doc.y, { continued: true });
    doc.font(REGULAR).fontSize(10).fillColor(INK).text(`  ${value}`);
    doc.moveDown(0.15);
  };
  labelled("Project", `${a.project.code} — ${a.project.name}`);
  if (a.project.clientName) labelled("Client", a.project.clientName);
  labelled("Period", `${a.period.start} to ${a.period.end}`);
  if (a.generatedBy) labelled("Issued by", a.generatedBy);

  // ---- Summary strip ----------------------------------------------------------------------
  sectionHeading(doc, "Summary");
  const stripY = doc.y;
  const cellWidth = WIDTH / 4;
  const cells: Array<[string, string]> = [
    ["Approved entries", String(s.entryCount)],
    ["Total hours", s.totalHours.toFixed(2)],
    ["Amount", money(s.totalAmount, currency)],
    ["Identity verified", `${s.identityVerifiedEntries} / ${s.entryCount}`]
  ];
  cells.forEach(([label, value], i) => {
    const x = LEFT + i * cellWidth;
    doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, stripY, { width: cellWidth - 8 });
    doc.font(BOLD).fontSize(13).fillColor(INK).text(value, x, stripY + 12, { width: cellWidth - 8 });
  });
  doc.y = stripY + 34;
  doc.font(REGULAR).fontSize(9).fillColor(MUTED);
  doc.text(`Billable hours ${s.billableHours.toFixed(2)}    ·    Contributors ${s.contributorCount}`, LEFT, doc.y);
  if (s.unratedHours > 0) {
    doc.fillColor(DANGER).text(`${s.unratedHours.toFixed(2)} hour(s) have no rate on record and are excluded from the amount.`);
  }

  // ---- Work table -------------------------------------------------------------------------
  sectionHeading(doc, "Work");

  const colX = { date: LEFT, person: 120, activity: 250, hours: 400, amount: 455 };
  function drawTableHeader() {
    const y = doc.y;
    doc.font(BOLD).fontSize(8).fillColor(MUTED);
    doc.text("DATE", colX.date, y);
    doc.text("PERSON", colX.person, y);
    doc.text("ACTIVITY", colX.activity, y);
    doc.text("HOURS", colX.hours, y);
    doc.text("AMOUNT", colX.amount, y);
    doc.y = y + 12;
    rule(doc);
    doc.moveDown(0.25);
  }

  if (payload.workItems.length === 0) {
    doc.font(REGULAR).fontSize(10).fillColor(MUTED).text("No approved work was recorded in this period.", LEFT, doc.y, {
      width: WIDTH,
      align: "center"
    });
  }

  for (const item of payload.workItems) {
    // Keep a ticket's heading with at least its first row rather than orphaning it at a page foot.
    if (breakIfNeeded(doc, PAGE_BREAK_Y - 60)) doc.moveDown(0.2);

    doc.font(BOLD).fontSize(10).fillColor(INK);
    doc.text(truncate(`${item.ticketKey ? `${item.ticketKey}  ` : ""}${item.ticketTitle}`, 68), LEFT, doc.y, { width: WIDTH - 130 });
    const headY = doc.y - doc.currentLineHeight();
    doc.font(REGULAR).fontSize(9).fillColor(MUTED);
    doc.text(`${item.hours.toFixed(2)}h`, colX.hours, headY, { width: 50 });
    doc.text(money(item.amount, currency), colX.amount, headY, { width: RIGHT - colX.amount });
    doc.moveDown(0.3);

    if (item.entries.length > 0) {
      drawTableHeader();
      doc.font(REGULAR).fontSize(8.5).fillColor(INK);
      for (const entry of item.entries) {
        if (breakIfNeeded(doc, PAGE_BREAK_Y)) drawTableHeader();
        const rowY = doc.y;
        doc.fillColor(INK).text(entry.workDate, colX.date, rowY, { width: colX.person - colX.date - 6 });
        doc.text(truncate(entry.person, 22), colX.person, rowY, { width: colX.activity - colX.person - 6 });
        doc.text(truncate(entry.activityType, 20), colX.activity, rowY, { width: colX.hours - colX.activity - 6 });
        doc.text(entry.hours.toFixed(2), colX.hours, rowY, { width: 45 });
        doc.text(entry.amount != null ? money(entry.amount, currency) : "—", colX.amount, rowY, { width: RIGHT - colX.amount });

        if (entry.identityVerified) {
          doc.font(BOLD).fontSize(7).fillColor(SUCCESS).text("IDENTITY VERIFIED", colX.person, rowY + 11);
          doc.font(REGULAR).fontSize(8.5).fillColor(INK);
          doc.y = rowY + 22;
        } else {
          doc.y = rowY + 13;
        }
        rule(doc, RULE_LIGHT, 0.4);
        doc.moveDown(0.15);
      }
    }
    doc.moveDown(0.4);
  }

  // ---- Approvals --------------------------------------------------------------------------
  if (payload.approvals.length > 0) {
    sectionHeading(doc, "Approvals");
    doc.font(REGULAR).fontSize(9);
    for (const ap of payload.approvals) {
      breakIfNeeded(doc);
      const y = doc.y;
      doc.fillColor(INK).text(truncate(ap.approver, 40), LEFT, y);
      doc.fillColor(MUTED).text(`${ap.entries} entr${ap.entries === 1 ? "y" : "ies"}`, 250, y);
      if (ap.identityVerified) doc.fillColor(SUCCESS).text("identity verified at approval", 360, y);
      doc.y = y + 14;
    }
  }

  // ---- Contributors -----------------------------------------------------------------------
  if (payload.contributors.length > 0) {
    sectionHeading(doc, "Contributors");
    doc.font(REGULAR).fontSize(9);
    for (const c of payload.contributors) {
      breakIfNeeded(doc);
      const y = doc.y;
      doc.fillColor(INK).text(truncate(c.name, 40), LEFT, y);
      doc.fillColor(MUTED).text(`${c.hours.toFixed(2)}h across ${c.entries} entr${c.entries === 1 ? "y" : "ies"}`, 250, y);
      doc.text(`${c.identityVerifiedEntries}/${c.entries} verified`, 430, y);
      doc.y = y + 14;
    }
  }

  // ---- Notes ------------------------------------------------------------------------------
  // Caveats are printed, never omitted: an artifact that hides what it does NOT cover is worse
  // than useless in the dispute it exists to settle.
  if (payload.caveats.length > 0) {
    sectionHeading(doc, "Notes");
    doc.font(REGULAR).fontSize(8).fillColor(MUTED);
    for (const caveat of payload.caveats) {
      breakIfNeeded(doc);
      doc.text(`•  ${caveat}`, LEFT, doc.y, { width: WIDTH });
      doc.moveDown(0.3);
    }
  }

  // ---- Footer on every page ---------------------------------------------------------------
  // Written after all content so the page count is final. `bufferedPageRange` covers pages added
  // by the break logic above, which is why the document is created with `bufferPages: true`.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(REGULAR).fontSize(7).fillColor(FOOTER);
    doc.text(`${a.reference}  ·  integrity SHA-256 ${payloadHash.slice(0, 32)}…`, LEFT, 790, { width: WIDTH - 80, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, RIGHT - 80, 790, { width: 80, align: "right", lineBreak: false });
  }
}
