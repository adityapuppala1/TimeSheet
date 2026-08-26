/**
 * WHAT: a downloadable, fill-in-the-blank PRD/BRD template for someone who doesn't already have a
 * requirements document to upload (Requirements Studio's "import an existing PRD/BRD" path).
 *
 * WHY PLAIN TEXT, NOT PDF OR WORD: `pdf-parse`'s bundled parser turned out to be picky enough about
 * non-Acrobat PDF structure — confirmed directly while building the import feature, a `pdfkit`-
 * generated PDF failed to re-parse through this app's own import path — that shipping a PDF
 * template risks handing the exact audience this is for a file our own upload rejects. `.txt`
 * round-trips with zero risk and is already one of the three accepted import formats.
 *
 * One guidance block per REQUIREMENTS_SECTIONS entry (ai.service.ts) — filling this in and
 * uploading it exercises the identical extraction/analysis path as any other document.
 */
import { REQUIREMENTS_SECTIONS } from "./ai.service.js";

const SECTION_GUIDANCE: Record<(typeof REQUIREMENTS_SECTIONS)[number], { heading: string; prompt: string }> = {
  problem: {
    heading: "Problem",
    prompt: "What's broken or missing today? Describe the core problem this project solves, in 2-3 sentences."
  },
  goals: {
    heading: "Goals",
    prompt: "What does success look like? State the outcome you want, ideally something measurable."
  },
  targetUsers: {
    heading: "Target users",
    prompt: "Who uses this day to day? Name the roles/personas, not just \"users\"."
  },
  scope: {
    heading: "Scope",
    prompt: "What's IN scope for this build, and — just as important — what's explicitly OUT of scope for now?"
  },
  features: {
    heading: "Features",
    prompt: "List the main features/capabilities. One line each is fine — the interview will ask for detail on anything unclear."
  },
  techStack: {
    heading: "Tech stack",
    prompt: "Any known or preferred technologies (languages, frameworks, cloud provider)? Leave blank if undecided."
  },
  dependencies: {
    heading: "Dependencies",
    prompt: "Any other systems, teams, or third-party services this relies on?"
  },
  uiUx: {
    heading: "UI/UX",
    prompt: "Describe the intended look and feel, or point to an existing design/product this should resemble."
  },
  architecture: {
    heading: "Architecture",
    prompt: "How do the major pieces fit together (frontend, backend, database, integrations)? A rough sketch in words is enough."
  },
  modules: {
    heading: "Modules",
    prompt: "What are the major components/modules this breaks into?"
  },
  nfr: {
    heading: "Non-functional requirements",
    prompt: "Performance, security, compliance, scalability expectations — anything that isn't a feature but still matters."
  },
  timeline: {
    heading: "Timeline",
    prompt: "Rough phases or milestones, and any hard deadlines."
  },
  risks: {
    heading: "Risks",
    prompt: "What could go wrong, or what's uncertain enough to flag now?"
  },
  successMetrics: {
    heading: "Success metrics",
    prompt: "How will you know this worked? Numbers if you have them (e.g. \"reduce X from 8 minutes to 1\")."
  }
};

export function renderRequirementsDocTemplate(): string {
  const sections = REQUIREMENTS_SECTIONS.map((key) => {
    const { heading, prompt } = SECTION_GUIDANCE[key];
    return `## ${heading}\n[${prompt}]\n`;
  });

  return [
    "PRD / BRD TEMPLATE",
    "",
    "Fill in each section below in plain language — a sentence or a short list is enough, there is",
    "no wrong format. Leave anything blank that doesn't apply yet; Requirements Studio's AI",
    "interview will ask a follow-up question for whatever this document doesn't cover once you",
    "upload it back in.",
    "",
    ...sections
  ].join("\n");
}
