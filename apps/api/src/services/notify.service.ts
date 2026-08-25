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
  | "ai.autonomy_applied"
  /** In-app ONLY — see the `null` in SETTINGS_FIELD. Raised when a reviewer edits somebody
   *  else's timesheet entry, so the change never happens silently behind the author's back. */
  | "timesheet.updated"
  /** In-app ONLY, and deliberately so — see the `null` in SETTINGS_FIELD. "The workspace is now
   *  running vX.Y.Z" is news, not correspondence: emailing every user of every tenant on every
   *  upgrade is the kind of send that gets a domain filtered, and no category in the email role
   *  matrix covers product announcements. Raised once per version per workspace by
   *  services/release-announce.service.ts. */
  | "release.published"
  /** In-app ONLY, deliberately. Raised by the Workflow Studio for news: a flow ran for the first
   *  time, or a step notified somebody. News does not need an email; a thing WAITING on somebody
   *  does, and that is `workflow.approval` below. */
  | "workflow.attention"
  /** A workflow has stopped at a gate and is waiting for this person to decide. The one workflow
   *  message with an email leg, because it is the only one that BLOCKS. */
  | "workflow.approval"
  /** Weekly, to a goal's owner: which of their goals are off track and which periods are closing. */
  | "goal.digest"
  /* --- Change management. Every one of these except the digest is a direct consequence of an
     action somebody took, which is this codebase's test for whether a message ships enabled. --- */
  /** A change has been raised and needs assessment or approval. */
  | "change.submitted"
  /** Sent to an approver the moment their step in a change's chain opens. */
  | "change.approval_requested"
  /** The board said yes — sent to the requester, implementer and watchers. */
  | "change.approved"
  /** The board said no, with the rejecting approver's comment. */
  | "change.rejected"
  /** An approved change has been given a window. */
  | "change.scheduled"
  /** The implementation window opens shortly — sent a day out and an hour out. */
  | "change.window_reminder"
  /** Work on an approved change has begun. */
  | "change.implementation_started"
  /** A change finished implementing, with its outcome. */
  | "change.completed"
  /** A change failed or was rolled back — sent to admins as well as the parties. */
  | "change.failed"
  /** A change is waiting on its post-implementation review. */
  | "change.pir_due"
  /** A change's window collides with a freeze period. */
  | "change.freeze_conflict"
  /** An approval has sat undecided past the workspace's approval SLA. */
  | "change.overdue_approval"
  /** Monday digest to change managers: next week's calendar, last week's outcomes. */
  | "digest.change_weekly";

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

/**
 * `null` marks a category with NO email leg and therefore no toggle to gate — it exists only as a
 * bell-menu row. Written as an explicit null rather than an omission so the `Record` still forces
 * every new category to make the choice, and so that giving one of them an email payload later is
 * a visible edit here (adding the settings column) instead of an ungated send.
 */
const SETTINGS_FIELD: Record<NotificationCategory, string | null> = {
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
  "ai.autonomy_applied": "emailAiAutonomyApplied",
  "timesheet.updated": null,
  "release.published": null,
  "workflow.attention": null,
  "workflow.approval": "emailWorkflowApproval",
  "goal.digest": "emailGoalDigest",
  "change.submitted": "emailChangeSubmitted",
  "change.approval_requested": "emailChangeApprovalRequested",
  "change.approved": "emailChangeApproved",
  "change.rejected": "emailChangeRejected",
  "change.scheduled": "emailChangeScheduled",
  "change.window_reminder": "emailChangeWindowReminder",
  "change.implementation_started": "emailChangeImplementationStarted",
  "change.completed": "emailChangeCompleted",
  "change.failed": "emailChangeFailed",
  "change.pir_due": "emailChangePirDue",
  "change.freeze_conflict": "emailChangeFreezeConflict",
  "change.overdue_approval": "emailChangeOverdueApproval",
  "digest.change_weekly": "emailChangeWeeklyDigest"
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
      preferenceKey: field ?? undefined,
      metadata: args.metadata
    });
  })().catch((error) => {
    console.error(`[notify] detached email send failed for ${args.category}:`, (error as Error).message);
  });
}

/**
 * One in-app row for many people at once, for a category that has NO email leg.
 *
 * WHY THIS EXISTS ALONGSIDE `dispatchNotification`: that function is per-recipient by necessity —
 * it reads the user to decide whether to email them and which role mutes apply. A workspace-wide
 * announcement has no email leg to decide anything about, so paying two queries per employee to
 * arrive at "write the row" is arithmetic, not safety. The recipient filtering that matters
 * (active, not deleted) is the caller's `where` clause on the same `User` table.
 *
 * The `null` assertion is the invariant, not a formality: giving `category` an email payload later
 * means adding a SETTINGS_FIELD column, and this path would have silently skipped the gate.
 */
export async function dispatchInAppToMany(args: {
  userIds: string[];
  category: NotificationCategory;
  title: string;
  body: string;
  link?: string;
}): Promise<number> {
  if (SETTINGS_FIELD[args.category] !== null) {
    throw new Error(`dispatchInAppToMany refuses "${args.category}": it has an email leg, use dispatchNotification`);
  }
  if (args.userIds.length === 0) return 0;

  const created = await prisma.notification.createMany({
    data: args.userIds.map((userId) => ({
      userId,
      title: args.title,
      body: args.body,
      category: args.category,
      link: args.link
    }))
  });
  return created.count;
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
  /** "The rendered body carries a credential." Set it on anything that emails a reset link or a
   *  generated password — see mail.service.ts#SendArgs.sensitive for what it changes and why. */
  sensitive?: boolean;
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
    template: args.templateKey,
    sensitive: args.sensitive
  });
}

export { templates };
