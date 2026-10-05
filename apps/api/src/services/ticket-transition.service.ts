/**
 * WHAT: the ONE function that moves a ticket's status — `transitionTicketStatus`. Every writer calls
 * it: the app's own route (`PATCH /api/tickets/:id/status`, which the Kanban drag also uses), the
 * public REST API, the MCP / agent `transition_ticket` tool, and the security-ingestion auto-reopen.
 *
 * WHY ONE FUNCTION: each of those surfaces used to carry its own copy of the rules, and the copies
 * had drifted. The API and MCP skipped the participants' notifications, the findings verification
 * gate and the close digest; MCP wrote no audit row on the ticket and the API wrote a different
 * action (`ticket.status_changed_via_api`), so the burndown, the reopen rate and the Tickets-page
 * sparklines — which replay `ticket.status_changed` — never saw either; MCP let anyone reopen a
 * CLOSED ticket; nothing refused a change's own ticket; and no reopen cleared `slaBreachAt`. A rule
 * that lives in one place cannot be forgotten by the fifth surface.
 *
 * WHAT IT APPLIES, in order: who may act (person surfaces only), the change-ownership guard,
 * transition legality, the closed→reopen right, the face gate (per surface — see below), the CI and
 * quality gates on RESOLVED, the write itself (resolvedAt/closedAt bookkeeping, a fresh SLA clock on
 * a reopen, the "needs review" flag cleared), one audit action, the domain events, the participants'
 * notifications, the findings gate, and the close digest.
 */
import { ticketStatusTransitions, type TicketStatus } from "@timesheet/shared";
import type { Prisma, TicketPriority } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import type { RequestUser } from "../middleware/auth.js";
import { htmlToPlainText } from "../utils/sanitize.js";
import { audit } from "./audit.service.js";
import { emitTicketStatusChanged } from "./domain-events.js";
import { templates } from "./mail-templates.js";
import { dispatchNotification, dispatchTransactional } from "./notify.service.js";
import {
  assertCiAllowsResolve,
  assertNotChangeOwned,
  assertQualityGateAllowsResolve,
  assertTicketVisible,
  canReopenClosedTicket,
  canWorkOnTicket,
  restartSlaClock,
  WORK_FORBIDDEN_MESSAGE
} from "./ticket.service.js";

/** Which surface moved the ticket — recorded on the audit row as `via`. */
export type TicketTransitionVia = "ui" | "api" | "mcp" | "auto_reopen";

/**
 * Who is moving the ticket, by surface. The shape differs because the authority does:
 *  - `ui` / `mcp`: a PERSON — the signed-in user, or the user an MCP credential or agent run acts
 *    for. Visibility, the may-work-on-it test and the closed→reopen right are all checked against
 *    them, exactly as the route always did.
 *  - `api`: an org-wide API KEY. Its writes are attributed to the person who created it, but it is
 *    not scoped to that person's projects or reporting line (see middleware/public-api-auth.ts), so
 *    the person-level checks do not apply — the same reason `ticketProjectScope` never did.
 *  - `auto_reopen`: nobody. The security ingestion reopening a ticket a scan proved still broken.
 */
export type TicketTransitionActor =
  | { via: "ui"; req: { user: RequestUser }; faceVerificationId?: string | null }
  | { via: "mcp"; req: { user: RequestUser }; caller?: { kind: string; id: string } }
  | { via: "api"; user: { id: string; name: string; email: string }; apiKeyId: string }
  | { via: "auto_reopen"; reason: string; label: string };

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

/** What the updated row carries — the shape the app's route has always returned, and the payload
 *  every surface's `ticket.status_changed` webhook now gets (it used to vary by surface). */
const TRANSITION_INCLUDE = {
  project: { select: { id: true, code: true, name: true, color: true } },
  module: { select: { id: true, name: true } },
  reporter: { select: USER_SUMMARY },
  assignee: { select: USER_SUMMARY }
} as const;

/** Stored rich text as the plain text an email can quote. */
function plainText(html: string | null | undefined): string {
  return html ? htmlToPlainText(html).trim() : "";
}

function actorPerson(actor: TicketTransitionActor): { id: string; name: string; email: string } | null {
  if (actor.via === "auto_reopen") return null;
  return actor.via === "api" ? actor.user : actor.req.user;
}

type LoadedTicket = NonNullable<Awaited<ReturnType<typeof loadTicket>>>;

function loadTicket(ticketId: string) {
  return prisma.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    include: {
      watchers: { select: { userId: true } },
      collaborators: { select: { userId: true } },
      changeRequest: { select: { id: true } }
    }
  });
}

export async function transitionTicketStatus(ticketId: string, to: TicketStatus, actor: TicketTransitionActor) {
  const existing = await loadTicket(ticketId);
  if (!existing) throw new AppError(404, "Ticket not found");
  const from = existing.status as TicketStatus;

  await assertMayTransition(existing, from, to, actor);

  const ticket = await prisma.ticket.update({ where: { id: existing.id }, data: await transitionData(existing, to), include: TRANSITION_INCLUDE });

  const person = actorPerson(actor);
  await audit(
    person?.id,
    // ONE action for every surface. The burndown, the reopen rate and the sparklines replay exactly
    // this action; `via` says where the move came from without hiding it from them.
    "ticket.status_changed",
    "Ticket",
    ticket.id,
    { from, to, ...auditDetail(actor) },
    actor.via === "auto_reopen" ? { actorType: "INTEGRATION", actorLabel: actor.label, before: { status: from } } : undefined
  );
  emitTicketStatusChanged(ticket, from, to);

  await notifyParticipants({ existing, ticket, from, to, actor, person });

  if (to === "RESOLVED" || to === "CLOSED") await afterResolution({ ticket, to, person });

  return { ticket, from, to };
}

/** Every refusal, in the order a person would want to hear them. Throws; returns nothing. */
async function assertMayTransition(existing: LoadedTicket, from: TicketStatus, to: TicketStatus, actor: TicketTransitionActor): Promise<void> {
  const person = actor.via === "ui" || actor.via === "mcp" ? actor.req : null;
  if (person) {
    // Two different questions, both required: is the ticket in a project you can see at all, and
    // may you work on this one.
    await assertTicketVisible(person, existing.projectId);
    if (!(await canWorkOnTicket(person, existing))) throw new AppError(403, WORK_FORBIDDEN_MESSAGE);
  }

  assertNotChangeOwned(existing);

  const allowed = ticketStatusTransitions[from] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError(422, `Cannot move ${existing.key} from ${from} to ${to}. From ${from} it can move to ${allowed.join(", ") || "nothing"}.`);
  }
  if (person && from === "CLOSED" && to === "REOPENED" && !canReopenClosedTicket(person)) {
    throw new AppError(403, "Only an assigner or admin can reopen a closed ticket");
  }

  // THE FACE GATE, per surface — exactly the rule each surface had before this function existed:
  //  - ui: the workspace's `requireForTicket` policy covers status transitions, the
  //    workflow-authoritative ticket action ("who actually resolved this?"). Checked before every
  //    write and side effect, and bound to this ticket since it already exists.
  //  - mcp: none. There is no camera at the far end of an MCP client or an agent run; what bounds
  //    them is the credential's user, the workspace's write latch and this tool's destructive opt-in.
  //  - api: none. An API key is an org-wide integration with no person in front of it.
  //  - auto_reopen: none. Nobody acted.
  // Imported at call time, like the security service below: the face module drags in the image
  // pipeline, and the MCP and ingestion paths that also import this file never need it.
  if (actor.via === "ui") {
    const face = await import("./face.service.js");
    if (await face.isFaceVerificationRequired(actor.req.user.id, "TICKET")) {
      await face.consumeVerification({
        verificationId: actor.faceVerificationId,
        userId: actor.req.user.id,
        context: "TICKET",
        ticketId: existing.id
      });
    }
  }

  // The CI gate first, so the build failure (the more urgent of the two) is the message somebody
  // sees; then the quality gate. Both off by default.
  if (to === "RESOLVED") {
    await assertCiAllowsResolve(existing);
    await assertQualityGateAllowsResolve(existing);
  }
}

/** The columns the move writes. */
async function transitionData(existing: LoadedTicket, to: TicketStatus): Promise<Prisma.TicketUpdateInput> {
  const now = new Date();
  const data: Prisma.TicketUpdateInput = { status: to };
  if (to === "RESOLVED") data.resolvedAt = now;
  if (to === "CLOSED") data.closedAt = now;
  if (to === "IN_PROGRESS" || to === "REOPENED") {
    data.resolvedAt = null;
    data.closedAt = null;
  }
  // A reopen is a new resolution window: see `restartSlaClock` for why the breach marker goes too.
  if (to === "REOPENED") Object.assign(data, await restartSlaClock(existing.priority as TicketPriority, now));
  // A status change is a human (or their integration) having looked at the ticket, so it is no
  // longer waiting for intake review.
  if (existing.needsReview) data.needsReview = false;
  return data;
}

/** What the audit row adds beyond `{ from, to }`: the surface, and whatever identifies the caller. */
function auditDetail(actor: TicketTransitionActor): Record<string, unknown> {
  if (actor.via === "api") return { via: actor.via, apiKeyId: actor.apiKeyId };
  if (actor.via === "mcp") return actor.caller ? { via: actor.via, caller: actor.caller } : { via: actor.via };
  if (actor.via === "auto_reopen") return { via: actor.via, reason: actor.reason };
  return { via: actor.via };
}

/**
 * The reporter, the assignee, every watcher and every collaborator — minus whoever made the move.
 * Collaborators are working the ticket, not merely observing it, so they hear on the same terms as
 * the assignee rather than having to opt in as watchers.
 */
async function notifyParticipants(args: {
  existing: { reporterId: string; assigneeId: string | null; watchers: Array<{ userId: string }>; collaborators: Array<{ userId: string }> };
  ticket: { id: string; key: string; title: string; type: string | null };
  from: TicketStatus;
  to: TicketStatus;
  actor: TicketTransitionActor;
  person: { id: string; name: string } | null;
}): Promise<void> {
  const { existing, ticket, from, to, actor, person } = args;
  const recipients = new Set<string>([existing.reporterId]);
  if (existing.assigneeId) recipients.add(existing.assigneeId);
  for (const w of existing.watchers) recipients.add(w.userId);
  for (const c of existing.collaborators) recipients.add(c.userId);
  if (person) recipients.delete(person.id);
  if (recipients.size === 0) return;

  const changedBy = person?.name ?? "An automatic reopen";
  /**
   * The last thing anybody said on the ticket, carried into the status email as CONTEXT. A status
   * change takes no note of its own, so the template labels this as the latest comment rather than
   * implying it explains the move — it is here because "moved to RESOLVED" with no idea what was
   * discussed is the email people open the app to understand.
   */
  const latestComment = await prisma.ticketComment.findFirst({
    where: { ticketId: ticket.id },
    orderBy: { createdAt: "desc" },
    select: { body: true, author: { select: { name: true } } }
  });
  const latestCommentText = latestComment ? `${latestComment.author?.name ?? "Somebody"}: ${plainText(latestComment.body)}` : "";

  for (const userId of recipients) {
    await dispatchNotification({
      userId,
      category: "ticket.status_changed",
      title: actor.via === "auto_reopen" ? `${ticket.key} auto-reopened` : `${ticket.key} moved to ${to}`,
      body:
        actor.via === "auto_reopen"
          ? `${actor.reason} reopened "${ticket.title}" automatically.`
          : `${changedBy} moved "${ticket.title}" from ${from} to ${to}.`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.status_changed",
        vars: { ticketKey: ticket.key, title: ticket.title, from, to, changedBy, type: ticket.type ?? "", comment: latestCommentText },
        fallback: {
          subject: `${ticket.key} moved to ${to}`,
          html: templates.ticketStatusChanged({
            ticketKey: ticket.key,
            title: ticket.title,
            from,
            to,
            changedBy,
            type: ticket.type ?? null,
            comment: latestCommentText || null,
            ticketId: ticket.id
          })
        }
      }
    });
  }
}

/** The two security-report side effects of a ticket being called done. */
async function afterResolution(args: {
  ticket: { id: string; key: string; title: string };
  to: TicketStatus;
  person: { id: string; name: string; email: string } | null;
}): Promise<void> {
  const { ticket, to, person } = args;
  // Imported at call time: this file is imported by the MCP catalogue and by the security service
  // itself (for the auto-reopen), and the security service's own import graph — AI triage, the git
  // providers — has no business in either of those at load time.
  const security = await import("./security-report.service.js");

  // THE RESOLUTION GATE — see security-report.service.ts#markFindingsAwaitingVerification. Resolving
  // or closing turns the ticket's security findings into a CLAIM the next scan settles. AWAITED (a
  // few indexed writes; detaching it would let the feature silently not happen), and WRAPPED
  // (refusing somebody's close over a failed bookkeeping write would be its own defect).
  try {
    await security.markFindingsAwaitingVerification({ id: ticket.id, key: ticket.key }, person?.id);
  } catch (error) {
    console.error(`[ticket] could not mark findings awaiting verification for ${ticket.key}:`, (error as Error).message);
  }

  // The security/test-status digest — its own recipients (closer, their manager, admins) and its own
  // toggle. Detached: it renders a report and sends real SMTP mail, none of which the close depends
  // on, and awaiting it made closing a ticket hang for seconds.
  // The outside person who reported it (email intake, a public request form) hears that it is done —
  // only when the workspace switched it on (EmailIntakeSettings.notifyReporterOnResolve, off by
  // default: it is mail to a customer). Detached and caught: mail never decides whether a move lands.
  notifyExternalReporter(ticket, to).catch((error) =>
    console.error(`[ticket] reporter notification failed for ${ticket.key}:`, (error as Error).message)
  );

  if (to === "CLOSED" && person) {
    void security
      .sendTicketClosedDigest({ id: ticket.id, key: ticket.key, title: ticket.title }, { id: person.id, name: person.name, email: person.email })
      .catch((error) => console.error(`[ticket] closed digest failed for ${ticket.key}:`, (error as Error).message));
  }
}

async function notifyExternalReporter(ticket: { id: string; key: string; title: string }, to: TicketStatus): Promise<void> {
  const settings = await prisma.emailIntakeSettings.findUnique({ where: { id: "global" }, select: { notifyReporterOnResolve: true } });
  if (!settings?.notifyReporterOnResolve) return;
  const row = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { externalReporterEmail: true, externalReporterName: true } });
  if (!row?.externalReporterEmail) return;
  const outcome = to === "RESOLVED" ? "resolved" : "closed";
  await dispatchTransactional({
    to: row.externalReporterEmail,
    templateKey: "ticket.reporter_resolved",
    vars: { ticketKey: ticket.key, title: ticket.title, outcome, reporterName: row.externalReporterName ?? "" },
    fallback: {
      subject: `[${ticket.key}] Your request has been ${outcome}`,
      html: templates.ticketReporterResolved({ reporterName: row.externalReporterName ?? "", ticketKey: ticket.key, title: ticket.title, outcome })
    }
  });
}
