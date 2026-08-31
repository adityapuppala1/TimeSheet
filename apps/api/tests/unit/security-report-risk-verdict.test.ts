/**
 * `buildRiskVerdict` writes the one line a reviewer actually reads: the headline on the ticket's
 * security PDF and on the ticket-closed digest email. Its `"Needs attention"` prefix is
 * load-bearing beyond the words — mail-templates.ts picks the email's accent colour from it and
 * Tickets.tsx picks the panel border from it.
 *
 * So this file asks the two narrow, important questions that decide whether that line is worth
 * reading:
 *
 *   1. When a finding is marked fixed but no scan has confirmed it, does the report still say so? A
 *      verdict of "Clean — no open findings" on the strength of somebody ticking a box is the single
 *      most expensive sentence this app can emit, because it is the one a reviewer stops reading
 *      after.
 *   2. Can a code smell produce a "Needs attention" verdict? It must not — see the second describe
 *      block, and `securityFindingTypeDisciplines` in packages/shared for the argument.
 */
import { describe, expect, it, vi } from "vitest";
import { securityFindingTypes } from "@timesheet/shared";

const fixture = vi.hoisted(() => ({ findings: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: { findFirstOrThrow: vi.fn().mockResolvedValue({ id: "t-1", key: "OPS-1", title: "Harden intake" }) },
    securityFinding: { findMany: vi.fn().mockImplementation(async () => fixture.findings) },
    testRun: { findFirst: vi.fn().mockResolvedValue(null) }
  }
}));

const { buildTicketSecurityReport } = await import("../../src/services/security-report.service.js");

let seq = 0;
function finding(status: string, severity = "CRITICAL", type = "SAST") {
  seq += 1;
  return {
    id: `f-${status}-${seq}`,
    ticketId: "t-1",
    type,
    tool: "semgrep",
    severity,
    status,
    title: "SQL injection",
    createdAt: new Date()
  };
}

describe("what counts as an open finding on a ticket's security report", () => {
  it("counts a claimed-but-unverified fix, and says so in the verdict", async () => {
    fixture.findings = [finding("PENDING_VERIFICATION")];
    const report = await buildTicketSecurityReport("t-1");

    expect(report.openCountBySeverity.CRITICAL).toBe(1);
    // The prefix, verbatim: three call sites parse it to choose a colour.
    expect(report.riskVerdict).toMatch(/^Needs attention — /);
  });

  it("does not count a confirmed fix or an accepted risk", async () => {
    fixture.findings = [finding("FIXED"), finding("ACCEPTED_RISK")];
    const report = await buildTicketSecurityReport("t-1");

    expect(report.openCountBySeverity.CRITICAL).toBe(0);
    expect(report.riskVerdict).toMatch(/^Clean — /);
  });

  it("still counts OPEN and ACKNOWLEDGED, which is what it always did", async () => {
    fixture.findings = [finding("OPEN"), finding("ACKNOWLEDGED", "HIGH")];
    const report = await buildTicketSecurityReport("t-1");

    expect(report.openCountBySeverity.CRITICAL).toBe(1);
    expect(report.openCountBySeverity.HIGH).toBe(1);
    expect(report.riskVerdict).toMatch(/^Needs attention — /);
  });
});

/**
 * The second question this report has to get right, and the one SonarQube/ESLint ingestion added:
 * WHICH DISCIPLINE a finding belongs to.
 *
 * The verdict line is what a reviewer reads and then stops reading. "Needs attention — 40 open HIGH
 * findings" has to mean this ticket carries security exposure. The moment a code smell can produce
 * that sentence, the sentence is still true and no longer worth reading — and that is the more
 * expensive failure, because it is the one somebody stops trusting rather than the one they notice.
 */
describe("code-quality findings on a ticket", () => {
  it("never reach the verdict, however many of them there are", async () => {
    fixture.findings = [
      ...Array.from({ length: 40 }, () => finding("OPEN", "HIGH", "QUALITY")),
      ...Array.from({ length: 60 }, () => finding("OPEN", "CRITICAL", "LINT"))
    ];
    const report = await buildTicketSecurityReport("t-1");

    expect(report.openCountBySeverity).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
    expect(report.riskVerdict).toMatch(/^Clean — /);
  });

  it("are still counted, still listed, and still on the report", async () => {
    // The other half. Excluding them from the verdict is only honest because the report says how
    // many there are and shows every one of them in its own section.
    fixture.findings = [finding("OPEN"), finding("OPEN", "MEDIUM", "QUALITY"), finding("OPEN", "LOW", "LINT")];
    const report = await buildTicketSecurityReport("t-1");

    expect(report.openCountBySeverity.CRITICAL).toBe(1);
    expect(report.openQualityCountBySeverity).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 1 });
    // Both disciplines have their own section in the by-type buckets the PDF and the ticket panel
    // both render from.
    expect(report.findingsByType.SAST).toHaveLength(1);
    expect(report.findingsByType.QUALITY).toHaveLength(1);
    expect(report.findingsByType.LINT).toHaveLength(1);
    expect(report.findings).toHaveLength(3);
  });

  it("gives every type a bucket, so none can be silently dropped from the report", async () => {
    // `findingsByType` is built from the shared constant rather than a literal list. With a literal,
    // a newly added type produced an `undefined` bucket that the renderer swallowed through `?? []`
    // — the findings were stored, counted, and simply never appeared in the document anybody read.
    fixture.findings = [];
    const report = await buildTicketSecurityReport("t-1");
    expect(Object.keys(report.findingsByType).sort()).toEqual([...securityFindingTypes].sort());
  });
});
