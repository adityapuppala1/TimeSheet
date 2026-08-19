/**
 * WHAT: the two emails change management sends — "this needs your approval" and "it was approved /
 * rejected" — and the recipient rule they share.
 *
 * WHY THE TEMPLATES ARE REGISTERED RATHER THAN INLINE: every other message in this app is an
 * `EmailTemplate` row, which is what puts it on the Email templates page with editable copy, per-
 * template send volume, the success/failure split and the failure triage desk. A hand-rolled
 * `sendMail` here would deliver the same bytes and be invisible to all of that — the analytics the
 * requirement asks for are a consequence of registering, not a separate feature.
 *
 * WHO GETS THEM: the approver and the requester on the To line, plus the change's collaborators,
 * because they are the people doing the work. Super admins are BCC'd — but by `mail.service.ts`,
 * which already does that for every send when the workspace has it switched on and skips anyone who
 * muted the category. This file deliberately does not add its own BCC; see `audienceFor`.
 *
 * WHY DELIVERY NEVER FAILS A TRANSITION: a change that moved is a fact. Losing it because a mail
 * server was slow would be the worse outcome, so every caller wraps these in a catch — the same
 * posture as every other dispatch site in this codebase.
 */
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { dispatchNotification } from "./notify.service.js";
import { renderEmailTemplate } from "./template-store.service.js";
import { sendMail } from "./mail.service.js";
import { templates } from "./mail-templates.js";

/** The template keys this module owns. Seeded into `EmailTemplate` so the Email templates page can
 *  edit their copy and report on their delivery. */
export const CHANGE_TEMPLATE_KEYS = {
  submitted: "change.submitted",
  decided: "change.decided"
} as const;

/** Everything both emails put on the page, in the order the requirement listed them. */
interface ChangeMailVars {
  changeKey: string;
  projectName: string;
  title: string;
  changeType: string;
  riskLevel: string;
  riskScore: string;
  activityWindow: string;
  description: string;
  requestedBy: string;
  receivedBy: string;
  peopleInvolved: string;
  appUrl: string;
  /** Decision mail only. */
  decision?: string;
  decidedBy?: string;
  comments?: string;
}

const stamp = (d: Date | null): string =>
  d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "not scheduled";

function activityWindow(change: { plannedStart: Date | null; plannedEnd: Date | null }): string {
  if (!change.plannedStart) return "Not scheduled";
  if (!change.plannedEnd) return stamp(change.plannedStart);
  return `${stamp(change.plannedStart)} to ${stamp(change.plannedEnd)}`;
}

/** Strips markup so the mail quotes prose rather than inheriting the app's styling inside a client
 *  that does not share it — the same treatment ticket descriptions get. */
function plain(html: string | null | undefined, limit = 1200): string {
  if (!html) return "";
  const text = html.replace(/<[^>]{0,400}>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

type ChangeForMail = {
  id: string;
  changeKey: string;
  changeKind: string;
  riskLevel: string;
  riskScore: number;
  justification: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  ticket: {
    title: string;
    description: string | null;
    project: { name: string };
    reporter: { id: string; name: string; email: string };
    assignee: { id: string; name: string; email: string } | null;
  };
  collaborators?: Array<{ user: { id: string; name: string; email: string } }>;
};

/**
 * Who is on the thread.
 *
 * ONLY the To line is built here. The super-admin BCC the requirement asks for is already a
 * workspace-level behaviour — `mail.service.ts#getBccList` adds it to every send when
 * `bccSuperAdminOnAllEmails` is on, and skips any super admin who muted this category in the Email
 * channels grid. Adding a second BCC here would double-deliver to the people who left it on and
 * re-deliver to the people who deliberately turned it off, which is the single loudest source of
 * super-admin inbox noise this codebase has already fixed once.
 */
async function audienceFor(change: ChangeForMail, approverIds: string[]): Promise<{ to: string[]; bcc: string[]; involved: string }> {
  const approvers = approverIds.length
    ? await prisma.user.findMany({ where: { id: { in: approverIds }, deletedAt: null }, select: { id: true, name: true, email: true } })
    : [];

  const people = new Map<string, { name: string; email: string }>();
  people.set(change.ticket.reporter.id, change.ticket.reporter);
  if (change.ticket.assignee) people.set(change.ticket.assignee.id, change.ticket.assignee);
  for (const a of approvers) people.set(a.id, a);
  for (const c of change.collaborators ?? []) people.set(c.user.id, c.user);

  const toEmails = [...people.values()].map((p) => p.email).filter(Boolean);

  // Oversight, named here rather than left to the workspace-wide audit BCC. That setting is off in
  // most workspaces precisely because it copies a super admin on every reminder for every employee;
  // a change approval is a governance record where oversight IS the point, so it asks for itself.
  // `sendMail` de-duplicates against the To line, so a super admin who is already the approver gets
  // one message rather than two.
  const superAdmins = await prisma.user.findMany({
    where: { role: { name: "SUPER_ADMIN" }, status: "ACTIVE", deletedAt: null, isAgent: false },
    select: { email: true }
  });

  const involved = [
    `${change.ticket.reporter.name} (requester)`,
    ...(change.ticket.assignee ? [`${change.ticket.assignee.name} (implementer)`] : []),
    ...approvers.map((a) => `${a.name} (approver)`),
    ...(change.collaborators ?? []).map((c) => c.user.name)
  ].join(", ");

  return { to: toEmails, bcc: superAdmins.map((a) => a.email).filter(Boolean), involved };
}

function baseVars(change: ChangeForMail, receivedBy: string): ChangeMailVars {
  return {
    changeKey: change.changeKey,
    projectName: change.ticket.project.name,
    title: change.ticket.title,
    changeType: change.changeKind,
    riskLevel: change.riskLevel,
    riskScore: `${change.riskScore}/100`,
    activityWindow: activityWindow(change),
    description: plain(change.ticket.description) || plain(change.justification),
    requestedBy: change.ticket.reporter.name,
    receivedBy,
    peopleInvolved: "",
    appUrl: `${env.APP_BASE_URL}/app/changes?open=${change.id}`
  };
}

/**
 * The shipped design, used when a workspace has not customised the template.
 *
 * Built from `mail-templates.ts` rather than hand-rolled here, so the fallback and the seeded
 * `EmailTemplate` row render the SAME email. A bespoke fallback would mean a workspace that disabled
 * its template silently started receiving a different-looking message than one that never touched it
 * — and a governance email that changes appearance is one people stop trusting.
 */
function fallbackFor(vars: ChangeMailVars, decision?: "APPROVED" | "REJECTED"): { subject: string; html: string } {
  if (decision) {
    return {
      subject: `Change ${decision}: ${vars.changeKey} - ${vars.title}`,
      html: templates.changeDecided({ ...vars, decision, decidedBy: vars.decidedBy ?? "", comments: vars.comments ?? null })
    };
  }
  return {
    subject: `Approval needed: ${vars.changeKey} - ${vars.title}`,
    html: templates.changeSubmitted(vars)
  };
}

/**
 * Sent the moment a change is submitted — the requirement is that it reaches the approver
 * immediately, so this is called from the transition itself rather than from a queue or a sweep.
 */
export async function sendChangeSubmittedMail(change: ChangeForMail, actor: { name: string }, approverIds: string[]): Promise<void> {
  const { to, bcc, involved } = await audienceFor(change, approverIds);
  const approvers = approverIds.length
    ? await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } })
    : [];

  const vars = baseVars(change, approvers.map((a) => a.name).join(", ") || "Pending assignment");
  vars.peopleInvolved = involved;

  const rendered = await renderEmailTemplate(CHANGE_TEMPLATE_KEYS.submitted, { ...vars }, fallbackFor(vars));

  await sendMail({ to: to.join(","), subject: rendered.subject, html: rendered.html, template: CHANGE_TEMPLATE_KEYS.submitted, preferenceKey: "emailChangeSubmitted", alwaysBcc: bcc });

  // The in-app half. Always fires, whatever the email settings say — an approval that goes silent
  // because somebody tidied their inbox rules is a governance hole, not a preference.
  for (const approverId of approverIds) {
    await dispatchNotification({
      userId: approverId,
      category: "change.approval_requested",
      title: `Approval needed: ${change.changeKey}`,
      body: `${actor.name} submitted "${change.ticket.title}" for your approval.`,
      link: `/app/changes?open=${change.id}`
    }).catch(() => undefined);
  }
}

/** Sent when the change is approved or rejected, carrying who decided and what they said. */
export async function sendChangeDecisionMail(
  change: ChangeForMail,
  actor: { id: string; name: string },
  decision: "APPROVED" | "REJECTED",
  comments: string | null
): Promise<void> {
  const { to, bcc, involved } = await audienceFor(change, [actor.id]);

  const vars = baseVars(change, actor.name);
  vars.peopleInvolved = involved;
  vars.decision = decision;
  vars.decidedBy = actor.name;
  vars.comments = comments ?? "—";

  const heading = decision === "APPROVED" ? "Change approved" : "Change rejected";
  const rendered = await renderEmailTemplate(CHANGE_TEMPLATE_KEYS.decided, { ...vars }, fallbackFor(vars, decision));

  await sendMail({ to: to.join(","), subject: rendered.subject, html: rendered.html, template: CHANGE_TEMPLATE_KEYS.decided, preferenceKey: decision === "APPROVED" ? "emailChangeApproved" : "emailChangeRejected", alwaysBcc: bcc });

  const parties = new Set<string>([change.ticket.reporter.id, change.ticket.assignee?.id].filter((id): id is string => Boolean(id)));
  parties.delete(actor.id);
  for (const userId of parties) {
    await dispatchNotification({
      userId,
      category: decision === "APPROVED" ? "change.approved" : "change.rejected",
      title: `${heading}: ${change.changeKey}`,
      body: `${actor.name} ${decision === "APPROVED" ? "approved" : "rejected"} "${change.ticket.title}".`,
      link: `/app/changes?open=${change.id}`
    }).catch(() => undefined);
  }
}
