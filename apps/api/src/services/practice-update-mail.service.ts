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
  type PracticeInitiative,
  type PracticeUpdateData
} from "./practice-update.service.js";
import { EMPTY_PRACTICE_ANALYTICS, type PracticeAnalytics } from "./practice-analytics.service.js";
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

/**
 * The derived layer of a record, or an empty one.
 *
 * `PracticeUpdateRecord.data` is JSON replayed through a cast that checks nothing, so a draft or
 * history row written before this layer existed arrives here with no `analytics` at all. Reading it
 * unconditionally turned every one of those into a 500 on the page a super admin opens. Both
 * renderers below go through this instead — a stored draft degrades to "unmeasured" rows and still
 * sends, which is the whole point of keeping the counted half independent of anything clever.
 */
function analyticsOf(data: PracticeUpdateData, which: "analytics" | "previousAnalytics"): PracticeAnalytics {
  return data[which] ?? EMPTY_PRACTICE_ANALYTICS;
}

/** A rate, or an honest dash. `null` here means the denominator was zero, and printing "0%" for
 *  "nothing was measured" is the single most common way a report says something untrue. */
function pct(value: number | null, note?: string): string {
  if (value === null) return note ? `— (${note})` : "—";
  return `${value}%${note ? ` (${note})` : ""}`;
}

/** A rate with its direction against the period before, in percentage POINTS — a rate that moved
 *  from 40% to 50% rose by 10 points, not by 25%, and reporting the second is how a modest week
 *  gets described as a transformation. */
function pctDelta(current: number | null, previous: number | null, note?: string): string {
  const base = pct(current, note);
  if (current === null || previous === null) return base;
  const diff = Number((current - previous).toFixed(1));
  if (diff === 0) return `${base} (flat)`;
  return `${base} (${diff > 0 ? "+" : ""}${diff} pts)`;
}

/**
 * Key Metrics, in themed blocks rather than one thirty-row list.
 *
 * WHY BLOCKS: this section grew from twelve figures to more than thirty, and a flat table that long
 * is skimmed rather than read — the reader loses which numbers belong to the same question. Each
 * block is one question a director actually asks.
 *
 * WHY AN UNCONFIGURED BLOCK DISAPPEARS ENTIRELY: a workspace with no CI, no change management or no
 * AI teammates would otherwise get a column of zeroes, and a row of zeroes reads as a bad week
 * rather than as an absent integration. The blocks that are always present are the ones every
 * workspace has data for by virtue of using the product at all.
 */
function metricsTable(data: PracticeUpdateData): string {
  const m = data.metrics;
  const p = data.previousMetrics;
  const a = analyticsOf(data, "analytics");
  const pa = analyticsOf(data, "previousAnalytics");

  const block = (title: string, rows: Array<[string, string]>) =>
    rows.length === 0
      ? ""
      : `<p style="margin:14px 0 4px;font-size:12px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:.04em;">${escape(
          title
        )}</p>` +
        dataTable({ head: ["Measure", "This period"], rows: rows.map(([k, v]) => [escape(k), escape(v)]), align: ["l", "r"] });

  const delivery: Array<[string, string]> = [
    ["Tickets closed", withDelta(m.ticketsClosed, p.ticketsClosed)],
    ["Tickets raised", withDelta(m.ticketsCreated, p.ticketsCreated)],
    // The ratio neither count shows on its own: above 100 the backlog shrank, below it grew.
    ["Closure rate (closed ÷ raised)", pctDelta(a.delivery.closureRatePct, pa.delivery.closureRatePct)],
    ["Open backlog", withDelta(a.delivery.backlogOpen, pa.delivery.backlogOpen)],
    [
      "Delivered on time",
      pctDelta(
        a.delivery.onTimeClosurePct,
        pa.delivery.onTimeClosurePct,
        `${a.delivery.closedWithDueDate} had a due date`
      )
    ],
    ["Median cycle time", a.delivery.medianCycleHours === null ? "—" : `${a.delivery.medianCycleHours} h`],
    ["Reopened this period", pct(a.delivery.reopenRatePct, `${a.delivery.reopened} of ${a.delivery.everResolved} resolved`)],
    ["Overdue tickets", withDelta(m.overdue, p.overdue)],
    ["Unassigned open tickets", String(a.delivery.unassignedOpen)],
    ["Timesheet approvals past SLA", withDelta(m.slaBreaches, p.slaBreaches)],
    ["Open escalations", String(m.openEscalations)],
    ["Falls due next week", String(a.delivery.dueNextWeek)]
  ];

  const severity: Array<[string, string]> = [
    ["Critical open / closed", `${a.priority.criticalOpen} / ${a.priority.criticalClosed}`],
    ["High open / closed", `${a.priority.highOpen} / ${a.priority.highClosed}`],
    // The number that should always be zero, so it is stated even when it is.
    ["Critical AND overdue", withDelta(a.priority.criticalOverdue, pa.priority.criticalOverdue)]
  ];

  const quality: Array<[string, string]> =
    a.quality.testRuns + a.quality.gatesPassed + a.quality.gatesWarned + a.quality.gatesFailed === 0
      ? []
      : [
          // Runs and assertions are labelled apart on purpose — see QualityAnalytics for why they
          // can disagree by seventy points and both still be right.
          ["Suite runs (passed / failed)", `${a.quality.testRuns} (${a.quality.runsPassed} / ${a.quality.runsFailed})`],
          ["Suite pass rate", pctDelta(a.quality.runPassRatePct, pa.quality.runPassRatePct)],
          ["Individual tests (passed / failed)", `${a.quality.testsPassed} / ${a.quality.testsFailed}`],
          ["Test pass rate", pctDelta(a.quality.testPassRatePct, pa.quality.testPassRatePct)],
          [
            "Quality gates OK / warn / failed",
            `${a.quality.gatesPassed} / ${a.quality.gatesWarned} / ${a.quality.gatesFailed}`
          ]
        ];

  const security: Array<[string, string]> = [
    ["Open findings (critical / high)", `${m.securityOpenCritical} / ${m.securityOpenHigh}`],
    ["New findings this period", withDelta(m.securityNewFindings, p.securityNewFindings)],
    ["New critical / high", `${a.security.newCritical} / ${a.security.newHigh}`],
    // Proven fixed versus claimed fixed. The gap between the two is the honest remediation figure,
    // and it is the distinction this product was built to make visible.
    ["Verified fixed", withDelta(a.security.verifiedFixed, pa.security.verifiedFixed)],
    ["Awaiting fix verification", String(a.security.awaitingVerification)],
    [
      "Age of open findings (median / oldest)",
      a.security.medianOpenAgeDays === null ? "—" : `${a.security.medianOpenAgeDays} d / ${a.security.oldestOpenDays} d`
    ],
    ["Scans run", String(a.security.scanRuns)]
  ];

  const change: Array<[string, string]> =
    m.changesRaised + m.changesImplemented + a.change.outcomeRecorded + a.change.awaitingApproval === 0
      ? []
      : [
          ["Changes raised / implemented", `${m.changesRaised} / ${m.changesImplemented}`],
          ["Releases shipped", withDelta(m.releases, p.releases)],
          ["Change success rate", pct(a.change.successRatePct, `${a.change.outcomeRecorded} with a recorded outcome`)],
          ["Failed / rolled back", `${a.change.failed} / ${a.change.rolledBack}`],
          ["Emergency changes", withDelta(a.change.emergency, pa.change.emergency)],
          ["Awaiting approval", String(a.change.awaitingApproval)],
          ["Scheduled to start next week", String(a.change.scheduledNextWeek)]
        ];

  const people: Array<[string, string]> = [
    ["Hours logged", withDelta(m.hours, p.hours, " h")],
    ["Contributors", withDelta(m.contributors, p.contributors)],
    [
      "Utilisation against capacity",
      pctDelta(
        a.people.utilisationPct,
        pa.people.utilisationPct,
        a.people.capacityHours === null ? "no capacity on file" : `${a.people.capacityHours} h capacity`
      )
    ],
    ["Billable share of hours", pctDelta(a.people.billablePct, pa.people.billablePct)],
    ["Training & capability hours", withDelta(m.trainingHours, p.trainingHours, " h")],
    ["Holding open work, logged nothing", String(a.people.silentOwners)]
  ];

  const goals: Array<[string, string]> =
    a.goals.active + a.goals.achievedThisPeriod === 0
      ? []
      : [
          ["Goals active", String(a.goals.active)],
          ["Achieved this period", String(a.goals.achievedThisPeriod)],
          ["Past their end date", String(a.goals.overdue)]
        ];

  // An AI/ML practice reporting on its own use of AI. Omitted where nothing has run.
  const ai: Array<[string, string]> =
    a.ai.agentRuns + a.ai.interactions === 0
      ? []
      : [
          ["AI teammate runs (failed)", `${a.ai.agentRuns} (${a.ai.agentRunsFailed})`],
          ["AI interactions", withDelta(a.ai.interactions, pa.ai.interactions)],
          ["AI spend", a.ai.spendUsd === null ? "—" : `$${a.ai.spendUsd.toFixed(2)}`]
        ];

  return [
    block("Delivery & flow", delivery),
    block("Severity", severity),
    block("Quality & testing", quality),
    block("Security", security),
    block("Change & release", change),
    block("People & capacity", people),
    block("Goals", goals),
    block("AI practice", ai)
  ].join("");
}

/** Who moved the most this period. Under People rather than as a section of its own: the request
 *  asked for visibility of where effort went, not for a scoreboard. */
function contributorTable(data: PracticeUpdateData): string {
  const rows = analyticsOf(data, "analytics").people.topContributors.map((c) => [escape(c.name), `${c.hours} h`, String(c.ticketsClosed)]);
  return dataTable({
    head: ["Contributor", "Hours", "Tickets closed"],
    rows,
    align: ["l", "r", "r"],
    empty: "Nobody logged time in this period."
  });
}

/**
 * The per-initiative table the request asked for: Owner, Status, This Week's Progress, Next Steps,
 * Risks / Dependencies.
 */
function initiativeTable(data: PracticeUpdateData, nextStepById: Map<string, string>, category: string): string {
  const rows = data.initiatives
    .filter((i) => i.category === category)
    .map((i) => [
      // Name, code and open work in ONE cell rather than in three.
      //
      // WHY: an email body is ~560px wide, and the open count arrived as a seventh column — at which
      // point "1 closed · 1 raised · 8.5 h logged" wrapped onto five lines and the table stopped
      // being readable at exactly the moment it gained the information worth reading. Stock ("172
      // open, 2 critical") belongs beside the thing it describes anyway; the columns that remain are
      // all flow and judgement, which is what the requested format actually asks for.
      //
      // The severity counts are defaulted because an initiative inside a draft stored before this
      // release carries neither field: `undefined + undefined` is NaN, `NaN === 0` is false, and the
      // cell would have rendered "undefined crit · undefined high" into a leadership email.
      `<strong>${escape(i.name)}</strong>` +
        `<br><span style="color:${MUTED};font-size:11px;">` +
        [
          i.code ? escape(i.code) : null,
          `${i.openCount} open`,
          (i.criticalOpen ?? 0) > 0 ? `${i.criticalOpen} critical` : null,
          (i.highOpen ?? 0) > 0 ? `${i.highOpen} high` : null
        ]
          .filter(Boolean)
          .join(" · ") +
        "</span>",
      escape(i.owner ?? "—"),
      RAG_EMOJI[i.status],
      escape(i.progress),
      // The model writes a next step when it can; when it cannot, the nearest real deadline on the
      // initiative is a better answer than a dash, and it is a fact rather than a guess.
      escape(nextStepById.get(i.id) ?? derivedNextStep(i)),
      escape(i.risks || "—")
    ]);

  return dataTable({
    head: ["Initiative", "Owner", "Status", "This period", "Next steps", "Risks / dependencies"],
    rows,
    align: ["l", "l", "l", "l", "l", "l"],
    empty: "Nothing in this area this period."
  });
}

/**
 * What to print under "Next steps" when the model wrote nothing for this initiative.
 *
 * A dash tells the reader nothing and makes the column look broken. The nearest unmet deadline is
 * the most useful fact the data can offer without inventing intent, and it degrades in a defined
 * order: a dated commitment, then the shape of the backlog, then an honest "nothing scheduled".
 */
function derivedNextStep(i: PracticeInitiative): string {
  if (i.nextDueDate) return `Next deadline ${i.nextDueDate}`;
  if ((i.criticalOpen ?? 0) > 0) return `Clear ${i.criticalOpen} critical`;
  if (i.overdueCount > 0) return `Clear ${i.overdueCount} overdue`;
  if (i.openCount > 0) return `${i.openCount} open, none dated`;
  return "Nothing scheduled";
}

/**
 * What genuinely needs somebody with authority, when the model wrote nothing.
 *
 * Deliberately conservative: only items where the blocker is a DECISION rather than effort. A list
 * that fills up with work in progress trains the reader to skip the section, which is the opposite
 * of what a "Decisions / Support Required" heading is for.
 */
function decisionsFallback(data: PracticeUpdateData): string[] {
  const a = analyticsOf(data, "analytics");
  const m = data.metrics;
  const lines = [
    m.securityOpenCritical > 0
      ? `${m.securityOpenCritical} critical security finding${
          m.securityOpenCritical === 1 ? " remains" : "s remain"
        } open and need${m.securityOpenCritical === 1 ? "s" : ""} a remediation owner.`
      : null,
    a.change.awaitingApproval > 0
      ? `${a.change.awaitingApproval} change${a.change.awaitingApproval === 1 ? " is" : "s are"} waiting on approval.`
      : null,
    a.delivery.unassignedOpen > 0
      ? `${a.delivery.unassignedOpen} open ticket${a.delivery.unassignedOpen === 1 ? "" : "s"} still need an owner.`
      : null,
    // Sustained over-capacity is a staffing decision, not something the team can work harder at.
    a.people.utilisationPct !== null && a.people.utilisationPct > 100
      ? `Utilisation ran at ${a.people.utilisationPct}% of capacity — sustained, that is a staffing decision.`
      : null,
    a.goals.overdue > 0 ? `${a.goals.overdue} goal${a.goals.overdue === 1 ? " is" : "s are"} past their end date and need re-planning.` : null
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines : ["No decisions are being requested this period."];
}

export interface PracticeUpdateEmail {
  subject: string;
  headline: string;
  sectionsHtml: string;
}

export function buildPracticeUpdateEmail(data: PracticeUpdateData, narrative: PracticeUpdateNarrative | null): PracticeUpdateEmail {
  const { metrics } = data;
  const nextStepById = new Map((narrative?.nextSteps ?? []).map((s) => [s.id, s.text]));

  const red = data.initiatives.filter((i) => i.status === "RED");
  const amber = data.initiatives.filter((i) => i.status === "AMBER");

  const strip = periodStrip([
    { label: "Tickets closed", value: String(metrics.ticketsClosed), sub: `${metrics.ticketsCreated} raised` },
    { label: "Hours logged", value: `${metrics.hours}`, sub: `${metrics.contributors} contributors` },
    { label: "At risk", value: String(red.length), sub: `${amber.length} amber · ${metrics.slaBreaches} approvals past SLA` }
  ]);

  // 1. Executive summary.
  const summaryFallback =
    `${metrics.ticketsClosed} tickets closed and ${metrics.ticketsCreated} raised across ${data.initiatives.length} initiatives, ` +
    `with ${metrics.hours} hours logged by ${metrics.contributors} people. ` +
    (red.length > 0
      ? `${red.length} initiative${red.length === 1 ? " is" : "s are"} red: ${red.map((i) => i.name).join(", ")}.`
      : "Nothing is currently red.");

  // The facts behind each narrative section, used when no prose was written for it.
  const a = analyticsOf(data, "analytics");
  // Blockers that belong to nobody in particular, so no initiative row carries them and the model
  // would have nothing to write from. Each one is a counted fact with a named consequence.
  const systemicRisks = [
    a.priority.criticalOverdue > 0
      ? `${a.priority.criticalOverdue} critical ticket${a.priority.criticalOverdue === 1 ? " is" : "s are"} past SLA.`
      : null,
    a.delivery.unassignedOpen > 0
      ? `${a.delivery.unassignedOpen} open ticket${a.delivery.unassignedOpen === 1 ? " has" : "s have"} no assignee.`
      : null,
    a.delivery.closureRatePct !== null && a.delivery.closureRatePct < 100
      ? `The backlog grew: ${a.delivery.closureRatePct}% closure rate against what was raised.`
      : null,
    a.security.awaitingVerification > 0
      ? `${a.security.awaitingVerification} security fix${a.security.awaitingVerification === 1 ? "" : "es"} claimed but not yet proven by a re-scan.`
      : null,
    a.change.failed + a.change.rolledBack > 0
      ? `${a.change.failed + a.change.rolledBack} change${a.change.failed + a.change.rolledBack === 1 ? "" : "s"} failed or was rolled back.`
      : null,
    a.people.silentOwners > 0
      ? `${a.people.silentOwners} ${a.people.silentOwners === 1 ? "person holds" : "people hold"} open work but logged no time.`
      : null
  ].filter((line): line is string => Boolean(line));

  const risksFallback =
    red.length + amber.length + systemicRisks.length === 0
      ? ["Nothing is overdue or breaching SLA in this period."]
      : [...[...red, ...amber].map((i) => `${RAG_EMOJI[i.status]} ${i.name} — ${i.risks || "no detail recorded"}`), ...systemicRisks];

  const sections = [
    strip,
    sectionHeading("Executive Summary"),
    prose(narrative?.executiveSummary, summaryFallback),
    ...PRACTICE_CATEGORIES.flatMap(({ key, label }) => {
      const has = data.initiatives.some((i) => i.category === key);
      // A category with nothing in it is omitted rather than printed empty — ten headings with
      // five "nothing here" boxes under them is how a weekly update starts getting deleted unread.
      if (!has) return [];
      // "New, ongoing and completed POCs" was asked for in those words, and the three counts are
      // not readable off a table of initiatives.
      const lifecycle =
        key === "POC"
          ? prose(
              undefined,
              `${a.poc.started} started this period · ${a.poc.ongoing} ongoing · ` +
                `${a.poc.completed} completed · ${a.poc.hours} h invested`
            )
          : "";
      return [sectionHeading(label), lifecycle, initiativeTable(data, nextStepById, key)];
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
    metricsTable(data),
    sectionHeading("Where the effort went"),
    contributorTable(data),
    sectionHeading("Risks / Blockers"),
    bulletList(narrative?.risks, risksFallback),
    sectionHeading("Next Week Priorities"),
    bulletList(narrative?.nextWeekPriorities, [
      // Dated commitments first: these are the only "next week" facts the data actually holds.
      ...(a.delivery.dueNextWeek > 0 ? [`${a.delivery.dueNextWeek} tickets fall due next week.`] : []),
      ...(a.change.scheduledNextWeek > 0
        ? [`${a.change.scheduledNextWeek} change${a.change.scheduledNextWeek === 1 ? " is" : "s are"} scheduled to start next week.`]
        : []),
      ...red.map((i) => `Clear the backlog on ${i.name} (${i.risks || "overdue work"})`)
    ]),
    sectionHeading("Decisions / Support Required"),
    bulletList(narrative?.decisionsRequired, decisionsFallback(data))
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
  const a = analyticsOf(data, "analytics");
  const pa = analyticsOf(data, "previousAnalytics");

  /** A rate for the prompt. Says "not measured" rather than "0%", for the same reason the email
   *  prints a dash: a model handed "0%" will write a sentence about a failure that did not happen. */
  const r = (value: number | null, unit = "%") => (value === null ? "not measured" : `${value}${unit}`);
  const dir = (current: number | null, previous: number | null) => {
    if (current === null || previous === null) return "";
    const diff = Number((current - previous).toFixed(1));
    return diff === 0 ? " (flat)" : ` (${diff > 0 ? "+" : ""}${diff} pts vs last period)`;
  };

  /**
   * WHY THE PROMPT GETS SO MUCH MORE THAN THE HEADLINE COUNTS: an executive summary written from
   * "42 closed, 38 raised, 190 hours" can only ever restate those three numbers, which the reader
   * can already see in the table underneath. The sentences worth having — "the backlog grew for the
   * third week", "two critical findings have been open a month", "utilisation is over capacity" —
   * need the ratios, the ages and the directions. Every line below is a counted fact; none of it
   * asks the model to judge, only to notice and to prioritise.
   *
   * Blocks whose subsystem is not configured are omitted rather than sent as zeroes. A model told
   * "0 test runs, 0 quality gates" will faithfully report a testing collapse in a workspace that
   * has simply never connected a CI system.
   */
  const lines = [
    "DELIVERY",
    `Tickets closed: ${withDelta(m.ticketsClosed, p.ticketsClosed)}; raised: ${withDelta(m.ticketsCreated, p.ticketsCreated)}`,
    `Closure rate (closed ÷ raised): ${r(a.delivery.closureRatePct)}${dir(a.delivery.closureRatePct, pa.delivery.closureRatePct)} — above 100% means the backlog shrank`,
    `Open backlog now: ${a.delivery.backlogOpen} (was ${pa.delivery.backlogOpen})`,
    `Delivered on time: ${r(a.delivery.onTimeClosurePct)} of the ${a.delivery.closedWithDueDate} closed items that had a due date`,
    `Median cycle time: ${r(a.delivery.medianCycleHours, " h")}`,
    `Reopened within the period: ${a.delivery.reopened} of the ${a.delivery.everResolved} resolved in it (${r(a.delivery.reopenRatePct)})`,
    `Tickets past SLA: ${withDelta(m.overdue, p.overdue)}; unassigned open: ${a.delivery.unassignedOpen}; open escalations: ${m.openEscalations}`,
    `Timesheet approvals past SLA (a different queue from the tickets above, do not add them together): ${withDelta(m.slaBreaches, p.slaBreaches)}`,
    `Falls due next week: ${a.delivery.dueNextWeek} tickets`,
    "",
    "SEVERITY",
    `Critical: ${a.priority.criticalOpen} open, ${a.priority.criticalClosed} closed this period, ${a.priority.criticalOverdue} of the open ones past SLA`,
    `High: ${a.priority.highOpen} open, ${a.priority.highClosed} closed this period`,
    "",
    "SECURITY",
    `Open findings: ${m.securityOpenCritical} critical, ${m.securityOpenHigh} high`,
    `New this period: ${withDelta(m.securityNewFindings, p.securityNewFindings)} (${a.security.newCritical} critical, ${a.security.newHigh} high)`,
    `Verified fixed: ${withDelta(a.security.verifiedFixed, pa.security.verifiedFixed)}; claimed fixed but not yet proven by a re-scan: ${a.security.awaitingVerification}`,
    `Open findings age: median ${r(a.security.medianOpenAgeDays, " days")}, oldest ${r(a.security.oldestOpenDays, " days")}`,
    `Scans run: ${a.security.scanRuns}`,
    "",
    "PEOPLE & CAPACITY",
    `Hours logged: ${withDelta(m.hours, p.hours, " h")} by ${m.contributors} people`,
    `Utilisation against capacity: ${r(a.people.utilisationPct)}${dir(a.people.utilisationPct, pa.people.utilisationPct)}${
      a.people.capacityHours === null ? " (no contracted hours on file)" : ` of ${a.people.capacityHours} h`
    }`,
    `Billable share: ${r(a.people.billablePct)}; training & capability hours: ${withDelta(m.trainingHours, p.trainingHours, " h")}`,
    `Holding open work but logged no time: ${a.people.silentOwners} people`,
    a.people.topContributors.length
      ? `Most active: ${a.people.topContributors.map((c) => `${c.name} (${c.hours} h, ${c.ticketsClosed} closed)`).join("; ")}`
      : "Most active: nobody logged time",
    "",
    "POCs",
    `${a.poc.started} started this period, ${a.poc.ongoing} ongoing, ${a.poc.completed} completed, ${a.poc.hours} h invested`
  ];

  if (a.quality.testRuns + a.quality.gatesPassed + a.quality.gatesWarned + a.quality.gatesFailed > 0) {
    lines.push(
      "",
      "QUALITY & TESTING",
      `Suite runs: ${withDelta(a.quality.testRuns, pa.quality.testRuns)} — ${a.quality.runsPassed} passed, ${a.quality.runsFailed} failed (suite pass rate ${r(a.quality.runPassRatePct)}${dir(a.quality.runPassRatePct, pa.quality.runPassRatePct)})`,
      `Individual tests: ${a.quality.testsPassed} passed, ${a.quality.testsFailed} failed (test pass rate ${r(a.quality.testPassRatePct)}) — a failing suite can still contain mostly passing tests, so these two rates differ legitimately`,
      `Quality gates: ${a.quality.gatesPassed} OK, ${a.quality.gatesWarned} warned, ${a.quality.gatesFailed} failed`
    );
  }

  if (m.changesRaised + m.changesImplemented + a.change.outcomeRecorded + a.change.awaitingApproval > 0) {
    lines.push(
      "",
      "CHANGE & RELEASE",
      `Changes raised: ${m.changesRaised}; implemented: ${m.changesImplemented}; releases shipped: ${withDelta(m.releases, p.releases)}`,
      `Outcomes recorded: ${a.change.outcomeRecorded} — ${a.change.successful} successful, ${a.change.withIssues} with issues, ${a.change.failed} failed, ${a.change.rolledBack} rolled back (success rate ${r(a.change.successRatePct)})`,
      `Emergency changes raised: ${a.change.emergency}; awaiting approval: ${a.change.awaitingApproval}; scheduled to start next week: ${a.change.scheduledNextWeek}`
    );
  }

  if (a.goals.active + a.goals.achievedThisPeriod > 0) {
    lines.push("", "GOALS", `${a.goals.active} active, ${a.goals.achievedThisPeriod} achieved this period, ${a.goals.overdue} past their end date`);
  }

  if (a.ai.agentRuns + a.ai.interactions > 0) {
    lines.push(
      "",
      "AI PRACTICE (this team's own AI usage)",
      `AI teammate runs: ${a.ai.agentRuns} (${a.ai.agentRunsFailed} failed); AI interactions: ${withDelta(a.ai.interactions, pa.ai.interactions)}; spend: ${
        a.ai.spendUsd === null ? "not recorded" : `$${a.ai.spendUsd.toFixed(2)}`
      }`
    );
  }

  return {
    metrics: lines.join("\n"),
    initiatives:
      data.initiatives
        .map((i) => {
          const detail = [
            `owner ${i.owner ?? "unassigned"}`,
            i.status,
            i.progress,
            `${i.openCount} open`,
            (i.criticalOpen ?? 0) > 0 ? `${i.criticalOpen} critical` : null,
            (i.highOpen ?? 0) > 0 ? `${i.highOpen} high` : null,
            i.nextDueDate ? `next deadline ${i.nextDueDate}` : null,
            i.risks ? `risks: ${i.risks}` : null
          ]
            .filter(Boolean)
            .join(" — ");
          return `[${i.category}] ${i.name} (id ${i.id}) — ${detail}`;
        })
        .join("\n") || "(no active initiatives with activity this period)",
    releases: data.releases.map((r2) => `${r2.version} — ${r2.product ?? "—"} — closed ${r2.closedAt ?? "—"}`).join("\n")
  };
}
