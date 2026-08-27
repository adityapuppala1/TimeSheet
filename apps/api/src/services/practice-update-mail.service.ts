/**
 * WHAT: turns a `PracticeUpdateData` plus an optional AI narrative into the ten sections of the
 * Weekly AI/ML Practice Update email, in the order leadership asked for them.
 *
 * WHY IT IS SEPARATE FROM `mail-templates.ts`: that file's templates are rendered TWICE — once with
 * real values and once with every argument replaced by `"{{name}}"`, so the admin editor can show
 * the shipped default. Anything that does arithmetic or iterates an array breaks on the second
 * pass (`"{{hours}}".toFixed(2)` throws). So the assembly happens here and the template takes one
 * finished `sectionsHtml` string.
 *
 * WHY THE NARRATIVE IS OPTIONAL EVERYWHERE: the figures are counted and go out regardless. A
 * section whose prose is missing renders its underlying facts instead of disappearing — a reader
 * who opens "Risks / Blockers" and finds nothing cannot tell whether nothing is at risk or the
 * model was down.
 */
import { emailBlocks } from "./mail-templates.js";
import {
  PRACTICE_CATEGORIES,
  RAG_EMOJI,
  type PracticeMetrics,
  type PracticeUpdateData
} from "./practice-update.service.js";
import type { PracticeUpdateNarrative } from "./ai.service.js";

const { dataTable, periodStrip, escape } = emailBlocks;

const MUTED = "#64748B";
const FG = "#0F172A";

/** "47 (up from 35)" / "47 (down from 60)" / "47 (unchanged)". A bare number cannot answer
 *  "is this week normal", which is the question the update exists to answer. */
function withDelta(current: number, previous: number, suffix = ""): string {
  const now = `${current}${suffix}`;
  if (previous === current) return `${now} (unchanged)`;
  return `${now} (${current > previous ? "up" : "down"} from ${previous}${suffix})`;
}

function sectionHeading(text: string): string {
  return `<div style="margin:22px 0 2px;font-size:14px;font-weight:800;color:${FG};border-top:1px solid #E2E8F0;padding-top:14px;">${escape(text)}</div>`;
}

/**
 * A prose block, or the facts it would have been written from.
 *
 * `fallback` is not a placeholder apology — it is the real content in a shorter form, so an update
 * sent while the model is unavailable is still a complete update.
 */
function prose(text: string | undefined, fallback: string): string {
  const body = (text ?? "").trim() || fallback;
  return `<p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:${FG};">${escape(body)}</p>`;
}

/**
 * A bullet list, or the facts it would have been written from.
 *
 * The narrative arrives as an ARRAY of short strings rather than one markdown blob, and that is not
 * a formatting preference — a small local model asked for "markdown bullets" inside a JSON string
 * emitted the bullets UNQUOTED and broke the whole object, losing four good sections to a parse
 * error. Measured against llama3.1:8b, not guessed at. Lists of short strings are the shape models
 * get right, and they need no markdown parsing here either.
 */
function bulletList(items: string[] | undefined, fallback: string[]): string {
  const rows = (items ?? []).map((v) => v.trim()).filter(Boolean);
  const use = rows.length > 0 ? rows : fallback;
  if (use.length === 0) return prose(undefined, "Nothing to report in this section.");
  return `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.6;color:${FG};">${use
    .map((item) => `<li style="margin:0 0 4px;">${escape(item)}</li>`)
    .join("")}</ul>`;
}

function metricsTable(metrics: PracticeMetrics, previous: PracticeMetrics): string {
  const rows: string[][] = [
    ["Tickets closed", withDelta(metrics.ticketsClosed, previous.ticketsClosed)],
    ["Tickets raised", withDelta(metrics.ticketsCreated, previous.ticketsCreated)],
    ["Hours logged", withDelta(metrics.hours, previous.hours, " h")],
    ["Contributors", withDelta(metrics.contributors, previous.contributors)],
    ["Overdue tickets", withDelta(metrics.overdue, previous.overdue)],
    ["SLA breaches", withDelta(metrics.slaBreaches, previous.slaBreaches)],
    ["Open escalations", String(metrics.openEscalations)],
    ["Changes raised / implemented", `${metrics.changesRaised} / ${metrics.changesImplemented}`],
    ["Releases shipped", withDelta(metrics.releases, previous.releases)],
    ["Open security findings (critical / high)", `${metrics.securityOpenCritical} / ${metrics.securityOpenHigh}`],
    ["New security findings", withDelta(metrics.securityNewFindings, previous.securityNewFindings)],
    ["Training & capability hours", withDelta(metrics.trainingHours, previous.trainingHours, " h")]
  ];
  return dataTable({ head: ["Measure", "This period"], rows: rows.map(([a, b]) => [escape(a), escape(b)]), align: ["l", "r"] });
}

/**
 * The per-initiative table the request asked for: Owner, Status, This Week's Progress, Next Steps,
 * Risks / Dependencies.
 */
function initiativeTable(data: PracticeUpdateData, nextStepById: Map<string, string>, category: string): string {
  const rows = data.initiatives
    .filter((i) => i.category === category)
    .map((i) => [
      `<strong>${escape(i.name)}</strong>${i.code ? `<br><span style="color:${MUTED};font-size:11px;">${escape(i.code)}</span>` : ""}`,
      escape(i.owner ?? "—"),
      RAG_EMOJI[i.status],
      escape(i.progress),
      escape(nextStepById.get(i.id) ?? "—"),
      escape(i.risks || "—")
    ]);

  return dataTable({
    head: ["Initiative", "Owner", "Status", "This period", "Next steps", "Risks / dependencies"],
    rows,
    align: ["l", "l", "l", "l", "l", "l"],
    empty: "Nothing in this area this period."
  });
}

export interface PracticeUpdateEmail {
  subject: string;
  headline: string;
  sectionsHtml: string;
}

export function buildPracticeUpdateEmail(data: PracticeUpdateData, narrative: PracticeUpdateNarrative | null): PracticeUpdateEmail {
  const { metrics, previousMetrics } = data;
  const nextStepById = new Map((narrative?.nextSteps ?? []).map((s) => [s.id, s.text]));

  const red = data.initiatives.filter((i) => i.status === "RED");
  const amber = data.initiatives.filter((i) => i.status === "AMBER");

  const strip = periodStrip([
    { label: "Tickets closed", value: String(metrics.ticketsClosed), sub: `${metrics.ticketsCreated} raised` },
    { label: "Hours logged", value: `${metrics.hours}`, sub: `${metrics.contributors} contributors` },
    { label: "At risk", value: String(red.length), sub: `${amber.length} amber · ${metrics.slaBreaches} SLA breaches` }
  ]);

  // 1. Executive summary.
  const summaryFallback =
    `${metrics.ticketsClosed} tickets closed and ${metrics.ticketsCreated} raised across ${data.initiatives.length} initiatives, ` +
    `with ${metrics.hours} hours logged by ${metrics.contributors} people. ` +
    (red.length > 0
      ? `${red.length} initiative${red.length === 1 ? " is" : "s are"} red: ${red.map((i) => i.name).join(", ")}.`
      : "Nothing is currently red.");

  // The facts behind each narrative section, used when no prose was written for it.
  const risksFallback =
    red.length + amber.length === 0
      ? ["Nothing is overdue or breaching SLA in this period."]
      : [...red, ...amber].map((i) => `${RAG_EMOJI[i.status]} ${i.name} — ${i.risks || "no detail recorded"}`);

  const sections = [
    strip,
    sectionHeading("Executive Summary"),
    prose(narrative?.executiveSummary, summaryFallback),
    ...PRACTICE_CATEGORIES.flatMap(({ key, label }) => {
      const has = data.initiatives.some((i) => i.category === key);
      // A category with nothing in it is omitted rather than printed empty — ten headings with
      // five "nothing here" boxes under them is how a weekly update starts getting deleted unread.
      return has ? [sectionHeading(label), initiativeTable(data, nextStepById, key)] : [];
    }),
    ...(data.releases.length > 0
      ? [
          sectionHeading("Releases"),
          dataTable({
            head: ["Version", "Product", "Closed", "State"],
            rows: data.releases.map((r) => [escape(r.version), escape(r.product ?? "—"), escape(r.closedAt ?? "—"), escape(r.state)]),
            align: ["l", "l", "l", "l"]
          })
        ]
      : []),
    sectionHeading("Key Metrics"),
    metricsTable(metrics, previousMetrics),
    sectionHeading("Risks / Blockers"),
    bulletList(narrative?.risks, risksFallback),
    sectionHeading("Next Week Priorities"),
    bulletList(
      narrative?.nextWeekPriorities,
      red.map((i) => `Clear the backlog on ${i.name} (${i.risks || "overdue work"})`)
    ),
    sectionHeading("Decisions / Support Required"),
    bulletList(
      narrative?.decisionsRequired,
      metrics.securityOpenCritical > 0
        ? [
            `${metrics.securityOpenCritical} critical security finding${
              metrics.securityOpenCritical === 1 ? " remains" : "s remain"
            } open and need${metrics.securityOpenCritical === 1 ? "s" : ""} a remediation owner.`
          ]
        : ["No decisions are being requested this period."]
    )
  ];

  return {
    subject: `Weekly AI/ML Practice Update — ${data.period.label}`,
    headline: (narrative?.executiveSummary ?? summaryFallback).split("\n")[0].slice(0, 160),
    sectionsHtml: sections.join("")
  };
}

/** The two plain-text blocks the AI prompt is fed. Kept here so the email and the prompt describe
 *  the same week in the same words. */
export function narrativeInputs(data: PracticeUpdateData): { metrics: string; initiatives: string; releases: string } {
  const m = data.metrics;
  const p = data.previousMetrics;
  return {
    metrics: [
      `Tickets closed: ${withDelta(m.ticketsClosed, p.ticketsClosed)}`,
      `Tickets raised: ${withDelta(m.ticketsCreated, p.ticketsCreated)}`,
      `Hours logged: ${withDelta(m.hours, p.hours, " h")} by ${m.contributors} people`,
      `Overdue tickets: ${withDelta(m.overdue, p.overdue)}`,
      `SLA breaches: ${withDelta(m.slaBreaches, p.slaBreaches)}`,
      `Open escalations: ${m.openEscalations}`,
      `Changes raised/implemented: ${m.changesRaised}/${m.changesImplemented}`,
      `Releases shipped: ${withDelta(m.releases, p.releases)}`,
      `Open security findings: ${m.securityOpenCritical} critical, ${m.securityOpenHigh} high; ${m.securityNewFindings} new this period`,
      `Training & capability hours: ${withDelta(m.trainingHours, p.trainingHours, " h")}`
    ].join("\n"),
    initiatives:
      data.initiatives
        .map(
          (i) =>
            `[${i.category}] ${i.name} (id ${i.id}) — owner ${i.owner ?? "unassigned"} — ${i.status} — ${i.progress}${
              i.risks ? ` — risks: ${i.risks}` : ""
            }`
        )
        .join("\n") || "(no active initiatives with activity this period)",
    releases: data.releases.map((r) => `${r.version} — ${r.product ?? "—"} — closed ${r.closedAt ?? "—"}`).join("\n")
  };
}
