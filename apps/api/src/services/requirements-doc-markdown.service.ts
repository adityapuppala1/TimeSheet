/**
 * WHAT: renders a generated RequirementsDocument to Markdown — the copy-into-Confluence/Notion/
 * GitHub-README export.
 *
 * WHY IT LOOKS THE WAY IT DOES: three deliberate choices, each about the destination rather than
 * about Markdown itself.
 *  - **YAML front-matter** so Obsidian/Notion/Confluence importers pick up title, type, version and
 *    date as real metadata instead of leaving them as a heading nobody can filter on.
 *  - **GFM tables** for stakeholders/requirements/metrics/timeline — the same data the PDF puts in
 *    tables, because a wall of bullets is where a reader stops reading.
 *  - **A real ```mermaid fence** rather than an image: GitHub, GitLab and Notion all render these
 *    natively, so the diagram stays live and editable rather than becoming a flat picture.
 *
 * Every section added after the first release is OPTIONAL and omitted entirely when absent — a
 * document generated before those sections existed must still export cleanly.
 */
import type { RequirementsDocSections } from "./ai.service.js";

function list(items: string[] | undefined): string {
  if (!items || items.length === 0) return "_none_";
  return items.map((item) => `- ${item}`).join("\n");
}

/** Escapes the one character that would break out of a GFM table cell. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function table(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  if (rows.length === 0) return "_none_";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ].join("\n");
}

/** A section only appears when it has content — `undefined` for the whole block drops it. */
function section(heading: string, body: string | undefined): string[] {
  if (!body) return [];
  return [`## ${heading}`, "", body, ""];
}

const RACI_LABEL: Record<string, string> = { R: "Responsible", A: "Accountable", C: "Consulted", I: "Informed" };

/** A metric with no target is a real state — `cell()` renders the null as an em dash. */
function formatTarget(value: number | undefined, unit: string | undefined): string | null {
  if (value == null) return null;
  return unit ? `${value} ${unit}` : String(value);
}

export function renderRequirementsDocMarkdown(requirementsDoc: {
  title: string;
  docType: string;
  createdAt: Date;
  sections: RequirementsDocSections;
}): string {
  const s = requirementsDoc.sections;
  const date = requirementsDoc.createdAt.toISOString().slice(0, 10);

  const nfrRows = [
    ["Performance", s.nfr.performance],
    ["Security", s.nfr.security],
    ["Compliance", s.nfr.compliance],
    ["Scalability", s.nfr.scalability]
  ].filter(([, value]) => Boolean(value));

  return [
    // Front-matter: real metadata for whatever imports this, not decoration.
    "---",
    `title: "${requirementsDoc.title.replace(/"/g, '\\"')}"`,
    `type: ${requirementsDoc.docType}`,
    `date: ${date}`,
    "version: 1.0",
    "generator: TimeSphere Requirements Studio",
    "---",
    "",
    `# ${requirementsDoc.title}`,
    "",
    `**${requirementsDoc.docType}** · Generated ${date} · TimeSphere Requirements Studio`,
    "",
    "---",
    "",

    ...section("Executive summary", s.executiveSummary),
    ...section("Problem", s.problem || "_none_"),
    ...section("Goals", s.goals || "_none_"),
    ...section("Target users", s.targetUsers || "_none_"),

    ...section(
      "User personas",
      s.personas?.length
        ? table(["Persona", "Role", "Needs", "Pain points"], s.personas.map((p) => [p.name, p.role, p.needs, p.painPoints]))
        : undefined
    ),

    ...section(
      "Stakeholders (RACI)",
      s.stakeholders?.length
        ? table(["Name", "Role", "RACI"], s.stakeholders.map((st) => [st.name, st.role, `**${st.raci}** ${RACI_LABEL[st.raci] ?? ""}`.trim()]))
        : undefined
    ),

    "## Scope",
    "",
    "**In scope**",
    "",
    list(s.scopeIn),
    "",
    "**Out of scope**",
    "",
    list(s.scopeOut),
    "",

    ...section(
      "Features",
      table(
        ["Feature", "Priority", "Module", "Est.", "Description"],
        s.features.map((f) => [f.title, f.priority, f.moduleName, f.estimatedHours ? `${f.estimatedHours}h` : null, f.description])
      )
    ),

    ...section(
      "Functional requirements",
      s.functionalRequirements?.length
        ? table(
            ["ID", "Requirement", "Priority", "Accepted when"],
            s.functionalRequirements.map((fr) => [fr.id, fr.requirement, fr.priority, fr.acceptanceCriteria])
          )
        : undefined
    ),

    ...section("Tech stack", list(s.techStack)),
    ...section("Dependencies", list(s.dependencies)),
    ...section("Constraints", s.constraints?.length ? list(s.constraints) : undefined),
    ...section("UI/UX", s.uiUx || "_none_"),

    "## Architecture",
    "",
    s.architecture.description || "_none_",
    "",
    // A live fence, not an image — GitHub/GitLab/Notion render this natively.
    "```mermaid",
    s.architecture.diagramMermaid || "flowchart TD\n  A[No diagram generated]",
    "```",
    "",

    ...section("Modules", s.modules.length ? table(["Module", "Description"], s.modules.map((m) => [m.name, m.description])) : undefined),
    ...section("Non-functional requirements", nfrRows.length ? table(["Attribute", "Requirement"], nfrRows) : undefined),

    ...section(
      "Timeline",
      s.timeline.length
        ? table(["Phase", "Milestone", "Description"], s.timeline.map((t) => [t.label, t.isMilestone ? "🎯 Yes" : "No", t.description]))
        : undefined
    ),

    ...section("Procedures", list(s.procedures)),

    ...section(
      "Cost & benefit",
      s.costBenefit
        ? [
            "**Costs**",
            "",
            s.costBenefit.costs || "_none_",
            "",
            "**Benefits**",
            "",
            s.costBenefit.benefits || "_none_",
            ...(s.costBenefit.notes ? ["", s.costBenefit.notes] : [])
          ].join("\n")
        : undefined
    ),

    ...section("Risks", list(s.risks)),

    ...section(
      "Success metrics",
      s.successMetrics.length
        ? table(
            ["Metric", "Target", "Notes"],
            s.successMetrics.map((m) => [m.title, formatTarget(m.targetValue, m.unit), m.description])
          )
        : undefined
    ),

    ...section("Open questions", s.openQuestions?.length ? list(s.openQuestions) : undefined),
    ...section("Assumptions", list(s.assumptions)),

    "---",
    "",
    `_Generated by **TimeSphere** Requirements Studio · ${date}_`,
    ""
  ].join("\n");
}
