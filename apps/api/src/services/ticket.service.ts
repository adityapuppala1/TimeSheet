/**
 * Ticket domain helpers shared across ticket.controller.ts and the AI/email-intake pipelines.
 *
 * WHAT: workspace-wide ticket settings (SLA hours per priority), the human-readable ticket
 * key sequence (e.g. "WEB-123"), and the access-control predicates (`ticketProjectScope`,
 * `canModifyTicket`, `isProjectMember`) that decide who can see/edit which tickets.
 *
 * WHY: these rules are needed by more than one controller (manual ticket creation, the AI
 * suggest-triage endpoint, and email-intake all need SLA due-date math; multiple routes need
 * the same "can this user touch this ticket" check) — keeping them here means the access-
 * control logic can't drift between call sites.
 */
import type { Prisma, TicketPriority } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

const GLOBAL_ID = "global";

/** Workspace-wide ticket SLA hours + opt-in analytics toggles. Upserted on read, mirrors getGlobalNotificationSettings. */
export async function getGlobalTicketSettings() {
  return prisma.globalTicketSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {},
    create: {
      id: GLOBAL_ID,
      slaLowHours: env.TICKET_SLA_LOW_HOURS,
      slaMediumHours: env.TICKET_SLA_MEDIUM_HOURS,
      slaHighHours: env.TICKET_SLA_HIGH_HOURS,
      slaCriticalHours: env.TICKET_SLA_CRITICAL_HOURS
    }
  });
}

type TicketSlaHours = { slaLowHours: number; slaMediumHours: number; slaHighHours: number; slaCriticalHours: number };

/** Due date for a ticket, computed from its priority against the workspace's configured SLA hours. */
export function computeTicketDueDate(createdAt: Date, priority: TicketPriority, settings: TicketSlaHours): Date {
  const hoursByPriority: Record<TicketPriority, number> = {
    LOW: settings.slaLowHours,
    MEDIUM: settings.slaMediumHours,
    HIGH: settings.slaHighHours,
    CRITICAL: settings.slaCriticalHours
  };
  const hours = hoursByPriority[priority] ?? settings.slaMediumHours;
  return new Date(createdAt.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Issue the next human-readable ticket key for a project (e.g. "WEB-123").
 * Must run inside the same transaction as the Ticket.create so a failed create
 * rolls back the sequence bump instead of leaving a numbering gap.
 */
export async function issueTicketKey(tx: Prisma.TransactionClient, projectId: string): Promise<string> {
  const project = await tx.project.update({
    where: { id: projectId },
    data: { ticketSeq: { increment: 1 } },
    select: { code: true, ticketSeq: true }
  });
  return `${project.code}-${project.ticketSeq}`;
}

/**
 * Which projects' tickets a user may see. Mirrors project.controller.ts's visibilityScope:
 * privileged roles see everything, MANAGER/TEAM_LEAD see their own + direct reports'
 * project assignments, EMPLOYEE sees only their own assignments.
 */
export async function ticketProjectScope(req: any): Promise<{ unrestricted: boolean; projectIds: string[] }> {
  const role = req.user.role;
  if (PRIVILEGED_ROLES.has(role)) return { unrestricted: true, projectIds: [] };

  const userIds = [req.user.id];
  if (role === "MANAGER" || role === "TEAM_LEAD") {
    const reports = await prisma.user.findMany({
      where: { managerId: req.user.id, deletedAt: null },
      select: { id: true }
    });
    userIds.push(...reports.map((r) => r.id));
  }

  const assignments = await prisma.userProjectAssignment.findMany({
    where: { userId: { in: userIds } },
    select: { projectId: true }
  });
  return { unrestricted: false, projectIds: Array.from(new Set(assignments.map((a) => a.projectId))) };
}

/**
 * Throws 403 unless `req.user` is allowed to see `projectId` under `ticketProjectScope`.
 * Every route that reads or writes a ticket sub-resource (comments, attachments, watchers,
 * labels, links, checklist) must call this with the parent ticket's projectId — the
 * sub-resource routes only check a coarse tickets:view/write permission, which every
 * non-viewer role holds tenant-wide, so without this a user could read/write sub-resources
 * on a ticket in a project they can't otherwise see at all via GET /api/tickets.
 */
export async function assertTicketVisible(req: any, projectId: string): Promise<void> {
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && !scope.projectIds.includes(projectId)) throw new AppError(403, "Forbidden");
}

export async function isProjectMember(userId: string, projectId: string): Promise<boolean> {
  const assignment = await prisma.userProjectAssignment.findFirst({ where: { userId, projectId } });
  return Boolean(assignment);
}

/**
 * Synchronous "may this person edit the ticket" test, over the parties already on the row.
 *
 * DELIBERATELY DOES NOT KNOW ABOUT COLLABORATORS: they live in their own table and answering for
 * them needs a query. Callers that can await should use `canWorkOnTicket()` below, which is this
 * predicate plus the collaborator roster; this one stays for the synchronous call sites and as the
 * cheap first branch of that function.
 */
export function canModifyTicket(req: any, ticket: { reporterId: string; assigneeId: string | null }): boolean {
  if (PRIVILEGED_ROLES.has(req.user.role)) return true;
  if (req.user.permissions.includes(permissions.TICKETS_MANAGE)) return true;
  return ticket.reporterId === req.user.id || ticket.assigneeId === req.user.id;
}

/**
 * The authority test for working on a ticket: the reporter who raised it, the assignee it sits
 * with, anyone explicitly added as a collaborator, a privileged role, or the manager the reporter
 * or assignee actually reports to.
 *
 * WHY `TICKETS_ASSIGN` NO LONGER GRANTS THIS ON ITS OWN: that permission is held tenant-wide by
 * every MANAGER and TEAM_LEAD, so it made "may I edit this ticket" answer yes for every manager in
 * the workspace, including ones with no relationship to the work. The rule now follows the
 * reporting line — `managerId` — which is the same relation the approvals chain, the org chart and
 * the Kanban swimlanes already read, so no new concept is introduced to enforce it.
 *
 * TICKETS_MANAGE is kept as a blanket grant: it is the delete-any-ticket right, and a role that may
 * remove a ticket outright cannot meaningfully be barred from editing one.
 */
export async function canWorkOnTicket(
  req: any,
  ticket: { id: string; reporterId: string; assigneeId: string | null }
): Promise<boolean> {
  if (canModifyTicket(req, ticket)) return true;
  if (await isMappedManagerFor(req.user.id, ticket)) return true;
  const collaborator = await prisma.ticketCollaborator.findFirst({
    where: { ticketId: ticket.id, userId: req.user.id },
    select: { id: true }
  });
  return Boolean(collaborator);
}

/**
 * Is `userId` the direct manager of this ticket's reporter or its assignee?
 *
 * Either side counts, deliberately. A ticket raised by one team against another has two people
 * with a legitimate stake in it, and a rule that recognised only the assignee's manager would stop
 * the raiser's own manager from chasing work their report is waiting on.
 */
async function isMappedManagerFor(
  userId: string,
  ticket: { reporterId: string; assigneeId: string | null }
): Promise<boolean> {
  const parties = [ticket.reporterId, ticket.assigneeId].filter((id): id is string => Boolean(id));
  if (parties.length === 0) return false;
  const managed = await prisma.user.findFirst({
    where: { id: { in: parties }, managerId: userId, deletedAt: null },
    select: { id: true }
  });
  return Boolean(managed);
}

/**
 * Who may change a ticket's assignee, or add and remove collaborators.
 *
 * Narrower than `canWorkOnTicket` on purpose: doing the work and deciding who does the work are
 * different rights. A SUPER_ADMIN or ADMIN administers the workspace and keeps both; beyond them,
 * only the manager the reporter or assignee actually reports to may move the ticket. An assignee
 * cannot hand their own ticket to somebody else, which is the whole point of the restriction.
 */
export async function canReassignTicket(
  req: any,
  ticket: { reporterId: string; assigneeId: string | null }
): Promise<boolean> {
  if (PRIVILEGED_ROLES.has(req.user.role)) return true;
  return isMappedManagerFor(req.user.id, ticket);
}

/**
 * The 403 an edit attempt raises. Says who MAY act rather than just refusing, because the most
 * common way to hit this is a manager who is simply not in this ticket's reporting line, and
 * "Forbidden" leaves them with no idea who to ask.
 */
export const WORK_FORBIDDEN_MESSAGE =
  "Only this ticket's reporter, its assignee, its collaborators, or their manager can work on it.";

/** The 403 both reassignment routes raise, phrased once so they cannot drift apart. */
export const REASSIGN_FORBIDDEN_MESSAGE =
  "Only a super admin, an admin, or the manager this ticket's reporter or assignee reports to can change who works on it.";

/** Throws a 422 unless `type` matches an active TicketType.name row. */
export async function assertValidTicketType(type: string): Promise<void> {
  const match = await prisma.ticketType.findFirst({ where: { name: type, isActive: true } });
  if (!match) throw new AppError(422, `"${type}" is not a valid ticket type`);
}

export function canReopenClosedTicket(req: any): boolean {
  return (
    PRIVILEGED_ROLES.has(req.user.role) ||
    req.user.permissions.includes(permissions.TICKETS_ASSIGN) ||
    req.user.permissions.includes(permissions.TICKETS_MANAGE)
  );
}

/**
 * General-purpose if/then automation on manually-created tickets — see prisma/schema.prisma's
 * TicketRule doc comment for the full model rationale. Evaluated once, right after a ticket is
 * created via the manual-creation route (ticket.controller.ts's POST /) — email/chat intake keep
 * using their own existing routing (EmailRoutingRule/ChatRoutingRule/ModuleAssigneeRule), so this
 * never runs for those sources; a rule with `conditionSource: EMAIL` is honored on the rare
 * "someone manually re-creates what looks like an email-sourced ticket" case, not real inbound
 * mail (which never reaches this function).
 *
 * Rules are evaluated in `order` ascending; the FIRST rule whose every set condition matches
 * wins (same semantics `ModuleAssigneeRule` lookups already use elsewhere) — later rules are not
 * merged in, so an admin ordering two overlapping rules gets a single predictable outcome instead
 * of last-write-wins field-by-field surprises.
 */
export interface AppliedTicketRule {
  ruleId: string;
  ruleName: string;
  assigneeId: string | null;
  notifyUserId: string | null;
}

export async function applyTicketRules(ticket: {
  id: string;
  key: string;
  title: string;
  projectId: string;
  priority: TicketPriority;
  source: string;
  externalReporterEmail: string | null;
}): Promise<AppliedTicketRule | null> {
  const rules = await prisma.ticketRule.findMany({ where: { isActive: true }, orderBy: { order: "asc" } });
  if (rules.length === 0) return null;

  const senderDomain = ticket.externalReporterEmail?.split("@")[1]?.toLowerCase();

  const matched = rules.find((rule) => {
    if (rule.conditionProjectId && rule.conditionProjectId !== ticket.projectId) return false;
    if (rule.conditionPriority && rule.conditionPriority !== ticket.priority) return false;
    if (rule.conditionSource && rule.conditionSource !== ticket.source) return false;
    if (rule.conditionSenderDomain && rule.conditionSenderDomain.toLowerCase() !== senderDomain) return false;
    return true;
  });
  if (!matched) return null;

  if (matched.actionAssigneeId) {
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: matched.actionAssigneeId } });
  }
  if (matched.actionLabelId) {
    await prisma.ticketLabel.upsert({
      where: { ticketId_labelId: { ticketId: ticket.id, labelId: matched.actionLabelId } },
      update: {},
      create: { ticketId: ticket.id, labelId: matched.actionLabelId }
    });
  }

  // Notification/email dispatch is the caller's job (ticket.controller.ts's POST / handler) —
  // it already knows how to send the "you've been assigned" email for a create-time assigneeId,
  // so returning the matched rule here lets it reuse that exact same code path for a
  // rule-assigned ticket instead of this function duplicating it.
  return { ruleId: matched.id, ruleName: matched.name, assigneeId: matched.actionAssigneeId, notifyUserId: matched.actionNotifyUserId };
}
