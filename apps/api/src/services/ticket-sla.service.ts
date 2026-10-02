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
import { suggestStaleTicketNextAction } from "./ai.service.js";
import { dispatchNotification } from "./notify.service.js";
import { templates } from "./mail-templates.js";
import { audit } from "./audit.service.js";
import { SYSTEM_ACCOUNT_DOMAIN } from "./workspace-metrics.js";

/** One account as the escalation rule reads it. */
interface DirectoryEntry {
  id: string;
  name: string;
  email: string;
  managerId: string | null;
  status: string;
  deletedAt: Date | null;
  isAgent: boolean;
  role: { name: string };
}

/** Everyone, oldest account first so "the first admin" is a stable answer — read once per sweep,
 *  not twice per overdue ticket. Inactive and deleted accounts included: the owner's manager chain
 *  is walked through them, and eligibility is decided below. */
async function loadEscalationDirectory(): Promise<DirectoryEntry[]> {
  return prisma.user.findMany({
    select: { id: true, name: true, email: true, managerId: true, status: true, deletedAt: true, isAgent: true, role: { select: { name: true } } },
    orderBy: { createdAt: "asc" }
  });
}

/**
 * Who an overdue ticket escalates to — somebody who can chase it and is not already on it. Mirrors
 * sla.service.ts#findEscalationTarget. Preference order:
 * 1. the owner's (the assignee's; the reporter's while it is unassigned) manager's manager;
 * 2. an ADMIN / SUPER_ADMIN, oldest account first.
 * Only an ACTIVE, undeleted person — never an agent identity or an intake/integration system account
 * — and never the assignee or the reporter (a system reporter is never a candidate anyway). So the
 * target is never the owner it escalates from. Null when nobody qualifies.
 *
 * WHY THE EXCLUSIONS: this was the timesheet sweep's old fallback — the first ADMIN/SUPER_ADMIN, with
 * no exclusions — and the manager's manager whoever they were. When that admin was the assignee the
 * ticket escalated to nobody although other admins existed, and a director who filed a ticket two
 * levels down had it escalated back to them: the one person already waiting on it.
 */
function findEscalationTarget(
  directory: readonly DirectoryEntry[],
  ticket: { assignee: { id: string } | null; reporter: { id: string } }
): { id: string; name: string; email: string } | null {
  const byId = new Map(directory.map((entry) => [entry.id, entry]));
  const excludedIds = new Set([ticket.reporter.id, ticket.assignee?.id]);
  const eligible = (entry: DirectoryEntry | undefined): entry is DirectoryEntry =>
    entry?.status === "ACTIVE" &&
    !entry.deletedAt &&
    !entry.isAgent &&
    !entry.email.toLowerCase().endsWith(SYSTEM_ACCOUNT_DOMAIN) &&
    !excludedIds.has(entry.id);
  const managerId = byId.get((ticket.assignee ?? ticket.reporter).id)?.managerId;
  const grandManager = managerId ? byId.get(byId.get(managerId)?.managerId ?? "") : undefined;
  const pick = eligible(grandManager)
    ? grandManager
    : directory.find((entry) => eligible(entry) && ["ADMIN", "SUPER_ADMIN"].includes(entry.role.name));
  return pick ? { id: pick.id, name: pick.name, email: pick.email } : null;
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
      deletedAt: null,
      // A change request's own ticket is timed by the change's STAGE SLAs (approval, implementation,
      // review), not by this resolution window. Without this, a MEDIUM change scheduled a week out
      // was "breached" after 72h and escalated to the requester's skip-level manager while it sat,
      // correctly, waiting for its window.
      changeRequest: { is: null }
    },
    include: { assignee: true, reporter: true, _count: { select: { comments: true, branches: true } } },
    take: 200
  });

  let escalations = 0;
  if (overdue.length === 0) return { breaches: 0, escalations };
  const directory = await loadEscalationDirectory();

  for (const ticket of overdue) {
    const hoursOverdue = ticket.dueAt ? (now.getTime() - ticket.dueAt.getTime()) / (1000 * 60 * 60) : 0;
    const owner = ticket.assignee ?? ticket.reporter;

    // slaBreachAt gates whether this sweep ever looks at this ticket again (the WHERE clause
    // above excludes anything with it set) — so it must only be written together with the
    // TicketEscalation row it implies, inside one transaction, not beforehand. Previously it
    // was set unconditionally before the escalation was even computed; a crash in between
    // permanently skipped that ticket's escalation on every future sweep with no way to
    // detect the miss. Notifications stay outside the transaction — best-effort external I/O.
    const target = findEscalationTarget(directory, ticket);

    if (target) {
      await prisma.$transaction([
        prisma.ticketEscalation.create({
          data: {
            ticketId: ticket.id,
            escalatedFromId: owner.id,
            escalatedToId: target.id,
            reason: `Resolution SLA breached by ${hoursOverdue.toFixed(1)}h.`
          }
        }),
        prisma.ticket.update({ where: { id: ticket.id }, data: { slaBreachAt: now } })
      ]);
      escalations += 1;
    } else {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { slaBreachAt: now } });
    }

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

    // Best-effort, opt-in AI nudge — its own notification, separate from the deterministic
    // breach notification above, so an AI failure/timeout never affects whether that one goes
    // out. Only fires when there's actually someone to send it to.
    if (ticket.assignee) {
      try {
        const suggestion = await suggestStaleTicketNextAction({
          ticketTitle: ticket.title,
          ticketType: ticket.type,
          priority: ticket.priority,
          hoursOverdue,
          commentCount: ticket._count.comments,
          hasLinkedBranch: ticket._count.branches > 0
        });
        if (suggestion) {
          await dispatchNotification({
            userId: ticket.assignee.id,
            category: "ticket.stale_nudge",
            title: `Suggested next step: ${ticket.key}`,
            body: suggestion,
            link: `/app/tickets?open=${ticket.id}`,
            email: {
              templateKey: "ticket.stale_nudge",
              vars: { assigneeName: ticket.assignee.name, ticketKey: ticket.key, title: ticket.title, suggestion },
              fallback: {
                subject: `Suggested next step — ${ticket.key}`,
                html: templates.ticketStaleNudge({ assigneeName: ticket.assignee.name, ticketKey: ticket.key, title: ticket.title, suggestion })
              }
            }
          });
        }
      } catch (error) {
        console.warn(`[ticket-sla] stale-ticket AI nudge failed for ticket ${ticket.id}: ${(error as Error).message}`);
      }
    }

    if (target) {
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

    await audit(undefined, "ticket.sla_breach", "Ticket", ticket.id, { hoursOverdue: Number(hoursOverdue.toFixed(2)) }, {
      actorType: "SYSTEM",
      actorLabel: "ticket-sla-sweep"
    });
  }

  return { breaches: overdue.length, escalations };
}
