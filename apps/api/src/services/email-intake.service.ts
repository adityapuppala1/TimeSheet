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
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { allowedAttachmentExtensions } from "../middleware/upload.js";
import { audit } from "./audit.service.js";
import { classifyTicket, getGlobalAISettings } from "./ai.service.js";
import { dispatchNotification, dispatchTransactional, templates } from "./notify.service.js";
import { computeTicketDueDate, getGlobalTicketSettings, issueTicketKey } from "./ticket.service.js";
import { sanitizeRichText } from "../utils/sanitize.js";

const GLOBAL_ID = "global";

/** Seeded once (see prisma/seed.ts) with an unguessable random password — exists purely to
 *  satisfy Ticket.reporterId's required FK for email-sourced tickets. The real sender lives in
 *  externalReporterEmail/Name. */
export const EMAIL_INTAKE_SYSTEM_EMAIL = "email-intake@system.local";

const MAX_CLASSIFIER_IMAGES = 3;
const IMAGE_MIME_TO_ANTHROPIC = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** See classifyTicket's untrustedSource doc — caps how much a single self-reported
 *  confidence value from email-sourced content can suppress the needsReview gate below. */
const EMAIL_INTAKE_CONFIDENCE_CEILING = 0.85;

export interface ParsedInboundEmail {
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  text: string;
  html?: string | false;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
}

export async function getGlobalEmailIntakeSettings() {
  return prisma.emailIntakeSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {},
    create: { id: GLOBAL_ID }
  });
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
  const diskName = `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safeBase}${ext}`;
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.UPLOAD_DIR, diskName), att.content);
  await prisma.ticketAttachment.create({
    data: {
      ticketId,
      fileName: att.filename || diskName,
      mimeType: att.contentType || "application/octet-stream",
      url: `/uploads/${diskName}`,
      sizeBytes: att.content.length
    }
  });
}

export interface ProcessResult {
  created: boolean;
  reason?: "NO_PROJECT_CONFIGURED" | "PROJECT_NOT_FOUND";
  ticketId?: string;
  ticketKey?: string;
}

/**
 * The full email-to-ticket pipeline: route -> classify (text + image attachments) ->
 * create -> confidence gate -> auto-assign -> confirmation reply -> audit.
 * Transport-agnostic — the IMAP worker is the only caller today, but a future inbound
 * webhook could call this same function with a differently-sourced ParsedInboundEmail.
 */
export async function processInboundEmail(email: ParsedInboundEmail): Promise<ProcessResult> {
  const rule = await resolveRouting(email);
  const intakeSettings = await getGlobalEmailIntakeSettings();
  const projectId = rule?.projectId ?? intakeSettings.fallbackProjectId ?? null;

  if (!projectId) {
    console.warn(`[email-intake] no routing rule matched and no fallback project configured — dropping "${email.subject}" from ${email.from.address}`);
    return { created: false, reason: "NO_PROJECT_CONFIGURED" };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { modules: true } });
  if (!project) return { created: false, reason: "PROJECT_NOT_FOUND" };

  const types = await prisma.ticketType.findMany({ where: { isActive: true }, select: { name: true } });
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
  const moduleId = rule?.defaultModuleId ?? classification?.moduleId ?? null;
  // The raw self-reported confidence is stored as-is for admin visibility, but the
  // needsReview GATE uses a capped version — a single free-form number from a model call
  // whose input included unauthenticated external email content shouldn't, by itself, be
  // able to fully suppress human review just because a (possibly prompt-injected) response
  // claimed near-total certainty. A manually-entered ticket's own AI suggestions aren't
  // capped this way since there's an authenticated user in the loop already.
  const confidence = classification?.confidence ?? null;
  const gatingConfidence = confidence === null ? null : Math.min(confidence, EMAIL_INTAKE_CONFIDENCE_CEILING);
  const needsReview = gatingConfidence === null || gatingConfidence < aiSettings.confidenceThreshold;

  const slaSettings = await getGlobalTicketSettings();
  const createdAt = new Date();

  const description = email.html && typeof email.html === "string" ? sanitizeRichText(email.html) : plainTextToHtml(bodyText || "(no message body)");

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, project.id);
    return tx.ticket.create({
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
    const reviewers = await prisma.user.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        OR: [
          { role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } } },
          { role: { name: { in: ["MANAGER", "TEAM_LEAD"] } }, projectAssignments: { some: { projectId: project.id } } }
        ]
      },
      select: { id: true, name: true }
    });
    for (const reviewer of reviewers) {
      await dispatchNotification({
        userId: reviewer.id,
        category: "ticket.needs_review",
        title: `Needs review: ${ticket.key}`,
        body: `An email from ${email.from.address} was auto-classified with low confidence (${confidence === null ? "n/a" : `${Math.round(confidence * 100)}%`}).`,
        link: `/app/tickets?open=${ticket.id}`,
        email: {
          templateKey: "ticket.needs_review",
          vars: { targetName: reviewer.name, ticketKey: ticket.key, title: ticket.title, senderEmail: email.from.address, confidence: confidence ?? 0 },
          fallback: {
            subject: `Needs review: ${ticket.key}`,
            html: templates.ticketNeedsReview({ targetName: reviewer.name, ticketKey: ticket.key, title: ticket.title, senderEmail: email.from.address, confidence: confidence ?? 0 })
          }
        }
      });
    }
  }

  await dispatchTransactional({
    to: email.from.address,
    templateKey: "ticket.received_via_email",
    vars: { senderName: email.from.name ?? email.from.address.split("@")[0], ticketKey: ticket.key, title: ticket.title, priority: ticket.priority },
    fallback: {
      subject: `We received your report — ${ticket.key}`,
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
    reasoning: classification?.reasoning ?? "(AI classification unavailable — used defaults)"
  });

  return { created: true, ticketId: ticket.id, ticketKey: ticket.key };
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
