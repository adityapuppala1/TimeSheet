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
import {
  isEmailRoleMuted,
  type EmailRoleMutes,
  type NotificationPreferences,
  type RoleName
} from "@timesheet/shared";
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
  | "ticket.closed_digest"
  | "digest.security_weekly"
  | "face.enrollment_required"
  | "face.enrollment_reminder"
  | "face.verification_flagged"
  | "face.review_overdue"
  | "face.data_deleted"
  | "face.entitlement_lost"
  | "digest.identity_weekly"
  | "digest.bug_pattern"
  | "ticket.stale_nudge"
  | "maintenance.scheduled"
  | "ai.autonomy_applied";

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
  "ticket.closed_digest": "emailTicketClosedDigest",
  "digest.security_weekly": "emailSecurityWeeklyDigest",
  "face.enrollment_required": "emailFaceEnrollmentRequired",
  "face.enrollment_reminder": "emailFaceEnrollmentReminder",
  "face.verification_flagged": "emailFaceVerificationFlagged",
  "face.review_overdue": "emailFaceReviewOverdue",
  "face.data_deleted": "emailFaceDataDeleted",
  "face.entitlement_lost": "emailFaceEntitlementLost",
  "digest.identity_weekly": "emailIdentityWeeklyDigest",
  "digest.bug_pattern": "emailBugPatternDigest",
  "ticket.stale_nudge": "emailTicketStaleNudge",
  "maintenance.scheduled": "emailMaintenanceScheduled",
  "ai.autonomy_applied": "emailAiAutonomyApplied"
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
    select: { id: true, email: true, status: true, deletedAt: true, role: { select: { name: true } } }
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

  // Per-role suppression, layered under the category toggle above. Note the ordering: the
  // in-app Notification row is already written, so a muted role still sees the alert in the
  // bell menu — we are only declining to also put it in their inbox. Managers/super admins
  // who don't log time but do approve it are the motivating case.
  if (field && isEmailRoleMuted(settings.emailRoleMutes as EmailRoleMutes | null, field as keyof NotificationPreferences, recipient.role?.name as RoleName | undefined)) {
    return;
  }

  // The EMAIL leg is deliberately fire-and-forget. This function runs inside user request
  // paths (submit, approve, status change, face verify), and a real SMTP round-trip costs
  // 1–3 seconds PER RECIPIENT — measured: a face verify that notified four reviewers took
  // 8.7s wall-clock with the sends awaited, ~200ms without. The in-app row above IS awaited
  // (it's one cheap insert and the bell menu must never miss it); the email is a delivery
  // channel whose outcome nothing in the response depends on — sendMail cannot throw (it
  // resolves a status object and records every attempt in EmailLog either way), so detaching
  // changes WHEN the email leaves, never whether failures are recorded. Tenant context
  // propagates into the detached chain via AsyncLocalStorage, so sendMail still resolves the
  // right org's SMTP settings.
  void (async () => {
    const enrichedVars = { ...args.email!.vars, appUrl: args.email!.vars.appUrl ?? env.APP_BASE_URL };
    const rendered = await renderEmailTemplate(args.email!.templateKey, enrichedVars, args.email!.fallback);
    await sendMail({
      to: recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      template: args.category,
      preferenceKey: field,
      metadata: args.metadata
    });
  })().catch((error) => {
    console.error(`[notify] detached email send failed for ${args.category}:`, (error as Error).message);
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
