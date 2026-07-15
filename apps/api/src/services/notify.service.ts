/**
 * Single fan-out point for every in-app + email notification. `dispatchNotification()` always
 * writes the in-app `Notification` row (so the bell menu never misses anything), then only
 * sends the matching email if that category's `GlobalNotificationSettings` field is on —
 * `SETTINGS_FIELD` is the category -> settings-column map that makes that lookup generic
 * instead of a giant if/else per category. Adding a new notification (e.g. `digest.weekly`)
 * means adding one union member, one SETTINGS_FIELD entry, and one GlobalNotificationSettings
 * column — everything else (the admin toggle UI, the dispatch gating) follows automatically
 * because WorkspaceSettings.tsx renders its toggle list from `notificationPreferenceKeys`.
 * `dispatchTransactional()` is the sibling for mail that isn't tied to a registered User at all
 * (e.g. the email-intake confirmation reply to an external sender's address).
 */
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { sendMail } from "./mail.service.js";
import { renderEmailTemplate } from "./template-store.service.js";
import { templates } from "./mail-templates.js";

export type NotificationCategory =
  | "timesheet.submitted"
  | "timesheet.approved"
  | "timesheet.rejected"
  | "sla.breach"
  | "escalation"
  | "deadline.reminder"
  | "reminder.daily"
  | "reminder.escalation"
  | "ticket.assigned"
  | "ticket.status_changed"
  | "ticket.commented"
  | "ticket.sla_breach"
  | "ticket.escalation"
  | "ticket.needs_review"
  | "digest.weekly"
  | "ticket.closed_digest";

interface EmailPayload {
  templateKey: string;
  vars: Record<string, string | number | undefined | null>;
  /** Compiled fallback used when no DB override exists. */
  fallback: { subject: string; html: string };
}

interface DispatchArgs {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  link?: string;
  email?: EmailPayload;
  metadata?: Record<string, unknown>;
}

const SETTINGS_FIELD: Record<NotificationCategory, string> = {
  "timesheet.submitted": "emailTimesheetSubmitted",
  "timesheet.approved": "emailTimesheetApproved",
  "timesheet.rejected": "emailTimesheetRejected",
  "sla.breach": "emailSlaBreach",
  "escalation": "emailEscalation",
  "deadline.reminder": "emailDeadlineReminder",
  "reminder.daily": "emailDailyReminder",
  "reminder.escalation": "emailDailyEscalation",
  "ticket.assigned": "emailTicketAssigned",
  "ticket.status_changed": "emailTicketStatusChanged",
  "ticket.commented": "emailTicketCommented",
  "ticket.sla_breach": "emailTicketSlaBreach",
  "ticket.escalation": "emailTicketEscalation",
  "ticket.needs_review": "emailTicketNeedsReview",
  "digest.weekly": "emailWeeklyDigest",
  "ticket.closed_digest": "emailTicketClosedDigest"
};

const GLOBAL_ID = "global";

export async function getGlobalNotificationSettings() {
  return prisma.globalNotificationSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {},
    create: { id: GLOBAL_ID }
  });
}

export async function dispatchNotification(args: DispatchArgs) {
  const recipient = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { id: true, email: true, status: true, deletedAt: true }
  });
  if (!recipient || recipient.deletedAt || recipient.status !== "ACTIVE") return;

  await prisma.notification.create({
    data: {
      userId: args.userId,
      title: args.title,
      body: args.body,
      category: args.category,
      link: args.link
    }
  });

  if (!args.email) return;

  const settings = await getGlobalNotificationSettings();
  const field = SETTINGS_FIELD[args.category];
  if (field && !(settings as any)[field]) return;

  const enrichedVars = { ...args.email.vars, appUrl: args.email.vars.appUrl ?? env.APP_BASE_URL };
  const rendered = await renderEmailTemplate(args.email.templateKey, enrichedVars, args.email.fallback);

  await sendMail({
    to: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    template: args.category,
    metadata: args.metadata
  });
}

export async function dispatchTransactional(args: {
  /** May be a comma-separated list of addresses (nodemailer/most SMTP servers accept this
   *  directly as the `to` header) — used by the ticket-closed digest to put the closer and
   *  their manager both as primary recipients rather than cc'ing one of them. */
  to: string;
  templateKey: string;
  vars: Record<string, string | number | undefined | null>;
  fallback: { subject: string; html: string };
  /** Real Cc, not the hidden super-admin bcc — see mail.service.ts#SendArgs.cc. */
  cc?: string[];
}) {
  if (!args.to) {
    return { ok: false, status: "SKIPPED" as const, errorMessage: "Recipient missing" };
  }
  const enrichedVars = { ...args.vars, appUrl: args.vars.appUrl ?? env.APP_BASE_URL };
  const rendered = await renderEmailTemplate(args.templateKey, enrichedVars, args.fallback);
  return sendMail({
    to: args.to,
    cc: args.cc,
    subject: rendered.subject,
    html: rendered.html,
    template: args.templateKey
  });
}

export { templates };
