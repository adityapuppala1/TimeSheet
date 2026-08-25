/**
 * Admin-only settings surface for the chat-connector pipeline — same shape as
 * email-intake.controller.ts: per-platform connection settings (secrets never returned, only a
 * `*Set: boolean`), and CRUD for the routing rules that decide which project a channel/command
 * lands in. Gated `requireSuperAdmin` throughout since bot tokens are sensitive, and additionally
 * plan-tier gated (Track E mirrors Track D's SSO gating) — an org can only ENABLE a platform its
 * plan tier allows, exactly like settings.controller.ts's SSO PATCH route.
 */
import { Router } from "express";
import { z } from "zod";
import { chatMatchTypes, chatPlatforms } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getAllowedChatPlatforms } from "../services/plan-limits.service.js";
import { encryptSecret } from "../utils/encryption.js";
import { egressUrl } from "../utils/egress.js";

export const chatIntegrationsRouter = Router();
chatIntegrationsRouter.use(requireAuth, requireSuperAdmin);

const PLATFORM_LABEL: Record<(typeof chatPlatforms)[number], string> = {
  SLACK: "Slack",
  MICROSOFT_TEAMS: "Microsoft Teams",
  GOOGLE_CHAT: "Google Chat",
  TELEGRAM: "Telegram"
};

function serialize(row: Awaited<ReturnType<typeof prisma.chatIntegration.findMany>>[number]) {
  return {
    platform: row.platform,
    isEnabled: row.isEnabled,
    botTokenSet: Boolean(row.encryptedBotToken),
    signingSecretSet: Boolean(row.encryptedSigningSecret),
    teamsAppId: row.teamsAppId,
    teamsAppPasswordSet: Boolean(row.encryptedTeamsAppPassword),
    googleChatWebhookUrl: row.googleChatWebhookUrl,
    defaultProjectId: row.defaultProjectId,
    lastEventAt: row.lastEventAt,
    lastError: row.lastError
  };
}

chatIntegrationsRouter.get("/settings", async (_req, res) => {
  const { orgId } = requireTenantContext();
  const [rows, allowed] = await Promise.all([
    prisma.chatIntegration.findMany(),
    getAllowedChatPlatforms(orgId)
  ]);
  const byPlatform = new Map(rows.map((r) => [r.platform, r]));
  res.json({
    allowedPlatforms: allowed,
    integrations: chatPlatforms.map((platform) => {
      const row = byPlatform.get(platform);
      return row
        ? serialize(row)
        : { platform, isEnabled: false, botTokenSet: false, signingSecretSet: false, teamsAppId: null, teamsAppPasswordSet: false, googleChatWebhookUrl: null, defaultProjectId: null, lastEventAt: null, lastError: null };
    })
  });
});

const settingsSchema = z.object({
  params: z.object({ platform: z.enum(chatPlatforms) }),
  body: z
    .object({
      isEnabled: z.boolean().optional(),
      botToken: z.string().max(2000).optional(),
      signingSecret: z.string().max(2000).optional(),
      teamsAppId: z.string().max(255).optional().nullable(),
      teamsAppPassword: z.string().max(2000).optional(),
      // `egressUrl`, not `.url()` — see utils/egress.ts. This value is fetched by the server
      // with the org's reply text, so an internal address here is an SSRF primitive.
      googleChatWebhookUrl: egressUrl(500).or(z.literal("")).optional().nullable(),
      defaultProjectId: z.string().uuid().optional().nullable()
    })
    .strict()
});

chatIntegrationsRouter.patch("/settings/:platform", validate(settingsSchema), async (req, res) => {
  const { orgId } = requireTenantContext();
  const platform = req.params.platform as (typeof chatPlatforms)[number];

  // Plan-tier enforcement — same convention as settings.controller.ts's SSO PATCH: editing/
  // saving credentials for a not-yet-allowed platform is fine, only flipping isEnabled: true
  // is gated, so an org mid-upgrade can stage config ahead of time.
  if (req.body.isEnabled === true) {
    const allowed = await getAllowedChatPlatforms(orgId);
    if (!allowed.includes(platform)) {
      throw new AppError(403, `${PLATFORM_LABEL[platform]} isn't available on this workspace's current plan.`);
    }
  }

  const { botToken, signingSecret, teamsAppPassword, ...rest } = req.body as Record<string, unknown> & {
    botToken?: string;
    signingSecret?: string;
    teamsAppPassword?: string;
  };
  const data: Record<string, unknown> = { ...rest, updatedById: req.user!.id };
  if (typeof botToken === "string") data.encryptedBotToken = botToken.length > 0 ? encryptSecret(botToken) : null;
  if (typeof signingSecret === "string") data.encryptedSigningSecret = signingSecret.length > 0 ? encryptSecret(signingSecret) : null;
  if (typeof teamsAppPassword === "string") data.encryptedTeamsAppPassword = teamsAppPassword.length > 0 ? encryptSecret(teamsAppPassword) : null;

  const updated = await prisma.chatIntegration.upsert({
    where: { platform },
    update: data,
    create: { platform, ...data }
  });
  await audit(req.user!.id, "settings.chat_integration_updated", "ChatIntegration", updated.id, {
    platform,
    ...req.body,
    botToken: undefined,
    signingSecret: undefined,
    teamsAppPassword: undefined
  });
  res.json(serialize(updated));
});

/* ---------- Routing rules ---------- */

const ROUTING_INCLUDE = {
  project: { select: { id: true, name: true, code: true } },
  defaultModule: { select: { id: true, name: true } }
} as const;

chatIntegrationsRouter.get("/routing-rules", async (_req, res) => {
  const rows = await prisma.chatRoutingRule.findMany({ orderBy: { createdAt: "asc" }, include: ROUTING_INCLUDE });
  res.json(rows);
});

const createRoutingSchema = z.object({
  body: z.object({
    platform: z.enum(chatPlatforms),
    matchType: z.enum(chatMatchTypes),
    matchValue: z.string().min(1).max(255),
    projectId: z.string().uuid(),
    defaultModuleId: z.string().uuid().optional()
  })
});

chatIntegrationsRouter.post("/routing-rules", validate(createRoutingSchema), async (req, res) => {
  const created = await prisma.chatRoutingRule.create({
    data: {
      platform: req.body.platform,
      matchType: req.body.matchType,
      matchValue: req.body.matchValue.trim(),
      projectId: req.body.projectId,
      defaultModuleId: req.body.defaultModuleId || null
    },
    include: ROUTING_INCLUDE
  });
  await audit(req.user!.id, "chat_routing_rule.created", "ChatRoutingRule", created.id, req.body);
  res.status(201).json(created);
});

const patchRoutingSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      matchType: z.enum(chatMatchTypes).optional(),
      matchValue: z.string().min(1).max(255).optional(),
      projectId: z.string().uuid().optional(),
      defaultModuleId: z.string().uuid().optional().nullable(),
      isActive: z.boolean().optional()
    })
    .strict()
});

chatIntegrationsRouter.patch("/routing-rules/:id", validate(patchRoutingSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.matchType === "string") data.matchType = req.body.matchType;
  if (typeof req.body.matchValue === "string") data.matchValue = req.body.matchValue.trim();
  if (typeof req.body.projectId === "string") data.projectId = req.body.projectId;
  if ("defaultModuleId" in req.body) data.defaultModuleId = req.body.defaultModuleId || null;
  if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;

  const updated = await prisma.chatRoutingRule.update({ where: { id: String(req.params.id) }, data, include: ROUTING_INCLUDE });
  await audit(req.user!.id, "chat_routing_rule.updated", "ChatRoutingRule", updated.id, data);
  res.json(updated);
});

chatIntegrationsRouter.delete("/routing-rules/:id", async (req, res) => {
  await prisma.chatRoutingRule.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "chat_routing_rule.deleted", "ChatRoutingRule", String(req.params.id));
  res.status(204).send();
});
