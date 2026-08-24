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
import { assertPublicEgressTarget } from "../utils/egress.js";
import type { ChatIntegration } from "@prisma/client";
import type { ParsedInboundChatMessage } from "./chat-intake.service.js";

/**
 * The only hosts a Bot Framework reply may be sent to.
 *
 * WHY THIS IS NOT PARANOIA: `sendTeamsMessage` below posts to a URL taken from the INBOUND
 * activity body (`activity.serviceUrl`) and puts an app-only AAD access token for the org's bot
 * in the `Authorization` header. If that host is attacker-chosen, the request hands them a live
 * bot credential — they can then post as the org's bot into any conversation it belongs to.
 *
 * Microsoft's own Bot Framework authentication guidance requires validating the `serviceurl`
 * claim in the inbound token against the activity's `serviceUrl` field, precisely because the
 * body is not covered by the token's signature. controllers/chat-webhook.controller.ts already
 * verifies the token's signature, issuer and `aud` (so a stranger cannot mint one), but a
 * REPLAYED token — a Bot Framework JWT is a bearer token valid for around an hour — carries no
 * binding to the body it arrived with. A host allow-list is a stronger and simpler check than
 * the claim comparison: it holds even if the claim is absent, and it cannot be satisfied by any
 * host Microsoft does not operate.
 *
 * EXACT hosts below, because the real one cannot be expressed as a safe suffix. Teams' commercial cloud
 * hands out `https://smba.trafficmanager.net/<region>/` — and `trafficmanager.net` is Azure
 * Traffic Manager, a SHARED service where anybody with an Azure subscription can claim a
 * `<their-name>.trafficmanager.net` label. So `.trafficmanager.net` as a suffix would allow any
 * Azure customer's endpoint; only the exact `smba.` host is Microsoft's.
 */
const BOT_FRAMEWORK_EXACT_HOSTS = new Set(["smba.trafficmanager.net"]);

/**
 * Suffixes for the zones Microsoft does control end-to-end: `directline.botframework.com`,
 * `webchat.botframework.com`, `europe.botframework.com`, and the sovereign-cloud Teams hosts
 * (`smba.infra.gov.teams.microsoft.us` and friends).
 *
 * The leading dot is load-bearing. Matching `endsWith("botframework.com")` without it would also
 * accept `botframework.com.attacker.net` — the classic suffix-check bypass, and the exact case
 * pinned in tests/unit/teams-reply-service-url.test.ts.
 */
const BOT_FRAMEWORK_HOST_SUFFIXES = [".botframework.com", ".teams.microsoft.com", ".teams.microsoft.us", ".botframework.azure.us"];

function assertBotFrameworkServiceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Bot Framework serviceUrl is not a valid URL.");
  }
  // https only: the token is a credential, and sending it over cleartext http is the same
  // disclosure by a different route.
  if (url.protocol !== "https:") {
    throw new Error(`Bot Framework serviceUrl must be https (got "${url.protocol}").`);
  }
  const host = url.hostname.toLowerCase();
  const allowed = BOT_FRAMEWORK_EXACT_HOSTS.has(host) || BOT_FRAMEWORK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throw new Error(`Refusing to send a bot access token to "${host}" — not a Bot Framework endpoint.`);
  }
  return url;
}

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
  // Admin-supplied URL, re-checked on every send rather than trusted from save time — see
  // utils/egress.ts. A stored value whose DNS record has since moved to a private address is
  // caught here, which validating only in the settings schema could never do.
  await assertPublicEgressTarget(integration.googleChatWebhookUrl, "The Google Chat webhook URL");
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
  // Validated BEFORE the token is minted, not after: there is no reason to ask Azure for a
  // credential we have already decided we will not be sending anywhere.
  const serviceUrl = assertBotFrameworkServiceUrl(message.replyContext.serviceUrl);

  const appPassword = decryptSecret(integration.encryptedTeamsAppPassword);
  const token = await getTeamsAppToken(integration.teamsAppId, appPassword);

  const url = `${serviceUrl.toString().replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(message.channelId)}/activities`;
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
