/**
 * The second half of the platform-admin console's API (3.12.0): the overview, platform mail
 * settings, the platform email templates with preview/test/log/resend/analytics, the trial
 * retention programme, customer feedback, the control-plane audit trail, and platform-admin
 * account management. Mounted at the same `/api/platform-admin` prefix as
 * `platform-admin.controller.ts`, before tenant resolution, with the same auth.
 *
 * Kept as its own router so the original file stays the org-lifecycle file it was; everything here
 * is about running the platform rather than one tenant.
 */
import { Router } from "express";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { requirePlatformAdmin } from "../middleware/platform-admin-auth.js";
import { validate } from "../middleware/validate.js";
import { encryptSecret } from "../utils/encryption.js";
import { generateTempPassword, hashPassword } from "../utils/security.js";
import { sanitizeEmailHtml } from "../utils/sanitize.js";
import { platformAudit } from "../services/platform-audit.service.js";
import { PLATFORM_TEMPLATES, PLATFORM_TEMPLATE_KEYS, platformTemplateDef, RETENTION_MARKER_TEMPLATE } from "../services/platform-mail-templates.js";
import {
  applyPlatformVars,
  getPlatformTransportStatus,
  renderPlatformTemplate,
  resendPlatformEmail,
  resolvePlatformMailConfig,
  sendPlatformTemplate
} from "../services/platform-mail.service.js";
import {
  deleteWorkspaceUnderPolicy,
  getRetentionQueue,
  getRetentionSettings,
  runRetentionTick,
  sendRetentionMarker,
  setRetentionHold,
  updateRetentionSettings
} from "../services/retention.service.js";
import { getPlatformAnalytics } from "../services/platform-admin-analytics.service.js";

export const platformAdminConsoleRouter = Router();
platformAdminConsoleRouter.use(requirePlatformAdmin);

const actorLabel = (req: { platformAdmin?: { email: string } }) => req.platformAdmin?.email ?? "platform-admin";
const DAY_MS = 24 * 60 * 60 * 1000;

/* ================================== Overview ==================================== */

platformAdminConsoleRouter.get("/overview", async (_req, res) => {
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const [orgs, emails30, feedback, audit, queue, settings, transport] = await Promise.all([
    controlPrisma.organization.findMany({
      select: { id: true, status: true, planTier: true, trialTier: true, trialEndsAt: true, createdAt: true, retentionDeletedAt: true, retentionHold: true }
    }),
    controlPrisma.platformEmailLog.groupBy({ by: ["status"], where: { createdAt: { gte: since30 }, isTest: false }, _count: { _all: true } }),
    controlPrisma.trialFeedback.aggregate({ _count: { _all: true }, _avg: { rating: true } }),
    controlPrisma.platformAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    getRetentionQueue(now),
    getRetentionSettings(),
    getPlatformTransportStatus()
  ]);

  const byStatus: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let trialsActive = 0;
  for (const org of orgs) {
    byStatus[org.status] = (byStatus[org.status] ?? 0) + 1;
    byTier[org.planTier] = (byTier[org.planTier] ?? 0) + 1;
    if (org.status === "ACTIVE" && org.trialEndsAt && org.trialEndsAt > now) trialsActive += 1;
  }
  const signups30 = orgs.filter((o) => o.createdAt >= since30).length;
  const emailCounts = Object.fromEntries(emails30.map((r) => [r.status, r._count._all]));

  // Twelve weekly buckets of signups — enough to see a trend, not so many the sparkline is noise.
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(now.getTime() - (11 - i) * 7 * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    return { week: start.toISOString().slice(0, 10), signups: orgs.filter((o) => o.createdAt >= start && o.createdAt < end).length };
  });

  res.json({
    orgs: { total: orgs.length, byStatus, byTier, trialsActive, signups30, deletedUnderPolicy: orgs.filter((o) => o.retentionDeletedAt).length },
    retention: {
      enabled: settings.enabled,
      autoDeleteEnabled: settings.autoDeleteEnabled,
      inProgramme: queue.filter((q) => q.plan.inProgramme).length,
      dueSoon: queue.filter((q) => q.plan.inProgramme && q.plan.daysUntilDeletion !== null && q.plan.daysUntilDeletion <= 14 && !q.plan.converted).length,
      held: queue.filter((q) => q.retentionHold).length
    },
    email: { sent30: emailCounts.SENT ?? 0, failed30: emailCounts.FAILED ?? 0, skipped30: emailCounts.SKIPPED ?? 0, configured: transport.configured, source: transport.source },
    feedback: { count: feedback._count._all, avgRating: feedback._avg.rating ? Number(feedback._avg.rating.toFixed(2)) : null },
    signupsByWeek: weeks,
    recentActivity: audit
  });
});

/* ============================== Platform mail settings ========================== */

platformAdminConsoleRouter.get("/mail-settings", async (_req, res) => {
  const [row, status] = await Promise.all([controlPrisma.platformMailSettings.findUnique({ where: { id: "global" } }), getPlatformTransportStatus()]);
  res.json({
    host: row?.host ?? "",
    port: row?.port ?? 587,
    secure: row?.secure ?? false,
    user: row?.user ?? "",
    passwordSet: Boolean(row?.encryptedPassword),
    fromAddress: row?.fromAddress ?? "",
    replyTo: row?.replyTo ?? "",
    updatedAt: row?.updatedAt ?? null,
    effective: status
  });
});

const mailSettingsSchema = z.object({
  body: z
    .object({
      host: z.string().max(255),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: z.string().max(255).optional(),
      password: z.string().max(500).optional(),
      clearPassword: z.boolean().optional(),
      fromAddress: z.string().max(255).optional(),
      replyTo: z.string().max(255).optional()
    })
    .strict()
});

platformAdminConsoleRouter.put("/mail-settings", validate(mailSettingsSchema), async (req, res) => {
  const b = req.body;
  const passwordData = b.clearPassword ? { encryptedPassword: null } : b.password ? { encryptedPassword: encryptSecret(b.password) } : {};
  const row = await controlPrisma.platformMailSettings.upsert({
    where: { id: "global" },
    update: { host: b.host.trim() || null, port: b.port, secure: b.secure, user: b.user?.trim() || null, fromAddress: b.fromAddress?.trim() || null, replyTo: b.replyTo?.trim() || null, ...passwordData },
    create: { id: "global", host: b.host.trim() || null, port: b.port, secure: b.secure, user: b.user?.trim() || null, fromAddress: b.fromAddress?.trim() || null, replyTo: b.replyTo?.trim() || null, ...passwordData }
  });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "platform_mail.updated", "PlatformMailSettings", "global", { host: row.host, port: row.port, secure: row.secure });
  res.json({ ok: true, updatedAt: row.updatedAt, effective: await getPlatformTransportStatus() });
});

platformAdminConsoleRouter.post("/mail-settings/test", validate(z.object({ body: z.object({ to: z.string().email() }).strict() })), async (req, res) => {
  const config = await resolvePlatformMailConfig();
  const result = await sendPlatformTemplate("platform.smtp_test", {
    to: req.body.to,
    vars: { sentAt: new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }), host: config.host || "(no host configured)" },
    isTest: true,
    metadata: { by: actorLabel(req) }
  });
  if (!result.ok) throw new AppError(502, `Test email NOT delivered: ${result.errorMessage ?? "the relay refused it"}`);
  res.json({ sent: true, to: req.body.to, emailLogId: result.emailLogId });
});

/* ============================== Platform email templates ======================== */

platformAdminConsoleRouter.get("/email-templates", async (_req, res) => {
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const [rows, counts] = await Promise.all([
    controlPrisma.platformEmailTemplate.findMany(),
    controlPrisma.platformEmailLog.groupBy({ by: ["templateKey", "status"], where: { createdAt: { gte: since30 }, isTest: false }, _count: { _all: true } })
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const countFor = (key: string, status: string) => counts.find((c) => c.templateKey === key && c.status === status)?._count._all ?? 0;
  res.json(
    PLATFORM_TEMPLATES.map((def) => {
      const row = byKey.get(def.key);
      return {
        key: def.key,
        group: def.group,
        description: def.description,
        variables: def.variables,
        hasOverride: Boolean(row),
        enabled: row?.enabled ?? true,
        subject: row?.subject ?? null,
        bodyHtml: row?.bodyHtml ?? null,
        defaultSubject: def.subject,
        defaultHtml: def.html,
        missingVariables: row ? def.variables.filter((v) => def.html.includes(`{{${v}}}`) && !row.bodyHtml.includes(`{{${v}}}`)) : [],
        sent30: countFor(def.key, "SENT"),
        failed30: countFor(def.key, "FAILED"),
        updatedAt: row?.updatedAt ?? null,
        updatedById: row?.updatedById ?? null
      };
    })
  );
});

const templateKeyParam = z.object({ params: z.object({ key: z.string().max(80) }) });
const requireKey = (key: string) => {
  if (!PLATFORM_TEMPLATE_KEYS.includes(key)) throw new AppError(404, "Unknown platform template");
  return key;
};

platformAdminConsoleRouter.put(
  "/email-templates/:key",
  validate(z.object({ params: z.object({ key: z.string() }), body: z.object({ subject: z.string().min(3).max(255), bodyHtml: z.string().min(20), enabled: z.boolean().optional() }).strict() })),
  async (req, res) => {
    const key = requireKey(String(req.params.key));
    const safe = sanitizeEmailHtml(req.body.bodyHtml);
    if (safe.length < 20) throw new AppError(422, "Body is empty after sanitization");
    const row = await controlPrisma.platformEmailTemplate.upsert({
      where: { key },
      update: { subject: req.body.subject.trim(), bodyHtml: safe, enabled: req.body.enabled ?? true, updatedById: req.platformAdmin!.id },
      create: { key, subject: req.body.subject.trim(), bodyHtml: safe, enabled: req.body.enabled ?? true, updatedById: req.platformAdmin!.id }
    });
    await platformAudit("PLATFORM_ADMIN", actorLabel(req), "platform_email_template.updated", "PlatformEmailTemplate", key);
    res.json(row);
  }
);

platformAdminConsoleRouter.delete("/email-templates/:key", validate(templateKeyParam), async (req, res) => {
  const key = requireKey(String(req.params.key));
  await controlPrisma.platformEmailTemplate.deleteMany({ where: { key } });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "platform_email_template.reverted", "PlatformEmailTemplate", key);
  res.status(204).send();
});

/** Render for the editor: the SAVED version by default, or an unsaved draft passed in the body. */
platformAdminConsoleRouter.post(
  "/email-templates/:key/preview",
  validate(z.object({ params: z.object({ key: z.string() }), body: z.object({ subject: z.string().optional(), bodyHtml: z.string().optional(), vars: z.record(z.string()).optional() }).strict() })),
  async (req, res) => {
    const key = requireKey(String(req.params.key));
    const def = platformTemplateDef(key)!;
    const vars = { ...def.sample, ...(req.body.vars ?? {}) };
    if (req.body.subject !== undefined || req.body.bodyHtml !== undefined) {
      res.json({ subject: applyPlatformVars(req.body.subject ?? def.subject, vars), html: applyPlatformVars(sanitizeEmailHtml(req.body.bodyHtml ?? def.html), vars), sample: vars });
      return;
    }
    const rendered = await renderPlatformTemplate(key, vars);
    res.json({ ...rendered, sample: vars });
  }
);

platformAdminConsoleRouter.post(
  "/email-templates/:key/test",
  validate(z.object({ params: z.object({ key: z.string() }), body: z.object({ to: z.string().email() }).strict() })),
  async (req, res) => {
    const key = requireKey(String(req.params.key));
    const def = platformTemplateDef(key)!;
    const result = await sendPlatformTemplate(key, { to: req.body.to, vars: def.sample, isTest: true, metadata: { by: actorLabel(req) } });
    if (!result.ok) throw new AppError(502, `Email NOT delivered: ${result.errorMessage ?? "the relay refused it"}`);
    res.json({ sent: true, to: req.body.to, subject: result.subject, emailLogId: result.emailLogId });
  }
);

platformAdminConsoleRouter.get("/email-templates/:key/log", validate(templateKeyParam), async (req, res) => {
  const key = requireKey(String(req.params.key));
  const rows = await controlPrisma.platformEmailLog.findMany({
    where: { templateKey: key },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, to: true, subject: true, status: true, errorMessage: true, dayMarker: true, isTest: true, createdAt: true, organizationId: true, organization: { select: { name: true, slug: true } } }
  });
  res.json(rows);
});

/* ================================ Email log + analytics ========================= */

platformAdminConsoleRouter.get("/email-log", validate(z.object({ query: z.object({ status: z.string().optional(), orgId: z.string().optional(), limit: z.string().optional() }).partial() })), async (req, res) => {
  const status = typeof req.query.status === "string" && ["SENT", "FAILED", "SKIPPED"].includes(req.query.status) ? (req.query.status as "SENT" | "FAILED" | "SKIPPED") : undefined;
  const orgId = typeof req.query.orgId === "string" ? req.query.orgId : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const rows = await controlPrisma.platformEmailLog.findMany({
    where: { ...(status ? { status } : {}), ...(orgId ? { organizationId: orgId } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, to: true, subject: true, templateKey: true, status: true, errorMessage: true, dayMarker: true, isTest: true, createdAt: true, organizationId: true, organization: { select: { name: true, slug: true } } }
  });
  res.json(rows);
});

platformAdminConsoleRouter.get("/email-log/:id", async (req, res) => {
  const row = await controlPrisma.platformEmailLog.findUnique({ where: { id: String(req.params.id) }, include: { organization: { select: { name: true, slug: true } } } });
  if (!row) throw new AppError(404, "Not in the log");
  res.json({ ...row, html: (row.payload as { html?: string } | null)?.html ?? null, payload: undefined });
});

platformAdminConsoleRouter.post("/email-log/:id/resend", async (req, res) => {
  const result = await resendPlatformEmail(String(req.params.id), actorLabel(req));
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "platform_email.resent", "PlatformEmailLog", String(req.params.id), { status: result.status });
  if (!result.ok) throw new AppError(502, `Email NOT delivered: ${result.errorMessage ?? "the relay refused it"}`);
  res.json({ sent: true, emailLogId: result.emailLogId });
});

platformAdminConsoleRouter.get("/email-analytics", async (_req, res) => {
  const now = Date.now();
  const since90 = new Date(now - 90 * DAY_MS);
  const rows = await controlPrisma.platformEmailLog.findMany({
    where: { createdAt: { gte: since90 } },
    select: { templateKey: true, status: true, isTest: true, createdAt: true, errorMessage: true, dayMarker: true }
  });
  const totals = { sent: 0, failed: 0, skipped: 0, test: 0 };
  const perTemplate = new Map<string, { key: string; sent: number; failed: number; skipped: number; test: number }>();
  const perDay = new Map<string, { day: string; sent: number; failed: number }>();
  const failures = new Map<string, number>();
  for (const r of rows) {
    const t = perTemplate.get(r.templateKey) ?? { key: r.templateKey, sent: 0, failed: 0, skipped: 0, test: 0 };
    perTemplate.set(r.templateKey, t);
    if (r.isTest) {
      totals.test += 1;
      t.test += 1;
      continue;
    }
    const day = r.createdAt.toISOString().slice(0, 10);
    const d = perDay.get(day) ?? { day, sent: 0, failed: 0 };
    perDay.set(day, d);
    if (r.status === "SENT") {
      totals.sent += 1;
      t.sent += 1;
      d.sent += 1;
    } else if (r.status === "FAILED") {
      totals.failed += 1;
      t.failed += 1;
      d.failed += 1;
      const reason = (r.errorMessage ?? "Unknown").replace(/\d{3}-?\d\.\d\.\d/g, "").trim().slice(0, 120);
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    } else {
      totals.skipped += 1;
      t.skipped += 1;
    }
  }
  // Every day in the window, zero-filled, so the chart's x-axis is time and not "days with mail".
  const days = Array.from({ length: 90 }, (_, i) => {
    const day = new Date(now - (89 - i) * DAY_MS).toISOString().slice(0, 10);
    return perDay.get(day) ?? { day, sent: 0, failed: 0 };
  });
  res.json({
    windowDays: 90,
    totals,
    perTemplate: PLATFORM_TEMPLATES.map((def) => {
      const counts = perTemplate.get(def.key) ?? { key: def.key, sent: 0, failed: 0, skipped: 0, test: 0 };
      return { key: def.key, group: def.group, sent: counts.sent, failed: counts.failed, skipped: counts.skipped, test: counts.test };
    }),
    perDay: days,
    failureReasons: [...failures.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8)
  });
});

/* ================================ Trial retention =============================== */

platformAdminConsoleRouter.get("/retention", async (_req, res) => {
  const [settings, queue] = await Promise.all([getRetentionSettings(), getRetentionQueue()]);
  res.json({ settings, markers: Object.keys(RETENTION_MARKER_TEMPLATE), queue });
});

const retentionSettingsSchema = z.object({
  body: z
    .object({
      enabled: z.boolean().optional(),
      feedbackDay: z.number().int().min(1).max(60).optional(),
      reminderDays: z.array(z.number().int().min(1).max(3650)).min(1).max(12).optional(),
      retentionDays: z.number().int().min(7).max(3650).optional(),
      autoDeleteEnabled: z.boolean().optional(),
      snapshotDir: z.string().max(500).nullable().optional()
    })
    .strict()
});

platformAdminConsoleRouter.put("/retention/settings", validate(retentionSettingsSchema), async (req, res) => {
  res.json(await updateRetentionSettings(req.body, actorLabel(req)));
});

platformAdminConsoleRouter.post("/retention/run", validate(z.object({ body: z.object({ dryRun: z.boolean().optional(), simulateNow: z.string().datetime().optional() }).strict().optional() })), async (req, res) => {
  const now = req.body?.simulateNow ? new Date(req.body.simulateNow) : new Date();
  // A simulated clock is a DRY RUN by definition. Deleting a workspace because an operator typed a
  // date in the future is not a feature anybody wants.
  const dryRun = Boolean(req.body?.dryRun) || Boolean(req.body?.simulateNow);
  const result = await runRetentionTick(now, { dryRun, actorLabel: actorLabel(req) });
  if (!dryRun) await platformAudit("PLATFORM_ADMIN", actorLabel(req), "retention.tick_run", "PlatformRetentionSettings", "global", { sent: result.sent.length, deleted: result.deleted.length });
  res.json(result);
});

platformAdminConsoleRouter.post("/retention/:orgId/hold", validate(z.object({ params: z.object({ orgId: z.string() }), body: z.object({ hold: z.boolean() }).strict() })), async (req, res) => {
  res.json(await setRetentionHold(String(req.params.orgId), req.body.hold, actorLabel(req)));
});

platformAdminConsoleRouter.post("/retention/:orgId/send/:marker", async (req, res) => {
  const marker = String(req.params.marker);
  if (!RETENTION_MARKER_TEMPLATE[marker]) throw new AppError(404, "Unknown retention stage");
  const result = await sendRetentionMarker(String(req.params.orgId), marker, { actorLabel: actorLabel(req), force: true });
  if (!result.ok) throw new AppError(502, `Email NOT delivered: ${result.errorMessage ?? "the relay refused it"}`);
  res.json(result);
});

platformAdminConsoleRouter.post("/retention/:orgId/delete", validate(z.object({ params: z.object({ orgId: z.string() }), body: z.object({ confirmSlug: z.string().min(1) }).strict() })), async (req, res) => {
  const org = await controlPrisma.organization.findUnique({ where: { id: String(req.params.orgId) }, select: { slug: true } });
  if (!org) throw new AppError(404, "Organization not found");
  // Typing the slug is the only confirmation a destructive console action should accept.
  if (org.slug !== req.body.confirmSlug.trim().toLowerCase()) throw new AppError(422, "The slug you typed does not match this workspace.");
  res.json(await deleteWorkspaceUnderPolicy(String(req.params.orgId), { actorLabel: actorLabel(req), force: true }));
});

/* =================================== Feedback ================================== */

platformAdminConsoleRouter.get("/feedback", async (_req, res) => {
  const rows = await controlPrisma.trialFeedback.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { organization: { select: { name: true, slug: true, status: true, planTier: true } } }
  });
  const distribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: rows.filter((r) => r.rating === rating).length }));
  const wouldReturn = ["yes", "maybe", "no"].map((answer) => ({ answer, count: rows.filter((r) => r.wouldReturn === answer).length }));
  const avg = rows.length ? Number((rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(2)) : null;
  res.json({ count: rows.length, avgRating: avg, distribution, wouldReturn, rows });
});

/* ================================= Audit trail ================================= */

platformAdminConsoleRouter.get("/audit", async (req, res) => {
  const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 80));
  const entity = typeof req.query.entity === "string" ? req.query.entity : undefined;
  res.json(await controlPrisma.platformAuditLog.findMany({ where: entity ? { entity } : undefined, orderBy: { createdAt: "desc" }, take: limit }));
});

/* ============================== Platform admin accounts ========================= */

platformAdminConsoleRouter.get("/admins", async (_req, res) => {
  const rows = await controlPrisma.platformAdminUser.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, status: true, createdAt: true, lastLoginAt: true, _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } } }
  });
  res.json(rows.map((r) => ({ id: r.id, email: r.email, name: r.name, status: r.status, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt, liveSessions: r._count.sessions })));
});

platformAdminConsoleRouter.post("/admins", validate(z.object({ body: z.object({ email: z.string().email(), name: z.string().min(2).max(120) }).strict() })), async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const existing = await controlPrisma.platformAdminUser.findUnique({ where: { email } });
  if (existing) throw new AppError(409, "A platform admin with that email already exists.");
  // Generated, never chosen: the person creating the account should never know a colleague's password.
  const password = generateTempPassword();
  const row = await controlPrisma.platformAdminUser.create({ data: { email, name: req.body.name.trim(), passwordHash: await hashPassword(password), status: "ACTIVE" } });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "platform_admin.created", "PlatformAdminUser", row.id, { email });
  res.status(201).json({ id: row.id, email: row.email, name: row.name, temporaryPassword: password });
});

platformAdminConsoleRouter.patch("/admins/:id", validate(z.object({ params: z.object({ id: z.string() }), body: z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }).strict() })), async (req, res) => {
  const id = String(req.params.id);
  if (id === req.platformAdmin!.id && req.body.status === "INACTIVE") throw new AppError(409, "You cannot deactivate the account you are signed in with.");
  const active = await controlPrisma.platformAdminUser.count({ where: { status: "ACTIVE" } });
  const target = await controlPrisma.platformAdminUser.findUnique({ where: { id } });
  if (!target) throw new AppError(404, "Not found");
  if (req.body.status === "INACTIVE" && target.status === "ACTIVE" && active <= 1) throw new AppError(409, "That is the last active platform admin. Create another one first.");
  const row = await controlPrisma.platformAdminUser.update({ where: { id }, data: { status: req.body.status } });
  if (req.body.status === "INACTIVE") await controlPrisma.platformAdminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), `platform_admin.${req.body.status.toLowerCase()}`, "PlatformAdminUser", id, { email: row.email });
  res.json({ id: row.id, status: row.status });
});

platformAdminConsoleRouter.get("/auth/sessions", async (req, res) => {
  const rows = await controlPrisma.platformAdminSession.findMany({
    where: { adminUserId: req.platformAdmin!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, refreshRotatedAt: true }
  });
  res.json(rows.map((r) => ({ ...r, current: r.id === req.platformAdminSessionId })));
});

platformAdminConsoleRouter.delete("/auth/sessions/:id", async (req, res) => {
  const id = String(req.params.id);
  if (id === req.platformAdminSessionId) throw new AppError(409, "Use Sign out to end this session.");
  await controlPrisma.platformAdminSession.updateMany({ where: { id, adminUserId: req.platformAdmin!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.status(204).send();
});

/* Re-exported so the console's organizations page can show analytics for one org without a second loop. */
platformAdminConsoleRouter.get("/analytics/summary", async (_req, res) => {
  res.json(await getPlatformAnalytics());
});
