/**
 * Chat-to-ticket ingestion pipeline — the same "message arrives, ticket appears" shape as
 * email-intake.service.ts, generalized across four chat platforms (Slack, Microsoft Teams,
 * Google Chat, Telegram) instead of one IMAP mailbox.
 *
 * WHAT: turns a normalized inbound chat message into a fully-classified, possibly-auto-assigned
 * Ticket, then replies back into the originating chat. `processInboundChatMessage()` is the
 * single entry point; three inbound transports feed it — the webhook receivers in
 * controllers/chat-webhook.controller.ts (Slack/Teams/Google Chat, all push-only APIs) and the
 * long-polling workers/chat-telegram.worker.ts (Telegram, which supports polling — chosen for
 * the same "avoid requiring a public endpoint" reasoning as the IMAP worker).
 *
 * HOW: 1) resolve which project the message belongs to via `ChatRoutingRule` (falls back to
 * that platform's `ChatIntegration.defaultProjectId`), 2) ask `ai.service.classifyChatMessage()`
 * for a title/type/priority/module, 3) create the ticket under a dedicated system "reporter"
 * user (mirrors EMAIL_INTAKE_SYSTEM_EMAIL — real tickets need a real User row for the FK, the
 * actual sender lives in separate free-text externalChat* fields), 4) gate on AI confidence —
 * same capped-confidence needsReview gate as email intake, 5) reply into the chat, 6) audit the
 * decision so it shows up in the ticket's own Activity tab automatically.
 */
import type { ChatIntegration, ChatPlatform } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { audit } from "./audit.service.js";
import { classifyChatMessage, getGlobalAISettings, EXTERNAL_INTAKE_CONFIDENCE_CEILING } from "./ai.service.js";
import { sendChatReply } from "./chat-outbound.service.js";
import { dispatchNotification, templates } from "./notify.service.js";
import { computeTicketDueDate, getGlobalTicketSettings, issueTicketKey } from "./ticket.service.js";

/** Seeded once (see prisma/seed.ts) with an unguessable random password — exists purely to
 *  satisfy Ticket.reporterId's required FK for chat-sourced tickets. The real sender lives in
 *  externalChatUserId/externalChatUserName. */
export const CHAT_INTAKE_SYSTEM_EMAIL = "chat-intake@system.local";

export interface ParsedInboundChatMessage {
  platform: ChatPlatform;
  externalUserId: string;
  externalUserName: string;
  /** Slack channel id / Telegram chat id / Google Chat space name / Teams conversation id. */
  channelId: string;
  text: string;
  /** Extra fields only Microsoft Teams' reply path needs (see chat-outbound.service.ts). */
  replyContext?: { serviceUrl?: string };
}

export interface ChatProcessResult {
  created: boolean;
  reason?: "CHAT_INTAKE_DISABLED" | "NOT_CONFIGURED" | "NO_PROJECT_CONFIGURED" | "PROJECT_NOT_FOUND";
  ticketId?: string;
  ticketKey?: string;
}

function matchesRule(message: ParsedInboundChatMessage, rule: { matchType: string; matchValue: string }): boolean {
  const value = rule.matchValue.trim();
  if (!value) return false;
  if (rule.matchType === "CHANNEL_ID") return message.channelId === value;
  if (rule.matchType === "COMMAND_PREFIX") return message.text.trim().toLowerCase().startsWith(value.toLowerCase());
  return false;
}

async function resolveRouting(message: ParsedInboundChatMessage) {
  const rules = await prisma.chatRoutingRule.findMany({
    where: { platform: message.platform, isActive: true },
    orderBy: { createdAt: "asc" },
    include: { project: { include: { modules: true } }, defaultModule: true }
  });
  return rules.find((rule) => matchesRule(message, rule)) ?? null;
}

/** Best-effort reply — a failed send should never surface as a pipeline error, just a log line,
 *  same "never let the confirmation step break the primary action" stance as email intake's
 *  dispatchTransactional (which likewise doesn't throw the caller into an error path). */
async function tryReply(integration: ChatIntegration, message: ParsedInboundChatMessage, text: string) {
  try {
    await sendChatReply(integration, message, text);
  } catch (error) {
    console.error(`[chat-intake] failed to reply on ${message.platform}/${message.channelId}:`, (error as Error).message);
  }
}

export async function processInboundChatMessage(message: ParsedInboundChatMessage): Promise<ChatProcessResult> {
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.aiEnabled || !aiSettings.chatIngestionEnabled) {
    return { created: false, reason: "CHAT_INTAKE_DISABLED" };
  }

  const integration = await prisma.chatIntegration.findUnique({ where: { platform: message.platform } });
  if (!integration?.isEnabled) {
    return { created: false, reason: "NOT_CONFIGURED" };
  }

  const rule = await resolveRouting(message);
  const projectId = rule?.projectId ?? integration.defaultProjectId ?? null;

  if (!projectId) {
    console.warn(`[chat-intake] no routing rule matched and no default project configured for ${message.platform} — dropping message from ${message.externalUserName}`);
    await tryReply(integration, message, "Sorry — this workspace hasn't set up a default project for chat-reported issues yet. Ask your admin to configure one.");
    return { created: false, reason: "NO_PROJECT_CONFIGURED" };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { modules: true } });
  if (!project) return { created: false, reason: "PROJECT_NOT_FOUND" };

  const types = await prisma.ticketType.findMany({ where: { isActive: true }, select: { name: true } });

  let classification: Awaited<ReturnType<typeof classifyChatMessage>> | null = null;
  try {
    classification = await classifyChatMessage({
      messageText: message.text,
      senderName: message.externalUserName,
      project,
      typeNames: types.map((t) => t.name)
    });
  } catch (error) {
    console.error(`[chat-intake] classification failed for message from ${message.externalUserName}:`, (error as Error).message);
  }

  const systemUser = await prisma.user.findUnique({ where: { email: CHAT_INTAKE_SYSTEM_EMAIL } });
  if (!systemUser) {
    throw new Error(`Chat Intake system user (${CHAT_INTAKE_SYSTEM_EMAIL}) is missing — run the seed script.`);
  }

  const title = (classification?.title ?? message.text.slice(0, 80) ?? "Chat-reported issue").slice(0, 255);
  const type = classification?.type ?? types[0]?.name ?? "BUG";
  const priority = classification?.priority ?? "MEDIUM";
  const moduleId = rule?.defaultModuleId ?? classification?.moduleId ?? null;
  // Same capped-confidence gate as email intake — see EXTERNAL_INTAKE_CONFIDENCE_CEILING's doc.
  const confidence = classification?.confidence ?? null;
  const gatingConfidence = confidence === null ? null : Math.min(confidence, EXTERNAL_INTAKE_CONFIDENCE_CEILING);
  const needsReview = gatingConfidence === null || gatingConfidence < aiSettings.confidenceThreshold;

  const slaSettings = await getGlobalTicketSettings();
  const createdAt = new Date();

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, project.id);
    return tx.ticket.create({
      data: {
        key,
        projectId: project.id,
        moduleId,
        type,
        title,
        description: message.text,
        priority,
        source: "CHAT",
        reporterId: systemUser.id,
        externalChatPlatform: message.platform,
        externalChatUserId: message.externalUserId,
        externalChatUserName: message.externalUserName,
        externalChatChannelId: message.channelId,
        aiConfidence: confidence,
        needsReview,
        dueAt: computeTicketDueDate(createdAt, priority, slaSettings)
      }
    });
  });

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
          body: `Auto-assigned from a ${message.platform} message: "${ticket.title}".`,
          link: `/app/tickets?open=${ticket.id}`,
          email: {
            templateKey: "ticket.assigned",
            vars: { assigneeName: assignee.name, ticketKey: ticket.key, title: ticket.title, priority: ticket.priority, assignedBy: "Chat Intake" },
            fallback: {
              subject: `Ticket ${ticket.key} assigned to you`,
              html: templates.ticketAssigned({ assigneeName: assignee.name, ticketKey: ticket.key, title: ticket.title, priority: ticket.priority, assignedBy: "Chat Intake" })
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
        body: `A ${message.platform} message from ${message.externalUserName} was auto-classified with low confidence (${confidence === null ? "n/a" : Math.round(confidence * 100) + "%"}).`,
        link: `/app/tickets?open=${ticket.id}`,
        email: {
          templateKey: "ticket.needs_review",
          vars: { targetName: reviewer.name, ticketKey: ticket.key, title: ticket.title, senderEmail: message.externalUserName, confidence: confidence ?? 0 },
          fallback: {
            subject: `Needs review: ${ticket.key}`,
            html: templates.ticketNeedsReview({ targetName: reviewer.name, ticketKey: ticket.key, title: ticket.title, senderEmail: message.externalUserName, confidence: confidence ?? 0 })
          }
        }
      });
    }
  }

  await tryReply(
    integration,
    message,
    needsReview
      ? `Thanks — I've logged this as ${ticket.key} and flagged it for a teammate to review.`
      : `Thanks — I've logged this as ${ticket.key} ("${ticket.title}").`
  );

  await prisma.chatIntegration.update({ where: { id: integration.id }, data: { lastEventAt: new Date(), lastError: null } });

  await audit(undefined, "chat_intake.ticket_created", "Ticket", ticket.id, {
    platform: message.platform,
    from: message.externalUserName,
    type,
    priority,
    moduleId,
    confidence,
    needsReview,
    reasoning: classification?.reasoning ?? "(AI classification unavailable — used defaults)"
  });

  return { created: true, ticketId: ticket.id, ticketKey: ticket.key };
}
