/**
 * Admin-only settings surface for the email-intake pipeline: mailbox connection (host/port/
 * user/password, never returned once saved — only `imapPasswordSet: boolean`), a live
 * "test connection" check, and CRUD for the routing rules / module-assignee rules that decide
 * where an inbound email lands and who it's assigned to. Gated `requireSuperAdmin` throughout
 * since IMAP credentials are sensitive.
 */
import { Router } from "express";
import { z } from "zod";
import { emailMatchTypes } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getGlobalEmailIntakeSettings, testImapConnection } from "../services/email-intake.service.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";

export const emailIntakeRouter = Router();
emailIntakeRouter.use(requireAuth, requireSuperAdmin);

function serializeSettings(settings: Awaited<ReturnType<typeof getGlobalEmailIntakeSettings>>) {
  const { imapPassword, ...rest } = settings;
  return { ...rest, imapPasswordSet: Boolean(imapPassword) };
}

emailIntakeRouter.get("/settings", async (_req, res) => {
  res.json(serializeSettings(await getGlobalEmailIntakeSettings()));
});

const settingsSchema = z.object({
  body: z
    .object({
      imapHost: z.string().max(255).optional().nullable(),
      imapPort: z.coerce.number().int().min(1).max(65535).optional(),
      imapSecure: z.boolean().optional(),
      imapUser: z.string().max(255).optional().nullable(),
      imapPassword: z.string().max(500).optional(),
      pollIntervalMinutes: z.coerce.number().int().min(1).max(1440).optional(),
      fallbackProjectId: z.string().uuid().optional().nullable()
    })
    .strict()
});

emailIntakeRouter.patch("/settings", validate(settingsSchema), async (req, res) => {
  const data: Record<string, unknown> = { updatedById: req.user!.id };
  if ("imapHost" in req.body) data.imapHost = req.body.imapHost || null;
  if (typeof req.body.imapPort === "number") data.imapPort = req.body.imapPort;
  if (typeof req.body.imapSecure === "boolean") data.imapSecure = req.body.imapSecure;
  if ("imapUser" in req.body) data.imapUser = req.body.imapUser || null;
  // Empty string means "leave the saved password alone" — the client never receives it back to resend.
  if (typeof req.body.imapPassword === "string" && req.body.imapPassword.length > 0) data.imapPassword = encryptSecret(req.body.imapPassword);
  if (typeof req.body.pollIntervalMinutes === "number") data.pollIntervalMinutes = req.body.pollIntervalMinutes;
  if ("fallbackProjectId" in req.body) data.fallbackProjectId = req.body.fallbackProjectId || null;

  const updated = await prisma.emailIntakeSettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  await audit(req.user!.id, "settings.email_intake_updated", "EmailIntakeSettings", "global", { ...req.body, imapPassword: undefined });
  res.json(serializeSettings(updated));
});

const testConnectionSchema = z.object({
  body: z.object({
    host: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional()
  })
});

emailIntakeRouter.post("/settings/test-connection", validate(testConnectionSchema), async (req, res) => {
  const saved = await getGlobalEmailIntakeSettings();
  const host = req.body.host || saved.imapHost;
  const port = req.body.port ?? saved.imapPort;
  const secure = req.body.secure ?? saved.imapSecure;
  const user = req.body.user || saved.imapUser;
  let password = req.body.password;
  if (!password && saved.imapPassword) {
    try {
      password = decryptSecret(saved.imapPassword);
    } catch {
      throw new AppError(422, "The saved password can't be read — re-enter it below and try again.");
    }
  }

  if (!host || !user || !password) {
    throw new AppError(422, "Host, user, and password are required to test the connection.");
  }

  const result = await testImapConnection({ host, port, secure, user, password });
  res.json(result);
});

/* ---------- Routing rules ---------- */

const ROUTING_INCLUDE = {
  project: { select: { id: true, name: true, code: true } },
  defaultModule: { select: { id: true, name: true } }
} as const;

emailIntakeRouter.get("/routing-rules", async (_req, res) => {
  const rows = await prisma.emailRoutingRule.findMany({ orderBy: { createdAt: "asc" }, include: ROUTING_INCLUDE });
  res.json(rows);
});

const createRoutingSchema = z.object({
  body: z.object({
    matchType: z.enum(emailMatchTypes),
    matchValue: z.string().min(1).max(255),
    projectId: z.string().uuid(),
    defaultModuleId: z.string().uuid().optional()
  })
});

emailIntakeRouter.post("/routing-rules", validate(createRoutingSchema), async (req, res) => {
  const created = await prisma.emailRoutingRule.create({
    data: {
      matchType: req.body.matchType,
      matchValue: req.body.matchValue.trim(),
      projectId: req.body.projectId,
      defaultModuleId: req.body.defaultModuleId || null
    },
    include: ROUTING_INCLUDE
  });
  await audit(req.user!.id, "email_routing_rule.created", "EmailRoutingRule", created.id, req.body);
  res.status(201).json(created);
});

const patchRoutingSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      matchType: z.enum(emailMatchTypes).optional(),
      matchValue: z.string().min(1).max(255).optional(),
      projectId: z.string().uuid().optional(),
      defaultModuleId: z.string().uuid().optional().nullable(),
      isActive: z.boolean().optional()
    })
    .strict()
});

emailIntakeRouter.patch("/routing-rules/:id", validate(patchRoutingSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.matchType === "string") data.matchType = req.body.matchType;
  if (typeof req.body.matchValue === "string") data.matchValue = req.body.matchValue.trim();
  if (typeof req.body.projectId === "string") data.projectId = req.body.projectId;
  if ("defaultModuleId" in req.body) data.defaultModuleId = req.body.defaultModuleId || null;
  if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;

  const updated = await prisma.emailRoutingRule.update({ where: { id: String(req.params.id) }, data, include: ROUTING_INCLUDE });
  await audit(req.user!.id, "email_routing_rule.updated", "EmailRoutingRule", updated.id, data);
  res.json(updated);
});

emailIntakeRouter.delete("/routing-rules/:id", async (req, res) => {
  await prisma.emailRoutingRule.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "email_routing_rule.deleted", "EmailRoutingRule", String(req.params.id));
  res.status(204).send();
});

/* ---------- Module assignee rules ---------- */

const ASSIGNEE_INCLUDE = {
  module: { select: { id: true, name: true, projectId: true } },
  defaultAssignee: { select: { id: true, name: true, email: true } }
} as const;

emailIntakeRouter.get("/assignee-rules", async (_req, res) => {
  const rows = await prisma.moduleAssigneeRule.findMany({ orderBy: { createdAt: "asc" }, include: ASSIGNEE_INCLUDE });
  res.json(rows);
});

const upsertAssigneeSchema = z.object({
  body: z.object({ moduleId: z.string().uuid(), defaultAssigneeId: z.string().uuid() })
});

emailIntakeRouter.post("/assignee-rules", validate(upsertAssigneeSchema), async (req, res) => {
  const saved = await prisma.moduleAssigneeRule.upsert({
    where: { moduleId: req.body.moduleId },
    update: { defaultAssigneeId: req.body.defaultAssigneeId },
    create: { moduleId: req.body.moduleId, defaultAssigneeId: req.body.defaultAssigneeId },
    include: ASSIGNEE_INCLUDE
  });
  await audit(req.user!.id, "module_assignee_rule.saved", "ModuleAssigneeRule", saved.id, req.body);
  res.status(201).json(saved);
});

emailIntakeRouter.delete("/assignee-rules/:id", async (req, res) => {
  await prisma.moduleAssigneeRule.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "module_assignee_rule.deleted", "ModuleAssigneeRule", String(req.params.id));
  res.status(204).send();
});
