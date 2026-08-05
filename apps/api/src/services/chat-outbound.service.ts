/**
 * Outbound chat replies — the "Ticket TS-123 created" confirmation sent back into whichever
 * platform a message arrived from. One function per platform, same "single entry point,
 * branch per provider" shape as ai.service.ts#callChat, so chat-intake.service.ts never needs
 * to know which platform it's replying to.
 *
 * Every platform here needs the ORG'S OWN app/bot registration (Slack app, Azure Bot resource,
 * Google Chat app, Telegram bot) — this file only holds the generic REST calls each platform's
 * API documents; it can't be end-to-end verified without a real registration on that platform,
 * same caveat as this app's existing Google/Microsoft SSO integrations.
 */
import { decryptSecret } from "../utils/encryption.js";
import type { ChatIntegration } from "@prisma/client";
import type { ParsedInboundChatMessage } from "./chat-intake.service.js";

async function sendSlackMessage(integration: ChatIntegration, channelId: string, text: string): Promise<void> {
  if (!integration.encryptedBotToken) throw new Error("Slack bot token is not configured.");
  const botToken = decryptSecret(integration.encryptedBotToken);
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel: channelId, text })
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`Slack chat.postMessage failed: ${body.error ?? "unknown error"}`);
}

async function sendTelegramMessage(integration: ChatIntegration, chatId: string, text: string): Promise<void> {
  if (!integration.encryptedBotToken) throw new Error("Telegram bot token is not configured.");
  const botToken = decryptSecret(integration.encryptedBotToken);
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  if (!body.ok) throw new Error(`Telegram sendMessage failed: ${body.description ?? "unknown error"}`);
}

async function sendGoogleChatMessage(integration: ChatIntegration, text: string): Promise<void> {
  if (!integration.googleChatWebhookUrl) throw new Error("Google Chat incoming webhook URL is not configured.");
  const res = await fetch(integration.googleChatWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`Google Chat webhook post failed: HTTP ${res.status}`);
}

/** Bot Framework Connector requires an app-only AAD token (client-credentials grant against the
 *  Bot Framework's own token endpoint) before it will accept a reply into a conversation — this
 *  is fetched fresh per send rather than cached, since chat replies here are low-frequency
 *  (one per created ticket), unlike a high-traffic bot that would need to cache/refresh it. */
async function getTeamsAppToken(appId: string, appPassword: string): Promise<string> {
  const res = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: "https://api.botframework.com/.default"
    })
  });
  if (!res.ok) throw new Error(`Failed to obtain a Bot Framework token: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function sendTeamsMessage(integration: ChatIntegration, message: ParsedInboundChatMessage, text: string): Promise<void> {
  if (!integration.teamsAppId || !integration.encryptedTeamsAppPassword) throw new Error("Microsoft Teams app credentials are not configured.");
  if (!message.replyContext?.serviceUrl) throw new Error("Missing Bot Framework serviceUrl for this conversation.");
  const appPassword = decryptSecret(integration.encryptedTeamsAppPassword);
  const token = await getTeamsAppToken(integration.teamsAppId, appPassword);

  const url = `${message.replyContext.serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(message.channelId)}/activities`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: "message", text })
  });
  if (!res.ok) throw new Error(`Bot Framework activity post failed: HTTP ${res.status}`);
}

/** Best-effort — a failed reply should never fail ticket creation itself, so every caller in
 *  chat-intake.service.ts wraps this in try/catch and only logs on failure. */
export async function sendChatReply(integration: ChatIntegration, message: ParsedInboundChatMessage, text: string): Promise<void> {
  switch (message.platform) {
    case "SLACK":
      return sendSlackMessage(integration, message.channelId, text);
    case "TELEGRAM":
      return sendTelegramMessage(integration, message.channelId, text);
    case "GOOGLE_CHAT":
      return sendGoogleChatMessage(integration, text);
    case "MICROSOFT_TEAMS":
      return sendTeamsMessage(integration, message, text);
  }
}
