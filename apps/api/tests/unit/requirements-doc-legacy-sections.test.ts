/**
 * A document generated BEFORE the industry-standard sections existed has a `sections` JSON with
 * none of those keys. Its export must still work — the alternative is that shipping new sections
 * silently breaks every document anyone already made, which is the worst possible way to find out.
 *
 * Exercises both renderers against a deliberately minimal legacy shape.
 */
import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { RequirementsDocSections } from "../../src/services/ai.service.js";
import { renderRequirementsDocMarkdown } from "../../src/services/requirements-doc-markdown.service.js";
import { renderRequirementsDocPdf } from "../../src/services/requirements-doc-pdf.service.js";

/** Exactly the shape the first release produced — no executiveSummary, personas, stakeholders,
 *  constraints, functionalRequirements, costBenefit or openQuestions. */
const LEGACY: RequirementsDocSections = {
  problem: "Churn is rising.",
  goals: "Reduce churn.",
  targetUsers: "Enterprise customers.",
  scopeIn: ["Automation tool"],
  scopeOut: ["Billing"],
  features: [{ title: "Churn analysis", description: "Analyse churn", priority: "HIGH", estimatedHours: 40, moduleName: "Core", dependsOnIndex: -1 }],
  techStack: ["Node"],
  dependencies: ["CRM"],
  uiUx: "Clean and simple.",
  architecture: { description: "Three tiers.", diagramMermaid: "flowchart TD\n  A-->B" },
  modules: [{ name: "Core", description: "The core" }],
  nfr: { performance: "Under 2s" },
  timeline: [{ label: "Phase 1", description: "Build it", isMilestone: true }],
  risks: ["Scope creep"],
  assumptions: ["Assumed a Node stack"],
  successMetrics: [{ title: "Churn rate", targetValue: 5, unit: "%" }],
  procedures: ["Deploy via CI"]
};

const BASE = { title: "Legacy doc", docType: "PRD", createdAt: new Date("2026-01-15T00:00:00Z") };

/** Renders to a real buffer, so a throw anywhere in the layout surfaces here. */
async function renderPdfToBuffer(sections: RequirementsDocSections, diagramPng?: string | null): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));
  renderRequirementsDocPdf(pdf, { ...BASE, sections, diagramPng });
  pdf.end();
  return done;
}

describe("legacy documents (no post-release sections)", () => {
  it("renders to Markdown without throwing, and omits the sections it doesn't have", () => {
    const md = renderRequirementsDocMarkdown({ ...BASE, sections: LEGACY });

    expect(md).toContain("# Legacy doc");
    expect(md).toContain("## Problem");
    // Absent sections are omitted entirely rather than rendered as empty headings.
    expect(md).not.toContain("## Executive summary");
    expect(md).not.toContain("## Stakeholders");
    expect(md).not.toContain("## Functional requirements");
  });

  it("renders to PDF without throwing", async () => {
    const buffer = await renderPdfToBuffer(LEGACY);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders a FULL document (every new section present) to PDF without throwing", async () => {
    const full: RequirementsDocSections = {
      ...LEGACY,
      executiveSummary: "A tool to reduce churn.",
      personas: [{ name: "Dana", role: "Dispatcher", needs: "Fast assignment", painPoints: "Phone calls" }],
      stakeholders: [
        { name: "Priya", role: "Product owner", raci: "A" },
        { name: "Sam", role: "Engineer", raci: "R" }
      ],
      constraints: ["Must use the existing CRM"],
      functionalRequirements: [
        { id: "FR-1", requirement: "The system shall list at-risk accounts.", priority: "HIGH", acceptanceCriteria: "A list renders within 2s." }
      ],
      costBenefit: { costs: "Two engineers for a quarter.", benefits: "5% churn reduction.", notes: "Payback in a year." },
      openQuestions: ["Which CRM fields identify churn risk?"]
    };

    const buffer = await renderPdfToBuffer(full);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    // Meaningfully bigger than the legacy render — the extra sections and tables are really there.
    const legacyBuffer = await renderPdfToBuffer(LEGACY);
    expect(buffer.length).toBeGreaterThan(legacyBuffer.length);
  });

  it("falls back to the Mermaid source when the diagram PNG is corrupt, rather than losing the export", async () => {
    // A caller could post anything; a bad image must not take the whole document down with it.
    const buffer = await renderPdfToBuffer(LEGACY, "data:image/png;base64,not-actually-a-png");
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    // Fell back to the monospaced source block rather than silently dropping the diagram.
    expect(buffer.toString("latin1")).toContain("Courier");
  });

  it("EMBEDS the diagram when a real PNG is supplied — the whole point of the browser handing one over", async () => {
    // Produced rather than hand-rolled: a hand-written base64 "PNG" is not a valid PNG, and a test
    // built on one passes for the wrong reason (it exercises the corrupt-input path above).
    const png = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#0F9AA8" } })
      .png()
      .toBuffer();

    const buffer = await renderPdfToBuffer(LEGACY, `data:image/png;base64,${png.toString("base64")}`);
    const raw = buffer.toString("latin1");

    expect(/\/Subtype\s*\/Image/.test(raw)).toBe(true);
    // …and did NOT also print the source block, which would mean both paths ran.
    expect(raw).not.toContain("Courier");
  });

  it("emits every section a full Markdown export should have", () => {
    const md = renderRequirementsDocMarkdown({
      ...BASE,
      sections: {
        ...LEGACY,
        executiveSummary: "Summary.",
        stakeholders: [{ name: "Priya", role: "Owner", raci: "A" }],
        functionalRequirements: [{ id: "FR-1", requirement: "Shall do X.", priority: "HIGH", acceptanceCriteria: "X happens." }],
        openQuestions: ["What about Y?"]
      }
    });

    expect(md).toContain("## Executive summary");
    expect(md).toContain("## Stakeholders (RACI)");
    expect(md).toContain("| FR-1 |");
    expect(md).toContain("## Open questions");
    // Front-matter, for whatever imports this.
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("generator: TimeSphere Requirements Studio");
    // The diagram stays a live fence rather than becoming a flat picture.
    expect(md).toContain("```mermaid");
  });
});
