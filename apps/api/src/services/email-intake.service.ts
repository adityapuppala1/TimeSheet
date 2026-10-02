/**
 * Email-to-ticket ingestion pipeline — the flagship "email arrives, ticket appears" feature.
 *
 * WHAT: turns a parsed inbound email into a fully-classified, possibly-auto-assigned Ticket,
 * then confirms receipt back to the sender. `processInboundEmail()` is the single entry point;
 * everything else in this file supports it (routing, attachment persistence, IMAP connection
 * testing for the admin settings UI).
 *
 * WHY: this logic is deliberately transport-agnostic — it takes a plain `ParsedInboundEmail`
 * object, not an IMAP message. Today the only caller is `workers/inbound-email.worker.ts`
 * (polling IMAP), but a future inbound webhook (Mailgun/SendGrid) could call this exact same
 * function once the app has a public domain, without touching any classification logic.
 *
 * HOW: 1) resolve which project the email belongs to via `EmailRoutingRule` (falls back to
 * `EmailIntakeSettings.fallbackProjectId`), 2) ask `ai.service.classifyTicket()` for a
 * type/priority/module using the email text *and* any image attachments, 3) create the ticket
 * under a dedicated system "reporter" user (see EMAIL_INTAKE_SYSTEM_EMAIL below — real tickets
 * need a real User row for the FK, but the actual sender lives in a separate free-text field),
 * 4) gate on AI confidence — anything below the admin's threshold gets flagged `needsReview`
 * instead of silently auto-assigned, 5) email the sender back, 6) audit the whole decision so
 * it shows up in that ticket's own Activity tab automatically (entity="Ticket").
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { documentsDirForOrg } from "../config/storage-paths.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { allowedAttachmentExtensions } from "../middleware/upload.js";
import { assertUploadIsClean } from "./virus-scan.service.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { classifyTicket, getGlobalAISettings, EXTERNAL_INTAKE_CONFIDENCE_CEILING } from "./ai.service.js";
import { dispatchNotification, dispatchTransactional, templates } from "./notify.service.js";
import { computeTicketDueDate, getGlobalTicketSettings, issueTicketKey, PLAIN_TICKET_TYPE_WHERE } from "./ticket.service.js";
import { tenantBaseUrl } from "./workspace-directory.service.js";
import { sanitizeRichText } from "../utils/sanitize.js";
import { lazyCreateSettings } from "../utils/lazy-create-settings.js";

const GLOBAL_ID = "global";

/** Seeded once (see prisma/seed.ts) with an unguessable random password — exists purely to
 *  satisfy Ticket.reporterId's required FK for email-sourced tickets. The real sender lives in
 *  externalReporterEmail/Name. */
export const EMAIL_INTAKE_SYSTEM_EMAIL = "email-intake@system.local";

const MAX_CLASSIFIER_IMAGES = 3;
const IMAGE_MIME_TO_ANTHROPIC = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface ParsedInboundEmail {
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  text: string;
  html?: string | false;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
  /** The handful of headers the loop guard and reply threading read. Absent ones are undefined. */
  headers?: InboundMailHeaders;
}

export interface InboundMailHeaders {
  autoSubmitted?: string;
  precedence?: string;
  /** Parsed, but deliberately NOT a loop signal: a list relays real customers' mail too (see the loop guard). */
  listId?: string;
  /** Raw `Return-Path` value; `<>` is the null return path every bounce carries. */
  returnPath?: string;
  inReplyTo?: string;
  references?: string[];
}

export async function getGlobalEmailIntakeSettings() {
  // Lazily created on first read, so two concurrent reads on a workspace that has no row yet
  // both attempt the INSERT and the loser gets a P2002. See utils/lazy-create-settings.ts.
  return lazyCreateSettings(
    () => prisma.emailIntakeSettings.upsert({ where: { id: GLOBAL_ID }, update: {}, create: { id: GLOBAL_ID } }),
    () => prisma.emailIntakeSettings.findUnique({ where: { id: GLOBAL_ID } })
  );
}

function matchesRule(email: ParsedInboundEmail, rule: { matchType: string; matchValue: string }): boolean {
  const value = rule.matchValue.trim().toLowerCase();
  if (!value) return false;

  if (rule.matchType === "TO_ADDRESS") {
    return email.to.some((to) => to.toLowerCase() === value);
  }
  if (rule.matchType === "TO_PLUS_TAG") {
    return email.to.some((to) => {
      const local = to.split("@")[0] ?? "";
      const tag = local.split("+")[1];
      return tag?.toLowerCase() === value;
    });
  }
  if (rule.matchType === "SUBJECT_PREFIX") {
    return (email.subject || "").trim().toLowerCase().startsWith(value);
  }
  return false;
}

async function resolveRouting(email: ParsedInboundEmail) {
  const rules = await prisma.emailRoutingRule.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    include: { project: { include: { modules: true } }, defaultModule: true }
  });
  return rules.find((rule) => matchesRule(email, rule)) ?? null;
}

function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function guessExtension(filename: string, mimeType: string): string {
  const fromName = path.extname(filename || "");
  if (fromName) return fromName;
  const fromMime = mimeType.split("/")[1];
  return fromMime ? `.${fromMime.split("+")[0]}` : "";
}

async function saveAttachment(ticketId: string, att: ParsedInboundEmail["attachments"][number]) {
  const ext = guessExtension(att.filename, att.contentType).toLowerCase();
  if (!allowedAttachmentExtensions.has(ext)) {
    console.warn(`[email-intake] skipped attachment "${att.filename}" — unsupported extension ${ext || "(none)"}`);
    return;
  }
  const safeBase = path.basename(att.filename || "attachment", ext).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  // Same two rules as the interactive upload path (services/attachment-storage.service.ts): the
  // file lands under the receiving org, and the unique part of its name is `crypto.randomBytes`
  // rather than a clock and `Math.random()` — an inbound email's arrival time and its attachment's
  // filename are both things the SENDER already knows.
  // THE HIGHEST-RISK UPLOAD PATH IN THE PRODUCT, and the one nobody clicks: these bytes arrive
  // from an arbitrary sender on the internet, not from a signed-in colleague. Scanned before the
  // write like every other path — and a rejection SKIPS the attachment rather than failing the
  // whole intake, because a malicious attachment must not stop the legitimate ticket beside it
  // from being created.
  try {
    await assertUploadIsClean(att.content, att.filename || "attachment");
  } catch (error) {
    console.warn(`[email-intake] refused attachment "${att.filename}": ${(error as Error).message}`);
    return;
  }

  const { orgId } = requireTenantContext();
  const diskName = `${crypto.randomBytes(16).toString("hex")}-${safeBase}${ext}`;
  const orgDir = documentsDirForOrg(orgId);
  fs.mkdirSync(orgDir, { recursive: true });
  fs.writeFileSync(path.join(orgDir, diskName), att.content);
  await prisma.ticketAttachment.create({
    data: {
      ticketId,
      fileName: att.filename || diskName,
      mimeType: att.contentType || "application/octet-stream",
      url: `/uploads/${orgId}/${diskName}`,
      sizeBytes: att.content.length
    }
  });
}

export interface ProcessResult {
  created: boolean;
  reason?: "NO_PROJECT_CONFIGURED" | "PROJECT_NOT_FOUND" | "AUTOMATED_SENDER";
  ticketId?: string;
  ticketKey?: string;
  /** Set when the message was a reply, added to this existing ticket as a comment. */
  appendedTo?: string;
  /** Set when the message replied to this CLOSED ticket, so it opened a new, related ticket instead. */
  followUpTo?: string;
}

/* ------------------------------------------------------------------------------------------ *
 * The loop guard (RFC 3834)
 *
 * Every message used to become a ticket and earn a confirmation, whoever sent it. Point an
 * auto-responding mailbox at this one — another helpdesk's acknowledgement, an out-of-office, a
 * bounce — and each confirmation draws a reply that becomes a ticket that draws a confirmation.
 * Automated mail is recognised by the signals RFC 3834 names, and dropped before it can create
 * anything; our own confirmation is stamped so the far side can do the same.
 *
 * MAILING-LIST MARKERS ARE DELIBERATELY NOT SIGNALS. support@ as a Google Group (or any list) with
 * the polled mailbox as a member is a common setup, and the list stamps `List-Id` and
 * `Precedence: list` on every customer message it relays — dropping on either discarded all of that
 * real mail. They say how a message travelled, not that a machine wrote it; an autoresponder behind
 * a list still carries Auto-Submitted, and our confirmation's `Auto-Submitted: auto-replied` is what
 * breaks the reply loop.
 * ------------------------------------------------------------------------------------------ */

const BULK_PRECEDENCE = new Set(["bulk", "junk"]);
const DAEMON_SENDERS = new Set(["mailer-daemon", "postmaster"]);

/** The audit action every drop is recorded under; the intake status counts these. */
const AUTOMATED_DROP_ACTION = "email_intake.automated_dropped";

/** Why this message is automated and must not become a ticket, or null for a person. */
export function automatedSenderReason(email: ParsedInboundEmail): string | null {
  const h = email.headers ?? {};
  const autoSubmitted = h.autoSubmitted?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return `Auto-Submitted: ${autoSubmitted}`;
  const precedence = h.precedence?.trim().toLowerCase();
  if (precedence && BULK_PRECEDENCE.has(precedence)) return `Precedence: ${precedence}`;
  const localPart = (email.from.address.split("@")[0] ?? "").toLowerCase();
  if (DAEMON_SENDERS.has(localPart)) return `a ${localPart} sender`;
  // The null return path. Only a header that is PRESENT and empty counts — a message retrieved
  // without a Return-Path at all is not thereby a bounce.
  if (h.returnPath !== undefined && h.returnPath.replace(/[<>\s]/g, "") === "") return "a null return path";
  return null;
}

/**
 * How many messages the loop guard has dropped, and the latest one's reason — the intake settings'
 * "skipped N automated messages" line.
 *
 * WHY THE AUDIT LOG: a drop used to leave only a console line, so a guard that misfired (as the
 * mailing-list rule did) discarded real mail with nothing for an admin to see. EmailIntakeSettings
 * has no column for a count, and every drop is already worth an audit row of its own, so the rows
 * ARE the count rather than a second tally that could drift from them.
 */
export async function automatedDropSummary(): Promise<{ count: number; lastReason: string | null; lastFrom: string | null; lastAt: Date | null }> {
  const where = { action: AUTOMATED_DROP_ACTION, actorType: "INTEGRATION" as const };
  const [count, last] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findFirst({ where, orderBy: { createdAt: "desc" }, select: { createdAt: true, metadata: true } })
  ]);
  const meta = (last?.metadata ?? {}) as { reason?: unknown; from?: unknown };
  return {
    count,
    lastReason: typeof meta.reason === "string" ? meta.reason : null,
    lastFrom: typeof meta.from === "string" ? meta.from : null,
    lastAt: last?.createdAt ?? null
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Reply threading
 *
 * The confirmation is sent under a Message-ID that names the ticket, so a reply's In-Reply-To or
 * References points straight back at it with nothing to store. Mail clients and providers that
 * drop or rewrite those headers are covered by the second signal: the ticket key, in brackets, in
 * the confirmation's subject, which every client keeps on a reply.
 * ------------------------------------------------------------------------------------------ */

/** The Message-ID the confirmation for `ticketId` is sent under. */
export function ticketConfirmationMessageId(ticketId: string, host: string): string {
  return `<ticket-${ticketId}.confirmation@${host}>`;
}

const CONFIRMATION_ID = /<ticket-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.confirmation@[^>\s]+>/i;
const SUBJECT_KEY = /\[([A-Z][A-Z0-9]{0,19}-\d{1,9})\]/;

/** The workspace's own host, so the Message-ID's right-hand side is a domain the operator controls. */
function messageIdHost(): string {
  try {
    return new URL(tenantBaseUrl()).hostname || "timesphere.local";
  } catch {
    return "timesphere.local";
  }
}

/** Who is on a reply's ticket, so a reply nobody would hear about can go to the triagers instead. */
const REPLY_TARGET_INCLUDE = { watchers: { select: { userId: true } }, collaborators: { select: { userId: true } } } as const;

/**
 * The existing ticket this message replies to, or null.
 *
 * In-Reply-To / References first: matching our own confirmation's id proves the sender received it.
 * Then a bracketed key in the subject — but only from the address that opened the ticket, because a
 * key is guessable (WEB-1, WEB-2, …) and a stranger must not be able to write into somebody else's
 * ticket by putting "[WEB-12]" in a subject line. Only email-sourced tickets are threaded onto.
 */
async function findReplyTarget(email: ParsedInboundEmail) {
  const ids = [email.headers?.inReplyTo, ...(email.headers?.references ?? [])].filter((v): v is string => Boolean(v));
  for (const id of ids) {
    const ticketId = CONFIRMATION_ID.exec(id)?.[1];
    if (!ticketId) continue;
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId.toLowerCase(), deletedAt: null, source: "EMAIL" }, include: REPLY_TARGET_INCLUDE });
    if (ticket) return ticket;
  }

  const key = SUBJECT_KEY.exec(email.subject || "")?.[1];
  if (!key) return null;
  const ticket = await prisma.ticket.findFirst({ where: { key, deletedAt: null, source: "EMAIL" }, include: REPLY_TARGET_INCLUDE });
  if (!ticket?.externalReporterEmail) return null;
  return ticket.externalReporterEmail.toLowerCase() === email.from.address.toLowerCase() ? ticket : null;
}

type ReplyTarget = {
  id: string;
  key: string;
  title: string;
  type: string | null;
  status: string;
  projectId: string;
  reporterId: string;
  assigneeId: string | null;
  watchers: Array<{ userId: string }>;
  collaborators: Array<{ userId: string }>;
};

/**
 * The people who triage this project's intake: every active super admin and admin, and the
 * project's own managers and team leads. The needs-review notice goes to them, and so does a
 * customer's reply on a ticket nobody else is on.
 */
function intakeTriagers(projectId: string) {
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      OR: [
        { role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } } },
        { role: { name: { in: ["MANAGER", "TEAM_LEAD"] } }, projectAssignments: { some: { projectId } } }
      ]
    },
    select: { id: true, name: true }
  });
}

/**
 * A customer answering a RESOLVED ticket is saying it is not resolved. Reopened through the one
 * transition every surface uses — a fresh SLA clock, the audit row the reopen rate reads, the
 * participants told — as an automatic reopen, because nobody in the workspace acted. A refusal
 * (only a change's own ticket, which intake never files) leaves the status alone; the reply is still
 * recorded.
 */
async function reopenForReply(ticket: { id: string; key: string }, email: ParsedInboundEmail): Promise<boolean> {
  // Imported at call time: the transition service pulls in the security and face modules' graphs.
  const { transitionTicketStatus } = await import("./ticket-transition.service.js");
  try {
    await transitionTicketStatus(ticket.id, "REOPENED", {
      via: "auto_reopen",
      reason: `A customer reply by email from ${email.from.address}`,
      label: "email-intake"
    });
    return true;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    console.warn(`[email-intake] could not reopen ${ticket.key} for a reply: ${error.message}`);
    return false;
  }
}

/**
 * The comment path tells the reporter, the assignee, the watchers and the collaborators, minus the
 * author. On an email ticket the reporter AND the author are the intake account, so on an unassigned,
 * unwatched one a customer's reply reached nobody at all. The triagers hear instead.
 */
async function tellTriagersIfNobodyHears(ticket: ReplyTarget, intakeUserId: string, sender: string, comment: string, reopened: boolean) {
  const people = [ticket.reporterId, ticket.assigneeId, ...ticket.watchers.map((w) => w.userId), ...ticket.collaborators.map((c) => c.userId)];
  if (people.some((id) => id && id !== intakeUserId)) return;

  const reopenNote = reopened ? " It had been resolved, so it is reopened." : "";
  for (const triager of await intakeTriagers(ticket.projectId)) {
    await dispatchNotification({
      userId: triager.id,
      category: "ticket.commented",
      title: `Customer reply on ${ticket.key}`,
      body: `${sender} replied by email to "${ticket.title}", which nobody is assigned to or watching.${reopenNote}`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.commented",
        vars: { ticketKey: ticket.key, title: ticket.title, author: sender, type: ticket.type ?? "", comment },
        fallback: {
          subject: `New comment on ${ticket.key}`,
          html: templates.ticketCommented({ ticketKey: ticket.key, title: ticket.title, author: sender, type: ticket.type ?? null, comment: comment || null, ticketId: ticket.id })
        }
      }
    });
  }
}

/**
 * Adds a reply to its ticket as a comment by the intake account, naming the real sender — after
 * reopening the ticket when it was RESOLVED. (A CLOSED ticket never gets here: a reply to one opens a
 * follow-up ticket instead; see processInboundEmail.)
 */
async function appendReply(ticket: ReplyTarget, email: ParsedInboundEmail, systemUser: { id: string; name: string }): Promise<ProcessResult> {
  // Imported at call time, like ticket.service.ts's assistant helpers: the comment path pulls in the
  // notification templates, which the rest of this pipeline does not otherwise need at load time.
  const { postTicketComment } = await import("./ticket-comment.service.js");
  const bodyText = email.text || (typeof email.html === "string" ? email.html : "");
  const sender = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const message = email.html && typeof email.html === "string" ? email.html : plainTextToHtml(bodyText || "(no message body)");

  // Reopened FIRST, so the reply lands on a live ticket and its comment notification follows the
  // reopen rather than describing a ticket that still reads as done.
  const reopened = ticket.status === "RESOLVED" && (await reopenForReply(ticket, email));

  // Posted through the one comment path, so the ticket's reporter, assignee, watchers and
  // collaborators hear about the customer's reply exactly as they would a colleague's comment.
  await postTicketComment({
    ticketId: ticket.id,
    author: systemUser,
    body: `<p><strong>Reply by email from ${escapeHtml(sender)}</strong></p>${message}`,
    via: "email"
  });
  await tellTriagersIfNobodyHears(ticket, systemUser.id, sender, (email.text || "").trim(), reopened);
  for (const att of email.attachments) {
    await saveAttachment(ticket.id, att);
  }
  await audit(undefined, "email_intake.reply_appended", "Ticket", ticket.id, { from: email.from.address, subject: email.subject, reopened }, {
    actorType: "INTEGRATION",
    actorLabel: "email-intake"
  });
  return { created: false, appendedTo: ticket.key, ticketId: ticket.id, ticketKey: ticket.key };
}

/**
 * Which project a NEW ticket from this message lands in, and the routing rule (if any) that lends
 * it a default module.
 *
 * A follow-up stays in the project of the conversation it continues. The reply went to the
 * confirmation's Reply-To, not to the address the customer first wrote to, so routing it afresh
 * could file it somewhere unrelated. A matched rule still lends its default module to its own
 * project, and only to that one.
 */
async function routeNewTicket(email: ParsedInboundEmail, followUpOf: { projectId: string } | null) {
  const rule = await resolveRouting(email);
  const intakeSettings = await getGlobalEmailIntakeSettings();
  const projectId = followUpOf?.projectId ?? rule?.projectId ?? intakeSettings.fallbackProjectId ?? null;
  return { intakeSettings, projectId, projectRule: rule?.projectId === projectId ? rule : null };
}

/** The new ticket's description: the message itself, led — on a follow-up — by the ticket it follows. */
function newTicketDescription(email: ParsedInboundEmail, bodyText: string, followUpOf: { key: string } | null): string {
  const message = email.html && typeof email.html === "string" ? sanitizeRichText(email.html) : plainTextToHtml(bodyText || "(no message body)");
  if (!followUpOf) return message;
  return `<p><strong>Follow-up to ${escapeHtml(followUpOf.key)}</strong>, which was closed when this reply arrived.</p>${message}`;
}

/**
 * The full email-to-ticket pipeline: route -> classify (text + image attachments) ->
 * create -> confidence gate -> auto-assign -> confirmation reply -> audit.
 * Transport-agnostic — the IMAP worker is the only caller today, but a future inbound
 * webhook could call this same function with a differently-sourced ParsedInboundEmail.
 */
export async function processInboundEmail(email: ParsedInboundEmail): Promise<ProcessResult> {
  const automated = automatedSenderReason(email);
  if (automated) {
    console.info(`[email-intake] dropped "${email.subject}" from ${email.from.address} — ${automated}`);
    await audit(
      undefined,
      AUTOMATED_DROP_ACTION,
      "EmailIntakeSettings",
      GLOBAL_ID,
      { from: email.from.address, subject: email.subject.slice(0, 255), reason: automated },
      { actorType: "INTEGRATION", actorLabel: "email-intake" }
    );
    return { created: false, reason: "AUTOMATED_SENDER" };
  }

  // A reply to an existing ticket is added to it, not opened as a new one — and earns no
  // confirmation, which is also what keeps two mailboxes from answering each other through us.
  // EXCEPT a reply to a CLOSED ticket: closed is final, so the reply opens a NEW ticket that names
  // the old one (the follow-up pattern helpdesks use), confirmed like any first email.
  const replyTarget = await findReplyTarget(email);
  if (replyTarget && replyTarget.status !== "CLOSED") {
    const intakeUser = await prisma.user.findUnique({ where: { email: EMAIL_INTAKE_SYSTEM_EMAIL } });
    if (!intakeUser) throw new Error(`Email Intake system user (${EMAIL_INTAKE_SYSTEM_EMAIL}) is missing — run the seed script.`);
    return appendReply(replyTarget, email, intakeUser);
  }
  const followUpOf = replyTarget;

  const { intakeSettings, projectId, projectRule } = await routeNewTicket(email, followUpOf);

  if (!projectId) {
    console.warn(`[email-intake] no routing rule matched and no fallback project configured — dropping "${email.subject}" from ${email.from.address}`);
    return { created: false, reason: "NO_PROJECT_CONFIGURED" };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { modules: true } });
  if (!project) return { created: false, reason: "PROJECT_NOT_FOUND" };

  // CHANGE is never a candidate: an email cannot raise a change request, only a ticket.
  const types = await prisma.ticketType.findMany({ where: PLAIN_TICKET_TYPE_WHERE, select: { name: true } });
  const aiSettings = await getGlobalAISettings();

  const imageAttachments = email.attachments
    .filter((a) => IMAGE_MIME_TO_ANTHROPIC.has(a.contentType))
    .slice(0, MAX_CLASSIFIER_IMAGES);

  const subject = (email.subject || "(no subject)").slice(0, 255);
  const bodyText = email.text || (typeof email.html === "string" ? email.html : "");

  let classification: Awaited<ReturnType<typeof classifyTicket>> | null = null;
  try {
    classification = await classifyTicket({
      title: subject,
      description: bodyText,
      project,
      typeNames: types.map((t) => t.name),
      images: imageAttachments.map((a) => ({ mediaType: a.contentType, base64: a.content.toString("base64") })),
      untrustedSource: true
    });
  } catch (error) {
    console.error(`[email-intake] classification failed for "${subject}":`, (error as Error).message);
  }

  const systemUser = await prisma.user.findUnique({ where: { email: EMAIL_INTAKE_SYSTEM_EMAIL } });
  if (!systemUser) {
    throw new Error(`Email Intake system user (${EMAIL_INTAKE_SYSTEM_EMAIL}) is missing — run the seed script.`);
  }

  const type = classification?.type ?? types[0]?.name ?? "BUG";
  const priority = classification?.priority ?? "MEDIUM";
  const moduleId = projectRule?.defaultModuleId ?? classification?.moduleId ?? null;
  // The raw self-reported confidence is stored as-is for admin visibility, but the
  // needsReview GATE uses a capped version — a single free-form number from a model call
  // whose input included unauthenticated external email content shouldn't, by itself, be
  // able to fully suppress human review just because a (possibly prompt-injected) response
  // claimed near-total certainty. A manually-entered ticket's own AI suggestions aren't
  // capped this way since there's an authenticated user in the loop already.
  const confidence = classification?.confidence ?? null;
  const gatingConfidence = confidence === null ? null : Math.min(confidence, EXTERNAL_INTAKE_CONFIDENCE_CEILING);
  const needsReview = gatingConfidence === null || gatingConfidence < aiSettings.confidenceThreshold;

  const slaSettings = await getGlobalTicketSettings();
  const createdAt = new Date();

  const description = newTicketDescription(email, bodyText, followUpOf);

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, project.id);
    const created = await tx.ticket.create({
      data: {
        key,
        projectId: project.id,
        moduleId,
        type,
        title: subject,
        description,
        priority,
        source: "EMAIL",
        reporterId: systemUser.id,
        externalReporterEmail: email.from.address,
        externalReporterName: email.from.name ?? null,
        aiConfidence: confidence,
        needsReview,
        dueAt: computeTicketDueDate(createdAt, priority, slaSettings)
      }
    });
    // RELATES: the closed ticket is the history this one continues — not a duplicate of it, and
    // nothing either waits on.
    if (followUpOf) await tx.ticketLink.create({ data: { sourceTicketId: created.id, targetTicketId: followUpOf.id, type: "RELATES" } });
    return created;
  });

  for (const att of email.attachments) {
    await saveAttachment(ticket.id, att);
  }

  if (!needsReview && moduleId) {
    const assigneeRule = await prisma.moduleAssigneeRule.findUnique({ where: { moduleId } });
    if (assigneeRule) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: assigneeRule.defaultAssigneeId } });
      const assignee = await prisma.user.findUnique({ where: { id: assigneeRule.defaultAssigneeId }, select: { id: true, name: true } });
      if (assignee) {
        await dispatchNotification({
          userId: assignee.id,
          category: "ticket.assigned",
          title: `Ticket assigned: ${ticket.key}`,
          body: `Auto-assigned from an inbound email: "${ticket.title}".`,
          link: `/app/tickets?open=${ticket.id}`,
          email: {
            templateKey: "ticket.assigned",
            vars: { assigneeName: assignee.name, ticketKey: ticket.key, title: ticket.title, priority: ticket.priority, assignedBy: "Email Intake" },
            fallback: {
              subject: `Ticket ${ticket.key} assigned to you`,
              html: templates.ticketAssigned({ assigneeName: assignee.name, ticketKey: ticket.key, title: ticket.title, priority: ticket.priority, assignedBy: "Email Intake" })
            }
          }
        });
      }
    }
  }

  if (needsReview) {
    for (const reviewer of await intakeTriagers(project.id)) {
      await dispatchNotification({
        userId: reviewer.id,
        category: "ticket.needs_review",
        title: `Needs review: ${ticket.key}`,
        body: `An email from ${email.from.address} was auto-classified with low confidence (${confidence === null ? "n/a" : `${Math.round(confidence * 100)}%`}).`,
        link: `/app/tickets?open=${ticket.id}`,
        email: {
          templateKey: "ticket.needs_review",
          vars: { targetName: reviewer.name, ticketKey: ticket.key, title: ticket.title, senderEmail: email.from.address, confidence: confidence ?? 0, ticketId: ticket.id },
          fallback: {
            subject: `Needs review: ${ticket.key}`,
            html: templates.ticketNeedsReview({ targetName: reviewer.name, ticketKey: ticket.key, title: ticket.title, senderEmail: email.from.address, confidence: confidence ?? 0, ticketId: ticket.id })
          }
        }
      });
    }
  }

  // The confirmation is marked as an automatic reply (RFC 3834) so the far side's autoresponder
  // ignores it, carries a Reply-To of this intake mailbox so an answer comes back here, and goes out
  // under a Message-ID naming the ticket so that answer threads onto it (see findReplyTarget). The
  // subject leads with the key in brackets for clients that drop the threading headers.
  const replyTo = intakeSettings.imapUser?.includes("@") ? intakeSettings.imapUser : null;
  await dispatchTransactional({
    to: email.from.address,
    templateKey: "ticket.received_via_email",
    vars: { senderName: email.from.name ?? email.from.address.split("@")[0], ticketKey: ticket.key, title: ticket.title, priority: ticket.priority },
    headers: { "Auto-Submitted": "auto-replied", ...(replyTo ? { "Reply-To": replyTo } : {}) },
    messageId: ticketConfirmationMessageId(ticket.id, messageIdHost()),
    fallback: {
      subject: `[${ticket.key}] We received your report`,
      html: templates.ticketReceivedViaEmail({
        senderName: email.from.name ?? email.from.address.split("@")[0],
        ticketKey: ticket.key,
        title: ticket.title,
        priority: ticket.priority
      })
    }
  });

  await audit(undefined, "email_intake.ticket_created", "Ticket", ticket.id, {
    from: email.from.address,
    subject: email.subject,
    type,
    priority,
    moduleId,
    confidence,
    needsReview,
    reasoning: classification?.reasoning ?? "(AI classification unavailable — used defaults)",
    followUpTo: followUpOf?.key ?? null
  }, {
    actorType: "INTEGRATION",
    actorLabel: "email-intake"
  });

  return { created: true, ticketId: ticket.id, ticketKey: ticket.key, ...(followUpOf ? { followUpTo: followUpOf.key } : {}) };
}

export interface ImapTestConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

/** Attempts a real IMAP login (no message fetch) so the admin UI's "Test connection" button gets a fast, clear signal. */
export async function testImapConnection(config: ImapTestConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false
  });
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    client.close();
  }
}
