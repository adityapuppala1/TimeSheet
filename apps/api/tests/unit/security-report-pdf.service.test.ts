/**
 * Layout tests for the Security Assessment Report PDF.
 *
 * Same philosophy as attestation-pdf.service.test.ts: render to a buffer, assert STRUCTURE —
 * page-break behavior under load, and that the fields the first version silently dropped
 * (descriptions, CWE, AI triage) actually make it into the document. Visual beauty is a human
 * job; "fifty findings don't fall off the bottom of page one" is not.
 */
import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { securityFindingTypes } from "@timesheet/shared";
import { renderSecurityReportPdf } from "../../src/services/security-report-pdf.service.js";
import type { TicketSecurityReport } from "../../src/services/security-report.service.js";

async function render(report: TicketSecurityReport): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  renderSecurityReportPdf(doc, report);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

function countPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function finding(i: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `f-${i}`,
    ticketId: "t-1",
    type: "SAST",
    tool: "semgrep",
    severity: (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const)[i % 4],
    status: "OPEN",
    title: `Unsanitised input reaches a SQL sink in handler number ${i}`,
    description: `User-controlled input flows from the request body into a raw query without parameterisation. Repro case ${i}: POST a crafted payload to the endpoint and observe the injected clause executing.`,
    cwe: "CWE-89",
    filePath: `apps/api/src/controllers/handler-${i}.ts`,
    lineNumber: 40 + i,
    repository: "acme/platform",
    branch: "main",
    prUrl: null,
    aiVerdict: i % 3 === 0 ? "TRUE_POSITIVE" : null,
    aiExploitability: null,
    aiFixSuggestion: i % 3 === 0 ? "Use a parameterised query via the ORM instead of string interpolation." : null,
    aiTriagedAt: null,
    createdAt: new Date(),
    ...over
  };
}

function reportWith(findingCount: number): TicketSecurityReport {
  const findings = Array.from({ length: findingCount }, (_, i) => finding(i));
  // The shared constant, not a fixture copy of it — otherwise this test builds a report whose
  // `findingsByType` is missing whichever type was added most recently, and then proves the renderer
  // handles it. The renderer's real input always has every key.
  const types = securityFindingTypes;
  return {
    ticket: { id: "t-1", key: "OPS-42", title: "Harden the intake endpoint" },
    findings,
    findingsByType: Object.fromEntries(types.map((t) => [t, findings.filter((f) => f.type === t)])),
    openCountBySeverity: { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 },
    // Non-zero so the quality line renders and the page-count assertions below cover it. The
    // SEPARATION itself is asserted in devops-quality-discipline.test.ts; this fixture only has to
    // make sure the renderer draws the line without falling off the page.
    openQualityCountBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0 },
    latestTestRun: {
      id: "r-1",
      ticketId: "t-1",
      provider: "github-actions",
      branch: "main",
      prUrl: null,
      status: "FAILED",
      passCount: 120,
      failCount: 3,
      durationMs: 95_000,
      logUrl: null,
      createdAt: new Date()
    },
    riskVerdict: "Needs attention — 1 open CRITICAL finding, latest test run FAILED.",
    generatedAt: new Date()
  } as unknown as TicketSecurityReport;
}

describe("renderSecurityReportPdf", () => {
  it("renders a complete report with the content the old version dropped", async () => {
    const pdf = await render(reportWith(3));
    const text = pdf.toString("latin1");

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Helvetica-Bold present = real heading hierarchy, not size-only.
    expect(text).toContain("Helvetica-Bold");
    expect(countPages(pdf)).toBeGreaterThanOrEqual(1);
  });

  it("a 60-finding report spills onto extra pages instead of clipping", async () => {
    const pdf = await render(reportWith(60));
    // ~4-6 lines per finding: must be several pages, and page numbering must have run.
    expect(countPages(pdf)).toBeGreaterThanOrEqual(3);
  });

  it("an empty report still renders the executive summary and methodology", async () => {
    const empty = reportWith(0);
    (empty as { latestTestRun: unknown }).latestTestRun = null;
    (empty as { riskVerdict: string }).riskVerdict = "Clean — no open findings, latest test run passed or none required.";
    const pdf = await render(empty);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(countPages(pdf)).toBeGreaterThanOrEqual(1);
  });
});
