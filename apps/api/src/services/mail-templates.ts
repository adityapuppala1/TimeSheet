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

export const templates = {
  welcome: (name: string) =>
    shell(
      { title: `Welcome to ${BRAND}`, preheader: "Your account is ready." },
      heading(`Welcome aboard, ${escape(name.split(" ")[0])}!`) +
        paragraph("Your TimeSphere account is provisioned. Log your first timesheet, track approvals, and stay on top of SLA deadlines from a single place.") +
        paragraph(button("Open your dashboard", appUrl("/app")))
    ),

  reset: (resetUrl: string) =>
    shell(
      { title: "Reset your password", preheader: "Reset link inside — expires in 30 minutes.", accentColor: ACCENT },
      heading("Reset your password") +
        paragraph("Click the button below to set a new password. The link expires in 30 minutes for your security.") +
        paragraph(button("Reset password", resetUrl, ACCENT)) +
        paragraph(`<span style="color:${MUTED};">If you didn't request a reset, you can safely ignore this email.</span>`)
    ),

  timesheetSubmitted: (params: { name: string; hours: number; date: string; project: string; managerName?: string | null }) =>
    shell(
      { title: "Timesheet submitted", preheader: `${params.hours}h logged for ${params.date}.` },
      heading("Your timesheet was submitted") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, your entry is now in the approval queue${params.managerName ? ` with ${escape(params.managerName)}` : ""}.`) +
        infoCard([
          ["Date", escape(params.date)],
          ["Project", escape(params.project)],
          ["Hours", `${params.hours.toFixed(2)}h`]
        ]) +
        paragraph(button("View status", appUrl("/app/history")))
    ),

  timesheetApproved: (params: { name: string; hours: number; date: string; reviewer: string; project: string }) =>
    shell(
      { title: "Timesheet approved", preheader: `Approved by ${params.reviewer}.`, accentColor: SUCCESS },
      heading("Approved ✔") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, your ${params.hours.toFixed(2)}h entry for ${escape(params.date)} on <strong>${escape(params.project)}</strong> was approved by ${escape(params.reviewer)}.`) +
        paragraph(button("View history", appUrl("/app/history"), SUCCESS))
    ),

  timesheetRejected: (params: { name: string; date: string; project: string; reviewer: string; reason: string }) =>
    shell(
      { title: "Timesheet rejected", preheader: `Reviewer: ${params.reviewer}.`, accentColor: DESTRUCTIVE },
      heading("Action required — entry rejected") +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, your entry for <strong>${escape(params.date)}</strong> on <strong>${escape(params.project)}</strong> was rejected by ${escape(params.reviewer)}.`) +
        infoCard([["Reason", escape(params.reason)]], DESTRUCTIVE) +
        paragraph(button("Fix and resubmit", appUrl("/app/history"), DESTRUCTIVE))
    ),

  slaBreach: (params: { managerName: string; employeeName: string; date: string; project: string; deadline: string; hoursOverdue: number }) =>
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
            ["Overdue by", `${params.hoursOverdue.toFixed(1)} hours`]
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

  deadlineReminder: (params: { name: string; daysLeft: number; deadlineDay: number }) =>
    shell(
      { title: "Submission deadline approaching", preheader: `${params.daysLeft} day(s) left this cycle.`, accentColor: ACCENT },
      heading(`${params.daysLeft} day${params.daysLeft === 1 ? "" : "s"} left to submit`) +
        paragraph(`Hi ${escape(params.name.split(" ")[0])}, just a heads up — your timesheets are due by day ${params.deadlineDay} of the month.`) +
        paragraph(button("Log time now", appUrl("/app/timesheet"), ACCENT))
    ),

  ticketAssigned: (params: { assigneeName: string; ticketKey: string; title: string; priority: string; assignedBy: string }) =>
    shell(
      { title: `Ticket assigned: ${params.ticketKey}`, preheader: `${params.assignedBy} assigned you a ${params.priority.toLowerCase()} priority ticket.` },
      heading("A ticket was assigned to you") +
        paragraph(`Hi ${escape(params.assigneeName.split(" ")[0])}, ${escape(params.assignedBy)} assigned you a ticket.`) +
        infoCard([
          ["Ticket", escape(params.ticketKey)],
          ["Title", escape(params.title)],
          ["Priority", escape(params.priority)]
        ]) +
        paragraph(button("Open ticket", appUrl("/app/tickets")))
    ),

  ticketStatusChanged: (params: { ticketKey: string; title: string; from: string; to: string; changedBy: string }) =>
    shell(
      { title: `${params.ticketKey} moved to ${params.to}`, preheader: `${params.changedBy} moved this ticket from ${params.from} to ${params.to}.`, accentColor: params.to === "RESOLVED" || params.to === "CLOSED" ? SUCCESS : PRIMARY },
      heading(`${params.ticketKey} moved to ${params.to}`) +
        paragraph(`${escape(params.changedBy)} moved "<strong>${escape(params.title)}</strong>" from ${escape(params.from)} to <strong>${escape(params.to)}</strong>.`) +
        paragraph(button("Open ticket", appUrl("/app/tickets"), params.to === "RESOLVED" || params.to === "CLOSED" ? SUCCESS : PRIMARY))
    ),

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

  ticketCommented: (params: { ticketKey: string; title: string; author: string }) =>
    shell(
      { title: `New comment on ${params.ticketKey}`, preheader: `${params.author} commented on "${params.title}".` },
      heading("New comment") +
        paragraph(`${escape(params.author)} commented on "<strong>${escape(params.title)}</strong>" (${escape(params.ticketKey)}).`) +
        paragraph(button("View comment", appUrl("/app/tickets")))
    ),

  ticketSlaBreach: (params: { assigneeName: string; ticketKey: string; title: string; priority: string; hoursOverdue: number }) =>
    shell(
      { title: `SLA breach — ${params.ticketKey}`, preheader: `${params.hoursOverdue.toFixed(1)}h overdue.`, accentColor: DESTRUCTIVE },
      heading("Ticket SLA breached") +
        paragraph(`${escape(params.assigneeName.split(" ")[0])}, this ticket has missed its resolution SLA and needs attention.`) +
        infoCard(
          [
            ["Ticket", escape(params.ticketKey)],
            ["Title", escape(params.title)],
            ["Priority", escape(params.priority)],
            ["Overdue by", `${params.hoursOverdue.toFixed(1)} hours`]
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

  weeklyDigest: (params: { name: string; weekLabel: string; summary: string }) =>
    shell(
      { title: `Your week in review — ${params.weekLabel}`, preheader: "An AI-authored recap of your ticket and timesheet activity." },
      heading(`Hi ${escape(params.name.split(" ")[0])}, here's your week`) +
        paragraph(escape(params.summary)) +
        paragraph(button("Open your dashboard", appUrl("/app"))) +
        paragraph(`<span style="color:${MUTED};">This recap is AI-generated from your ticket and timesheet activity — turn it off anytime in your notification preferences.</span>`)
    ),

  securityWeeklyDigest: (params: { weekLabel: string; summary: string; riskScore: number }) =>
    shell(
      { title: `Security digest — week of ${params.weekLabel}`, preheader: "AI-authored recap of this week's security findings and risk trend." },
      heading(`Security posture — week of ${escape(params.weekLabel)}`) +
        infoCard([["Risk score", String(params.riskScore)]], params.riskScore > 30 ? DESTRUCTIVE : params.riskScore > 10 ? ACCENT : SUCCESS) +
        paragraph(escape(params.summary)) +
        paragraph(button("Open Security insights", appUrl("/app/security-insights"))) +
        paragraph(`<span style="color:${MUTED};">AI-generated from this week's ingested findings — turn it off anytime in Workspace Settings → AI.</span>`)
    ),

  ticketNeedsReview: (params: { targetName: string; ticketKey: string; title: string; senderEmail: string; confidence: number }) =>
    shell(
      { title: `Needs review: ${params.ticketKey}`, preheader: "An email-sourced ticket needs a human check.", accentColor: ACCENT },
      heading("An inbound ticket needs review") +
        paragraph(`${escape(params.targetName.split(" ")[0])}, an email from ${escape(params.senderEmail)} was auto-classified with low confidence and needs a quick human check before it's assigned.`) +
        infoCard(
          [
            ["Ticket", escape(params.ticketKey)],
            ["Summary", escape(params.title)],
            ["AI confidence", `${Math.round(params.confidence * 100)}%`]
          ],
          ACCENT
        ) +
        paragraph(button("Review ticket", appUrl("/app/tickets"), ACCENT))
    )
};

export type TemplateName = keyof typeof templates;
