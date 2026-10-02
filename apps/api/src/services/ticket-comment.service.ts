/**
 * WHAT: `postTicketComment`, the ONE way a comment is posted on a ticket — by the app's own comment
 * route, by the MCP `add_ticket_comment` tool and Ask AI's `comment_on_ticket` (both through
 * ticket.service.ts#addTicketCommentForActor), and by the public API.
 *
 * WHY ONE FUNCTION: the app's route told the reporter, the assignee and the watchers, recorded an
 * audit row and honoured @mentions; the other surfaces posted the row and told nobody, while the
 * assistant tools' own descriptions promised "its participants are notified". A comment somebody
 * posts through a tool is still their comment, and the people on the ticket hear about it the same
 * way.
 *
 * WHAT IT DOES NOT DO: decide who may comment. Each caller has already answered that (the route and
 * the assistant helpers check project visibility; an API key is org-wide by design) before it gets
 * here.
 */
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { htmlToPlainText, sanitizeRichText } from "../utils/sanitize.js";
import { audit } from "./audit.service.js";
import { templates } from "./mail-templates.js";
import { extractMentionIds } from "./mentions.service.js";
import { dispatchNotification } from "./notify.service.js";
import { isProjectMember } from "./ticket.service.js";

/** Which surface posted the comment — recorded on the audit row as `via`. */
export type TicketCommentVia = "ui" | "api" | "mcp" | "ai_chat";

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

/** A comment's stored rich text as plain text an email can quote. */
function plainText(html: string | null | undefined): string {
  return html ? htmlToPlainText(html).trim() : "";
}

async function isPrivilegedUser(userId: string): Promise<boolean> {
  const privileged = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } } },
    select: { id: true }
  });
  return Boolean(privileged);
}

/** May this person be handed a comment or a mention on this project? Members, or admins. */
export async function canBeAddressed(userId: string, projectId: string): Promise<boolean> {
  if (await isProjectMember(userId, projectId)) return true;
  return isPrivilegedUser(userId);
}

/** The assignee of an action-item comment hears once, personally, and the audit trail records who
 *  handed it over. */
export async function notifyCommentAssigned(
  actor: { id: string; name: string },
  ticket: { id: string; key: string },
  commentId: string,
  assigneeId: string,
  body: string
): Promise<void> {
  if (assigneeId === actor.id) return;
  await audit(actor.id, "ticket.comment_assigned", "Ticket", ticket.id, { commentId, assigneeId });
  await dispatchNotification({
    userId: assigneeId,
    category: "ticket.comment_assigned",
    title: `${actor.name} assigned you a comment on ${ticket.key}`,
    body: plainText(body).slice(0, 160),
    link: `/app/tickets?open=${ticket.id}`
  });
}

/** The mentioned ids that may actually see the project — members, or admins — minus the author. */
async function mentionRecipients(html: string, authorId: string, projectId: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of extractMentionIds(html)) {
    if (id === authorId) continue;
    if (await canBeAddressed(id, projectId)) out.push(id);
  }
  return out;
}

export interface PostTicketCommentInput {
  ticketId: string;
  /** The person the comment is posted as. `name` is looked up when the caller does not carry it
   *  (Ask AI's context holds only id, role and permissions). */
  author: { id: string; name?: string | null };
  /** Raw rich text; sanitised here, because it may have come from a model or an integration. */
  body: string;
  /** Makes the comment an action item for this person (V12 8.3). The app's route only. */
  assigneeId?: string | null;
  via: TicketCommentVia;
  /** The public API key, when `via` is "api". */
  apiKeyId?: string;
}

export async function postTicketComment(input: PostTicketCommentInput) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      projectId: true,
      reporterId: true,
      assigneeId: true,
      watchers: { select: { userId: true } },
      collaborators: { select: { userId: true } }
    }
  });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const authorName =
    input.author.name ?? (await prisma.user.findUnique({ where: { id: input.author.id }, select: { name: true } }))?.name ?? "Somebody";
  const author = { id: input.author.id, name: authorName };

  const cleanBody = sanitizeRichText(input.body);
  const assigneeId = input.assigneeId || null;
  if (assigneeId && !(await canBeAddressed(assigneeId, ticket.projectId))) throw new AppError(422, "That person is not on this project.");

  const comment = await prisma.ticketComment.create({
    data: { ticketId: ticket.id, authorId: author.id, body: cleanBody, assigneeId },
    include: { author: { select: USER_SUMMARY }, assignee: { select: USER_SUMMARY }, resolvedBy: { select: USER_SUMMARY } }
  });
  await audit(author.id, "ticket.commented", "Ticket", ticket.id, {
    commentId: comment.id,
    via: input.via,
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {})
  });
  if (assigneeId) await notifyCommentAssigned(author, ticket, comment.id, assigneeId, cleanBody);

  // V12 8.1: @mentions. Only people who may see the project count — an id pasted into the HTML by
  // hand notifies nobody the role model would not show. Mentioned people get the stronger, personal
  // message and are left out of the generic fan-out below so nobody hears twice; they are NOT made
  // watchers (the reference: mentioned people follow only if they choose to).
  const mentioned = await mentionRecipients(cleanBody, author.id, ticket.projectId);
  if (mentioned.length) await audit(author.id, "ticket.mentioned", "Ticket", ticket.id, { userIds: mentioned });
  for (const userId of mentioned) {
    await dispatchNotification({
      userId,
      category: "ticket.mentioned",
      title: `${author.name} mentioned you on ${ticket.key}`,
      body: `In a comment on "${ticket.title}": ${plainText(cleanBody).slice(0, 160)}`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.commented",
        vars: { ticketKey: ticket.key, title: ticket.title, author: author.name, type: ticket.type ?? "", comment: plainText(cleanBody) },
        fallback: {
          subject: `${author.name} mentioned you on ${ticket.key}`,
          html: templates.ticketCommented({ ticketKey: ticket.key, title: ticket.title, author: author.name, type: ticket.type ?? null, comment: plainText(cleanBody) || null, ticketId: ticket.id })
        }
      }
    });
  }

  await notifyParticipants(ticket, author, cleanBody, new Set([...mentioned, ...(assigneeId ? [assigneeId] : []), author.id]));
  return comment;
}

/**
 * The reporter, the assignee, every watcher and every COLLABORATOR — the same people a status change
 * reaches. Collaborators are working the ticket, so leaving them out of its discussion (which this
 * fan-out used to) meant the people doing the work missed what was said about it.
 */
async function notifyParticipants(
  ticket: { id: string; key: string; title: string; type: string | null; reporterId: string; assigneeId: string | null; watchers: Array<{ userId: string }>; collaborators: Array<{ userId: string }> },
  author: { id: string; name: string },
  cleanBody: string,
  alreadyTold: Set<string>
): Promise<void> {
  const recipients = new Set<string>([ticket.reporterId]);
  if (ticket.assigneeId) recipients.add(ticket.assigneeId);
  for (const w of ticket.watchers) recipients.add(w.userId);
  for (const c of ticket.collaborators) recipients.add(c.userId);
  for (const id of alreadyTold) recipients.delete(id);

  for (const userId of recipients) {
    await dispatchNotification({
      userId,
      category: "ticket.commented",
      title: `New comment on ${ticket.key}`,
      body: `${author.name} commented on "${ticket.title}".`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.commented",
        // The comment itself travels with the mail. Without it this was a notification that a
        // notification existed, and every recipient had to open the app to learn whether it
        // concerned them.
        vars: { ticketKey: ticket.key, title: ticket.title, author: author.name, type: ticket.type ?? "", comment: plainText(cleanBody) },
        fallback: {
          subject: `New comment on ${ticket.key}`,
          html: templates.ticketCommented({
            ticketKey: ticket.key,
            title: ticket.title,
            author: author.name,
            type: ticket.type ?? null,
            comment: plainText(cleanBody) || null,
            ticketId: ticket.id
          })
        }
      }
    });
  }
}
