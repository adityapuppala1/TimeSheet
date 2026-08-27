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
import { sanitizeRichText } from "../utils/sanitize.js";
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
/** The brand teal, for the two things rich text can carry that the rest of this file cannot:
 *  a link, and a block quote's rule. Matches the header band in mail-templates.ts. */
const ACCENT = "#0F8B96";

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
  const body = (text ?? "").trim();
  // Nothing written: the fallback is PLAIN text this file composed, so it is escaped as before.
  if (!body) return `<p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:${FG};">${escape(fallback)}</p>`;
  return richTextToEmailHtml(body);
}

/**
 * Renders the reviewer's rich text into the email's house style.
 *
 * WHY THIS EXISTS AT ALL. The written sections used to be plain strings and this file `escape`d
 * them. They are rich text now — the editor emits `<p>`, `<strong>`, `<ul>`, `<h3>`, `<blockquote>`
 * — and escaping HTML prints the tags to the reader instead of rendering them, which is precisely
 * the failure the PDF exports were fixed for. So: sanitise, then style.
 *
 * SANITISE FIRST, ALWAYS. This is prose a person typed, arriving from a browser, on its way into an
 * email that leaves this workspace and lands in inboxes belonging to people who have no account
 * here. `sanitizeRichText` reduces it to a known short tag list; everything below assumes that has
 * already happened.
 *
 * WHY INLINE STYLES AND NOT A STYLESHEET. Mail clients ignore `<style>` blocks to varying and
 * unpredictable degrees, and Outlook ignores most of one. Every other block in this file is inline-
 * styled for that reason and this has to match, or the reviewer's paragraph renders in a different
 * font from the paragraph above it.
 *
 * WHY A REGEX OVER HTML IS DEFENSIBLE HERE, given that it usually is not: the input has ALREADY
 * been reduced to a closed set of tags with no attributes worth preserving except `href`, and the
 * only edit being made is adding a `style` to an opening tag whose name is known. It is not parsing
 * the document; it is decorating a whitelist.
 */
function richTextToEmailHtml(html: string): string {
  const clean = sanitizeRichText(html);
  if (!clean) return "";

  const styles: Record<string, string> = {
    p: `margin:6px 0 0;font-size:13px;line-height:1.6;color:${FG};`,
    h1: `margin:16px 0 4px;font-size:16px;font-weight:800;color:${FG};`,
    h2: `margin:14px 0 4px;font-size:15px;font-weight:800;color:${FG};`,
    h3: `margin:12px 0 4px;font-size:14px;font-weight:700;color:${FG};`,
    ul: `margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.6;color:${FG};`,
    ol: `margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.6;color:${FG};`,
    li: "margin:0 0 4px;",
    blockquote: `margin:10px 0;padding:6px 0 6px 12px;border-left:3px solid ${ACCENT};color:${MUTED};font-size:13px;line-height:1.6;`,
    pre: "margin:8px 0;padding:10px;background:#0F172A;color:#E2E8F0;border-radius:6px;font-size:12px;overflow-x:auto;",
    code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;",
    a: `color:${ACCENT};text-decoration:underline;`
  };

  return Object.entries(styles).reduce(
    // Opening tags only. The captured group carries whatever attributes were already there, so a
    // link's href survives being styled.
    //
    // THE DOUBLE BACKSLASH IS LOAD-BEARING. Inside a template literal, a single `\s` is not a regex
    // escape — JavaScript collapses it to a bare "s", so the pattern built was `<p(s[^>]*)?>`. That
    // matched a bare `<p>` by skipping the optional group and silently failed to match any tag WITH
    // attributes, which is every `<a href>` — links would have come out unstyled and nothing would
    // have looked broken enough to notice. Verified by building both patterns and testing them.
    (acc, [tag, style]) =>
      acc.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, "gi"), (_match, attrs: string | undefined) => `<${tag}${attrs ?? ""} style="${style}">`),
    clean
  );
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

/**
 * One list item's worth of rich text: sanitised, then flattened to inline markup.
 *
 * The block wrapper has to go. These fields are single items inside a `<ul>` this file builds, and
 * a `<p>` nested in an `<li>` renders as an extra line break in several mail clients and as nothing
 * in others — so the safest shape is the one with no block element in it at all. A model that
 * ignores the "no bullets, no headings" guidance therefore degrades to a correctly-rendered
 * sentence rather than to a broken list.
 */
function inlineRichText(value: string): string {
  const clean = sanitizeRichText(value);
  if (!clean) return "";
  const inline = clean
    .replace(/<\/(p|h[1-3]|blockquote|li)>/gi, " ")
    .replace(/<(p|h[1-3]|blockquote|ul|ol|li)(\s[^>]*)?>/gi, "")
    .replace(/<\/(ul|ol)>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // Escaped only if sanitising left nothing structural — i.e. it was plain text all along, which is
  // what every pre-3.8 draft and every fallback in this file still is.
  return inline || escape(value);
}

function bulletList(items: string[] | undefined, fallback: string[]): string {
  const rows = (items ?? []).map((v) => v.trim()).filter(Boolean);
  const use = rows.length > 0 ? rows : fallback;
  if (use.length === 0) return prose(undefined, "Nothing to report in this section.");
  return `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.6;color:${FG};">${use
    // Each item may now carry INLINE rich text (a bolded figure, a link) — the editor for these
    // fields hides the block buttons, so what arrives is a phrase, not a document. `inlineRichText`
    // sanitises it and strips any block wrapper the model added anyway, because a `<p>` inside an
    // `<li>` renders as a line break in half the mail clients that exist.
    .map((item) => `<li style="margin:0 0 4px;">${inlineRichText(item)}</li>`)
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
