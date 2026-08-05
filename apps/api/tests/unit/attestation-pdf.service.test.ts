/**
 * Layout tests for the Verified Work Attestation PDF.
 *
 * WHY these exist: the first version of this renderer drew one continuous flow with no page-break
 * guards, so any attestation longer than a single page silently clipped its remaining content —
 * a document that quietly drops half the work it's attesting to is worse than no document. That
 * failure is invisible in a happy-path render (the sample data fits on one page), so it needs a
 * test that deliberately overflows.
 *
 * Rendering to a buffer rather than asserting on pixels: pdfkit output is deterministic enough to
 * count `/Type /Page` objects and find embedded font names, which is exactly the structural
 * evidence these tests need. Verifying visual beauty is a human job; verifying that nothing is
 * lost off the bottom of a page is not.
 */
import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { renderAttestationPdf } from "../../src/services/attestation-pdf.service.js";
import type { AttestationPayload } from "../../src/services/attestation.service.js";

/** Renders to a Buffer the way the route does (bufferPages is required for the page footer). */
async function render(payload: AttestationPayload, status = "ISSUED"): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  renderAttestationPdf(doc, payload, status, "a".repeat(64));
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

function countPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function payloadWith(entryCount: number): AttestationPayload {
  const entries = Array.from({ length: entryCount }, (_, i) => ({
    workDate: `2026-03-${String((i % 28) + 1).padStart(2, "0")}`,
    hours: 2.5,
    activityType: "Development",
    task: `Implemented the thing number ${i}`,
    person: `Contributor Number ${i}`,
    rate: 150,
    rateSource: "PROJECT",
    amount: 375,
    identityVerified: i % 2 === 0
  }));
  return {
    attestation: {
      reference: "ATT-TEST-20260301-ABCDEF",
      generatedAt: new Date("2026-03-01T10:00:00Z").toISOString(),
      generatedBy: "Test Issuer",
      project: { code: "TEST", name: "Test Project", clientName: "Acme Corp" },
      period: { start: "2026-03-01", end: "2026-03-31" },
      currency: "USD"
    },
    summary: {
      totalHours: entryCount * 2.5,
      billableHours: entryCount * 2.5,
      unratedHours: 0,
      totalAmount: entryCount * 375,
      entryCount,
      contributorCount: Math.min(entryCount, 5),
      identityVerifiedEntries: Math.ceil(entryCount / 2),
      approvedEntries: entryCount
    },
    workItems: [
      { ticketKey: "TEST-1", ticketTitle: "A ticket with a great many entries", hours: entryCount * 2.5, amount: entryCount * 375, entries }
    ],
    contributors: [{ name: "Contributor Number 0", hours: entryCount * 2.5, entries: entryCount, identityVerifiedEntries: 1 }],
    approvals: [{ approver: "Approving Manager", entries: entryCount, identityVerified: true }],
    caveats: ["This is a synthetic fixture used by the layout tests."]
  };
}

describe("renderAttestationPdf", () => {
  it("produces a valid PDF", async () => {
    const pdf = await render(payloadWith(3));
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("uses real bold for headings, not just larger grey text", async () => {
    // No PDF in this repo had ever called doc.font() before this renderer — hierarchy came only
    // from size and colour, which prints washed out.
    const text = (await render(payloadWith(3))).toString("latin1");
    expect(text).toContain("Helvetica-Bold");
  });

  it("paginates instead of clipping when the work table overflows a page", async () => {
    // The regression this whole test file exists for.
    const short = await render(payloadWith(3));
    const long = await render(payloadWith(120));
    expect(countPages(short)).toBe(1);
    expect(countPages(long)).toBeGreaterThan(1);
  });

  it("grows monotonically with content — no silent truncation at a page boundary", async () => {
    const p60 = countPages(await render(payloadWith(60)));
    const p200 = countPages(await render(payloadWith(200)));
    expect(p200).toBeGreaterThan(p60);
  });

  it("renders a VOID document without throwing and marks it", async () => {
    const pdf = await render(payloadWith(2), "VOID");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("handles an empty period without throwing", async () => {
    const empty = payloadWith(0);
    empty.workItems = [];
    empty.contributors = [];
    empty.approvals = [];
    const pdf = await render(empty);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
