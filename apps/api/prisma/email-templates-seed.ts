/**
 * Bulletproof transactional email HTML for all eight TimeSphere templates.
 *
 * Cross-client rules followed here:
 *  - Table-based layout (Outlook desktop's Word engine ignores div/flex/grid).
 *  - All styling inline (Gmail web/iOS Mail mishandle <style> blocks inconsistently).
 *  - Web-safe fonts only: 'Segoe UI', Arial, Helvetica, Georgia.
 *  - Container capped at 600 px, percentage widths inside.
 *  - HTML attributes (bgcolor / align / valign / cellpadding) alongside CSS for Outlook.
 *  - VML for rounded buttons in Outlook desktop, sourced from preserved conditional comments.
 *  - Variables wrapped in {{double_braces}} — substituted at dispatch time.
 *
 * Admins can re-open any of these in the Email Templates page (super-admin only),
 * tweak copy / colors / CTAs, and "Send test" before applying.
 */

const COLORS = {
  primary: "#0F9AA8",
  accent: "#F59E0B",
  success: "#16A34A",
  destructive: "#DC2626",
  info: "#3B82F6",
  fg: "#0F172A",
  muted: "#64748B",
  border: "#E2E8F0",
  card: "#FFFFFF",
  page: "#F7F9FB",
  white: "#FFFFFF"
};

interface ShellOptions {
  preheader: string;
  accent: string;
  body: string;
  footerNote?: string;
}

function shell({ preheader, accent, body, footerNote }: ShellOptions): string {
  return `<!doctype html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TimeSphere</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  @media only screen and (max-width:620px) {
    .ts-container { width:100% !important; max-width:100% !important; }
    .ts-px { padding-left:20px !important; padding-right:20px !important; }
    .ts-stack { display:block !important; width:100% !important; }
    .ts-h1 { font-size:22px !important; line-height:30px !important; }
    .ts-btn a { padding:14px 22px !important; font-size:14px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.page};font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:${COLORS.fg};">
<div style="display:none;font-size:1px;color:${COLORS.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background-color:${COLORS.page};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:${COLORS.card};border-radius:12px;border:1px solid ${COLORS.border};overflow:hidden;">
        <tr>
          <td bgcolor="${accent}" style="padding:20px 28px;background-color:${accent};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:18px;font-weight:800;color:${COLORS.white};letter-spacing:0.4px;">
                  TimeSphere
                </td>
                <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:1px;font-weight:600;">
                  Enterprise Time Tracking
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="ts-px" style="padding:28px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:${COLORS.fg};font-size:14px;line-height:22px;">
${body}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid ${COLORS.border};">
              <tr>
                <td style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${COLORS.muted};">
                  ${footerNote ?? "You're receiving this because of activity on your TimeSphere workspace. Manage notification preferences inside the app."}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      <table role="presentation" class="ts-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#94A3B8;">
            © TimeSphere &middot; This is an automated message
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function heading(text: string): string {
  return `            <h1 class="ts-h1" style="margin:0 0 14px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;letter-spacing:-0.2px;font-weight:800;color:${COLORS.fg};">${text}</h1>`;
}

function lead(text: string): string {
  return `            <p style="margin:0 0 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:${COLORS.fg};">${text}</p>`;
}

function para(text: string): string {
  return `            <p style="margin:0 0 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:${COLORS.fg};">${text}</p>`;
}

function muted(text: string): string {
  return `            <p style="margin:0 0 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:${COLORS.muted};">${text}</p>`;
}

/** Bulletproof CTA button — VML for Outlook desktop, styled <a> elsewhere. */
function button(label: string, href: string, color = COLORS.primary): string {
  return `            <table role="presentation" class="ts-btn" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
              <tr>
                <td align="center">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="14%" strokecolor="${color}" fillcolor="${color}">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">${label}</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="${href}" target="_blank" style="display:inline-block;background-color:${color};color:#ffffff;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:14px 28px;border-radius:8px;border:1px solid ${color};">${label}</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>`;
}

interface InfoRow {
  label: string;
  value: string;
  emphasize?: boolean;
}

function infoCard(rows: InfoRow[], accent = COLORS.primary): string {
  const rowsHtml = rows
    .map(
      (row, index) => `                  <tr>
                    <td style="padding:${index === 0 ? "10" : "6"}px 0 ${index === rows.length - 1 ? "10" : "6"}px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:${COLORS.muted};text-transform:uppercase;letter-spacing:0.7px;vertical-align:top;width:38%;">${row.label}</td>
                    <td style="padding:${index === 0 ? "10" : "6"}px 0 ${index === rows.length - 1 ? "10" : "6"}px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;font-weight:${row.emphasize ? "700" : "600"};color:${row.emphasize ? accent : COLORS.fg};">${row.value}</td>
                  </tr>`
    )
    .join("\n");
  return `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${COLORS.border};border-left:4px solid ${accent};border-radius:8px;margin:16px 0;background-color:#FAFBFC;">
              <tr>
                <td style="padding:6px 16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rowsHtml}
                  </table>
                </td>
              </tr>
            </table>`;
}

function calloutBox(label: string, value: string, accent: string): string {
  return `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;border-left:4px solid ${accent};background-color:#FFF5F5;border-radius:0 8px 8px 0;">
              <tr>
                <td style="padding:14px 16px;">
                  <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:0.7px;">${label}</p>
                  <p style="margin:0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:${COLORS.fg};">${value}</p>
                </td>
              </tr>
            </table>`;
}

/* ====================================================================
 * Template definitions
 * ==================================================================== */

export interface SeedTemplate {
  subject: string;
  bodyHtml: string;
}

export const SEED_TEMPLATES: Record<string, SeedTemplate> = {
  welcome: {
    subject: "Welcome to TimeSphere, {{name}}",
    bodyHtml: shell({
      preheader: "Your TimeSphere account is ready. Let's log your first timesheet.",
      accent: COLORS.primary,
      body: [
        heading("Welcome aboard, {{name}}"),
        lead("Your TimeSphere account is provisioned. You're ready to log time, track approvals, and stay on top of SLA deadlines from one place."),
        para("Here's what to do next:"),
        `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;">
              <tr>
                <td style="padding:8px 0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;color:${COLORS.fg};">
                  <strong style="color:${COLORS.primary};">1.</strong>&nbsp;&nbsp;Open the portal and sign in with the credentials your admin shared.
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;color:${COLORS.fg};">
                  <strong style="color:${COLORS.primary};">2.</strong>&nbsp;&nbsp;Update your profile photo and bio so teammates know who you are.
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;color:${COLORS.fg};">
                  <strong style="color:${COLORS.primary};">3.</strong>&nbsp;&nbsp;Log your first timesheet entry — your manager will be notified for approval.
                </td>
              </tr>
            </table>`,
        button("Open your dashboard", "{{appUrl}}/app"),
        muted("Tip: press <span style=\"font-family:Consolas,Menlo,monospace;background:#F1F5F9;padding:2px 6px;border-radius:4px;font-size:12px;\">Ctrl</span> + <span style=\"font-family:Consolas,Menlo,monospace;background:#F1F5F9;padding:2px 6px;border-radius:4px;font-size:12px;\">K</span> anywhere in the app to jump between pages.")
      ].join("\n")
    })
  },

  reset: {
    subject: "Reset your TimeSphere password",
    bodyHtml: shell({
      preheader: "Reset link inside — expires in 30 minutes.",
      accent: COLORS.accent,
      body: [
        heading("Reset your password"),
        lead("We received a request to reset your TimeSphere password."),
        para("Click the button below to set a new one. For your security, this link <strong>expires in 30 minutes</strong>."),
        button("Reset password", "{{resetUrl}}", COLORS.accent),
        muted("If the button doesn't work, copy and paste this URL into your browser:"),
        `            <p style="margin:0 0 18px;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:18px;color:${COLORS.primary};word-break:break-all;background-color:#F1F5F9;padding:10px 12px;border-radius:6px;border:1px solid ${COLORS.border};">{{resetUrl}}</p>`,
        muted("Didn't request a reset? You can safely ignore this email — your password won't change.")
      ].join("\n"),
      footerNote: "Security note: TimeSphere will never ask you for your password by email. If anything looks off, contact your workspace admin."
    })
  },

  "timesheet.submitted": {
    subject: "Timesheet submitted — {{hours}}h on {{date}}",
    bodyHtml: shell({
      preheader: "{{hours}}h on {{project}} for {{date}} sent for approval.",
      accent: COLORS.primary,
      body: [
        heading("Your timesheet was submitted"),
        lead("Hi {{name}}, your entry is now in the approval queue with <strong>{{managerName}}</strong>."),
        infoCard([
          { label: "Date", value: "{{date}}" },
          { label: "Project", value: "{{project}}", emphasize: true },
          { label: "Hours", value: "{{hours}}h", emphasize: true },
          { label: "Reviewer", value: "{{managerName}}" }
        ]),
        para("We'll email you the moment it's approved or rejected. Need to make changes? Open History before it's reviewed and you can pull it back to a draft."),
        button("View status", "{{appUrl}}/app/history")
      ].join("\n")
    })
  },

  "timesheet.approved": {
    subject: "Approved: your {{hours}}h on {{date}}",
    bodyHtml: shell({
      preheader: "Approved by {{reviewer}}. Nice work.",
      accent: COLORS.success,
      body: [
        `            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
              <tr>
                <td style="background-color:${COLORS.success};border-radius:999px;width:48px;height:48px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:48px;font-weight:700;color:#ffffff;">&#10003;</td>
              </tr>
            </table>`,
        heading("Approved"),
        lead("Hi {{name}}, your timesheet was approved by <strong>{{reviewer}}</strong>."),
        infoCard(
          [
            { label: "Date", value: "{{date}}" },
            { label: "Project", value: "{{project}}", emphasize: true },
            { label: "Hours", value: "{{hours}}h", emphasize: true },
            { label: "Reviewer", value: "{{reviewer}}" }
          ],
          COLORS.success
        ),
        button("View history", "{{appUrl}}/app/history", COLORS.success)
      ].join("\n")
    })
  },

  "timesheet.rejected": {
    subject: "Action required: timesheet for {{date}} rejected",
    bodyHtml: shell({
      preheader: "Reviewer: {{reviewer}}. Reason inside.",
      accent: COLORS.destructive,
      body: [
        heading("Action required — entry rejected"),
        lead("Hi {{name}}, your entry for <strong>{{date}}</strong> on <strong>{{project}}</strong> was rejected by <strong>{{reviewer}}</strong>."),
        calloutBox("Reason", "{{reason}}", COLORS.destructive),
        para("Open the entry, apply the fix, and resubmit. It'll re-enter the approval queue immediately."),
        button("Fix and resubmit", "{{appUrl}}/app/history", COLORS.destructive),
        muted("If you think this rejection was a mistake, reply to this email or contact {{reviewer}} directly.")
      ].join("\n")
    })
  },

  "sla.breach": {
    subject: "[SLA breach] Approve {{employeeName}}'s timesheet",
    bodyHtml: shell({
      preheader: "{{hoursOverdue}}h overdue. Please review now.",
      accent: COLORS.destructive,
      body: [
        heading("Approval SLA breached"),
        lead("{{managerName}}, a timesheet has missed its approval window and needs your immediate attention."),
        infoCard(
          [
            { label: "Employee", value: "{{employeeName}}", emphasize: true },
            { label: "Project", value: "{{project}}" },
            { label: "Work date", value: "{{date}}" },
            { label: "Deadline was", value: "{{deadline}}" },
            { label: "Overdue by", value: "{{hoursOverdue}} hours", emphasize: true }
          ],
          COLORS.destructive
        ),
        para("If this isn't resolved soon, the approval will be auto-escalated up the management chain."),
        button("Review approvals", "{{appUrl}}/app/approvals", COLORS.destructive)
      ].join("\n"),
      footerNote: "This is an automated SLA notification. The escalation chain runs every 15 minutes."
    })
  },

  escalation: {
    subject: "[Escalation] Approve {{employeeName}}'s timesheet",
    bodyHtml: shell({
      preheader: "Escalated from {{managerName}}.",
      accent: COLORS.accent,
      body: [
        heading("Escalation: please review"),
        lead("{{targetName}}, an approval has been escalated to you because the SLA was missed by <strong>{{managerName}}</strong>."),
        infoCard(
          [
            { label: "Employee", value: "{{employeeName}}", emphasize: true },
            { label: "Project", value: "{{project}}" },
            { label: "Work date", value: "{{date}}" },
            { label: "Original reviewer", value: "{{managerName}}" }
          ],
          COLORS.accent
        ),
        para("You can approve or reject the timesheet directly. The original reviewer has also been notified that the SLA was missed."),
        button("Review approvals", "{{appUrl}}/app/approvals", COLORS.accent)
      ].join("\n")
    })
  },

  "deadline.reminder": {
    subject: "{{daysLeft}} day(s) left to submit timesheets",
    bodyHtml: shell({
      preheader: "Submission deadline approaching.",
      accent: COLORS.accent,
      body: [
        heading("{{daysLeft}} day(s) left to submit"),
        lead("Hi {{name}}, just a heads up — your timesheets are due by <strong>day {{deadlineDay}}</strong> of the month."),
        para("Log any outstanding entries before the cutoff to keep approvals flowing and your team reports accurate."),
        button("Log time now", "{{appUrl}}/app/timesheet", COLORS.accent),
        muted("Already submitted? You can safely ignore this. Reminders only fire when we don't see a logged entry this cycle.")
      ].join("\n")
    })
  },

  "reminder.daily": {
    subject: "Don't forget — log today's timesheet ({{date}})",
    bodyHtml: shell({
      preheader: "Two minutes now saves a tomorrow-morning escalation.",
      accent: COLORS.primary,
      body: [
        heading("Hi {{name}}, log today's time"),
        lead("We haven't seen a timesheet entry from you for <strong>{{date}}</strong> yet."),
        para("Take two minutes to capture today's work — your manager sees it instantly, and we won't need to escalate tomorrow morning."),
        infoCard([
          { label: "Date", value: "{{date}}" },
          { label: "Deadline", value: "Today, {{deadlineHour}}:00", emphasize: true }
        ]),
        button("Log timesheet now", "{{appUrl}}/app/timesheet"),
        muted("Already logged for today? Great — you can safely ignore this reminder.")
      ].join("\n")
    })
  },

  "reminder.escalation.employee": {
    subject: "Action required — yesterday's timesheet escalated to {{managerName}}",
    bodyHtml: shell({
      preheader: "Log {{missedDate}} now to avoid an SLA breach.",
      accent: COLORS.destructive,
      body: [
        heading("Yesterday's timesheet was missed"),
        lead("{{name}}, you didn't log a timesheet for <strong>{{missedDate}}</strong>. We've notified your manager <strong>{{managerName}}</strong> this morning."),
        calloutBox(
          "Action required",
          "Log the missing entry for {{missedDate}} <strong>and</strong> file today's timesheet before 5 PM to avoid an SLA breach.",
          COLORS.destructive
        ),
        button("Catch up now", "{{appUrl}}/app/timesheet", COLORS.destructive),
        muted("Need to dispute this? Reply to this email or message {{managerName}} directly.")
      ].join("\n"),
      footerNote: "This escalation was triggered automatically because no timesheet entry was found for the previous business day."
    })
  },

  "reminder.escalation.manager": {
    subject: "{{employeeName}} missed yesterday's timesheet",
    bodyHtml: shell({
      preheader: "Reported to you so you can follow up before the SLA breaches.",
      accent: COLORS.accent,
      body: [
        heading("Heads up — missed timesheet from your team"),
        lead("Hi {{managerName}}, your report <strong>{{employeeName}}</strong> did not log a timesheet for <strong>{{missedDate}}</strong>."),
        infoCard(
          [
            { label: "Employee", value: "{{employeeName}}", emphasize: true },
            { label: "Email", value: "{{employeeEmail}}" },
            { label: "Missed date", value: "{{missedDate}}" }
          ],
          COLORS.accent
        ),
        para("They've also received a direct reminder asking them to catch up. If this happens repeatedly, consider a 1:1 — daily logging is a leading indicator of team health."),
        button("Open team view", "{{appUrl}}/app/team", COLORS.accent)
      ].join("\n"),
      footerNote: "Triggered automatically by the workspace's daily-reminder schedule. Edit the timing in Workspace Settings → Reminders & schedule."
    })
  },

  // --- Change management -------------------------------------------------------------------
  // Both carry the same block of facts, in the order the requirement listed them, so an approver
  // reading the second mail recognises the first without re-reading it.
  "change.submitted": {
    subject: "Approval needed: {{changeKey}} - {{title}}",
    bodyHtml: shell({
      preheader: "{{requestedBy}} submitted a change that needs your approval.",
      accent: COLORS.primary,
      body: [
        heading("A change needs your approval"),
        lead("<strong>{{requestedBy}}</strong> submitted a change on <strong>{{projectName}}</strong> and it is waiting on you."),
        infoCard([
          { label: "Change", value: "{{changeKey}}", emphasize: true },
          { label: "Project", value: "{{projectName}}" },
          { label: "Title", value: "{{title}}" },
          { label: "Type", value: "{{changeType}}" },
          { label: "Risk", value: "{{riskLevel}} ({{riskScore}})" },
          { label: "Activity window", value: "{{activityWindow}}" },
          { label: "Requested by", value: "{{requestedBy}}" },
          { label: "Received by", value: "{{receivedBy}}" },
          { label: "People involved", value: "{{peopleInvolved}}" }
        ]),
        lead("{{description}}"),
        button("Review and decide", "{{appUrl}}")
      ].join("\n")
    })
  },

  "change.decided": {
    subject: "Change {{decision}}: {{changeKey}} - {{title}}",
    bodyHtml: shell({
      preheader: "{{decidedBy}} {{decision}} this change.",
      accent: COLORS.primary,
      body: [
        heading("{{changeKey}} was {{decision}}"),
        lead("<strong>{{decidedBy}}</strong> reviewed \"<strong>{{title}}</strong>\" on {{projectName}}."),
        infoCard([
          { label: "Change", value: "{{changeKey}}", emphasize: true },
          { label: "Project", value: "{{projectName}}" },
          { label: "Title", value: "{{title}}" },
          { label: "Type", value: "{{changeType}}" },
          { label: "Risk", value: "{{riskLevel}} ({{riskScore}})" },
          { label: "Activity window", value: "{{activityWindow}}" },
          { label: "Requested by", value: "{{requestedBy}}" },
          { label: "Decision by", value: "{{decidedBy}}" },
          { label: "Comments", value: "{{comments}}" },
          { label: "People involved", value: "{{peopleInvolved}}" }
        ]),
        button("Open the change", "{{appUrl}}")
      ].join("\n")
    })
  },

  "ticket.assigned": {
    subject: "Ticket {{ticketKey}} assigned to you",
    bodyHtml: shell({
      preheader: "{{assignedBy}} assigned you a {{priority}} priority ticket.",
      accent: COLORS.primary,
      body: [
        heading("A ticket was assigned to you"),
        lead("Hi {{assigneeName}}, <strong>{{assignedBy}}</strong> assigned you a ticket."),
        infoCard([
          { label: "Ticket", value: "{{ticketKey}}", emphasize: true },
          { label: "Title", value: "{{title}}" },
          { label: "Priority", value: "{{priority}}" }
        ]),
        button("Open ticket", "{{appUrl}}/app/tickets")
      ].join("\n")
    })
  },

  "ticket.status_changed": {
    subject: "{{ticketKey}} moved to {{to}}",
    bodyHtml: shell({
      preheader: "{{changedBy}} moved this ticket from {{from}} to {{to}}.",
      accent: COLORS.primary,
      body: [
        heading("{{ticketKey}} moved to {{to}}"),
        lead("{{changedBy}} moved \"<strong>{{title}}</strong>\" from {{from}} to <strong>{{to}}</strong>."),
        button("Open ticket", "{{appUrl}}/app/tickets")
      ].join("\n")
    })
  },

  "ticket.commented": {
    subject: "New comment on {{ticketKey}}",
    bodyHtml: shell({
      preheader: "{{author}} commented on \"{{title}}\".",
      accent: COLORS.primary,
      body: [
        heading("New comment"),
        lead("{{author}} commented on \"<strong>{{title}}</strong>\" ({{ticketKey}})."),
        button("View comment", "{{appUrl}}/app/tickets")
      ].join("\n")
    })
  },

  "ticket.sla_breach": {
    subject: "[SLA breach] {{ticketKey}} — {{title}}",
    bodyHtml: shell({
      preheader: "{{hoursOverdue}}h overdue. Please review now.",
      accent: COLORS.destructive,
      body: [
        heading("Ticket SLA breached"),
        lead("{{assigneeName}}, this ticket has missed its resolution SLA and needs your immediate attention."),
        infoCard(
          [
            { label: "Ticket", value: "{{ticketKey}}", emphasize: true },
            { label: "Title", value: "{{title}}" },
            { label: "Priority", value: "{{priority}}" },
            { label: "Overdue by", value: "{{hoursOverdue}} hours", emphasize: true }
          ],
          COLORS.destructive
        ),
        button("Review ticket", "{{appUrl}}/app/tickets", COLORS.destructive)
      ].join("\n"),
      footerNote: "This is an automated SLA notification. The ticket escalation sweep runs every 15 minutes."
    })
  },

  "ticket.escalation": {
    subject: "[Escalation] {{ticketKey}} — {{title}}",
    bodyHtml: shell({
      preheader: "Escalated because {{assigneeName}} missed the resolution SLA.",
      accent: COLORS.accent,
      body: [
        heading("Escalation: please review"),
        lead("{{targetName}}, \"<strong>{{title}}</strong>\" ({{ticketKey}}) has been escalated to you because its assignee, <strong>{{assigneeName}}</strong>, missed the resolution SLA."),
        button("Review ticket", "{{appUrl}}/app/tickets", COLORS.accent)
      ].join("\n")
    })
  },

  "ticket.received_via_email": {
    subject: "We received your report — {{ticketKey}}",
    bodyHtml: shell({
      preheader: "Our team has been notified and will follow up.",
      accent: COLORS.primary,
      body: [
        heading("Thanks — we've logged this"),
        lead("Hi {{senderName}}, your email was automatically turned into a tracked ticket. Our team will follow up as needed."),
        infoCard([
          { label: "Ticket", value: "{{ticketKey}}", emphasize: true },
          { label: "Summary", value: "{{title}}" },
          { label: "Priority", value: "{{priority}}" }
        ]),
        muted("This is an automated confirmation — no need to reply unless you have more details to add.")
      ].join("\n")
    })
  },

  "ticket.needs_review": {
    subject: "Needs review: {{ticketKey}}",
    bodyHtml: shell({
      preheader: "An email-sourced ticket needs a human check.",
      accent: COLORS.accent,
      body: [
        heading("An inbound ticket needs review"),
        lead("{{targetName}}, an email from {{senderEmail}} was auto-classified with low confidence and needs a quick human check before it's assigned."),
        infoCard(
          [
            { label: "Ticket", value: "{{ticketKey}}", emphasize: true },
            { label: "Summary", value: "{{title}}" },
            { label: "AI confidence", value: "{{confidence}}" }
          ],
          COLORS.accent
        ),
        button("Review ticket", "{{appUrl}}/app/ai-activity", COLORS.accent)
      ].join("\n")
    })
  },

  "digest.weekly": {
    subject: "Your week in review — {{weekLabel}}",
    bodyHtml: shell({
      preheader: "An AI-authored recap of your ticket and timesheet activity.",
      accent: COLORS.info,
      body: [
        heading("Hi {{name}}, here's your week"),
        lead("{{summary}}"),
        button("Open your dashboard", "{{appUrl}}/app", COLORS.info),
        muted("This recap is AI-generated from your ticket and timesheet activity — turn it off anytime in your notification preferences.")
      ].join("\n")
    })
  },

  "ticket.closed_digest": {
    subject: "[{{ticketKey}}] Security digest — {{riskVerdict}}",
    bodyHtml: shell({
      preheader: "{{riskVerdict}}",
      accent: COLORS.destructive,
      body: [
        heading("{{ticketKey}} closed — security digest"),
        lead("{{closedBy}} closed \"<strong>{{title}}</strong>\". Summary of ingested security findings and test status below."),
        infoCard(
          [
            { label: "Verdict", value: "{{riskVerdict}}", emphasize: true },
            { label: "Latest test run", value: "{{testStatus}}" }
          ],
          COLORS.destructive
        ),
        calloutBox("Findings", "{{findingsText}}", COLORS.destructive),
        button("Open ticket", "{{appUrl}}/app/tickets", COLORS.destructive)
      ].join("\n"),
      footerNote: "Ingest-only — findings reflect whatever CI/security tools this workspace has connected. See Workspace Settings → Security & DevOps."
    })
  },

  /**
   * The one email in this file that contradicts a decision somebody already made — a scan ran and
   * the vulnerability they marked fixed is still there. That shapes every choice below.
   *
   * IT LEADS WITH THE EVIDENCE, not the accusation: which tool, which repository and branch, which
   * commit. A reader has to be able to check the claim and push back on it, and "your fix didn't
   * work" with nothing attached is unanswerable.
   *
   * IT SHOWS BOTH LISTS. The same scan usually confirms other findings as genuinely fixed, and
   * omitting those turns a factual report into a complaint. "Two of the four came back" is the
   * sentence that makes the situation legible.
   *
   * ITS BUTTON OPENS THE TICKET, not the ticket list — `?open={{ticketId}}`, the same deep link the
   * in-app notification uses. The close digest above still points at the bare list, which is a wart
   * it is welcome to keep; a mail sent to five people about ONE failed fix must not make each of
   * them search a workspace of seventeen hundred tickets for it.
   */
  "ticket.reopened_digest": {
    subject: "[{{ticketKey}}] A fix did not hold",
    bodyHtml: shell({
      preheader: "{{scanSummary}} still reports findings that were marked fixed.",
      accent: COLORS.destructive,
      body: [
        heading("{{ticketKey}} — a fix did not hold"),
        lead(
          "A scan ran and still reports findings that were marked fixed when {{closedBy}} resolved \"<strong>{{title}}</strong>\"."
        ),
        infoCard(
          [
            { label: "Proved by", value: "{{scanSummary}}", emphasize: true },
            { label: "Current verdict", value: "{{riskVerdict}}" },
            { label: "Ticket", value: "{{slaText}}" }
          ],
          COLORS.destructive
        ),
        calloutBox("Still reported", "{{survivedText}}", COLORS.destructive),
        calloutBox("Confirmed fixed by the same scan", "{{fixedText}}", COLORS.success),
        button("Open ticket", "{{appUrl}}/app/tickets?open={{ticketId}}", COLORS.destructive),
        muted(
          "Only a scan by the same tool, on the same repository and branch, can confirm or refute a finding — a different scanner not reporting it proves nothing either way."
        )
      ].join("\n"),
      footerNote: "Verified remediation is opt-in per workspace. See Workspace Settings → Security & DevOps."
    })
  }
};
