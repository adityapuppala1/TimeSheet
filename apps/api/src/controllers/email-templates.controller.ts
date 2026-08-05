/**
 * WHAT: SUPER_ADMIN-only editor for this org's transactional email templates (subject/body,
 * with `{{variable}}` placeholders) — view/edit/revert-to-default, send a single test, or
 * smoke-test every template at once.
 * WHY: `services/mail-templates.ts` ships a sensible default HTML for every template key; this
 * router is what lets an org customize that default (stored as an `EmailTemplate` row) without
 * a code change, and safely preview the result before it ever reaches a real recipient.
 * HOW: edited HTML is re-sanitized (`utils/sanitize.ts#sanitizeEmailHtml`) before saving — admin
 * authorship is a lower-risk input than external content, but it's still HTML headed for an
 * email client, not a sandboxed browser tab. Test sends use `skipBcc: true` so debug traffic
 * never fans out to every super admin via the workspace's BCC setting.
 * WHO calls this: `apps/web/src/pages/EmailTemplates.tsx`.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getTransportStatus, sendMail } from "../services/mail.service.js";
import { sanitizeEmailHtml } from "../utils/sanitize.js";
import {
  TEMPLATE_DESCRIPTIONS,
  TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  sampleVariables
} from "../services/template-store.service.js";

export const emailTemplatesRouter = Router();
emailTemplatesRouter.use(requireAuth, requireSuperAdmin);

emailTemplatesRouter.get("/transport-status", async (_req, res) => {
  res.json(await getTransportStatus());
});

emailTemplatesRouter.get("/", async (_req, res) => {
  const rows = await prisma.emailTemplate.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const items = TEMPLATE_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      description: TEMPLATE_DESCRIPTIONS[key] ?? "",
      variables: TEMPLATE_VARIABLES[key] ?? [],
      hasOverride: Boolean(row),
      enabled: row?.enabled ?? true,
      subject: row?.subject ?? null,
      bodyHtml: row?.bodyHtml ?? null,
      updatedAt: row?.updatedAt ?? null,
      updatedById: row?.updatedById ?? null
    };
  });
  res.json(items);
});

emailTemplatesRouter.get("/:key/log", async (req, res) => {
  const key = String(req.params.key);
  if (!TEMPLATE_KEYS.includes(key)) throw new AppError(404, "Unknown template");
  const logs = await prisma.emailLog.findMany({
    where: { template: { in: [key, `${key}.test`] } },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  res.json(logs);
});

const upsertSchema = z.object({
  params: z.object({ key: z.string() }),
  body: z.object({
    subject: z.string().min(3).max(255),
    bodyHtml: z.string().min(20),
    enabled: z.boolean().optional()
  })
});

emailTemplatesRouter.put("/:key", validate(upsertSchema), async (req, res) => {
  const key = String(req.params.key);
  if (!TEMPLATE_KEYS.includes(key)) throw new AppError(404, "Unknown template");

  const safeBody = sanitizeEmailHtml(req.body.bodyHtml);
  if (safeBody.length < 20) throw new AppError(422, "Body is empty after sanitization");

  const row = await prisma.emailTemplate.upsert({
    where: { key },
    update: {
      subject: req.body.subject.trim(),
      bodyHtml: safeBody,
      enabled: req.body.enabled ?? true,
      updatedById: req.user!.id
    },
    create: {
      key,
      subject: req.body.subject.trim(),
      bodyHtml: safeBody,
      enabled: req.body.enabled ?? true,
      variables: TEMPLATE_VARIABLES[key] ?? [],
      description: TEMPLATE_DESCRIPTIONS[key] ?? null,
      updatedById: req.user!.id
    }
  });
  await audit(req.user!.id, "email_template.updated", "EmailTemplate", row.id, { key });
  res.json(row);
});

emailTemplatesRouter.delete("/:key", async (req, res) => {
  const key = String(req.params.key);
  await prisma.emailTemplate.deleteMany({ where: { key } });
  await audit(req.user!.id, "email_template.reverted", "EmailTemplate", key);
  res.status(204).send();
});

/**
 * Render a saved template with sample vars and dispatch a single test send.
 *
 * `skipBcc: true` — tests are debug events, not transactional. They never
 * trigger the workspace-wide BCC-super-admin behaviour, so the only recipient
 * is the address the operator typed in.
 */
async function dispatchTestSend(key: string, recipient: string, actorId: string) {
  const row = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!row) return { ok: false, status: "FAILED" as const, errorMessage: "Template not saved — open the editor and save it first" };

  const samples = sampleVariables(key);
  const apply = (input: string) =>
    input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => samples[name] ?? `{{${name}}}`);

  return sendMail({
    to: recipient,
    subject: `[Test] ${apply(row.subject)}`,
    html: apply(row.bodyHtml),
    template: `${key}.test`,
    metadata: { triggeredBy: actorId, testSend: true },
    skipBcc: true
  });
}

const testSchema = z.object({
  params: z.object({ key: z.string() }),
  body: z.object({ to: z.string().email().optional() })
});

emailTemplatesRouter.post("/:key/test", validate(testSchema), async (req, res) => {
  const key = String(req.params.key);
  if (!TEMPLATE_KEYS.includes(key)) throw new AppError(404, "Unknown template");

  const recipient = req.body.to ?? req.user!.email;
  const result = await dispatchTestSend(key, recipient, req.user!.id);
  if (!result.ok) {
    throw new AppError(502, `Email NOT delivered: ${result.errorMessage ?? "SMTP transport refused the message"}`);
  }
  res.json({ sent: true, to: recipient, emailLogId: result.emailLogId, messageId: result.messageId });
});

const testAllSchema = z.object({
  body: z.object({ to: z.string().email().optional() })
});

/**
 * Bulk smoke test: send EVERY known template (with sample variables) to a single recipient.
 * Returns a per-template result so the operator can spot which templates succeeded / failed.
 *
 * Templates are sent sequentially with a 200ms gap to stay polite with SMTP rate limits.
 */
emailTemplatesRouter.post("/test-all", validate(testAllSchema), async (req, res) => {
  const recipient = (req.body.to as string | undefined) ?? req.user!.email;

  const results: Array<{ key: string; ok: boolean; status: string; errorMessage?: string; emailLogId?: string }> = [];
  for (const key of TEMPLATE_KEYS) {
    const result = await dispatchTestSend(key, recipient, req.user!.id);
    results.push({
      key,
      ok: result.ok,
      status: result.status,
      errorMessage: result.errorMessage,
      emailLogId: result.emailLogId
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  await audit(req.user!.id, "email_template.test_all", "EmailTemplate", recipient, { sent, failed });

  res.json({ recipient, sent, failed, total: results.length, results });
});
