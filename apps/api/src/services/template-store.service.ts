/**
 * WHAT: the registry pairing every email template key with its expected `{{variable}}` names,
 * a human-readable description, and sample values — used to render live previews and validate
 * saved templates in the admin Email Templates editor.
 * WHY: `mail-templates.ts` defines what each template *looks like*; this file defines what
 * variables it *expects*, kept as one shared source of truth so the editor's preview and the
 * actual send always agree on what `{{name}}`-style placeholders are valid for a given key.
 * WHO calls this: `controllers/email-templates.controller.ts`.
 */
import { prisma } from "../config/prisma.js";
import { templates as compiledTemplates } from "./mail-templates.js";

export const TEMPLATE_VARIABLES: Record<string, string[]> = {
  welcome: ["name", "appUrl"],
  reset: ["resetUrl", "appUrl"],
  "timesheet.submitted": ["name", "hours", "date", "project", "managerName", "appUrl"],
  "timesheet.approved": ["name", "hours", "date", "reviewer", "project", "appUrl"],
  "timesheet.rejected": ["name", "date", "project", "reviewer", "reason", "appUrl"],
  "sla.breach": ["managerName", "employeeName", "date", "project", "deadline", "hoursOverdue", "appUrl"],
  escalation: ["targetName", "employeeName", "managerName", "date", "project", "appUrl"],
  "deadline.reminder": ["name", "daysLeft", "deadlineDay", "appUrl"],

  // Daily-reminder family
  "reminder.daily": ["name", "date", "deadlineHour", "appUrl"],
  "reminder.escalation.employee": ["name", "missedDate", "managerName", "appUrl"],
  "reminder.escalation.manager": ["managerName", "employeeName", "missedDate", "employeeEmail", "appUrl"],

  // Ticketing
  "ticket.assigned": ["assigneeName", "ticketKey", "title", "priority", "assignedBy", "appUrl"],
  "ticket.status_changed": ["ticketKey", "title", "from", "to", "changedBy", "appUrl"],
  "ticket.commented": ["ticketKey", "title", "author", "appUrl"],
  "ticket.sla_breach": ["assigneeName", "ticketKey", "title", "priority", "hoursOverdue", "appUrl"],
  "ticket.escalation": ["targetName", "ticketKey", "title", "assigneeName", "appUrl"],
  "ticket.received_via_email": ["senderName", "ticketKey", "title", "priority", "appUrl"],
  "ticket.needs_review": ["targetName", "ticketKey", "title", "senderEmail", "confidence", "appUrl"],
  "digest.weekly": ["name", "weekLabel", "summary", "appUrl"],
  "ticket.closed_digest": ["ticketKey", "title", "closedBy", "riskVerdict", "findingsText", "testStatus", "appUrl"],
  "digest.security_weekly": ["weekLabel", "summary", "riskScore", "appUrl"]
};

export const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  welcome: "Sent the first time an account is created.",
  reset: "Password reset link with a 30-minute TTL.",
  "timesheet.submitted": "Confirmation to the employee when a timesheet enters the approval queue.",
  "timesheet.approved": "Sent when a manager approves a timesheet.",
  "timesheet.rejected": "Sent when a manager rejects a timesheet — includes the reason.",
  "sla.breach": "Sent to the manager who missed an approval window before we escalate.",
  escalation: "Sent to the manager-of-manager (or admin) when an approval SLA is missed.",
  "deadline.reminder": "Reminder to log time before the monthly cutoff.",
  "reminder.daily": "Daily 4 PM nudge to log today's timesheet (weekdays only).",
  "reminder.escalation.employee": "Next-morning escalation reminder to the employee for a missed log day.",
  "reminder.escalation.manager": "Next-morning notification to the manager when a report missed yesterday's log.",

  "ticket.assigned": "Sent to the assignee when a ticket is assigned to them.",
  "ticket.status_changed": "Sent to the reporter, assignee, and watchers when a ticket's status changes.",
  "ticket.commented": "Sent to the reporter, assignee, and watchers when someone comments on a ticket.",
  "ticket.sla_breach": "Sent to the assignee when a ticket misses its resolution SLA.",
  "ticket.escalation": "Sent to the escalation target when a ticket's SLA breach is escalated.",
  "ticket.received_via_email": "Confirmation sent to an external sender whose email was auto-converted into a ticket.",
  "ticket.needs_review": "Sent to project admins/managers when an email-sourced ticket's AI confidence is below the threshold.",
  "digest.weekly": "Monday-morning AI-authored recap of a person's ticket + timesheet activity for the past week.",
  "ticket.closed_digest": "Security/test-status digest sent when a ticket with ingested findings closes — to the closer + their manager, cc this workspace's admins.",
  "digest.security_weekly": "Monday-morning AI-authored org-wide security recap (open findings, risk score, tickets past SLA) sent to every ADMIN/SUPER_ADMIN."
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATE_VARIABLES);

export function applyVars(
  template: string,
  vars: Record<string, string | number | undefined | null>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

interface RenderedEmail {
  subject: string;
  html: string;
}

export async function renderEmailTemplate(
  key: string,
  vars: Record<string, string | number | undefined | null>,
  defaults: RenderedEmail
): Promise<RenderedEmail> {
  const override = await prisma.emailTemplate.findUnique({ where: { key } }).catch(() => null);
  if (override && override.enabled) {
    return {
      subject: applyVars(override.subject, vars),
      html: applyVars(override.bodyHtml, vars)
    };
  }
  return defaults;
}

export function sampleVariables(key: string): Record<string, string> {
  const samples: Record<string, Record<string, string>> = {
    welcome: { name: "Aanya Sharma", appUrl: "https://timesphere.local" },
    reset: { resetUrl: "https://timesphere.local/reset-password?token=demo", appUrl: "https://timesphere.local" },
    "timesheet.submitted": {
      name: "Aanya Sharma", hours: "7.50", date: "2026-05-27",
      project: "HICS Operations Platform", managerName: "Mira Kapoor",
      appUrl: "https://timesphere.local"
    },
    "timesheet.approved": {
      name: "Aanya Sharma", hours: "7.50", date: "2026-05-27",
      reviewer: "Mira Kapoor", project: "HICS Operations Platform",
      appUrl: "https://timesphere.local"
    },
    "timesheet.rejected": {
      name: "Aanya Sharma", date: "2026-05-27",
      project: "HICS Operations Platform", reviewer: "Mira Kapoor",
      reason: "Activity should be 'Bug Fixing'.", appUrl: "https://timesphere.local"
    },
    "sla.breach": {
      managerName: "Mira Kapoor", employeeName: "Aanya Sharma", date: "2026-05-27",
      project: "HICS Operations Platform", deadline: "2026-05-29 18:00",
      hoursOverdue: "4.2", appUrl: "https://timesphere.local"
    },
    escalation: {
      targetName: "Avery Stone", employeeName: "Aanya Sharma", managerName: "Mira Kapoor",
      date: "2026-05-27", project: "HICS Operations Platform", appUrl: "https://timesphere.local"
    },
    "deadline.reminder": {
      name: "Aanya Sharma", daysLeft: "3", deadlineDay: "5", appUrl: "https://timesphere.local"
    },
    "reminder.daily": {
      name: "Aanya Sharma", date: "2026-05-27", deadlineHour: "17", appUrl: "https://timesphere.local"
    },
    "reminder.escalation.employee": {
      name: "Aanya Sharma", missedDate: "2026-05-26",
      managerName: "Mira Kapoor", appUrl: "https://timesphere.local"
    },
    "reminder.escalation.manager": {
      managerName: "Mira Kapoor", employeeName: "Aanya Sharma",
      employeeEmail: "aanya@example.com", missedDate: "2026-05-26",
      appUrl: "https://timesphere.local"
    },
    "ticket.assigned": {
      assigneeName: "Dev Patel", ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      priority: "HIGH", assignedBy: "Mira Kapoor", appUrl: "https://timesphere.local"
    },
    "ticket.status_changed": {
      ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      from: "IN_PROGRESS", to: "IN_REVIEW", changedBy: "Dev Patel", appUrl: "https://timesphere.local"
    },
    "ticket.commented": {
      ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      author: "Mira Kapoor", appUrl: "https://timesphere.local"
    },
    "ticket.sla_breach": {
      assigneeName: "Dev Patel", ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      priority: "HIGH", hoursOverdue: "6.5", appUrl: "https://timesphere.local"
    },
    "ticket.escalation": {
      targetName: "Avery Stone", ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      assigneeName: "Dev Patel", appUrl: "https://timesphere.local"
    },
    "ticket.received_via_email": {
      senderName: "Priya Nair", ticketKey: "HICS-OPS-1", title: "Checkout page throws a 500 error",
      priority: "HIGH", appUrl: "https://timesphere.local"
    },
    "ticket.needs_review": {
      targetName: "Avery Stone", ticketKey: "HICS-OPS-1", title: "Checkout page throws a 500 error",
      senderEmail: "priya@example.com", confidence: "0.42", appUrl: "https://timesphere.local"
    },
    "digest.weekly": {
      name: "Dev Patel", weekLabel: "Jun 29 - Jul 5",
      summary: "It was a solid week — you resolved 4 tickets and logged 32.5 hours, mostly on the Payments module. HICS-OPS-12 (checkout timeout) is still open and worth a look Monday morning.",
      appUrl: "https://timesphere.local"
    },
    "ticket.closed_digest": {
      ticketKey: "HICS-OPS-140", title: "Security ingestion test ticket", closedBy: "Avery Stone",
      riskVerdict: "Needs attention — 1 open CRITICAL finding, 1 open HIGH finding, latest test run FAILED.",
      findingsText: "Static analysis (SAST):<br />  - [CRITICAL] SQL injection in login handler (semgrep)<br /><br />Secrets scanning (SSAT):<br />  - [HIGH] Hardcoded AWS key (gitleaks)",
      testStatus: "FAILED", appUrl: "https://timesphere.local"
    },
    "digest.security_weekly": {
      weekLabel: "Jun 29 - Jul 5",
      summary: "Risk dropped this week — 2 CRITICAL findings from last week were resolved and no new CRITICAL/HIGH issues landed. One security-linked ticket is still past its SLA and worth a look Monday morning.",
      riskScore: "18", appUrl: "https://timesphere.local"
    }
  };
  return samples[key] ?? {};
}

export { compiledTemplates };
