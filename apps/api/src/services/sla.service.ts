/**
 * WHAT: timesheet-approval SLA logic — computing a submission's approval deadline
 * (`computeApprovalDeadline`), sweeping for breaches and escalating them
 * (`processSlaSweep`), and clearing open escalations once a timesheet leaves SUBMITTED
 * (`resolveEscalationsFor`). This is the timesheet-side SLA system — the ticket-side equivalent
 * lives separately in `ticket-sla.service.ts`.
 * WHY: an approval that nobody acts on shouldn't just sit silently — this is what notices a
 * breach and routes it up the reporting chain (manager's manager, then an ADMIN/SUPER_ADMIN, then
 * any other approver — always somebody who may decide the entry) automatically.
 * HOW: `processSlaSweep` is idempotent per breach — `Timesheet.slaBreachAt` is the marker, so
 * re-running the sweep never double-escalates the same overdue entry.
 * WHO calls this: `workers/escalation.worker.ts` (the cron entry point), `controllers/timesheet.controller.ts`
 * (`computeApprovalDeadline` at submit time, `resolveEscalationsFor` at approve/reject time).
 */
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { dispatchNotification } from "./notify.service.js";
import { templates } from "./mail-templates.js";
import { audit } from "./audit.service.js";
import { loadReportingRows } from "./reporting-line.service.js";
import { loadApprovers, othersWhoMayDecide } from "./timesheet-approval-scope.service.js";

/**
 * Compute the approval deadline for a timesheet at submit time.
 * Uses Project.slaApprovalHours, falling back to the workspace default.
 */
export function computeApprovalDeadline(submittedAt: Date, slaHours: number | null | undefined): Date {
  const hours = slaHours && slaHours > 0 ? slaHours : env.SLA_DEFAULT_APPROVAL_HOURS;
  return new Date(submittedAt.getTime() + hours * 60 * 60 * 1000);
}

/** The reporting links and the current approvers — read once per sweep, not once per overdue row. */
interface EscalationDirectory {
  rows: Awaited<ReturnType<typeof loadReportingRows>>;
  approvers: Awaited<ReturnType<typeof loadApprovers>>;
}

/**
 * Who an overdue entry by `authorId` escalates to — only ever somebody who may DECIDE it, by the
 * rule in timesheet-approval-scope.service.ts: never the author, never someone the decision route
 * would refuse, and only an active, non-agent approver. Preference order among those:
 * 1. the author's manager's manager;
 * 2. an ADMIN / SUPER_ADMIN;
 * 3. any other eligible approver.
 * Null when nobody but the author could decide it.
 *
 * WHY THE ELIGIBILITY FILTER (audit 2026-10 R3, finding 1): the fallback used to be the first
 * ADMIN/SUPER_ADMIN with no exclusions. For the top of a reporting tree that was often the author
 * themselves, or a subordinate the approve route then refused — and since an escalation resolves
 * only when the entry is decided, that Escalation row could never resolve.
 */
function findEscalationTarget(directory: EscalationDirectory, authorId: string): { id: string; name: string; email: string } | null {
  const eligible = othersWhoMayDecide(
    directory.rows,
    directory.approvers.map((a) => a.id),
    authorId
  );
  const byId = new Map(directory.approvers.map((a) => [a.id, a]));
  const managerId = directory.rows.get(authorId)?.managerId;
  const grandManagerId = managerId ? directory.rows.get(managerId)?.managerId : null;
  const pick =
    (grandManagerId && eligible.includes(grandManagerId) ? grandManagerId : undefined) ??
    eligible.find((id) => ["ADMIN", "SUPER_ADMIN"].includes(byId.get(id)?.role.name ?? "")) ??
    eligible[0];
  const target = pick ? byId.get(pick) : undefined;
  return target ? { id: target.id, name: target.name, email: target.email } : null;
}

/**
 * Scan for timesheets where approval is overdue, mark the breach, create an Escalation,
 * notify the employee and the escalation target.
 *
 * Idempotent: only triggers once per breach (uses slaBreachAt as the marker).
 */
export async function processSlaSweep(now: Date = new Date()) {
  if (!env.SLA_ENABLED) return { breaches: 0, escalations: 0 };

  const overdue = await prisma.timesheet.findMany({
    where: {
      status: "SUBMITTED",
      slaBreachAt: null,
      approvalDeadline: { lte: now },
      deletedAt: null
    },
    include: {
      user: { include: { manager: true } },
      project: true
    },
    take: 200
  });

  let escalations = 0;
  if (overdue.length === 0) return { breaches: 0, escalations };
  const [rows, approvers] = await Promise.all([loadReportingRows(), loadApprovers()]);
  const directory: EscalationDirectory = { rows, approvers };

  for (const ts of overdue) {
    const hoursOverdue = ts.approvalDeadline ? (now.getTime() - ts.approvalDeadline.getTime()) / (1000 * 60 * 60) : 0;
    const dateLabel = ts.workDate.toISOString().slice(0, 10);

    const escalationTarget = findEscalationTarget(directory, ts.userId);
    const fromUser = ts.user.manager ?? ts.user;

    // slaBreachAt (the idempotency marker that keeps a re-run of this sweep from
    // double-escalating the same entry) is only written together with the Escalation row it
    // gates, inside one transaction — not as a separate write beforehand. Previously
    // slaBreachAt was set first and the Escalation created afterward; a crash or DB error in
    // between left the breach permanently marked "handled" with no escalation ever created,
    // a silent miss the next sweep could never catch (slaBreachAt being non-null is exactly
    // what tells it to skip this row). Notifications (email/in-app) stay outside the
    // transaction — they're best-effort external I/O that souldn't hold a DB transaction open,
    // and notify.service.ts already swallows its own email-send failures without throwing.
    if (escalationTarget) {
      await prisma.$transaction([
        prisma.escalation.create({
          data: {
            timesheetId: ts.id,
            escalatedFromId: fromUser.id,
            escalatedToId: escalationTarget.id,
            reason: `Approval SLA breached by ${hoursOverdue.toFixed(1)}h.`
          }
        }),
        prisma.timesheet.update({
          where: { id: ts.id },
          data: { slaBreachAt: now, escalatedAt: now }
        })
      ]);
      escalations += 1;

      await dispatchNotification({
        userId: escalationTarget.id,
        category: "escalation",
        title: "Approval escalated to you",
        body: `${ts.user.name}'s timesheet for ${dateLabel} on ${ts.project.name} missed SLA. Please review.`,
        link: "/app/approvals",
        email: {
          templateKey: "escalation",
          vars: {
            targetName: escalationTarget.name,
            employeeName: ts.user.name,
            managerName: fromUser.name,
            date: dateLabel,
            project: ts.project.name
          },
          fallback: {
            subject: `[Escalation] Approve ${ts.user.name}'s timesheet`,
            html: templates.escalation({
              targetName: escalationTarget.name,
              employeeName: ts.user.name,
              managerName: fromUser.name,
              date: dateLabel,
              project: ts.project.name
            })
          }
        }
      });

      // Also notify the original manager that we've escalated above them.
      if (ts.user.manager && ts.user.manager.id !== escalationTarget.id) {
        await dispatchNotification({
          userId: ts.user.manager.id,
          category: "sla.breach",
          title: "Your approval SLA was missed",
          body: `${ts.user.name}'s timesheet for ${dateLabel} was escalated to ${escalationTarget.name}.`,
          link: "/app/approvals"
        });
      }
    } else {
      // No target — only one write needed here (no Escalation row), so it's already atomic
      // on its own; still flag in-app for the immediate manager.
      await prisma.timesheet.update({
        where: { id: ts.id },
        data: { slaBreachAt: now }
      });
      const fallbackId = ts.user.manager?.id ?? ts.user.id;
      await dispatchNotification({
        userId: fallbackId,
        category: "sla.breach",
        title: "Approval SLA breached",
        body: `${ts.user.name}'s timesheet for ${dateLabel} is past its approval window.`,
        link: "/app/approvals",
        email: ts.user.manager
          ? {
              templateKey: "sla.breach",
              vars: {
                managerName: ts.user.manager.name,
                employeeName: ts.user.name,
                date: dateLabel,
                project: ts.project.name,
                deadline: ts.approvalDeadline?.toLocaleString() ?? "—",
                hoursOverdue: hoursOverdue.toFixed(1)
              },
              fallback: {
                subject: `[SLA breach] Approve ${ts.user.name}'s timesheet`,
                html: templates.slaBreach({
                  managerName: ts.user.manager.name,
                  employeeName: ts.user.name,
                  date: dateLabel,
                  project: ts.project.name,
                  deadline: ts.approvalDeadline?.toLocaleString() ?? "—",
                  hoursOverdue
                })
              }
            }
          : undefined
      });
    }

    await audit(undefined, "timesheet.sla_breach", "Timesheet", ts.id, {
      hoursOverdue: Number(hoursOverdue.toFixed(2))
    }, {
      actorType: "SYSTEM",
      actorLabel: "timesheet-sla-sweep"
    });
  }

  return { breaches: overdue.length, escalations };
}

/**
 * Resolve open escalations when a timesheet leaves the SUBMITTED state.
 */
export async function resolveEscalationsFor(timesheetId: string) {
  await prisma.escalation.updateMany({
    where: { timesheetId, resolvedAt: null },
    data: { resolvedAt: new Date() }
  });
}
