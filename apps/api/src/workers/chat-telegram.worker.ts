/**
 * Telegram polling worker — the chat-connector analog of workers/inbound-email.worker.ts.
 * WHY polling instead of a webhook, when the other three chat platforms (Slack/Teams/Google
 * Chat) all get webhook receivers (controllers/chat-webhook.controller.ts): Telegram's Bot API
 * uniquely supports both, and this app runs locally/on-prem without a public domain by default
 * — same "avoid requiring inbound network exposure where the platform doesn't mandate it"
 * reasoning as the IMAP worker, not a limitation of Telegram itself.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { getGlobalAISettings } from "../services/ai.service.js";
import { processInboundChatMessage, type ParsedInboundChatMessage } from "../services/chat-intake.service.js";
import { decryptSecret } from "../utils/encryption.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let polling = false;

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
}

export function startChatTelegramWorker() {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", async () => {
    if (polling) return;
    polling = true;
    try {
      await runForEveryOrg("chat-telegram", pollOnce);
    } catch (error) {
      console.error("[chat-telegram] poll failed:", (error as Error).message);
    } finally {
      polling = false;
    }
  });

  console.info("[chat-telegram] worker scheduled (checks every minute).");
}

function senderDisplayName(from: NonNullable<TelegramUpdate["message"]>["from"]): string {
  if (!from) return "Telegram user";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || from.username || `Telegram user ${from.id}`;
}

async function pollOnce() {
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.aiEnabled || !aiSettings.chatIngestionEnabled) return;

  const integration = await prisma.chatIntegration.findUnique({ where: { platform: "TELEGRAM" } });
  if (!integration?.isEnabled || !integration.encryptedBotToken) return;

  let botToken: string;
  try {
    botToken = decryptSecret(integration.encryptedBotToken);
  } catch {
    await prisma.chatIntegration.update({
      where: { id: integration.id },
      data: { lastError: "Stored Telegram bot token is unreadable — re-enter it in Workspace Settings." }
    });
    return;
  }

  const offset = integration.telegramUpdateOffset ?? undefined;
  let updates: TelegramUpdate[] = [];
  let pollError: string | null = null;

  try {
    const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
    if (offset !== undefined) url.searchParams.set("offset", String(offset));
    const res = await fetch(url);
    const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!body.ok) throw new Error(body.description ?? "Telegram getUpdates failed");
    updates = body.result ?? [];
  } catch (error) {
    pollError = (error as Error).message;
    console.error("[chat-telegram] getUpdates failed:", pollError);
  }

  let processedCount = 0;
  let highestUpdateId = integration.telegramUpdateOffset ? integration.telegramUpdateOffset - 1 : 0;

  for (const update of updates) {
    highestUpdateId = Math.max(highestUpdateId, update.update_id);
    const message = update.message;
    if (!message?.text) continue;
    try {
      const parsed: ParsedInboundChatMessage = {
        platform: "TELEGRAM",
        externalUserId: String(message.from?.id ?? "unknown"),
        externalUserName: senderDisplayName(message.from),
        channelId: String(message.chat.id),
        text: message.text
      };
      const result = await processInboundChatMessage(parsed);
      if (result.created) processedCount += 1;
    } catch (error) {
      console.error(`[chat-telegram] failed to process update_id=${update.update_id}:`, (error as Error).message);
    }
  }

  await prisma.chatIntegration.update({
    where: { id: integration.id },
    data: { telegramUpdateOffset: highestUpdateId + 1, lastError: pollError, lastEventAt: updates.length > 0 ? new Date() : integration.lastEventAt }
  });

  if (processedCount > 0) {
    console.info(`[chat-telegram] poll complete: ${processedCount} ticket(s) created.`);
  }
}
