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

/** Reporter/assignee can edit their own ticket; tickets:assign / tickets:manage holders can edit any. */
export function canModifyTicket(req: any, ticket: { reporterId: string; assigneeId: string | null }): boolean {
  if (PRIVILEGED_ROLES.has(req.user.role)) return true;
  if (req.user.permissions.includes(permissions.TICKETS_ASSIGN) || req.user.permissions.includes(permissions.TICKETS_MANAGE)) {
    return true;
  }
  return ticket.reporterId === req.user.id || ticket.assigneeId === req.user.id;
}

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
