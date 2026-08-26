/**
 * WHAT: renders a generated RequirementsDocument to Markdown — the copy-into-Confluence/Notion/
 * GitHub-README export. Trivial on purpose: one `## Section` per field, no library, because a
 * sections→markdown serializer earns nothing from an abstraction it will only ever be called from
 * here.
 */
import type { RequirementsDocSections } from "./ai.service.js";

function list(items: string[]): string {
  return items.length === 0 ? "_none_" : items.map((item) => `- ${item}`).join("\n");
}

function featureLine(f: RequirementsDocSections["features"][number]): string {
  const badges = [f.priority, f.moduleName, f.estimatedHours ? `~${f.estimatedHours}h` : null].filter(Boolean).join(", ");
  const suffix = f.description ? ` — ${f.description}` : "";
  return `- **${f.title}** (${badges})${suffix}`;
}

function metricLine(m: RequirementsDocSections["successMetrics"][number]): string {
  const target = m.targetValue != null ? ` — target ${m.targetValue}${m.unit ? ` ${m.unit}` : ""}` : "";
  const suffix = m.description ? ` — ${m.description}` : "";
  return `- **${m.title}**${target}${suffix}`;
}

export function renderRequirementsDocMarkdown(requirementsDoc: { title: string; docType: string; createdAt: Date; sections: RequirementsDocSections }): string {
  const s = requirementsDoc.sections;

  const featureLines = s.features.map(featureLine);
  const moduleLines = s.modules.map((m) => `- **${m.name}**${m.description ? ` — ${m.description}` : ""}`);

  const nfrLines = [
    s.nfr.performance ? `- Performance: ${s.nfr.performance}` : null,
    s.nfr.security ? `- Security: ${s.nfr.security}` : null,
    s.nfr.compliance ? `- Compliance: ${s.nfr.compliance}` : null,
    s.nfr.scalability ? `- Scalability: ${s.nfr.scalability}` : null
  ].filter((v): v is string => Boolean(v));

  const timelineLines = s.timeline.map((t) => `- ${t.isMilestone ? "🎯 " : ""}**${t.label}** — ${t.description}`);
  const metricLines = s.successMetrics.map(metricLine);

  return [
    `# ${requirementsDoc.title}`,
    "",
    `_${requirementsDoc.docType} · generated ${requirementsDoc.createdAt.toISOString().slice(0, 10)}_`,
    "",
    "## Problem",
    s.problem || "_none_",
    "",
    "## Goals",
    s.goals || "_none_",
    "",
    "## Target users",
    s.targetUsers || "_none_",
    "",
    "## Scope — in",
    list(s.scopeIn),
    "",
    "## Scope — out",
    list(s.scopeOut),
    "",
    "## Features",
    featureLines.length ? featureLines.join("\n") : "_none_",
    "",
    "## Tech stack",
    list(s.techStack),
    "",
    "## Dependencies",
    list(s.dependencies),
    "",
    "## UI/UX",
    s.uiUx || "_none_",
    "",
    "## Architecture",
    s.architecture.description || "_none_",
    "",
    "```mermaid",
    s.architecture.diagramMermaid || "flowchart TD\n  A[No diagram generated]",
    "```",
    "",
    "## Modules",
    moduleLines.length ? moduleLines.join("\n") : "_none_",
    "",
    "## Non-functional requirements",
    nfrLines.length ? nfrLines.join("\n") : "_none_",
    "",
    "## Timeline",
    timelineLines.length ? timelineLines.join("\n") : "_none_",
    "",
    "## Procedures",
    list(s.procedures),
    "",
    "## Risks",
    list(s.risks),
    "",
    "## Success metrics",
    metricLines.length ? metricLines.join("\n") : "_none_",
    "",
    "## Assumptions",
    list(s.assumptions),
    ""
  ].join("\n");
}
