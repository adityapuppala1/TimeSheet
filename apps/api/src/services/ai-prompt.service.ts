/**
 * WHAT: lets a super admin change what the AI is told, without shipping a release.
 *
 * WHY it matters: today every prompt is a string literal in ai.service.ts. "The weekly digest is
 * too chirpy" is a code change, a review, and a deploy — so in practice nobody fixes it. Paired
 * with golden datasets (ai-dataset.service.ts) and the eval runner, this is the half of the loop
 * that lets a measured improvement actually reach production.
 *
 * ── THE TWO RULES THIS FILE ENFORCES ────────────────────────────────────────────────────────
 *
 * 1. ALLOWLIST, NOT ALL CAPABILITIES. Only free-text capabilities are editable. Every capability
 *    that asks for JSON is excluded, for two independent reasons:
 *      - its output MUST parse. `classifyTicket` throws 502 on unparseable output, and email and
 *        chat intake both depend on it — one careless edit would stop tickets being created from
 *        email, with no obvious connection back to the prompt someone changed.
 *      - those prompts carry <untrusted-*> delimiter blocks, which are a prompt-injection DEFENCE
 *        against content that arrives from email, chat, CI logs and PR diffs. Making them editable
 *        would mean an admin could silently delete a security control.
 *    The two face capabilities are excluded for a third reason: they sit inside a biometric
 *    compliance regime, and their prompts are part of what that regime promises.
 *
 * 2. THE RUNTIME NEVER THROWS. `resolvePrompt` cannot fail — it returns the code default for any
 *    problem (no override, DB unreachable, unknown placeholder, empty render) and reports WHY via
 *    `fallbackReason`, which gets stamped onto the interaction. A bad prompt therefore degrades to
 *    "the feature works exactly as it did before", and the fact that it fell back is visible in
 *    the activity log rather than being silent.
 */
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

export interface PromptPlaceholder {
  name: string;
  description: string;
  /** Stand-in used by the test-render on the editor, so an admin sees real shape before saving. */
  sample: string;
}

export interface PromptSpec {
  feature: string;
  label: string;
  /** What this prompt is for, in the admin's terms — shown above the editor. */
  description: string;
  placeholders: PromptPlaceholder[];
  /** Placeholders the body MUST keep. Dropping one means the model never receives that data, which
   *  produces confidently wrong output rather than an error — so it's refused at save time. */
  required: string[];
  defaultTemplate: string;
}

const SPECS: PromptSpec[] = [
  {
    feature: "writing_assistant",
    label: "Writing assistant",
    description: "Rewrites a terse ticket description or comment into clearer prose.",
    placeholders: [
      { name: "instruction", description: "The per-context instruction the app supplies (bug-report layout vs. comment tone).", sample: "Improve the clarity and tone of this comment while preserving its meaning and intent. Keep it concise." },
      { name: "context", description: "Either ticket_description or comment.", sample: "comment" },
      { name: "text", description: "The user's original text, plain (HTML already stripped).", sample: "cant login it just breaks" }
    ],
    required: ["text"],
    defaultTemplate: `{{instruction}}

Original text:
{{text}}

Respond with ONLY the improved text — no preamble, no explanation.`
  },
  {
    feature: "text_refine",
    label: "Refine text",
    description:
      "Cleans up what someone typed into a description, note, title or comment. Separate from the writing assistant because this one is forbidden from restructuring or adding anything — it is used on records of work.",
    placeholders: [
      { name: "fieldLabel", description: "Which field is being refined, in the user's words.", sample: "timesheet task description" },
      {
        name: "guidance",
        description: "The one extra rule the app supplies for this particular field (a title stays a single line; a timesheet entry is a compliance record).",
        sample: "This text is a record of work that has already happened, kept for approval and audit."
      },
      { name: "text", description: "The user's original text, plain (HTML already stripped, paragraph and list breaks kept).", sample: "fixd the login bug on safri, took abt 3 hrs, see WEB-12" }
    ],
    required: ["text"],
    // The "never invent" rules are load-bearing, not politeness: this capability runs over timesheet
    // entries, which are what an approver and an auditor later read as a statement of what was done.
    // An AI that smooths "mostly fixed" into "fixed", or helpfully adds a next step nobody committed
    // to, has changed a record — so the constraint lives in the prompt and `required` keeps {{text}}
    // in place no matter how an admin edits the rest.
    defaultTemplate: `Clean up the text below. A person typed it into the "{{fieldLabel}}" field of a work-tracking app, and a colleague will read it.

Fix spelling, grammar and punctuation, and improve clarity. Keep it concise — no longer than the original unless the original is genuinely hard to follow.

Rules you must not break:
- Preserve the author's meaning exactly. Never add a fact, cause, result, next step or opinion that isn't already there.
- Keep every specific detail exactly as written: numbers, durations, dates, ticket keys (like WEB-12), file paths, error text, product names and people's names.
- Never make a claim stronger or weaker than the author made it — "mostly working" must not become "working".
- Don't add greetings, sign-offs, headings, or filler like "In summary".
- Keep the author's existing structure: if they wrote a list, return a list; if they wrote one paragraph, return one paragraph.
- Code, logs, stack traces, SQL, config and shell commands are NEVER prose. Return each such block inside a \`\`\` fence, exactly as written — same characters, same line breaks, same indentation. Never correct spelling, grammar or capitalisation inside a fence.
- If the author pasted code or a log WITHOUT a fence, put a fence around it and change nothing inside it. That is the one structural change you are allowed to make.
- If it is already clear, return it essentially unchanged rather than rewriting it for the sake of it.

{{guidance}}

Original text:
{{text}}

Respond with ONLY the cleaned-up text — no preamble, no explanation, no quotation marks around it.`
  },
  {
    feature: "comment_summary",
    label: "Comment thread summary",
    description: "Condenses a ticket's comment thread into a short status recap.",
    placeholders: [
      { name: "ticketTitle", description: "The ticket's title.", sample: "Login fails on Safari" },
      { name: "thread", description: "The full comment thread, one entry per line with author and timestamp.", sample: "Ana (2026-07-30 09:12): Reproduced on 17.4.\n\nBen (2026-07-30 11:40): Looks like the cookie is SameSite=Strict." }
    ],
    required: ["thread"],
    defaultTemplate: `Summarize this comment thread on ticket "{{ticketTitle}}" in 2-4 sentences — focus on current status, decisions made, and any open questions.

{{thread}}`
  },
  {
    feature: "ask_ai",
    label: "Ask AI",
    description: "Answers a free-text question about the backlog, grounded in the tickets the asker can see.",
    placeholders: [
      { name: "tickets", description: "The accessible tickets, one per line with key, status, priority and a description snippet.", sample: "[WEB-12] (OPEN, HIGH) Login fails on Safari — cookie rejected" },
      { name: "analyticsSnapshot", description: "Insights aggregates (velocity, SLA, workload, cost). Empty when unavailable — it brings its own leading blank lines.", sample: "\n\nWorkspace analytics snapshot (use this for trend/aggregate questions — velocity, SLA, workload, cost):\nSLA compliance: 92%" },
      { name: "question", description: "What the user asked.", sample: "Why did our SLA compliance drop last week?" }
    ],
    required: ["tickets", "question"],
    defaultTemplate: `You're answering a question about a team's ticket backlog and workspace analytics. Use only the tickets and analytics listed below — cite ticket keys like [WEB-12] when referencing a specific ticket, and cite numbers directly when referencing analytics. If the answer isn't in the provided data, say so plainly.

Tickets:
{{tickets}}{{analyticsSnapshot}}

Question: {{question}}`
  },
  {
    feature: "weekly_digest",
    label: "Weekly digest",
    description: "The Monday-morning recap of one person's week, sent by the digest worker.",
    placeholders: [
      { name: "userName", description: "Who the recap is for.", sample: "Ana" },
      { name: "weekLabel", description: "The week being covered.", sample: "21–27 July" },
      { name: "ticketsCreated", description: "Tickets they created.", sample: "4" },
      { name: "ticketsResolved", description: "Tickets they resolved.", sample: "6" },
      { name: "openAssigned", description: "Still open and assigned to them.", sample: "3" },
      { name: "hoursLogged", description: "Hours logged that week.", sample: "31.5" },
      { name: "notableTickets", description: "A bulleted list of notable tickets, or (none).", sample: "- [WEB-12] Login fails on Safari (RESOLVED)" }
    ],
    required: [],
    defaultTemplate: `Write a short, friendly Monday-morning recap (3-5 sentences, plain prose, no headings/bullets in the output) for {{userName}} covering the week of {{weekLabel}}.

Tickets created: {{ticketsCreated}}
Tickets resolved: {{ticketsResolved}}
Currently open & assigned to them: {{openAssigned}}
Hours logged: {{hoursLogged}}
Notable tickets:
{{notableTickets}}

Keep it encouraging but factual — don't invent numbers beyond what's given. If everything is at zero, say the week was quiet rather than padding it out.

Respond with ONLY the recap paragraph — no preamble, no subject line.`
  },
  {
    feature: "security_weekly_digest",
    label: "Security weekly digest",
    description: "The org-wide security posture recap sent to admins.",
    placeholders: [
      { name: "weekLabel", description: "The week being covered.", sample: "21–27 July" },
      { name: "openFindings", description: "Open findings.", sample: "18" },
      { name: "newCriticalOrHigh", description: "New CRITICAL/HIGH findings this week.", sample: "2" },
      { name: "resolvedThisWeek", description: "Findings resolved this week.", sample: "5" },
      { name: "riskScore", description: "This week's risk score.", sample: "41" },
      { name: "riskScoreLastWeek", description: "Last week's risk score.", sample: "47" },
      { name: "ticketsStuckPastSla", description: "Security-linked tickets past SLA.", sample: "1" },
      { name: "topRepositories", description: "Repositories with the most open findings, bulleted.", sample: "- acme/web: 9 open" }
    ],
    required: [],
    defaultTemplate: `Write a short, factual security-posture recap (3-5 sentences, plain prose, no headings/bullets in the output) for the workspace admins covering the week of {{weekLabel}}.

Open findings: {{openFindings}}
New CRITICAL/HIGH findings this week: {{newCriticalOrHigh}}
Findings resolved this week: {{resolvedThisWeek}}
Risk score: {{riskScore}} (was {{riskScoreLastWeek}} last week)
Security-linked tickets past their SLA: {{ticketsStuckPastSla}}
Top repositories by open findings:
{{topRepositories}}

Keep it factual and actionable — call out what changed and what needs attention first, don't invent numbers beyond what's given. If the risk score dropped and nothing is stuck, say the week looked good rather than manufacturing concern.

Respond with ONLY the recap paragraph — no preamble, no subject line.`
  },
  {
    feature: "bug_pattern_digest",
    label: "Bug pattern digest",
    description: "The monthly \"what keeps breaking\" narrative across CI, tickets and findings.",
    placeholders: [
      { name: "periodLabel", description: "The period being covered.", sample: "July 2026" },
      { name: "recurringFailures", description: "Recurring CI failures by provider/branch, bulleted.", sample: "- github (main): 12 failed runs" },
      { name: "hotTickets", description: "Tickets with the most failed runs, bulleted.", sample: "- [WEB-12] Login fails on Safari: 7 failed runs" },
      { name: "findingHotspots", description: "Repositories with the most open findings, bulleted.", sample: "- acme/web: 9 open findings" }
    ],
    required: [],
    defaultTemplate: `Write a short, factual "what keeps breaking" recap (3-5 sentences, plain prose, no headings/bullets in the output) for engineering leads covering {{periodLabel}}.

Recurring CI failures by provider/branch:
{{recurringFailures}}

Tickets accumulating the most failed test runs:
{{hotTickets}}

Security-finding hotspots by repository:
{{findingHotspots}}

Call out the clearest recurring pattern first (a specific branch, ticket, or repository that keeps coming up), and be honest if nothing stands out — don't invent a trend from thin data. Never invent numbers beyond what's given.

Respond with ONLY the recap paragraph — no preamble, no subject line.`
  },
  {
    feature: "status_report",
    label: "Project status report",
    description: "The on-demand stakeholder update generated from a project page.",
    placeholders: [
      { name: "projectName", description: "The project.", sample: "Acme Web" },
      { name: "periodLabel", description: "The period being covered.", sample: "July 2026" },
      { name: "ticketsCreated", description: "Tickets created.", sample: "22" },
      { name: "ticketsResolved", description: "Tickets resolved.", sample: "19" },
      { name: "openCount", description: "Currently open.", sample: "14" },
      { name: "overdueCount", description: "Currently overdue.", sample: "3" },
      { name: "hoursLogged", description: "Hours logged.", sample: "410.5" },
      { name: "notableTickets", description: "Notable tickets, bulleted.", sample: "- [WEB-12] Login fails on Safari (RESOLVED)" }
    ],
    required: [],
    defaultTemplate: `Write a short stakeholder status update (4-7 sentences, plain prose, no headings/bullets in the output) for the project "{{projectName}}" covering {{periodLabel}}.

Tickets created: {{ticketsCreated}}
Tickets resolved: {{ticketsResolved}}
Currently open: {{openCount}}
Overdue: {{overdueCount}}
Hours logged: {{hoursLogged}}
Notable tickets:
{{notableTickets}}

Write for a non-technical stakeholder reading this outside the team — plain language, no jargon. Be factual, don't invent numbers beyond what's given, and call out overdue items if any exist rather than glossing over them.

Respond with ONLY the status update paragraph(s) — no preamble, no subject line.`
  },
  {
    feature: "assignee_suggestion_explanation",
    label: "Assignee suggestion explanation",
    description: "One sentence explaining why the top-ranked assignee is a sensible pick. The ranking itself is computed in code and is never re-done by the model.",
    placeholders: [
      { name: "ticketTitle", description: "The ticket needing an assignee.", sample: "Login fails on Safari" },
      { name: "candidates", description: "The already-ranked candidates with their open/resolved counts.", sample: "1. Ana — 3 open now, 11 resolved here before" }
    ],
    required: ["candidates"],
    defaultTemplate: `A ticket titled "{{ticketTitle}}" needs an assignee. Ranked candidates (already scored, do NOT re-rank):
{{candidates}}

In ONE sentence, explain why the top candidate is the reasonable pick, in plain language a
manager would use (e.g. "already familiar with this area and has room on their plate").
Never invent skills or history beyond the open/resolved counts given. Respond with ONLY that
one sentence — no preamble, no candidate list repeated back.`
  },
  {
    feature: "stale_ticket_nudge",
    label: "Stale ticket nudge",
    description: "The advisory one-liner attached to a ticket the SLA sweep flagged as overdue.",
    placeholders: [
      { name: "priority", description: "Ticket priority.", sample: "HIGH" },
      { name: "ticketType", description: "Ticket type.", sample: "BUG" },
      { name: "ticketTitle", description: "Ticket title.", sample: "Login fails on Safari" },
      { name: "hoursOverdue", description: "Hours past the resolution SLA, one decimal.", sample: "18.5" },
      { name: "commentCount", description: "How many comments it has.", sample: "2" },
      { name: "linkedBranchPhrase", description: "Either \"a\" or \"no\", reading as \"a linked branch/PR\" or \"no linked branch/PR\".", sample: "no" }
    ],
    required: [],
    defaultTemplate: `A {{priority}}-priority {{ticketType}} ticket titled "{{ticketTitle}}" is {{hoursOverdue}} hours past its resolution SLA.
It has {{commentCount}} comment(s) and {{linkedBranchPhrase}} linked branch/PR.

In ONE short sentence, suggest the single most useful next action for whoever owns this
(e.g. "post a status update so the reporter isn't left wondering", "link a branch if work has
already started", "flag it as blocked if it's stuck on someone else"). Be concrete, not generic
advice like "look into it" or "prioritize this". Never invent facts about the ticket beyond
what's given. Respond with ONLY that one sentence — no preamble.`
  }
];

const SPEC_BY_FEATURE = new Map(SPECS.map((s) => [s.feature, s]));

export function listPromptSpecs(): PromptSpec[] {
  return SPECS;
}

export function getPromptSpec(feature: string): PromptSpec | undefined {
  return SPEC_BY_FEATURE.get(feature);
}

const TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** Every placeholder the body actually references, deduped, in first-appearance order. */
export function extractPlaceholders(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(TOKEN_RE)) found.add(match[1]);
  return [...found];
}

export interface TemplateProblem {
  kind: "unknown_placeholder" | "missing_required" | "empty";
  message: string;
}

/**
 * Save-time validation. Deliberately strict about unknown placeholders: `{{ticketName}}` when the
 * spec says `ticketTitle` would otherwise render literally into the prompt, and the model would
 * cheerfully answer about a ticket called "{{ticketName}}".
 */
export function validateTemplate(spec: PromptSpec, body: string): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  if (!body.trim()) {
    problems.push({ kind: "empty", message: "The prompt can't be empty." });
    return problems;
  }

  const known = new Set(spec.placeholders.map((p) => p.name));
  for (const name of extractPlaceholders(body)) {
    if (!known.has(name)) {
      problems.push({
        kind: "unknown_placeholder",
        message: `{{${name}}} isn't a placeholder this prompt provides. Available: ${[...known].map((n) => `{{${n}}}`).join(", ")}.`
      });
    }
  }

  const used = new Set(extractPlaceholders(body));
  for (const name of spec.required) {
    if (!used.has(name)) {
      problems.push({
        kind: "missing_required",
        message: `{{${name}}} must stay in the prompt — without it the AI never receives that data, and it will answer confidently from nothing.`
      });
    }
  }

  return problems;
}

export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(TOKEN_RE, (_match, name: string) => values[name] ?? "");
}

export interface ResolvedPrompt {
  text: string;
  /** The active version's id, stamped onto the interaction so "what was it told?" is answerable. */
  promptVersionId?: string;
  /** Set only when an override existed and was NOT used. Absent on the normal default path — the
   *  code default is the expected state, not a failure. */
  fallbackReason?: string;
}

/**
 * The runtime entry point. CANNOT THROW — every failure path returns the code default.
 *
 * That guarantee is the reason this feature is safe to ship: the worst an admin can do with a
 * broken prompt is get today's behaviour back, with a reason recorded on the interaction.
 */
export async function resolvePrompt(feature: string, values: Record<string, string>): Promise<ResolvedPrompt> {
  const spec = SPEC_BY_FEATURE.get(feature);
  // Not overridable at all — shouldn't happen, since callers pass their own feature key, but
  // returning empty text would be far worse than returning nothing.
  if (!spec) return { text: "" };

  const fallback = () => renderTemplate(spec.defaultTemplate, values);

  try {
    const template = await prisma.aIPromptTemplate.findUnique({
      where: { feature },
      include: { versions: true }
    });
    if (!template?.activeVersionId) return { text: fallback() };

    const active = template.versions.find((v) => v.id === template.activeVersionId);
    if (!active) return { text: fallback(), fallbackReason: "active_version_missing" };

    const problems = validateTemplate(spec, active.body);
    if (problems.length > 0) {
      // Shouldn't be reachable — the save path rejects these — but a spec can change under an
      // already-saved version, and that must degrade rather than break.
      return { text: fallback(), fallbackReason: `invalid_template:${problems[0].kind}` };
    }

    const rendered = renderTemplate(active.body, values);
    if (!rendered.trim()) return { text: fallback(), fallbackReason: "rendered_empty" };

    return { text: rendered, promptVersionId: active.id };
  } catch (error) {
    console.warn(`[ai] prompt lookup failed for ${feature}, using the built-in prompt: ${(error as Error).message}`);
    return { text: fallback(), fallbackReason: "lookup_failed" };
  }
}

/* ------------------------------- Admin surface ------------------------------------------- */

export async function listPromptTemplates() {
  const rows = await prisma.aIPromptTemplate.findMany({
    include: { versions: { orderBy: { version: "desc" }, select: { id: true, version: true, createdAt: true } } }
  });
  const byFeature = new Map(rows.map((r) => [r.feature, r]));

  // Driven by the allowlist, not by what's in the table: a capability with no row yet is a normal
  // state (it's using the built-in prompt) and must still be listed so it can be customised.
  return SPECS.map((spec) => {
    const row = byFeature.get(spec.feature);
    const active = row?.versions.find((v) => v.id === row.activeVersionId);
    return {
      feature: spec.feature,
      label: spec.label,
      description: spec.description,
      customized: Boolean(active),
      activeVersion: active ? active.version : null,
      versionCount: row?.versions.length ?? 0
    };
  });
}

export async function getPromptTemplate(feature: string) {
  const spec = SPEC_BY_FEATURE.get(feature);
  if (!spec) throw new AppError(404, "That capability's prompt isn't editable.");

  const row = await prisma.aIPromptTemplate.findUnique({
    where: { feature },
    include: {
      versions: {
        orderBy: { version: "desc" },
        include: { createdBy: { select: { id: true, name: true } } }
      }
    }
  });

  return {
    feature: spec.feature,
    label: spec.label,
    description: spec.description,
    placeholders: spec.placeholders,
    required: spec.required,
    defaultTemplate: spec.defaultTemplate,
    activeVersionId: row?.activeVersionId ?? null,
    versions: (row?.versions ?? []).map((v) => ({
      id: v.id,
      version: v.version,
      body: v.body,
      note: v.note,
      createdBy: v.createdBy,
      createdAt: v.createdAt
    }))
  };
}

/** A dry run against the spec's sample values, so an admin sees the real prompt before saving. */
export function previewPrompt(feature: string, body: string): { problems: TemplateProblem[]; preview: string } {
  const spec = SPEC_BY_FEATURE.get(feature);
  if (!spec) throw new AppError(404, "That capability's prompt isn't editable.");

  const problems = validateTemplate(spec, body);
  const samples = Object.fromEntries(spec.placeholders.map((p) => [p.name, p.sample]));
  return { problems, preview: problems.length > 0 ? "" : renderTemplate(body, samples) };
}

/**
 * Saves a new version and — unless told otherwise — makes it live. Append-only: this never edits
 * an existing version, so the record of what the AI was told at any past moment stays intact.
 */
export async function savePromptVersion(params: {
  feature: string;
  body: string;
  note?: string;
  activate?: boolean;
  userId: string;
}) {
  const spec = SPEC_BY_FEATURE.get(params.feature);
  if (!spec) throw new AppError(404, "That capability's prompt isn't editable.");

  const problems = validateTemplate(spec, params.body);
  if (problems.length > 0) throw new AppError(422, problems.map((p) => p.message).join(" "));

  const template = await prisma.aIPromptTemplate.upsert({
    where: { feature: params.feature },
    create: { feature: params.feature },
    update: {}
  });

  const latest = await prisma.aIPromptVersion.findFirst({
    where: { templateId: template.id },
    orderBy: { version: "desc" },
    select: { version: true }
  });

  const created = await prisma.aIPromptVersion.create({
    data: {
      templateId: template.id,
      version: (latest?.version ?? 0) + 1,
      body: params.body,
      note: params.note?.trim() || null,
      createdById: params.userId
    }
  });

  if (params.activate !== false) {
    await prisma.aIPromptTemplate.update({ where: { id: template.id }, data: { activeVersionId: created.id } });
  }

  return created;
}

/**
 * Points the template at a different version, or at nothing.
 *
 * `versionId: null` is revert-to-built-in — which is why the default was never seeded as a version
 * row: "no override" is a real, reachable state rather than a copy that could drift from the code.
 */
export async function activatePromptVersion(feature: string, versionId: string | null) {
  const spec = SPEC_BY_FEATURE.get(feature);
  if (!spec) throw new AppError(404, "That capability's prompt isn't editable.");

  const template = await prisma.aIPromptTemplate.upsert({
    where: { feature },
    create: { feature },
    update: {}
  });

  if (versionId) {
    const version = await prisma.aIPromptVersion.findFirst({ where: { id: versionId, templateId: template.id } });
    if (!version) throw new AppError(404, "That version doesn't belong to this prompt.");

    // Re-validate on activation, not just on save: a spec's placeholder list can change in a
    // release, and activating a now-invalid old version would only surface as a silent fallback.
    const problems = validateTemplate(spec, version.body);
    if (problems.length > 0) throw new AppError(422, problems.map((p) => p.message).join(" "));
  }

  await prisma.aIPromptTemplate.update({ where: { id: template.id }, data: { activeVersionId: versionId } });
}
