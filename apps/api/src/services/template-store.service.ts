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
  "workspace.find": ["code", "appUrl"],
  "timesheet.submitted": ["name", "hours", "date", "project", "managerName", "module", "submodule", "activity", "description", "ticketRef", "appUrl"],
  "timesheet.approved": ["name", "hours", "date", "reviewer", "project", "module", "submodule", "activity", "description", "appUrl"],
  "timesheet.rejected": ["name", "date", "project", "reviewer", "reason", "module", "submodule", "activity", "description", "appUrl"],
  "sla.breach": ["managerName", "employeeName", "date", "project", "deadline", "hoursOverdue", "appUrl"],
  escalation: ["targetName", "employeeName", "managerName", "date", "project", "appUrl"],
  "deadline.reminder": ["name", "daysLeft", "deadlineDay", "appUrl"],

  // Daily-reminder family
  "reminder.daily": ["name", "date", "deadlineHour", "appUrl"],
  "reminder.escalation.employee": ["name", "missedDate", "managerName", "appUrl"],
  "reminder.escalation.manager": ["managerName", "employeeName", "missedDate", "employeeEmail", "appUrl"],

  // Ticketing
  "ticket.assigned": ["assigneeName", "ticketKey", "title", "priority", "assignedBy", "type", "module", "description", "appUrl"],
  "ticket.status_changed": ["ticketKey", "title", "from", "to", "changedBy", "type", "comment", "appUrl"],
  "ticket.commented": ["ticketKey", "title", "author", "type", "comment", "appUrl"],
  "ticket.sla_breach": ["assigneeName", "ticketKey", "title", "priority", "hoursOverdue", "appUrl"],
  "ticket.escalation": ["targetName", "ticketKey", "title", "assigneeName", "appUrl"],
  "ticket.received_via_email": ["senderName", "ticketKey", "title", "priority", "appUrl"],
  "ticket.needs_review": ["targetName", "ticketKey", "title", "senderEmail", "confidence", "appUrl"],
  "digest.weekly": ["name", "weekLabel", "summary", "tablesHtml", "appUrl"],
  "digest.practice_update": ["periodLabel", "headline", "sectionsHtml", "appUrl"],
  "ticket.closed_digest": ["ticketKey", "title", "closedBy", "riskVerdict", "findingsText", "testStatus", "appUrl"],
  "digest.security_weekly": ["weekLabel", "summary", "riskScore", "appUrl"],
  // Both of these were being SENT and were missing from this registry, so the editor did not list
  // them and no administrator could change a word of them. Reconciled by a test now, not by care.
  "digest.bug_pattern": ["periodLabel", "summary", "appUrl"],
  "ticket.stale_nudge": ["assigneeName", "ticketKey", "title", "suggestion", "appUrl"],
  "goal.digest": ["name", "weekLabel", "summary", "linesText", "appUrl"],
  "workflow.approval": ["name", "flowName", "subject", "stepOrder", "appUrl"],

  // Maintenance mode — the "wrap up" warning a SUPER_ADMIN sends to online users.
  "maintenance.scheduled": ["name", "window", "message", "appUrl"],

  // Face (identity) verification — see docs/FACE_VERIFICATION.md. Deliberately variable-light:
  // these emails never carry scores, images, or anything biometric.
  "face.enrollment_required": ["name", "appUrl"],
  "face.verification_flagged": ["targetName", "employeeName", "failureCount", "context", "appUrl"],
  "face.review_overdue": ["targetName", "pendingCount", "oldestAgeHours", "appUrl"],
  "face.data_deleted": ["name", "appUrl"],
  "face.entitlement_lost": ["targetName", "graceDays", "appUrl"],
  "digest.identity_weekly": ["targetName", "weekLabel", "total", "passed", "failed", "flaggedPending", "notes", "appUrl"],
  "change.submitted": ["changeKey", "projectName", "title", "changeType", "riskLevel", "riskScore", "activityWindow", "description", "requestedBy", "receivedBy", "peopleInvolved", "appUrl"],
  "change.decided": ["changeKey", "projectName", "title", "changeType", "riskLevel", "riskScore", "activityWindow", "requestedBy", "decision", "decidedBy", "comments", "peopleInvolved", "appUrl"]
};

export const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  welcome: "Sent the first time an account is created.",
  reset: "Password reset link with a 30-minute TTL.",
  "workspace.find": "Verification code for \"find my workspaces\" — sent only when the address matches one, and expires in 10 minutes.",
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
  "digest.practice_update":
    "The consolidated Weekly AI/ML Practice Update sent to a leadership distribution list — products, POCs, bugs, security, training, metrics, risks and the decisions being asked for. Sent on demand by a SUPER_ADMIN, and optionally every Monday.",
  "digest.bug_pattern": "Periodic AI-authored correlation of what keeps breaking, to whoever opted in.",
  "ticket.stale_nudge": "Nudge to a ticket's assignee when it has gone quiet, with an AI-suggested next step.",
  "goal.digest": "Weekly, to a goal's OWNER: which of their goals are off track and which periods close soon. Off by default.",
  "workflow.approval": "A workflow stopped at a gate and is waiting for this person to approve or decline. On by default — it blocks.",
  "ticket.closed_digest": "Security/test-status digest sent when a ticket with ingested findings closes — to the closer + their manager, cc this workspace's admins.",
  "digest.security_weekly": "Monday-morning AI-authored org-wide security recap (open findings, risk score, tickets past SLA) sent to every ADMIN/SUPER_ADMIN.",
  "maintenance.scheduled": "\"Save your work\" warning a super admin sends to online users before a maintenance window — quotes the window and the admin's message.",

  "face.enrollment_required": "Sent when the face-verification policy starts covering someone who hasn't enrolled (and as the follow-up reminder).",
  "face.verification_flagged": "Sent to the person's manager and workspace admins when repeated failed identity checks flag an attempt for review.",
  "face.review_overdue": "Sent to admins when flagged identity checks have sat unreviewed for more than 48 hours.",
  "face.data_deleted": "Confirmation to the person whose face enrollment/captures were deleted (self-service or by an admin).",
  "face.entitlement_lost": "Sent to admins when the org's plan tier stops including face verification — enforcement pauses and a purge grace window starts.",
  "digest.identity_weekly": "Monday-morning deterministic identity-assurance recap (checks run, failures, flagged pending) sent to every ADMIN/SUPER_ADMIN.",
  "change.submitted":
    "Sent the moment a change is submitted — to its approver, the requester, and everyone tagged on it. Super admins are BCC'd.",
  "change.decided":
    "Sent when a change is approved or rejected, carrying who decided and the comments they left."
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
    "workspace.find": { code: "418902", appUrl: "https://timesphere.local" },
    "timesheet.submitted": {
      module: "Payments", submodule: "Checkout", activity: "Development",
      description: "Reworked the retry path so a declined card no longer double-charges.\n\nBlocked for an hour on the sandbox being down.",
      ticketRef: "HICS-OPS-88 — Invoice PDF renders blank",
      name: "Aanya Sharma", hours: "7.50", date: "2026-05-27",
      project: "HICS Operations Platform", managerName: "Mira Kapoor",
      appUrl: "https://timesphere.local"
    },
    "timesheet.approved": {
      module: "Payments", submodule: "Checkout", activity: "Development",
      description: "Reworked the retry path so a declined card no longer double-charges.",
      name: "Aanya Sharma", hours: "7.50", date: "2026-05-27",
      reviewer: "Mira Kapoor", project: "HICS Operations Platform",
      appUrl: "https://timesphere.local"
    },
    "timesheet.rejected": {
      module: "Payments", submodule: "Checkout", activity: "Development",
      description: "Reworked the retry path so a declined card no longer double-charges.",
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
      type: "BUG", module: "Checkout",
      description: "Customers on the annual plan see a blank invoice PDF. Reproduced on two accounts.",
      assigneeName: "Dev Patel", ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      priority: "HIGH", assignedBy: "Mira Kapoor", appUrl: "https://timesphere.local"
    },
    "ticket.status_changed": {
      type: "BUG", comment: "Priya Raman: Fix is on staging — please retest with the annual plan account.",
      ticketKey: "HICS-OPS-1", title: "Login button misaligned on mobile",
      from: "IN_PROGRESS", to: "IN_REVIEW", changedBy: "Dev Patel", appUrl: "https://timesphere.local"
    },
    "ticket.commented": {
      type: "BUG", comment: "I can reproduce this on the annual plan only. The monthly invoice renders fine.",
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
    "goal.digest": {
      name: "Priya Raman", weekLabel: "Aug 17 - Aug 23",
      summary: "One of your three goals is off track and one period closes this week.",
      linesText: "Cut SLA breaches by half — off track, 68% of the way with 20% of the period left<br />Ship the billing rewrite — on track<br />Keep spend under 40k — period ends Friday",
      appUrl: "https://timesphere.local"
    },
    "workflow.approval": {
      name: "Avery Stone", flowName: "Ask before it acts", subject: "HICS-OPS-1340 — checkout timeout",
      stepOrder: "1", appUrl: "https://timesphere.local"
    },
    "digest.bug_pattern": {
      periodLabel: "Jul 21 - Aug 17",
      summary: "Checkout accounted for 6 of 14 bugs this period, all after the payment retry change on the 24th.",
      appUrl: "https://timesphere.local"
    },
    "ticket.stale_nudge": {
      assigneeName: "Dev Patel", ticketKey: "HICS-OPS-88", title: "Invoice PDF renders blank for one client",
      suggestion: "Nobody has commented in 9 days. Either ask the reporter for the failing invoice id, or close it as cannot-reproduce.",
      appUrl: "https://timesphere.local"
    },
    "digest.practice_update": {
      periodLabel: "17 Aug – 23 Aug 2026",
      headline: "47 tickets closed and 128 hours logged across 6 initiatives; two are red.",
      sectionsHtml:
        "<p style=\"color:#64748B;font-size:13px;\">(the ten sections — executive summary, the five practice areas, releases, metrics, risks, priorities and decisions — render here)</p>",
      appUrl: "https://timesphere.local"
    },
    "digest.weekly": {
      tablesHtml: "<p style=\"color:#64748B;font-size:13px;\">(the tables of last week, month-to-date and year-to-date figures render here)</p>",
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
    // The face family and the identity digest had NO sample values at all, so their previews rendered
    // the design with every field blank — which reads as a broken template rather than as an
    // unfilled one. Deliberately kept free of scores, images and anything biometric, matching what
    // these emails are allowed to carry.
    "face.enrollment_required": { name: "Dev Patel", appUrl: "https://timesphere.local" },
    "face.verification_flagged": {
      targetName: "Avery Stone", employeeName: "Dev Patel", failureCount: "3",
      context: "three failed checks while submitting a timesheet", appUrl: "https://timesphere.local"
    },
    "face.review_overdue": { targetName: "Avery Stone", pendingCount: "6", oldestAgeHours: "52", appUrl: "https://timesphere.local" },
    "face.data_deleted": { name: "Dev Patel", appUrl: "https://timesphere.local" },
    "face.entitlement_lost": { targetName: "Avery Stone", graceDays: "14", appUrl: "https://timesphere.local" },
    "digest.identity_weekly": {
      targetName: "Avery Stone", weekLabel: "Aug 10 - Aug 16", total: "128", passed: "124", failed: "3",
      flaggedPending: "1", notes: "One check is still awaiting review from Thursday.",
      appUrl: "https://timesphere.local"
    },
    "maintenance.scheduled": {
      name: "Aanya Sharma",
      window: "Sat, Aug 8, 10:00 PM until Sat, Aug 8, 11:30 PM",
      message: "We're upgrading the database. Timesheets submitted before 9:45 PM are safe.",
      appUrl: "https://timesphere.local"
    },
    "digest.security_weekly": {
      weekLabel: "Jun 29 - Jul 5",
      summary: "Risk dropped this week — 2 CRITICAL findings from last week were resolved and no new CRITICAL/HIGH issues landed. One security-linked ticket is still past its SLA and worth a look Monday morning.",
      riskScore: "18", appUrl: "https://timesphere.local"
    },
    "change.submitted": {
      changeKey: "HICS-TS-20260812-0001",
      projectName: "HICS Operations Platform",
      title: "Upgrade the payments database to 15.4",
      changeType: "NORMAL",
      riskLevel: "HIGH",
      riskScore: "72/100",
      activityWindow: "2026-08-29 22:00 to 2026-08-30 02:00 UTC",
      description: "15.2 leaves support in October and the CVE backlog is growing. Snapshot, upgrade in place, verify with the payment smoke suite.",
      requestedBy: "Dev Patel",
      receivedBy: "Mira Kapoor",
      peopleInvolved: "Dev Patel (requester), Mira Kapoor (approver), Aditya Teja",
      appUrl: "https://timesphere.local/app/changes"
    },
    "change.decided": {
      changeKey: "HICS-TS-20260812-0001",
      projectName: "HICS Operations Platform",
      title: "Upgrade the payments database to 15.4",
      changeType: "NORMAL",
      riskLevel: "HIGH",
      riskScore: "72/100",
      activityWindow: "2026-08-29 22:00 to 2026-08-30 02:00 UTC",
      requestedBy: "Dev Patel",
      decision: "APPROVED",
      decidedBy: "Mira Kapoor",
      comments: "Window is outside the billing run. Please confirm the snapshot completed before starting.",
      peopleInvolved: "Dev Patel (requester), Mira Kapoor (approver), Aditya Teja",
      appUrl: "https://timesphere.local/app/changes"
    }
  };
  return samples[key] ?? {};
}

export { compiledTemplates };

/* ================================================================== *
 * The shipped default for every key
 * ================================================================== */

/**
 * WHAT: each template's real subject and real body, with `{{placeholders}}` where the values go.
 *
 * WHY IT EXISTS: the Email Templates editor had no idea what any un-customised template actually
 * looked like. The list route returned `bodyHtml: null` when there was no override, and the editor
 * fell back to a three-line stub reading "Title / Hi {{name}}, your action is required." So the
 * preview was near-blank for every template nobody had already edited — which is most of them — and,
 * far worse, pressing Save on that screen REPLACED a carefully built email with the stub. An editor
 * whose default action destroys the thing it is editing is not an editor.
 *
 * HOW: the compiled templates in `mail-templates.ts` are called with each of their own arguments set
 * to that argument's `{{name}}`. The result is the genuine design — shell, heading, info card,
 * button, footer — with placeholders exactly where a real value would land. `escape()` leaves
 * `{{name}}` untouched (it holds no HTML-special characters), and the five numeric fields go through
 * `num`/`pct`, which pass a placeholder straight through rather than calling `.toFixed` on a string.
 *
 * WHY IT IS NOT DERIVED AUTOMATICALLY: every compiled template takes a differently-shaped argument
 * object, and nothing can invent one. A test reconciles this map against `TEMPLATE_KEYS` and against
 * every `templateKey` actually dispatched in the codebase, so the drift that hid `digest.bug_pattern`
 * and `ticket.stale_nudge` from the editor entirely cannot recur silently.
 */
const V = (name: string) => `{{${name}}}`;

export const TEMPLATE_DEFAULTS: Record<string, { subject: string; html: string }> = {
  welcome: { subject: "Welcome to TimeSphere", html: compiledTemplates.welcome(V("name")) },
  reset: { subject: "Reset your TimeSphere password", html: compiledTemplates.reset(V("resetUrl")) },
  "workspace.find": {
    // THE CODE IS NOT IN THE SUBJECT, deliberately. `sensitive: true` keeps the rendered BODY out
    // of EmailLog, but the subject is always stored — and Workspace Settings → Email templates
    // shows recent sends to any workspace admin. A code in the subject would therefore be a live,
    // readable credential for ten minutes to an admin of an unrelated workspace, which is exactly
    // the cross-workspace disclosure this whole flow is built to prevent. Caught by reading the
    // EmailLog rows a real send produced.
    subject: "Your TimeSphere verification code",
    html: compiledTemplates.workspaceFind(V("code"))
  },

  "timesheet.submitted": {
    subject: "Timesheet submitted - {{date}}",
    html: compiledTemplates.timesheetSubmitted({
      name: V("name"), hours: V("hours"), date: V("date"), project: V("project"), managerName: V("managerName"),
      module: V("module"), submodule: V("submodule"), activity: V("activity"), description: V("description"), ticketRef: V("ticketRef")
    })
  },
  "timesheet.approved": {
    subject: "Your timesheet was approved",
    html: compiledTemplates.timesheetApproved({
      name: V("name"), hours: V("hours"), date: V("date"), reviewer: V("reviewer"), project: V("project"),
      module: V("module"), submodule: V("submodule"), activity: V("activity"), description: V("description")
    })
  },
  "timesheet.rejected": {
    subject: "Timesheet rejected - action required",
    html: compiledTemplates.timesheetRejected({
      name: V("name"), date: V("date"), project: V("project"), reviewer: V("reviewer"), reason: V("reason"),
      module: V("module"), submodule: V("submodule"), activity: V("activity"), description: V("description")
    })
  },

  "sla.breach": {
    subject: "[SLA breach] Approve the timesheet for {{employeeName}}",
    html: compiledTemplates.slaBreach({
      managerName: V("managerName"), employeeName: V("employeeName"), date: V("date"), project: V("project"),
      deadline: V("deadline"), hoursOverdue: V("hoursOverdue")
    })
  },
  escalation: {
    subject: "[Escalation] Approve the timesheet for {{employeeName}}",
    html: compiledTemplates.escalation({
      targetName: V("targetName"), employeeName: V("employeeName"), managerName: V("managerName"), date: V("date"), project: V("project")
    })
  },
  "deadline.reminder": {
    subject: "{{daysLeft}} day(s) left to submit timesheets",
    html: compiledTemplates.deadlineReminder({ name: V("name"), daysLeft: V("daysLeft"), deadlineDay: V("deadlineDay") })
  },

  "reminder.daily": {
    subject: "Log your hours for {{date}}",
    html: compiledTemplates.deadlineReminder({ name: V("name"), daysLeft: V("date"), deadlineDay: V("deadlineHour") })
  },
  "reminder.escalation.employee": {
    subject: "You missed logging time on {{missedDate}}",
    html: compiledTemplates.escalation({
      targetName: V("name"), employeeName: V("name"), managerName: V("managerName"), date: V("missedDate"), project: "-"
    })
  },
  "reminder.escalation.manager": {
    subject: "{{employeeName}} missed a timesheet on {{missedDate}}",
    html: compiledTemplates.escalation({
      targetName: V("managerName"), employeeName: V("employeeName"), managerName: V("managerName"), date: V("missedDate"), project: "-"
    })
  },

  "ticket.assigned": {
    subject: "{{ticketKey}} assigned to you",
    html: compiledTemplates.ticketAssigned({
      assigneeName: V("assigneeName"), ticketKey: V("ticketKey"), title: V("title"), priority: V("priority"),
      assignedBy: V("assignedBy"), type: V("type"), module: V("module"), description: V("description")
    })
  },
  "ticket.status_changed": {
    subject: "{{ticketKey}} moved to {{to}}",
    html: compiledTemplates.ticketStatusChanged({
      ticketKey: V("ticketKey"), title: V("title"), from: V("from"), to: V("to"), changedBy: V("changedBy"),
      type: V("type"), comment: V("comment")
    })
  },
  "ticket.commented": {
    subject: "New comment on {{ticketKey}}",
    html: compiledTemplates.ticketCommented({
      ticketKey: V("ticketKey"), title: V("title"), author: V("author"), type: V("type"), comment: V("comment")
    })
  },
  "ticket.sla_breach": {
    subject: "[SLA breach] {{ticketKey}} is {{hoursOverdue}}h overdue",
    html: compiledTemplates.ticketSlaBreach({
      assigneeName: V("assigneeName"), ticketKey: V("ticketKey"), title: V("title"), priority: V("priority"), hoursOverdue: V("hoursOverdue")
    })
  },
  "ticket.escalation": {
    subject: "[Escalation] {{ticketKey}} needs attention",
    html: compiledTemplates.ticketEscalation({
      targetName: V("targetName"), ticketKey: V("ticketKey"), title: V("title"), assigneeName: V("assigneeName")
    })
  },
  "ticket.received_via_email": {
    subject: "We received your report - {{ticketKey}}",
    html: compiledTemplates.ticketReceivedViaEmail({
      senderName: V("senderName"), ticketKey: V("ticketKey"), title: V("title"), priority: V("priority")
    })
  },
  "ticket.needs_review": {
    subject: "{{ticketKey}} needs a human look",
    html: compiledTemplates.ticketNeedsReview({
      targetName: V("targetName"), ticketKey: V("ticketKey"), title: V("title"), senderEmail: V("senderEmail"), confidence: V("confidence")
    })
  },
  "ticket.stale_nudge": {
    subject: "Suggested next step - {{ticketKey}}",
    html: compiledTemplates.ticketStaleNudge({
      assigneeName: V("assigneeName"), ticketKey: V("ticketKey"), title: V("title"), suggestion: V("suggestion")
    })
  },
  "ticket.closed_digest": {
    subject: "{{ticketKey}} closed - security summary",
    html: compiledTemplates.ticketClosedDigest({
      ticketKey: V("ticketKey"), title: V("title"), closedBy: V("closedBy"), riskVerdict: V("riskVerdict"),
      findingsText: V("findingsText"), testStatus: V("testStatus")
    })
  },

  "digest.practice_update": {
    subject: "Weekly AI/ML Practice Update - {{periodLabel}}",
    html: compiledTemplates.practiceUpdate({ periodLabel: V("periodLabel"), headline: V("headline"), sectionsHtml: V("sectionsHtml") })
  },
  "digest.weekly": {
    subject: "Your week in review - {{weekLabel}}",
    html: compiledTemplates.weeklyDigest({ name: V("name"), weekLabel: V("weekLabel"), summary: V("summary"), tablesHtml: V("tablesHtml") })
  },
  "digest.security_weekly": {
    subject: "Security digest - week of {{weekLabel}}",
    html: compiledTemplates.securityWeeklyDigest({ weekLabel: V("weekLabel"), summary: V("summary"), riskScore: V("riskScore") })
  },
  "digest.bug_pattern": {
    subject: "What kept breaking - {{periodLabel}}",
    html: compiledTemplates.bugPatternDigest({ periodLabel: V("periodLabel"), summary: V("summary") })
  },
  "digest.identity_weekly": {
    subject: "Identity review - week of {{weekLabel}}",
    html: compiledTemplates.identityWeeklyDigest({
      targetName: V("targetName"), weekLabel: V("weekLabel"), total: V("total"), passed: V("passed"),
      failed: V("failed"), flaggedPending: V("flaggedPending"), notes: V("notes")
    })
  },

  "goal.digest": {
    subject: "Your goals - {{weekLabel}}",
    html: compiledTemplates.goalDigest({ name: V("name"), weekLabel: V("weekLabel"), summary: V("summary"), lines: [V("linesText")] })
  },
  "workflow.approval": {
    subject: "{{flowName}} needs your approval",
    html: compiledTemplates.workflowApproval({
      name: V("name"), flowName: V("flowName"), subject: V("subject"), stepOrder: V("stepOrder")
    })
  },
  "maintenance.scheduled": {
    subject: "Scheduled maintenance - {{window}}",
    html: compiledTemplates.maintenanceScheduled({ name: V("name"), window: V("window"), message: V("message") })
  },

  "face.enrollment_required": {
    subject: "Set up face verification",
    html: compiledTemplates.faceEnrollmentRequired({ name: V("name") })
  },
  "face.verification_flagged": {
    subject: "A verification needs review",
    html: compiledTemplates.faceVerificationFlagged({
      targetName: V("targetName"), employeeName: V("employeeName"), failureCount: V("failureCount"), context: V("context")
    })
  },
  "face.review_overdue": {
    subject: "Face reviews are overdue",
    html: compiledTemplates.faceReviewOverdue({ targetName: V("targetName"), pendingCount: V("pendingCount"), oldestAgeHours: V("oldestAgeHours") })
  },
  "face.data_deleted": {
    subject: "Your face data was deleted",
    html: compiledTemplates.faceDataDeleted({ name: V("name"), byAdmin: false })
  },
  "face.entitlement_lost": {
    subject: "Face verification is no longer active",
    html: compiledTemplates.faceEntitlementLost({ targetName: V("targetName"), graceDays: V("graceDays") })
  },

  "change.submitted": {
    subject: "Approval needed: {{changeKey}} - {{title}}",
    html: compiledTemplates.changeSubmitted({
      changeKey: V("changeKey"), projectName: V("projectName"), title: V("title"), changeType: V("changeType"),
      riskLevel: V("riskLevel"), riskScore: V("riskScore"), activityWindow: V("activityWindow"),
      description: V("description"), requestedBy: V("requestedBy"), receivedBy: V("receivedBy"),
      peopleInvolved: V("peopleInvolved"), appUrl: V("appUrl")
    })
  },

  "change.decided": {
    subject: "Change {{decision}}: {{changeKey}} - {{title}}",
    html: compiledTemplates.changeDecided({
      changeKey: V("changeKey"), projectName: V("projectName"), title: V("title"), changeType: V("changeType"),
      riskLevel: V("riskLevel"), riskScore: V("riskScore"), activityWindow: V("activityWindow"),
      requestedBy: V("requestedBy"), decision: V("decision"), decidedBy: V("decidedBy"),
      comments: V("comments"), peopleInvolved: V("peopleInvolved"), appUrl: V("appUrl")
    })
  }
};

/** The shipped default for one key, or null for a key with no compiled template behind it. */
export function templateDefault(key: string): { subject: string; html: string } | null {
  return TEMPLATE_DEFAULTS[key] ?? null;
}
