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
    )
};

export type TemplateName = keyof typeof templates;
