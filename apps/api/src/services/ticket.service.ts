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
