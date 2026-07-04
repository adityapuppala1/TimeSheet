/**
 * Ticket SLA sweep — the periodic job (see workers/ticket-escalation.worker.ts) that finds
 * tickets past their `dueAt` and turns that into human action: flags the breach, notifies the
 * assignee, and escalates up the management chain if it's still not resolved.
 *
 * WHY a sweep instead of a scheduled-per-ticket timer: `dueAt` is just a stored timestamp
 * (computed once at creation from GlobalTicketSettings), so a cron tick comparing "now" against
 * every open ticket's due date is simpler and more resilient to server restarts than scheduling
 * an individual timer per ticket.
 */
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { dispatchNotification } from "./notify.service.js";
import { templates } from "./mail-templates.js";
import { audit } from "./audit.service.js";

/**
 * Find the escalation target for a given user. Mirrors sla.service.ts's findEscalationTarget:
 * 1. User's manager's manager
 * 2. Any ADMIN / SUPER_ADMIN
 */
async function findEscalationTarget(userId: string): Promise<{ id: string; name: string; email: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { manager: { include: { manager: true } } }
  });
  const candidate = user?.manager?.manager;
  if (candidate && candidate.status === "ACTIVE") {
    return { id: candidate.id, name: candidate.name, email: candidate.email };
  }
  const admin = await prisma.user.findFirst({
    where: { status: "ACTIVE", deletedAt: null, role: { name: { in: ["ADMIN", "SUPER_ADMIN"] } } },
    select: { id: true, name: true, email: true }
  });
  return admin;
}

/**
 * Scan for tickets past their due date, mark the breach, create a TicketEscalation,
 * and notify the assignee + escalation target.
 *
 * Idempotent: only triggers once per breach (uses slaBreachAt as the marker).
 */
export async function processTicketSlaSweep(now: Date = new Date()) {
  if (!env.TICKET_SLA_ENABLED) return { breaches: 0, escalations: 0 };

  const overdue = await prisma.ticket.findMany({
    where: {
      status: { notIn: ["RESOLVED", "CLOSED"] },
      slaBreachAt: null,
      dueAt: { lte: now },
      deletedAt: null
    },
    include: { assignee: true, reporter: true },
    take: 200
  });

  let escalations = 0;
  for (const ticket of overdue) {
    const hoursOverdue = ticket.dueAt ? (now.getTime() - ticket.dueAt.getTime()) / (1000 * 60 * 60) : 0;

    await prisma.ticket.update({ where: { id: ticket.id }, data: { slaBreachAt: now } });

    const owner = ticket.assignee ?? ticket.reporter;
    if (ticket.assignee) {
      await dispatchNotification({
        userId: ticket.assignee.id,
        category: "ticket.sla_breach",
        title: `SLA breach: ${ticket.key}`,
        body: `"${ticket.title}" is ${hoursOverdue.toFixed(1)}h past its resolution SLA.`,
        link: `/app/tickets?open=${ticket.id}`,
        email: {
          templateKey: "ticket.sla_breach",
          vars: {
            assigneeName: ticket.assignee.name,
            ticketKey: ticket.key,
            title: ticket.title,
            priority: ticket.priority,
            hoursOverdue: hoursOverdue.toFixed(1)
          },
          fallback: {
            subject: `[SLA breach] ${ticket.key} — ${ticket.title}`,
            html: templates.ticketSlaBreach({
              assigneeName: ticket.assignee.name,
              ticketKey: ticket.key,
              title: ticket.title,
              priority: ticket.priority,
              hoursOverdue
            })
          }
        }
      });
    }

    const target = await findEscalationTarget(owner.id);
    if (target && target.id !== owner.id) {
      await prisma.ticketEscalation.create({
        data: {
          ticketId: ticket.id,
          escalatedFromId: owner.id,
          escalatedToId: target.id,
          reason: `Resolution SLA breached by ${hoursOverdue.toFixed(1)}h.`
        }
      });
      escalations += 1;

      await dispatchNotification({
        userId: target.id,
        category: "ticket.escalation",
        title: `Ticket escalated: ${ticket.key}`,
        body: `"${ticket.title}" missed its resolution SLA and was escalated to you.`,
        link: `/app/tickets?open=${ticket.id}`,
        email: {
          templateKey: "ticket.escalation",
          vars: { targetName: target.name, ticketKey: ticket.key, title: ticket.title, assigneeName: owner.name },
          fallback: {
            subject: `[Escalation] ${ticket.key} — ${ticket.title}`,
            html: templates.ticketEscalation({ targetName: target.name, ticketKey: ticket.key, title: ticket.title, assigneeName: owner.name })
          }
        }
      });
    }

    await audit(undefined, "ticket.sla_breach", "Ticket", ticket.id, { hoursOverdue: Number(hoursOverdue.toFixed(2)) });
  }

  return { breaches: overdue.length, escalations };
}
