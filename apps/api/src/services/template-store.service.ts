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
  "reminder.escalation.manager": ["managerName", "employeeName", "missedDate", "employeeEmail", "appUrl"]
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
  "reminder.escalation.manager": "Next-morning notification to the manager when a report missed yesterday's log."
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
    }
  };
  return samples[key] ?? {};
}

export { compiledTemplates };
