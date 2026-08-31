/**
 * WHAT: the built-in default HTML for every transactional email this app sends (welcome,
 * password reset, timesheet status changes, SLA/escalation, reminders, ticket lifecycle
 * notifications) — one branded shell + one render function per template key.
 * WHY: these are the fallback bodies used whenever an org hasn't customized a template (see
 * `template-store.service.ts`/`email-templates.controller.ts`, which let a SUPER_ADMIN override
 * any of these per-org) — so a brand-new org always has working, reasonably-designed email
 * without configuring anything first.
 * WHO calls this: `services/notify.service.ts`'s `fallback.html` argument at every dispatch
 * call site across the codebase, and `template-store.service.ts` (for the variable list per key).
 */
import { env } from "../config/env.js";

const BRAND = "TimeSphere";
const PRIMARY = "#0F9AA8";
const ACCENT = "#F59E0B";
const DESTRUCTIVE = "#DC2626";
const SUCCESS = "#16A34A";
const SURFACE = "#F7F9FB";
const FG = "#0F172A";
const MUTED = "#64748B";

interface ShellOptions {
  title: string;
  preheader?: string;
  accentColor?: string;
}

function shell({ title, preheader, accentColor = PRIMARY }: ShellOptions, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escape(title)}</title>
  </head>
  <body style="margin:0;background:${SURFACE};font-family:Inter,Segoe UI,-apple-system,BlinkMacSystemFont,sans-serif;color:${FG};">
    ${preheader ? `<div style="display:none;font-size:1px;color:${SURFACE};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escape(preheader)}</div>` : ""}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${SURFACE};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 14px 40px rgba(15,23,42,0.08);">
            <tr>
              <td style="background:${accentColor};padding:20px 28px;color:#ffffff;font-weight:800;font-size:18px;letter-spacing:.3px;">${BRAND}</td>
            </tr>
            <tr>
              <td style="padding:28px;">
                ${body}
                <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;" />
                <p style="margin:0;color:${MUTED};font-size:12px;line-height:18px;">
                  You're receiving this because of activity on your ${BRAND} workspace.<br />
                  Manage notification preferences inside the app.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(label: string, href: string, color = PRIMARY): string {
  return `<a href="${href}" style="display:inline-block;background:${color};color:#ffffff;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none;font-size:14px;">${escape(label)}</a>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;color:${FG};font-size:14px;line-height:22px;">${text}</p>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;letter-spacing:-0.2px;color:${FG};">${escape(text)}</h1>`;
}

function infoCard(rows: Array<[string, string]>, color = PRIMARY): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #E2E8F0;border-left:4px solid ${color};border-radius:10px;margin:16px 0;">
    ${rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:8px 14px;font-size:12px;color:${MUTED};width:38%;text-transform:uppercase;letter-spacing:.6px;font-weight:600;">${escape(label)}</td><td style="padding:8px 14px;font-size:14px;color:${FG};font-weight:600;">${value}</td></tr>`
      )
      .join("")}
  </table>`;
}

function escape(input: string | number | undefined | null): string {
  if (input === null || input === undefined) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const appUrl = (path = "") => `${env.APP_BASE_URL.replace(/\/$/, "")}${path}`;

/**
 * A numeric field that may arrive as a `{{placeholder}}`.
 *
 * WHY: these same template functions are rendered twice — once for a real send, with real values, and
 * once with every argument set to its own `{{name}}` so the Email Templates editor can show the REAL
 * default body instead of a stub. `(8).toFixed(2)` is fine; `"{{hours}}".toFixed(2)` throws, and the
 * editor would then show nothing at all for exactly the templates that carry numbers. Five call sites
 * needed this; the rest of the fields are strings and survive unchanged.
 */
const num = (value: number | string, digits = 2): string => (typeof value === "number" ? value.toFixed(digits) : String(value));

/** Same idea for a fraction rendered as a percentage. */
const pct = (value: number | string): string => (typeof value === "number" ? `${Math.round(value * 100)}%` : String(value));

/**
 * Rows for an info card, with the empty ones dropped.
 *
 * WHY: a timesheet entry may have no submodule, no ticket and no description, and an info card that
 * prints "SUBMODULE  —" three times buries the two rows that matter. Passing `null` for a field that
 * genuinely has no value is how a caller says "leave it out", and this is the one place that decides
 * what that means so every template agrees.
 *
 * A `{{placeholder}}` is deliberately NOT empty: the editor's default body has to show every row an
 * administrator might want to keep or delete.
 */
const rows = (pairs: Array<[string, string | null | undefined]>): Array<[string, string]> =>
  pairs.filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].trim().length > 0);

/**
 * Free text somebody typed — a description, a comment, a rejection reason — as a readable block
 * rather than a table cell.
 *
 * Escaped, then newlines become `<br>`: a comment written over four lines arrives as four lines. It is
 * clipped at a length that stays an email rather than a document, and says so when it clips, because
 * silently truncating somebody's comment is how a reader misses the sentence that mattered.
 */
/**
 * A link to ONE ticket, not to the list.
 *
 * Every ticket email used to send the reader to `/app/tickets` and leave them to find the ticket the
 * mail was about — in a workspace with seventeen hundred of them. `?open=<id>` is the same deep link
 * the in-app notifications already use, so both routes land on the same panel.
 *
 * Falls back to the list when the caller has no id, which is honest: a link that 404s is worse than
 * one that needs a click.
 */
const ticketUrl = (ticketId?: string | null) => appUrl(ticketId ? `/app/tickets?open=${ticketId}` : "/app/tickets");

/**
 * A data table that survives an email client.
 *
 * WHY IT IS BUILT BY HAND AND FULLY INLINE-STYLED: Outlook strips `<style>` blocks, Gmail strips
 * classes, and neither reliably honours `border-collapse` from anywhere but an inline attribute. The
 * shell above already accepts this constraint; this extends it to tabular data rather than dropping a
 * `<div>` grid into an email and hoping.
 *
 * WHY EVERY NUMERIC COLUMN IS RIGHT-ALIGNED AND TABULAR: a column of hours that does not line up is a
 * column nobody compares, which defeats the point of sending a table rather than a sentence.
 *
 * `align` is per column, so a caller states it once instead of at every cell.
 */
function dataTable(params: {
  caption?: string;
  head: string[];
  rows: string[][];
  /** "l" | "r" per column. Defaults to left for the first and right for the rest, which is what a
   *  label-then-numbers table wants and saves every caller from spelling it out. */
  align?: Array<"l" | "r">;
  /** Shown INSTEAD of the table when there are no rows — never an empty grid, and never a zero that
   *  reads as a measurement. */
  empty?: string;
}): string {
  const align = params.align ?? params.head.map((_, i) => (i === 0 ? "l" : "r"));
  const cell = (content: string, i: number, header: boolean) =>
    `<td style="padding:7px 10px;font-size:${header ? "11px" : "13px"};${
      header ? `color:${MUTED};text-transform:uppercase;letter-spacing:.5px;font-weight:700;` : `color:${FG};`
    }text-align:${align[i] === "r" ? "right" : "left"};${align[i] === "r" && !header ? "font-variant-numeric:tabular-nums;" : ""}border-bottom:1px solid #EEF2F7;">${content}</td>`;

  const caption = params.caption
    ? `<div style="margin:18px 0 6px;font-size:13px;font-weight:700;color:${FG};">${escape(params.caption)}</div>`
    : "";

  if (params.rows.length === 0) {
    return `${caption}<div style="padding:10px 12px;border:1px dashed #E2E8F0;border-radius:8px;font-size:13px;color:${MUTED};">${escape(
      params.empty ?? "Nothing in this period."
    )}</div>`;
  }

  return `${caption}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #E2E8F0;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;margin:0 0 6px;">
    <tr style="background:${SURFACE};">${params.head.map((h, i) => cell(escape(h), i, true)).join("")}</tr>
    ${params.rows.map((r) => `<tr>${r.map((c, i) => cell(c, i, false)).join("")}</tr>`).join("")}
  </table>`;
}

/**
 * The three-period strip every digest leads with: last week, month to date, year to date.
 *
 * WHY A STRIP AND NOT THREE TABLES: the question a manager opens this to answer is "is this week
 * normal", and that is a comparison. Three numbers side by side answer it in one glance; three tables
 * make the reader do the arithmetic.
 */
function periodStrip(cells: Array<{ label: string; value: string; sub?: string }>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0;border-collapse:separate;border-spacing:6px 0;">
    <tr>${cells
      .map(
        (c) =>
          `<td width="33%" style="background:${SURFACE};border:1px solid #E2E8F0;border-radius:10px;padding:12px 10px;text-align:center;">
            <div style="font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:${MUTED};font-weight:700;">${escape(c.label)}</div>
            <div style="font-size:20px;font-weight:800;color:${FG};margin-top:3px;font-variant-numeric:tabular-nums;">${escape(c.value)}</div>
            ${c.sub ? `<div style="font-size:11px;color:${MUTED};margin-top:2px;">${escape(c.sub)}</div>` : ""}
          </td>`
      )
      .join("")}</tr>
  </table>`;
}

/** A share, or an em dash when the denominator is zero — "0%" of nothing is a claim, not a measurement. */
function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function quoted(text: string, limit = 1200): string {
  const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
  const body = escape(clipped).replace(/\r?\n/g, "<br />");
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0;"><tr><td style="border-left:3px solid #CBD5E1;padding:2px 0 2px 14px;font-size:14px;line-height:1.6;color:${FG};">${body}${
    text.length > limit ? `<div style="margin-top:8px;font-size:12px;color:${MUTED};">Clipped — open it in TimeSphere to read the rest.</div>` : ""
  }</td></tr></table>`;
}


export const templates = {
  welcome: (name: string) =>
    shell(
      { title: `Welcome to ${BRAND}`, preheader: "Your account is ready." },
      heading(`Welcome aboard, ${escape(name.split(" ")[0])}!`) +
        paragraph("Your TimeSphere account is provisioned. Log your first timesheet, track approvals, and stay on top of SLA deadlines from a single place.") +
        paragraph(button("Open your dashboard", appUrl("/app")))
    ),

  /** The trial is still running and ends soon. Names the deadline and the one action. */
  trialEnding: (workspace: string, daysLeft: number, billingUrl: string) =>
    shell(
      { title: "Your trial ends soon", preheader: `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left on ${workspace}.`, accentColor: ACCENT },
      heading(`${daysLeft} ${daysLeft === 1 ? "day" : "days"} left on your trial`) +
        paragraph(`Your <strong>${workspace}</strong> workspace is on a free trial that ends in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}.`) +
        paragraph("Add a plan before then and nothing changes — same workspace, same data, same people. Nothing is deleted if you don't.") +
        paragraph(button("Choose a plan", billingUrl, ACCENT))
    ),

  /** The trial has ended. States plainly what still works, because the alternative reading is
   *  "they deleted our data", and that is the one a customer assumes by default. */
  trialEnded: (workspace: string, graceDays: number, billingUrl: string) =>
    shell(
      { title: "Your trial has ended", preheader: `${workspace} is paused — your data is intact.`, accentColor: ACCENT },
      heading("Your trial has ended") +
        paragraph(`<strong>${workspace}</strong> is paused. Everything in it is exactly where you left it — nothing has been deleted and nothing will be for at least ${graceDays} days.`) +
        paragraph("A workspace admin can sign in to choose a plan, or to export your data. Everyone else will see a short notice instead of the app until a plan is active.") +
        paragraph(button("Choose a plan", billingUrl, ACCENT))
    ),

  /** A renewal payment failed. Different from a trial ending: they already decided to buy. */
  paymentFailed: (workspace: string, graceDays: number, billingUrl: string) =>
    shell(
      { title: "A payment didn't go through", preheader: `Update the card on ${workspace}.`, accentColor: ACCENT },
      heading("A payment didn't go through") +
        paragraph(`We couldn't take payment for <strong>${workspace}</strong>. This is usually an expired card.`) +
        paragraph(`The workspace is paused for now and your data is untouched. Update the payment method within ${graceDays} days and everything resumes exactly as it was.`) +
        paragraph(button("Update payment method", billingUrl, ACCENT))
    ),

  /**
   * The receipt for a plan change — the only thing that arrives in an inbox when money moves here.
   *
   * Says WHICH plan and WHERE the invoice is, and nothing else. It is deliberately not a marketing
   * email about the features just unlocked: this is the mail a finance team forwards, and the one a
   * customer opens when they are trying to work out what a line on a card statement was. It carries
   * no amount, because the amount lives on the invoice and a prorated charge quoted here would
   * disagree with the one Stripe actually took.
   */
  planChanged: (workspace: string, plan: string, billingUrl: string) =>
    shell(
      { title: "Your plan has changed", preheader: `${workspace} is now on ${plan}.`, accentColor: SUCCESS },
      heading("Your plan has changed") +
        paragraph(`<strong>${escape(workspace)}</strong> is now on the <strong>${escape(plan)}</strong> plan. It's active right away — nobody has to sign out and back in.`) +
        infoCard([["Workspace", escape(workspace)], ["Plan", escape(plan)]], SUCCESS) +
        paragraph("Your invoices, receipts and payment method are all in Billing, and any change to a plan mid-month is prorated on your next one.") +
        paragraph(button("View billing", billingUrl, SUCCESS))
    ),

  /** The "find my workspace" verification code. Deliberately terse: the code IS the content, and a
   *  wall of explanation around a six-digit number is how a phishing template reads. */
  workspaceFind: (code: string) =>
    shell(
      { title: "Your verification code", preheader: "Enter this code to see your workspaces.", accentColor: ACCENT },
      heading("Your verification code") +
        paragraph("Enter this code to see the workspaces this address can sign in to. It expires in 10 minutes.") +
        `<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;color:${ACCENT};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</p>` +
        paragraph(`<span style="color:${MUTED};">If you didn't ask to find your workspaces, you can safely ignore this email — nobody can use this code without your inbox.</span>`)
    ),

  reset: (resetUrl: string) =>
    shell(
      { title: "Reset your password", preheader: "Reset link inside — expires in 30 minutes.", accentColor: ACCENT },
      heading("Reset your password") +
        paragraph("Click the button below to set a new password. The link expires in 30 minutes for your security.") +
        paragraph(button("Reset password", resetUrl, ACCENT)) +
        paragraph(`<span style="color:${MUTED};">If you didn't request a reset, you can safely ignore this email.</span>`)
    ),

  /**
   * WHAT CHANGED AND WHY: this used to carry date, project and hours — which is enough to know an
   * entry exists and not enough to approve it. An approver reading it on a phone had to open the app
   * to answer "what was actually done", so the mail was a notification that a decision was needed
   * somewhere else. It now carries the module, submodule, activity, linked ticket and the description
   * the person wrote, which is the whole entry.
   *
   * Empty fields are dropped rather than printed as dashes (see `rows`), so an entry with no
   * submodule and no ticket reads as short instead of as mostly missing.
   */
  timesheetSubmitted: (params: {
    name: string;
    hours: number | string;
    date: string;
    project: string;
    managerName?: string | null;
    module?: string | null;
    submodule?: string | null;
    activity?: string | null;
    description?: string | null;
    ticketRef?: string | null;
  }) =>
    shell(
      { title: "Timesheet submitted", preheader: `${params.hours}h on ${params.project} for ${params.date}.` },
      heading("Your timesheet was submitted") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, your entry is now in the approval queue${params.managerName ? ` with ${escape(params.managerName)}` : ""}.`) +
        infoCard(
          rows([
            ["Date", escape(params.date)],
            ["Hours", `${num(params.hours)}h`],
            ["Project", escape(params.project)],
            ["Module", escape(params.module)],
            ["Submodule", escape(params.submodule)],
            ["Activity", escape(params.activity)],
            ["Ticket", escape(params.ticketRef)]
          ])
        ) +
        (params.description ? quoted(params.description) : "") +
        paragraph(button("View status", appUrl("/app/history")))
    ),

  timesheetApproved: (params: {
    name: string;
    hours: number | string;
    date: string;
    reviewer: string;
    project: string;
    module?: string | null;
    submodule?: string | null;
    activity?: string | null;
    description?: string | null;
  }) =>
    shell(
      { title: "Timesheet approved", preheader: `Approved by ${params.reviewer}.`, accentColor: SUCCESS },
      heading("Approved") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, your ${num(params.hours)}h entry for ${escape(params.date)} on <strong>${escape(params.project)}</strong> was approved by ${escape(params.reviewer)}.`) +
        // Which entry, spelled out: somebody with four entries awaiting approval cannot tell from a
        // date and a project alone which one this is about.
        infoCard(
          rows([
            ["Module", escape(params.module)],
            ["Submodule", escape(params.submodule)],
            ["Activity", escape(params.activity)]
          ]),
          SUCCESS
        ) +
        (params.description ? quoted(params.description) : "") +
        paragraph(button("View history", appUrl("/app/history"), SUCCESS))
    ),

  timesheetRejected: (params: {
    name: string;
    date: string;
    project: string;
    reviewer: string;
    reason: string;
    module?: string | null;
    submodule?: string | null;
    activity?: string | null;
    description?: string | null;
  }) =>
    shell(
      { title: "Timesheet rejected", preheader: `Reviewer: ${params.reviewer}.`, accentColor: DESTRUCTIVE },
      heading("Action required — entry rejected") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, your entry for <strong>${escape(params.date)}</strong> on <strong>${escape(params.project)}</strong> was rejected by ${escape(params.reviewer)}.`) +
        infoCard(
          rows([
            ["Module", escape(params.module)],
            ["Submodule", escape(params.submodule)],
            ["Activity", escape(params.activity)],
            ["Reason", escape(params.reason)]
          ]),
          DESTRUCTIVE
        ) +
        // What they originally wrote, so a resubmission can be a correction rather than a retype.
        (params.description ? quoted(params.description) : "") +
        paragraph(button("Fix and resubmit", appUrl("/app/history"), DESTRUCTIVE))
    ),

  slaBreach: (params: { managerName: string; employeeName: string; date: string; project: string; deadline: string; hoursOverdue: number | string }) =>
    shell(
      { title: "SLA breach — approval overdue", preheader: `${params.hoursOverdue}h overdue.`, accentColor: DESTRUCTIVE },
      heading("Approval SLA breached") +
        paragraph(`${escape(params.managerName.split(" ")[0])}, a timesheet has missed its approval SLA and needs immediate review.`) +
        infoCard(
          [
            ["Employee", escape(params.employeeName)],
            ["Project", escape(params.project)],
            ["Work date", escape(params.date)],
            ["Deadline was", escape(params.deadline)],
            ["Overdue by", `${num(params.hoursOverdue, 1)} hours`]
          ],
          DESTRUCTIVE
        ) +
        paragraph(button("Review approvals", appUrl("/app/approvals"), DESTRUCTIVE))
    ),

  escalation: (params: { targetName: string; employeeName: string; managerName: string; date: string; project: string }) =>
    shell(
      { title: "Approval escalated to you", preheader: `From ${params.managerName}.`, accentColor: ACCENT },
      heading("Escalation: please review") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, an approval has been escalated to you because the SLA was missed by ${escape(params.managerName)}.`) +
        infoCard(
          [
            ["Employee", escape(params.employeeName)],
            ["Project", escape(params.project)],
            ["Work date", escape(params.date)]
          ],
          ACCENT
        ) +
        paragraph(button("Review approvals", appUrl("/app/approvals"), ACCENT))
    ),

  deadlineReminder: (params: { name: string; daysLeft: number | string; deadlineDay: number | string }) =>
    shell(
      { title: "Submission deadline approaching", preheader: `${params.daysLeft} day(s) left this cycle.`, accentColor: ACCENT },
      heading(`${params.daysLeft} day${params.daysLeft === 1 ? "" : "s"} left to submit`) +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, just a heads up — your timesheets are due by day ${params.deadlineDay} of the month.`) +
        paragraph(button("Log time now", appUrl("/app/timesheet"), ACCENT))
    ),

  /**
   * The two change-management messages.
   *
   * Both carry the SAME block of facts, in the same order, so an approver reading the decision mail
   * recognises the request without re-reading it. Built from the shared `shell`/`infoCard` helpers
   * like every other template here — a governance email that looked different from the rest of the
   * app's mail would read as a phishing attempt, which is the opposite of what it needs to achieve.
   */
  changeSubmitted: (params: {
    changeKey: string;
    projectName: string;
    title: string;
    changeType: string;
    riskLevel: string;
    riskScore: string;
    activityWindow: string;
    description?: string | null;
    requestedBy: string;
    receivedBy: string;
    peopleInvolved?: string | null;
    appUrl: string;
  }) =>
    shell(
      { title: `Approval needed: ${params.changeKey}`, preheader: `${params.requestedBy} submitted a change that needs your approval.` },
      heading("A change needs your approval") +
        paragraph(`${escape(params.requestedBy)} submitted a change on ${escape(params.projectName)} and it is waiting on you.`) +
        infoCard(
          rows([
            ["Change", escape(params.changeKey)],
            ["Project", escape(params.projectName)],
            ["Title", escape(params.title)],
            ["Type", escape(params.changeType)],
            ["Risk", `${escape(params.riskLevel)} (${escape(params.riskScore)})`],
            ["Activity window", escape(params.activityWindow)],
            ["Requested by", escape(params.requestedBy)],
            ["Received by", escape(params.receivedBy)],
            ["People involved", escape(params.peopleInvolved)]
          ])
        ) +
        (params.description ? quoted(params.description) : "") +
        paragraph(button("Review and decide", params.appUrl))
    ),

  changeDecided: (params: {
    changeKey: string;
    projectName: string;
    title: string;
    changeType: string;
    riskLevel: string;
    riskScore: string;
    activityWindow: string;
    requestedBy: string;
    decision: string;
    decidedBy: string;
    comments?: string | null;
    peopleInvolved?: string | null;
    appUrl: string;
  }) =>
    shell(
      {
        title: `Change ${params.decision}: ${params.changeKey}`,
        preheader: `${params.decidedBy} ${params.decision.toLowerCase()} this change.`,
        // Green for approved, amber for anything else. Colour carries the outcome before the words do,
        // which matters on a phone lock screen.
        accentColor: params.decision === "APPROVED" ? SUCCESS : ACCENT
      },
      heading(`${params.changeKey} was ${escape(params.decision.toLowerCase())}`) +
        paragraph(`${escape(params.decidedBy)} reviewed "${escape(params.title)}" on ${escape(params.projectName)}.`) +
        infoCard(
          rows([
            ["Change", escape(params.changeKey)],
            ["Project", escape(params.projectName)],
            ["Title", escape(params.title)],
            ["Type", escape(params.changeType)],
            ["Risk", `${escape(params.riskLevel)} (${escape(params.riskScore)})`],
            ["Activity window", escape(params.activityWindow)],
            ["Requested by", escape(params.requestedBy)],
            [params.decision === "APPROVED" ? "Approved by" : "Rejected by", escape(params.decidedBy)],
            ["People involved", escape(params.peopleInvolved)]
          ])
        ) +
        (params.comments ? quoted(params.comments) : "") +
        paragraph(button("Open the change", params.appUrl))
    ),

  ticketAssigned: (params: {
    assigneeName: string;
    ticketKey: string;
    title: string;
    priority: string;
    assignedBy: string;
    /** Bug, task, improvement — the first thing that decides how somebody triages it. */
    type?: string | null;
    module?: string | null;
    description?: string | null;
    ticketId?: string | null;
  }) =>
    shell(
      { title: `Ticket assigned: ${params.ticketKey}`, preheader: `${params.assignedBy} assigned you a ${params.priority.toLowerCase()} priority ticket.` },
      heading("A ticket was assigned to you") +
        paragraph(`Hi ${escape(params.assigneeName.split(" ")[0])}, ${escape(params.assignedBy)} assigned you a ticket.`) +
        infoCard(
          rows([
            ["Ticket", escape(params.ticketKey)],
            ["Title", escape(params.title)],
            ["Type", escape(params.type)],
            ["Priority", escape(params.priority)],
            ["Module", escape(params.module)]
          ])
        ) +
        (params.description ? quoted(params.description) : "") +
        paragraph(button("Open ticket", ticketUrl(params.ticketId)))
    ),

  ticketStatusChanged: (params: {
    ticketKey: string;
    title: string;
    from: string;
    to: string;
    changedBy: string;
    type?: string | null;
    /** The note left WITH the move, when there was one. A status change with a reason attached is the
     *  difference between "it moved" and "here is why", and the reason was previously in the app only. */
    comment?: string | null;
    ticketId?: string | null;
  }) => {
    const done = params.to === "RESOLVED" || params.to === "CLOSED";
    return shell(
      { title: `${params.ticketKey} moved to ${params.to}`, preheader: `${params.changedBy} moved this ticket from ${params.from} to ${params.to}.`, accentColor: done ? SUCCESS : PRIMARY },
      heading(`${params.ticketKey} moved to ${params.to}`) +
        paragraph(`${escape(params.changedBy)} moved "<strong>${escape(params.title)}</strong>" from ${escape(params.from)} to <strong>${escape(params.to)}</strong>.`) +
        infoCard(rows([["Type", escape(params.type)], ["From", escape(params.from)], ["To", escape(params.to)]]), done ? SUCCESS : PRIMARY) +
        // Labelled as the LATEST comment, never as a reason: this route takes no note of its own, so
        // presenting the last thing said as an explanation for the move would be inventing a link.
        (params.comment ? `<div style="margin-top:14px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};font-weight:700;">Latest comment</div>${quoted(params.comment)}` : "") +
        paragraph(button("Open ticket", ticketUrl(params.ticketId), done ? SUCCESS : PRIMARY))
    );
  },

  /** See services/security-report.service.ts#sendTicketClosedDigest — one email, closer + their
   *  manager as primary recipients, this ticket's own tenant admins in Cc (set by the caller,
   *  not this template). `findingsText` is pre-rendered plain text turned into <br>-joined HTML
   *  here rather than re-deriving structure, so the PDF export and this email can never disagree
   *  on what counts as "the findings" — both read from the same buildTicketSecurityReport call. */
  ticketClosedDigest: (params: { ticketKey: string; title: string; closedBy: string; riskVerdict: string; findingsText: string; testStatus: string }) =>
    shell(
      {
        title: `Security digest — ${params.ticketKey}`,
        preheader: params.riskVerdict,
        accentColor: params.riskVerdict.startsWith("Needs attention") ? DESTRUCTIVE : SUCCESS
      },
      heading(`${params.ticketKey} closed — security digest`) +
        paragraph(`${escape(params.closedBy)} closed "<strong>${escape(params.title)}</strong>". Summary of ingested security findings and test status below.`) +
        infoCard([
          ["Verdict", escape(params.riskVerdict)],
          ["Latest test run", escape(params.testStatus)]
        ], params.riskVerdict.startsWith("Needs attention") ? DESTRUCTIVE : SUCCESS) +
        paragraph(`<strong>Findings</strong><br />${escape(params.findingsText).replace(/\n/g, "<br />")}`) +
        paragraph(button("Open ticket", appUrl("/app/tickets")))
    ),

  /**
   * The other half of the pair above: a scan proved a claimed fix did not hold. See
   * services/security-report.service.ts#sendTicketReopenedDigest for the audience — this one goes
   * far wider than the close digest (the closer, the current assignee and everyone who logged time
   * on the ticket, with the closer's manager and the module owner in Cc), because the people who
   * can do something about a failed fix are the people who worked on it.
   *
   * WHY IT IS STRUCTURED RATHER THAN A SENTENCE: "your fix didn't work" is an accusation until it
   * shows its evidence. Which scan, which tool, which commit; what survived and for how long; what
   * the same run DID confirm fixed; and where the SLA now stands. A reader has to be able to check
   * the claim, and disagree with it if it is wrong.
   *
   * `slaText` is a full sentence written by the caller rather than a flag, because there are three
   * genuinely different things to say — reopened with a restarted clock, reopened with no SLA
   * configured, and deliberately not reopened because auto-reopen is off — and a template that
   * inferred which from a boolean would eventually tell somebody their clock restarted when it did
   * not.
   *
   * NOTE THE LINK: `ticketUrl(params.ticketId)`, not the bare list `ticketClosedDigest` still uses.
   * A digest about ONE ticket that lands the reader on a page of seventeen hundred is a digest they
   * open the app to escape.
   */
  ticketReopenedDigest: (params: {
    ticketKey: string;
    title: string;
    closedBy: string;
    scanSummary: string;
    riskVerdict: string;
    survivedText: string;
    fixedText: string;
    slaText: string;
    ticketId?: string | null;
  }) =>
    shell(
      {
        title: `A fix did not hold — ${params.ticketKey}`,
        preheader: `${params.scanSummary} still reports findings that were marked fixed.`,
        // Same load-bearing "Needs attention" prefix the close digest keys its accent off — see
        // buildRiskVerdict in security-report.service.ts. Do not reword either end of this.
        accentColor: params.riskVerdict.startsWith("Needs attention") ? DESTRUCTIVE : ACCENT
      },
      heading(`${params.ticketKey} — a fix did not hold`) +
        paragraph(
          `A scan ran and still reports findings that were marked fixed when ${escape(params.closedBy)} resolved "<strong>${escape(params.title)}</strong>".`
        ) +
        infoCard(
          [
            ["Proved by", escape(params.scanSummary)],
            ["Current verdict", escape(params.riskVerdict)],
            ["Ticket", escape(params.slaText)]
          ],
          params.riskVerdict.startsWith("Needs attention") ? DESTRUCTIVE : ACCENT
        ) +
        paragraph(`<strong>Still reported</strong><br />${escape(params.survivedText).replace(/\n/g, "<br />")}`) +
        paragraph(`<strong>Confirmed fixed by the same scan</strong><br />${escape(params.fixedText).replace(/\n/g, "<br />")}`) +
        paragraph(button("Open ticket", ticketUrl(params.ticketId), DESTRUCTIVE))
    ),

  /**
   * WHAT CHANGED: this said that somebody had commented and did not say what they wrote, so every
   * recipient had to open the app to find out whether it concerned them. The comment itself is the
   * entire content of the event; an email about a comment that omits the comment is a notification
   * that a notification exists.
   */
  ticketCommented: (params: {
    ticketKey: string;
    title: string;
    author: string;
    type?: string | null;
    comment?: string | null;
    ticketId?: string | null;
  }) =>
    shell(
      {
        title: `New comment on ${params.ticketKey}`,
        // The preheader is the line a phone shows next to the subject, so it carries the opening of
        // the comment rather than restating the title.
        preheader: params.comment ? `${params.author}: ${params.comment.slice(0, 120)}` : `${params.author} commented on "${params.title}".`
      },
      heading("New comment") +
        paragraph(`${escape(params.author)} commented on "<strong>${escape(params.title)}</strong>" (${escape(params.ticketKey)}).`) +
        infoCard(rows([["Ticket", escape(params.ticketKey)], ["Type", escape(params.type)]])) +
        (params.comment ? quoted(params.comment) : "") +
        paragraph(button("Open ticket", ticketUrl(params.ticketId)))
    ),

  ticketSlaBreach: (params: { assigneeName: string; ticketKey: string; title: string; priority: string; hoursOverdue: number | string }) =>
    shell(
      { title: `SLA breach — ${params.ticketKey}`, preheader: `${num(params.hoursOverdue, 1)}h overdue.`, accentColor: DESTRUCTIVE },
      heading("Ticket SLA breached") +
        paragraph(`${escape(params.assigneeName.split(" ")[0])}, this ticket has missed its resolution SLA and needs attention.`) +
        infoCard(
          [
            ["Ticket", escape(params.ticketKey)],
            ["Title", escape(params.title)],
            ["Priority", escape(params.priority)],
            ["Overdue by", `${num(params.hoursOverdue, 1)} hours`]
          ],
          DESTRUCTIVE
        ) +
        paragraph(button("Review ticket", appUrl("/app/tickets"), DESTRUCTIVE))
    ),

  ticketEscalation: (params: { targetName: string; ticketKey: string; title: string; assigneeName: string }) =>
    shell(
      { title: `Ticket escalated: ${params.ticketKey}`, preheader: `Escalated because of a missed SLA.`, accentColor: ACCENT },
      heading("Escalation: please review") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, "<strong>${escape(params.title)}</strong>" (${escape(params.ticketKey)}) has been escalated to you because its assignee, ${escape(params.assigneeName)}, missed the resolution SLA.`) +
        paragraph(button("Review ticket", appUrl("/app/tickets"), ACCENT))
    ),

  ticketStaleNudge: (params: { assigneeName: string; ticketKey: string; title: string; suggestion: string }) =>
    shell(
      { title: `Suggested next step — ${params.ticketKey}`, preheader: "AI-suggested next action for a stale ticket.", accentColor: ACCENT },
      heading("A suggested next step") +
        paragraph(`${escape(params.assigneeName.split(" ")[0])}, "<strong>${escape(params.title)}</strong>" (${escape(params.ticketKey)}) just missed its SLA — here's one concrete idea:`) +
        infoCard([["Suggestion", escape(params.suggestion)]], ACCENT) +
        paragraph(button("Review ticket", appUrl("/app/tickets"), ACCENT)) +
        paragraph(`<span style="color:${MUTED};">AI-generated from the ticket's own stats (priority, comment count, whether a branch is linked) — turn it off anytime in Workspace Settings → AI.</span>`)
    ),

  ticketReceivedViaEmail: (params: { senderName: string; ticketKey: string; title: string; priority: string }) =>
    shell(
      { title: `We received your report — ${params.ticketKey}`, preheader: "Our team has been notified and will follow up." },
      heading("Thanks — we've logged this") +
        paragraph(`Hi ${escape(params.senderName.split(" ")[0])}, your email was automatically turned into a tracked ticket. Our team will follow up as needed.`) +
        infoCard([
          ["Ticket", escape(params.ticketKey)],
          ["Summary", escape(params.title)],
          ["Priority", escape(params.priority)]
        ]) +
        paragraph(`<span style="color:${MUTED};">This is an automated confirmation — no need to reply unless you have more details to add.</span>`)
    ),

  /**
   * WHAT CHANGED AND WHY: this used to be one AI-written paragraph and a button to the dashboard —
   * so the recipient had to leave the email to learn anything, and if the model was unavailable the
   * email did not go at all. The numbers now come first and come from the database; the written
   * summary is a garnish that may be absent without costing the reader the report.
   *
   * `tablesHtml` is pre-rendered by `weekly-digest-data.service.ts` rather than assembled here,
   * because what a person sees depends on what they may see: an employee gets their own week, a
   * manager or administrator also gets the workspace user-by-user and project-by-project. Deciding
   * that in a template would put an access-control rule in a presentation file.
   */
  weeklyDigest: (params: { name: string; weekLabel: string; summary: string; tablesHtml: string }) =>
    shell(
      { title: `Your week in review — ${params.weekLabel}`, preheader: `Last week, month to date and year to date — ${params.weekLabel}.` },
      heading(`Hi ${escape(params.name.split(" ")[0])}, here is ${escape(params.weekLabel)}`) +
        (params.summary ? paragraph(escape(params.summary)) : "") +
        params.tablesHtml +
        paragraph(button("Open your dashboard", appUrl("/app"))) +
        paragraph(
          `<span style="color:${MUTED};">Every figure above is counted from this workspace's own records for the stated period. ${
            params.summary ? "The opening paragraph is AI-written from those same numbers. " : ""
          }Turn this digest off anytime in your notification preferences.</span>`
        )
    ),

  /**
   * The Weekly AI/ML Practice Update — the consolidated leadership view.
   *
   * ONE ARGUMENT, `sectionsHtml`, rather than ten. The ten sections are assembled by
   * `practice-update-mail.service.ts` from counted figures plus an optionally AI-written narrative,
   * and several of them are tables whose shape depends on what actually happened. Passing ten
   * strings through here would give the admin editor ten placeholders it could reorder into
   * nonsense, and would still not let it change a table's columns.
   */
  practiceUpdate: (params: { periodLabel: string; headline: string; sectionsHtml: string }) =>
    shell(
      {
        title: `Weekly AI/ML Practice Update — ${params.periodLabel}`,
        preheader: params.headline || `Products, POCs, bugs, security, training and metrics for ${params.periodLabel}.`
      },
      heading(`Weekly AI/ML Practice Update`) +
        `<div style="font-size:13px;color:${MUTED};margin:-6px 0 4px;">${escape(params.periodLabel)}</div>` +
        params.sectionsHtml +
        paragraph(button("Open TimeSphere", appUrl("/app"))) +
        paragraph(
          `<span style="color:${MUTED};">Every figure above is counted from this workspace's own records for the stated period. Status colours are computed from overdue and SLA counts, not chosen. Narrative sections are drafted from those same numbers and reviewed before sending.</span>`
        )
    ),

  /** One email per PERSON listing their goals, never one per goal — a send per goal is the send
   *  people filter, and filtering it costs them the one that mattered. */
  goalDigest: (params: { name: string; weekLabel: string; summary: string; lines: string[] }) =>
    shell(
      { title: `Your goals — ${params.weekLabel}`, preheader: params.summary },
      heading(`Hi ${escape(params.name.split(" ")[0])}, where your goals stand`) +
        paragraph(escape(params.summary)) +
        infoCard(params.lines.map((line) => [escape(line.split(" — ")[0] ?? line), escape(line.split(" — ")[1] ?? "")])) +
        paragraph(button("Open Goals", appUrl("/app/goals"))) +
        paragraph(`<span style="color:${MUTED};">Progress is measured from what this workspace already records. Where nothing comparable exists, a goal says so rather than showing a zero.</span>`)
    ),

  /** The only workflow email. It exists because a gate BLOCKS — everything after it waits until this
   *  person decides, potentially for days. */
  workflowApproval: (params: { name: string; flowName: string; subject: string; stepOrder: number | string }) =>
    shell(
      { title: `${params.flowName} needs your approval`, preheader: `Step ${params.stepOrder} is waiting on you.`, accentColor: ACCENT },
      heading("A workflow is waiting for you") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, "${escape(params.flowName)}" stopped at step ${params.stepOrder} and cannot continue until you approve or decline it.`) +
        infoCard([
          ["Workflow", escape(params.flowName)],
          ["Waiting on", `step ${params.stepOrder}`],
          ["Working on", escape(params.subject)]
        ]) +
        paragraph(button("Review it", appUrl("/app/studio"), ACCENT)) +
        paragraph(`<span style="color:${MUTED};">Nothing after that step happens until you decide. Declining stops the run; it changes nothing that already happened.</span>`)
    ),

  /** `tablesHtml` is the counted report; `summary` is an optional paragraph on top of it. The
   *  preheader and the footnote both say "counted" rather than "AI-authored" because the figures
   *  are read from this workspace's own findings and send whether or not a model answered. */
  securityWeeklyDigest: (params: { weekLabel: string; summary: string; riskScore: number | string; tablesHtml?: string }) =>
    shell(
      { title: `Security digest — week of ${params.weekLabel}`, preheader: "Last week's security findings, risk trend and SLA breaches." },
      heading(`Security posture — week of ${escape(params.weekLabel)}`) +
        infoCard([["Risk score", String(params.riskScore)]], Number(params.riskScore) > 30 ? DESTRUCTIVE : Number(params.riskScore) > 10 ? ACCENT : SUCCESS) +
        (params.summary ? paragraph(escape(params.summary)) : "") +
        (params.tablesHtml ?? "") +
        paragraph(button("Open Security insights", appUrl("/app/security-insights"))) +
        paragraph(`<span style="color:${MUTED};">Figures are counted from this workspace's ingested findings. The opening paragraph, when present, is AI-generated — turn it off anytime in Workspace Settings → AI.</span>`)
    ),

  bugPatternDigest: (params: { periodLabel: string; summary: string }) =>
    shell(
      { title: `What kept breaking — ${params.periodLabel}`, preheader: "AI-authored recap of recurring CI failures and security-finding hotspots." },
      heading(`What kept breaking — ${escape(params.periodLabel)}`) +
        paragraph(escape(params.summary)) +
        paragraph(button("Open Tickets", appUrl("/app/tickets"))) +
        paragraph(`<span style="color:${MUTED};">AI-generated from this period's recurring test-run failures and security findings — turn it off anytime in Workspace Settings → AI.</span>`)
    ),

  ticketNeedsReview: (params: { targetName: string; ticketKey: string; title: string; senderEmail: string; confidence: number | string }) =>
    shell(
      { title: `Needs review: ${params.ticketKey}`, preheader: "An email-sourced ticket needs a human check.", accentColor: ACCENT },
      heading("An inbound ticket needs review") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, an email from ${escape(params.senderEmail)} was auto-classified with low confidence and needs a quick human check before it's assigned.`) +
        infoCard(
          [
            ["Ticket", escape(params.ticketKey)],
            ["Summary", escape(params.title)],
            ["AI confidence", pct(params.confidence)]
          ],
          ACCENT
        ) +
        paragraph(button("Review ticket", appUrl("/app/tickets"), ACCENT))
    ),

  /* ---- Face (identity) verification lifecycle. Deliberately data-light: none of these ever
     contain a captured image, a similarity score, or anything biometric — email gets forwarded,
     archived, and read on unmanaged devices, so they say THAT something needs attention and
     link into the app, where authorization is actually checked. ---- */

  /** `thin` addresses somebody who IS enrolled but whose model holds a single angle — a different
   *  ask from "enroll", and telling an enrolled person to enroll is how a nudge gets ignored. */
  faceEnrollmentRequired: (params: { name: string; reminder?: boolean; thin?: boolean }) =>
    shell(
      {
        title: params.thin ? "Improve your face model" : "Set up face verification",
        preheader: params.thin
          ? "Your identity checks are failing because your face model holds one angle."
          : "Your workspace requires an identity check for some actions."
      },
      heading(
        params.thin
          ? `Hi ${escape(params.name.split(" ")[0])}, fifteen seconds fixes your failed checks`
          : `Hi ${escape(params.name.split(" ")[0])}, one quick setup step`
      ) +
        paragraph(
          params.thin
            ? "Your face was enrolled from a single angle, so identity checks taken from any other angle come back as a non-match. Retraining walks you through four quick head positions and replaces your reference set — it is the one change most likely to stop the failures."
            : params.reminder
              ? "A reminder: your workspace requires a face identity check for some of your actions, and you haven't enrolled yet. Until you do, those submissions will be held up."
              : "Your workspace now requires a quick face identity check for some of your actions (like submitting a timesheet). Enrolling takes under a minute — you'll review and agree to a consent notice first."
        ) +
        paragraph(button(params.thin ? "Retrain in your profile" : "Enroll in your profile", appUrl("/app/profile"))) +
        paragraph(`<span style="color:${MUTED};">Why this exists: it confirms the person submitting is the account owner. Your face data is encrypted, never shared, and you can delete it from your profile at any time.</span>`)
    ),

  faceVerificationFlagged: (params: { targetName: string; employeeName: string; failureCount: number | string; context: string }) =>
    shell(
      { title: "Identity check flagged for review", preheader: "Repeated failed identity checks need a look.", accentColor: ACCENT },
      heading("An identity check needs review") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, ${escape(params.employeeName)} has failed ${params.failureCount} identity ${params.failureCount === 1 ? "check" : "checks"} in a row while trying to ${params.context === "TIMESHEET" ? "submit a timesheet" : params.context === "APPROVAL" ? "approve a timesheet" : "work on a ticket"}.`) +
        paragraph("Honest failures happen — bad lighting, new glasses, a dirty lens. Repeated ones are exactly what this control exists to surface. The review log shows the scores and captures behind each attempt.") +
        paragraph(button("Open the review log", appUrl("/app/settings"), ACCENT))
    ),

  faceReviewOverdue: (params: { targetName: string; pendingCount: number | string; oldestAgeHours: number | string }) =>
    shell(
      { title: "Flagged identity checks awaiting review", preheader: "Flagged attempts have sat unreviewed.", accentColor: ACCENT },
      heading("Flagged identity checks are waiting") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, ${params.pendingCount} flagged identity ${params.pendingCount === 1 ? "attempt has" : "attempts have"} been waiting for review — the oldest for about ${params.oldestAgeHours} hours. A flag nobody reads is not a control.`) +
        paragraph(button("Review them now", appUrl("/app/settings"), ACCENT))
    ),

  faceDataDeleted: (params: { name: string; byAdmin: boolean }) =>
    shell(
      { title: "Your face data was deleted", preheader: "Confirmation of biometric data deletion." },
      heading("Your face data has been deleted") +
        paragraph(
          `${escape(params.name.split(" ")[0])}, ${params.byAdmin ? "an administrator has deleted" : "you deleted"} your face verification enrollment. The stored face template and any retained captures have been permanently removed.`
        ) +
        paragraph("If face verification is still required for your actions, you'll be asked to enroll again (with fresh consent) before your next covered submission.") +
        paragraph(`<span style="color:${MUTED};">This confirmation is part of your workspace's biometric-data record keeping. No action is needed.</span>`)
    ),

  faceEntitlementLost: (params: { targetName: string; graceDays: number | string }) =>
    shell(
      { title: "Face verification is no longer in your plan", preheader: "Enforcement paused; stored face data will be purged.", accentColor: ACCENT },
      heading("Face verification lost its plan entitlement") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, this workspace's current plan no longer includes face verification. Identity checks have stopped being enforced as of now — nobody is locked out.`) +
        paragraph(`Stored face templates and captures will be kept for ${params.graceDays} days so an upgrade can restore the feature without re-enrolling everyone. After that they are permanently purged — retaining biometric data for a feature you can't use isn't defensible under data-protection rules.`) +
        paragraph(button("Review plan & billing", appUrl("/app/settings"), ACCENT))
    ),

  identityWeeklyDigest: (params: { targetName: string; weekLabel: string; total: number | string; passed: number | string; failed: number | string; flaggedPending: number | string; notes: string }) =>
    shell(
      { title: `Identity assurance — week of ${params.weekLabel}`, preheader: "Weekly face verification recap." },
      heading(`Identity assurance — week of ${escape(params.weekLabel)}`) +
        infoCard(
          [
            ["Checks run", String(params.total)],
            ["Passed", String(params.passed)],
            ["Failed", String(params.failed)],
            ["Flagged awaiting review", String(params.flaggedPending)]
          ],
          Number(params.flaggedPending) > 0 ? ACCENT : SUCCESS
        ) +
        (params.notes ? paragraph(escape(params.notes)) : "") +
        paragraph(button("Open the review log", appUrl("/app/settings"))) +
        paragraph(`<span style="color:${MUTED};">Computed directly from this week's verification attempts — no AI involved. Turn it off in Workspace Settings → Email channels.</span>`)
    ),

  /** The "wrap up, maintenance is coming" warning a SUPER_ADMIN sends from the Maintenance tab
   *  (services/maintenance.service.ts#notifyUsersOfMaintenance). Amber accent — a heads-up, not
   *  an incident. `message` is the admin's UNTRUSTED free text — escaped here, like every other
   *  human-authored value in this file. */
  maintenanceScheduled: (params: { name: string; window: string; message: string }) =>
    shell(
      { title: "Scheduled maintenance — please save your work", preheader: `Maintenance window: ${params.window}.`, accentColor: ACCENT },
      heading("Scheduled maintenance ahead") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, this workspace is going into <strong>scheduled maintenance</strong>. Please save your work and sign out before the window starts.`) +
        infoCard(
          [
            ["Maintenance window", escape(params.window)],
            ["What happens", "You'll be signed out automatically when it begins; signing in is paused until it ends."]
          ],
          ACCENT
        ) +
        (params.message ? paragraph(escape(params.message)) : "") +
        paragraph(button("Open your workspace", appUrl("/app"), ACCENT)) +
        paragraph(`<span style="color:${MUTED};">Super admins stay signed in to run the maintenance. You'll be able to sign back in the moment the window ends.</span>`)
    )
};

export type TemplateName = keyof typeof templates;

/** Shared with `weekly-digest-data.service.ts`, which assembles the digest's tables: the layout
 *  primitives live here with the rest of the email design rather than being reinvented beside the
 *  queries. */
export const emailBlocks = { dataTable, periodStrip, share, escape };

/**
 * The house email chrome, for the platform-level templates in `platform-mail-templates.ts`.
 * Exported rather than copied so a retention reminder and a timesheet approval look like they
 * came from the same product — they did.
 */
export const emailShell = { shell, heading, paragraph, button, escape, ACCENT, PRIMARY, MUTED };
