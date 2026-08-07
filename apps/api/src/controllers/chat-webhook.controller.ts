/**
 * Inbound chat webhook receivers — Slack, Microsoft Teams, and Google Chat all only support
 * push delivery (no polling option), so unlike Telegram (workers/chat-telegram.worker.ts) they
 * need an HTTP endpoint. Mounted on `app` BEFORE the blanket `app.use("/api", resolveTenant)`
 * in app.ts, for the same reason controllers/sso.controller.ts's SAML ACS route is: an external
 * platform calling a fixed webhook URL has no Host-header subdomain to resolve a tenant from.
 *
 * Unlike SSO's signed-state round trip (there's no redirect here to carry anything through),
 * the org is identified directly from the URL path (`/:orgSlug`) — safe because the URL's
 * secrecy isn't what proves authenticity; each platform's own signature/token check is (Slack's
 * HMAC request signature, Teams' Bot Framework JWT, Google Chat's shared bearer token).
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import jwt from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";
import { getTenantClient, prisma } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { processInboundChatMessage, type ParsedInboundChatMessage } from "../services/chat-intake.service.js";
import { isReplayedDelivery } from "../services/webhook-replay.js";

export const chatWebhookRouter = Router();

/** Resolves the org from its slug and runs `fn` inside that org's tenant context — the
 *  webhook equivalent of controllers/sso.controller.ts's finishSsoLogin tenant-resolution
 *  tail, just without a session/cookie at the end of it. */
async function withOrgTenant<T>(orgSlug: string, fn: () => Promise<T>): Promise<T> {
  const org = await resolveActiveOrgBySlug(orgSlug);
  const dsn = decryptSecret(org.database!.encryptedDsn);
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, fn);
}

// ---------------------------------------------------------------------------------------------
// Slack — Events API. Needs the RAW request body to verify the HMAC signature, so this route
// (and only this one) gets its own express.raw() instead of the app-wide JSON body parser.
// ---------------------------------------------------------------------------------------------

const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function verifySlackSignature(signingSecret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

chatWebhookRouter.post("/slack/events/:orgSlug", express.raw({ type: "application/json" }), async (req, res, next) => {
  try {
    const rawBody = (req.body as Buffer).toString("utf8");
    const payload = JSON.parse(rawBody || "{}") as Record<string, unknown>;

    // Slack's one-time endpoint-verification handshake — no tenant/signature context needed
    // yet the very first time an admin points a new Events API subscription at this URL.
    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      res.json({ challenge: payload.challenge });
      return;
    }

    await withOrgTenant(req.params.orgSlug, async () => {
      const integration = await prisma.chatIntegration.findUnique({ where: { platform: "SLACK" } });
      if (!integration?.isEnabled || !integration.encryptedSigningSecret) throw new AppError(404, "Slack isn't configured for this workspace.");

      const timestamp = String(req.headers["x-slack-request-timestamp"] ?? "");
      const signature = String(req.headers["x-slack-signature"] ?? "");
      const signingSecret = decryptSecret(integration.encryptedSigningSecret);
      if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
        throw new AppError(401, "Invalid Slack request signature.");
      }

      // The ±5 minute timestamp window above narrows replay to that window; it does not close
      // it, and inside it a captured event can be resent to create the same ticket repeatedly.
      // Slack's `event_id` is unique per event and covered by the signature, so it cannot be
      // varied without the signing secret. This also collapses Slack's own delivery retries
      // (which reuse `event_id`) into one intake, which is the behaviour we want anyway: the
      // retry arrives because Slack missed our 200, not because the message happened twice.
      // After the signature check, so an unauthenticated caller cannot pollute the store.
      // Returning (rather than throwing) leaves the caller's plain 200 in place: Slack disables
      // endpoints that keep failing, and "already handled" is a success from its point of view.
      const eventId = typeof payload.event_id === "string" ? payload.event_id : null;
      if (eventId && isReplayedDelivery(`slack:${req.params.orgSlug}`, eventId)) return;

      const event = payload.event as Record<string, unknown> | undefined;
      const userId = typeof event?.user === "string" ? event.user : null;
      const channelId = typeof event?.channel === "string" ? event.channel : null;
      // Ignore anything that isn't a plain human message (bot echoes, edits, thread broadcasts,
      // channel-join notices, etc.) — a bare "message" subtype-less event is the normal case.
      if (event?.type === "message" && !event.subtype && !event.bot_id && typeof event.text === "string" && userId && channelId) {
        const message: ParsedInboundChatMessage = {
          platform: "SLACK",
          externalUserId: userId,
          externalUserName: userId,
          channelId,
          text: event.text
        };
        await processInboundChatMessage(message);
      }
    });

    res.status(200).send();
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------------------------
// Microsoft Teams — Bot Framework Connector. Regular JSON body; authenticity comes from a
// bearer JWT issued by Bot Framework's own token service, verified against its public JWKS.
// ---------------------------------------------------------------------------------------------

const botFrameworkJwks = new JwksClient({ jwksUri: "https://login.botframework.com/v1/.well-known/keys" });

function getBotFrameworkSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    botFrameworkJwks.getSigningKey(kid, (err, key) => {
      if (err || !key) return reject(err ?? new Error("Unknown signing key"));
      resolve(key.getPublicKey());
    });
  });
}

async function verifyTeamsBearerToken(authHeader: string, expectedAppId: string): Promise<boolean> {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid) return false;
  try {
    const publicKey = await getBotFrameworkSigningKey(kid);
    const verified = jwt.verify(token, publicKey, { algorithms: ["RS256"], issuer: "https://api.botframework.com" }) as { aud?: string };
    return verified.aud === expectedAppId;
  } catch {
    return false;
  }
}

chatWebhookRouter.post("/teams/messages/:orgSlug", express.json(), async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      const integration = await prisma.chatIntegration.findUnique({ where: { platform: "MICROSOFT_TEAMS" } });
      if (!integration?.isEnabled || !integration.teamsAppId) throw new AppError(404, "Microsoft Teams isn't configured for this workspace.");

      const authHeader = String(req.headers.authorization ?? "");
      if (!authHeader || !(await verifyTeamsBearerToken(authHeader, integration.teamsAppId))) {
        throw new AppError(401, "Invalid Bot Framework bearer token.");
      }

      const activity = req.body as Record<string, unknown>;
      if (activity.type === "message" && typeof activity.text === "string") {
        const from = activity.from as { id?: string; name?: string } | undefined;
        const conversation = activity.conversation as { id?: string } | undefined;
        const message: ParsedInboundChatMessage = {
          platform: "MICROSOFT_TEAMS",
          externalUserId: String(from?.id ?? "unknown"),
          externalUserName: String(from?.name ?? "Teams user"),
          channelId: String(conversation?.id ?? ""),
          text: activity.text,
          replyContext: { serviceUrl: typeof activity.serviceUrl === "string" ? activity.serviceUrl : undefined }
        };
        await processInboundChatMessage(message);
      }
    });

    res.status(200).send();
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------------------------
// Google Chat — a Chat app's HTTP endpoint. Simplest viable authenticity check: a shared bearer
// token the org sets when creating the Chat app (Configuration > Verification Token in the
// Google Cloud console), compared against ChatIntegration.encryptedSigningSecret.
// ---------------------------------------------------------------------------------------------

chatWebhookRouter.post("/google/events/:orgSlug", express.json(), async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      const integration = await prisma.chatIntegration.findUnique({ where: { platform: "GOOGLE_CHAT" } });
      if (!integration?.isEnabled || !integration.encryptedSigningSecret) throw new AppError(404, "Google Chat isn't configured for this workspace.");

      const authHeader = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const expectedToken = decryptSecret(integration.encryptedSigningSecret);
      const authBuf = Buffer.from(authHeader, "utf8");
      const expectedBuf = Buffer.from(expectedToken, "utf8");
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        throw new AppError(401, "Invalid Google Chat verification token.");
      }

      const body = req.body as Record<string, unknown>;
      if (body.type === "MESSAGE") {
        const message = body.message as Record<string, unknown> | undefined;
        const sender = message?.sender as { name?: string; displayName?: string } | undefined;
        const space = body.space as { name?: string } | undefined;
        const text = message?.text;
        if (typeof text === "string") {
          const parsed: ParsedInboundChatMessage = {
            platform: "GOOGLE_CHAT",
            externalUserId: String(sender?.name ?? "unknown"),
            externalUserName: String(sender?.displayName ?? "Google Chat user"),
            channelId: String(space?.name ?? ""),
            text
          };
          await processInboundChatMessage(parsed);
        }
      }
      // Google Chat expects the created/echoed message (or an empty object) as the sync response.
      res.json({});
    });
  } catch (error) {
    next(error);
  }
});
