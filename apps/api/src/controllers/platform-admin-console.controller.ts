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
import { createReadStream } from "node:fs";
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
import { getPlatformEmailAnalytics } from "../services/platform-email-analytics.service.js";
import { deleteSnapshot, listSnapshots, restoreSnapshot, snapshotPath } from "../services/platform-backup.service.js";
import { broadcastMaintenance, getFleetMaintenance, listBroadcasts } from "../services/platform-maintenance.service.js";
import { getDatabaseMetrics, getFleetHealth, getTenantHealth } from "../services/platform-tenant-health.service.js";
import { getTenantDbTrend, runMaintenanceOperation, sampleAllTenantDatabases } from "../services/tenant-db-metrics.service.js";
import { adviseWorkspace, decideAdvice, getPlatformAiSettings, listAdvice, updatePlatformAiSettings, ADVISOR_ACTIONS } from "../services/platform-ai.service.js";
import { DESTINATION_FIELDS, describeSecret, encryptDestinationSecret, testDestination, type BackupDestinationKind, type DestinationRecord } from "../services/backup-destination.service.js";
import { backupEntitlement, nextRunAt, planRetention, runBackup, runBackupTick, sweepRetention, testRestore } from "../services/backup.service.js";
import { allowedBackupFrequencies, BACKUP_FREQUENCY_LABEL, backupFrequencyAllowed, type BackupFrequency } from "@timesheet/shared";

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

/**
 * Delivery analytics for platform mail. The aggregation lives in
 * `platform-email-analytics.service.ts` — this route only resolves the window.
 *
 * The window is a pair of inclusive calendar dates, the same contract the workspace-side email
 * analytics uses, so an operator who has learned one date picker has learned both. Omitted bounds
 * mean the last 90 days.
 */
platformAdminConsoleRouter.get(
  "/email-analytics",
  validate(z.object({ query: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).partial() })),
  async (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    res.json(await getPlatformEmailAnalytics(from, to));
  }
);

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

/**
 * Customer feedback, with the analytics an operator actually asks of it: not only how many and how
 * happy, but WHERE the answers came from (which retention stage), WHICH kind of workspace gave them
 * (plan tier and lifecycle state), and whether the score is moving.
 *
 * WHY THE TREND IS BY MONTH AND NOT BY DAY. Feedback arrives in single figures a week even on a
 * healthy platform; a daily series of a 1-to-5 rating is almost all noise and empty buckets. A
 * monthly mean over twelve months is the shortest window in which a change in it means something.
 */
platformAdminConsoleRouter.get("/feedback", async (_req, res) => {
  const rows = await controlPrisma.trialFeedback.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { organization: { select: { name: true, slug: true, status: true, planTier: true, trialTier: true } } }
  });

  const distribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: rows.filter((r) => r.rating === rating).length }));
  const wouldReturn = ["yes", "maybe", "no"].map((answer) => ({ answer, count: rows.filter((r) => r.wouldReturn === answer).length }));
  const mean = (list: typeof rows) => (list.length ? Number((list.reduce((sum, r) => sum + r.rating, 0) / list.length).toFixed(2)) : null);

  // Per stage: the day-10 check-in and the post-trial reminders are different questions asked of
  // different moods, and averaging them together hides which one is bad.
  const stages = [...new Set(rows.map((r) => r.stage))].map((stage) => {
    const of = rows.filter((r) => r.stage === stage);
    return { stage, count: of.length, avgRating: mean(of), wouldReturn: of.filter((r) => r.wouldReturn === "yes").length };
  }).sort((a, b) => b.count - a.count);

  const byStatus = [...new Set(rows.map((r) => r.organization.status))].map((status) => {
    const of = rows.filter((r) => r.organization.status === status);
    return { status, count: of.length, avgRating: mean(of) };
  });

  const byTier = [...new Set(rows.map((r) => r.organization.trialTier ?? r.organization.planTier))].map((tier) => {
    const of = rows.filter((r) => (r.organization.trialTier ?? r.organization.planTier) === tier);
    return { tier, count: of.length, avgRating: mean(of) };
  });

  const now = new Date();
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    const next = new Date(now.getFullYear(), now.getMonth() - (10 - i), 1);
    const of = rows.filter((r) => r.createdAt >= start && r.createdAt < next);
    return { month: start.toISOString().slice(0, 7), count: of.length, avgRating: mean(of) };
  });

  // The words, not only the scores: the two free-text fields are why this screen exists, so the
  // response rate on them is worth stating — a wall of rating-only answers means the form is asking
  // badly, not that customers have nothing to say.
  const withWords = rows.filter((r) => (r.liked ?? "").trim() || (r.missing ?? "").trim() || (r.comment ?? "").trim()).length;

  res.json({
    count: rows.length,
    avgRating: mean(rows),
    withWords,
    distribution,
    wouldReturn,
    stages,
    byStatus,
    byTier,
    monthly,
    rows
  });
});

/* ================================= Audit trail ================================= */

/**
 * The control-plane audit trail, paginated. It only grows, so an un-paginated "last 80" answers
 * "what happened recently" and nothing else — and "who deleted that workspace in June" is exactly
 * the question this table exists for.
 *
 * Offset paging rather than a cursor: the rows are ordered by a timestamp that never changes, the
 * volume is platform-scale, and an operator jumping to page 9 is a normal thing to want from an
 * audit log in a way it is not from an activity feed.
 */
platformAdminConsoleRouter.get("/audit", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const entity = typeof req.query.entity === "string" && req.query.entity !== "all" ? req.query.entity : undefined;
  const actorType = typeof req.query.actorType === "string" && req.query.actorType !== "all" ? req.query.actorType : undefined;
  const where = { ...(entity ? { entity } : {}), ...(actorType ? { actorType } : {}) };
  const [rows, total, entities] = await Promise.all([
    controlPrisma.platformAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    controlPrisma.platformAuditLog.count({ where }),
    // The filter's options come from the data, so a new entity type appears in the picker the first
    // time something writes one — no hand-kept list to drift.
    controlPrisma.platformAuditLog.groupBy({ by: ["entity"], _count: { _all: true } })
  ]);
  res.json({
    rows,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    entities: entities.map((e) => ({ entity: e.entity, count: e._count._all })).sort((a, b) => b.count - a.count)
  });
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

/**
 * This admin's own live console sessions, paginated.
 *
 * PAGINATED BECAUSE THE LIST IS NOT SHORT. Every sign-in establishes a row and nothing collapses
 * them, so an operator who has been testing — or any automation that signs in — accumulates dozens
 * within a day. The tenant app hit exactly this and it is written up on `Session.deviceId` in the
 * tenant schema: a list of seventy near-identical rows cannot answer "is there a session here that
 * should not be?", which is the only question this screen is asked.
 */
platformAdminConsoleRouter.get("/auth/sessions", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = { adminUserId: req.platformAdmin!.id, revokedAt: null, expiresAt: { gt: new Date() } };
  const [rows, total] = await Promise.all([
    controlPrisma.platformAdminSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, refreshRotatedAt: true }
    }),
    controlPrisma.platformAdminSession.count({ where })
  ]);
  res.json({
    rows: rows.map((r) => ({ ...r, current: r.id === req.platformAdminSessionId })),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit))
  });
});

/**
 * End every session except the one making the request — the "I signed in on a machine I no longer
 * have" button. Deliberately keeps the caller signed in: an operator who has to sign in again to
 * see whether the revocation worked will not press it.
 */
platformAdminConsoleRouter.post("/auth/sessions/revoke-others", async (req, res) => {
  const result = await controlPrisma.platformAdminSession.updateMany({
    where: { adminUserId: req.platformAdmin!.id, revokedAt: null, id: { not: req.platformAdminSessionId! } },
    data: { revokedAt: new Date() }
  });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "platform_admin.sessions_revoked", "PlatformAdminUser", req.platformAdmin!.id, { count: result.count });
  res.json({ revoked: result.count });
});

platformAdminConsoleRouter.delete("/auth/sessions/:id", async (req, res) => {
  const id = String(req.params.id);
  if (id === req.platformAdminSessionId) throw new AppError(409, "Use Sign out to end this session.");
  await controlPrisma.platformAdminSession.updateMany({ where: { id, adminUserId: req.platformAdmin!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.status(204).send();
});

/* ============================ Platform-wide maintenance ========================= */

/**
 * Every workspace's current maintenance window, read live.
 *
 * NOT CACHED, on purpose: this is an operator watching a change window, and a ten-second-stale
 * "is everyone in maintenance yet?" is worse than a slow answer.
 */
platformAdminConsoleRouter.get("/maintenance/fleet", async (_req, res) => {
  const [workspaces, broadcasts] = await Promise.all([getFleetMaintenance(), listBroadcasts(15)]);
  res.json({ workspaces, broadcasts });
});

const broadcastSchema = z.object({
  body: z
    .object({
      /** Empty = every reachable workspace. The console makes that choice explicit. */
      organizationIds: z.array(z.string()).default([]),
      enabled: z.boolean(),
      scheduledStartAt: z.string().datetime().nullable().optional(),
      scheduledEndAt: z.string().datetime().nullable().optional(),
      message: z.string().max(500).nullable().optional(),
      notifyUsers: z.boolean().optional(),
      emailSuperAdmins: z.boolean().optional()
    })
    .strict()
});

platformAdminConsoleRouter.post("/maintenance/broadcast", validate(broadcastSchema), async (req, res) => {
  const result = await broadcastMaintenance({
    organizationIds: req.body.organizationIds ?? [],
    enabled: req.body.enabled,
    scheduledStartAt: req.body.scheduledStartAt ? new Date(req.body.scheduledStartAt) : null,
    scheduledEndAt: req.body.scheduledEndAt ? new Date(req.body.scheduledEndAt) : null,
    message: req.body.message ?? null,
    notifyUsers: req.body.notifyUsers ?? false,
    emailSuperAdmins: req.body.emailSuperAdmins ?? false,
    actorLabel: actorLabel(req)
  });
  res.json(result);
});

/* ============================== Per-tenant monitoring =========================== */

/** Every workspace's database at a glance, with the alerts each one's numbers imply. */
platformAdminConsoleRouter.get("/monitoring/fleet", async (_req, res) => {
  res.json(await getFleetHealth());
});

/**
 * One workspace: its maintenance state, server health, service status with incident history, API
 * performance and database metrics — the same figures its own admins see in their Maintenance tab,
 * because the same services produce them.
 */
platformAdminConsoleRouter.get("/monitoring/:orgId", async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json(await getTenantHealth(String(req.params.orgId), days));
});

/** The database panel alone, for the poll that keeps it fresh without re-reading the whole page. */
platformAdminConsoleRouter.get("/monitoring/:orgId/database", async (req, res) => {
  res.json(await getDatabaseMetrics(String(req.params.orgId)));
});

/** The size/row/latency series behind the trend charts, plus the growth summary derived from it. */
platformAdminConsoleRouter.get("/monitoring/:orgId/trend", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json(await getTenantDbTrend(String(req.params.orgId), days));
});

/**
 * Take a reading of the whole fleet NOW, rather than waiting for the :25 worker.
 *
 * Useful exactly twice: on a fresh install, where an empty chart is indistinguishable from a broken
 * one, and right after a migration, where the interesting comparison is before-and-after rather
 * than this-hour-and-last.
 */
platformAdminConsoleRouter.post("/monitoring/sample", async (req, res) => {
  const result = await sampleAllTenantDatabases();
  // `platformAudit`, not the tenant `audit`: this touched every workspace and belongs to none of
  // them, so it goes in the control plane's own trail where the operator's other actions are.
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "tenant_db.sampled", "Organization", undefined, {
    sampled: result.sampled,
    failed: result.failed.length,
    prunedRows: result.prunedRows
  });
  res.json(result);
});

const operationSchema = z.object({
  body: z
    .object({
      operation: z.enum(["ANALYZE", "OPTIMIZE"]),
      /** Empty means every table in the schema. Names are checked against the LIVE schema. */
      tables: z.array(z.string().max(64)).max(200).default([])
    })
    .strict()
});

/**
 * The two maintenance operations, and they are the only two.
 *
 * The caller names an operation from an enum and a list of tables; it never supplies SQL. OPTIMIZE
 * is refused unless the workspace is inside an ACTIVE maintenance window, because it rebuilds each
 * table and blocks writes while it runs — see the service.
 */
platformAdminConsoleRouter.post("/monitoring/:orgId/operation", validate(operationSchema), async (req, res) => {
  const result = await runMaintenanceOperation({
    orgId: String(req.params.orgId),
    operation: req.body.operation,
    tables: req.body.tables ?? [],
    actorLabel: actorLabel(req)
  });
  res.json(result);
});

/* ================================ The AI advisor ================================ */

/** The advisor's own configuration, and the catalogue of actions a finding may name. */
platformAdminConsoleRouter.get("/ai/settings", async (_req, res) => {
  res.json({ settings: await getPlatformAiSettings(), actions: ADVISOR_ACTIONS });
});

const aiSettingsSchema = z.object({
  body: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(["ANTHROPIC", "OPENAI_COMPATIBLE"]),
      baseUrl: z.string().url().max(500).nullable().optional(),
      model: z.string().min(1).max(120),
      /** Omitted keeps the stored key; "" clears it. It is never returned. */
      apiKey: z.string().max(500).optional(),
      dailyCallLimit: z.number().int().min(1).max(1000)
    })
    .strict()
});

platformAdminConsoleRouter.put("/ai/settings", validate(aiSettingsSchema), async (req, res) => {
  res.json(
    await updatePlatformAiSettings({
      enabled: req.body.enabled,
      provider: req.body.provider,
      baseUrl: req.body.baseUrl ?? null,
      model: req.body.model,
      apiKey: req.body.apiKey,
      dailyCallLimit: Number(req.body.dailyCallLimit),
      actorLabel: actorLabel(req)
    })
  );
});

/**
 * Generate one advisory for one workspace. Always operator-initiated — nothing here is on a timer,
 * because an advisor that runs on its own produces a queue nobody reads and a bill somebody pays.
 */
platformAdminConsoleRouter.post("/ai/advise/:orgId", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
  res.json(await adviseWorkspace(String(req.params.orgId), actorLabel(req), days));
});

platformAdminConsoleRouter.get("/ai/advice/:orgId", async (req, res) => {
  res.json({ advice: await listAdvice(String(req.params.orgId), 10) });
});

const decisionSchema = z.object({
  body: z
    .object({
      status: z.enum(["APPLIED", "DISMISSED"]),
      /** Required for a dismissal — the service enforces it, this only shapes the payload. */
      note: z.string().max(1000).nullable().optional()
    })
    .strict()
});

platformAdminConsoleRouter.post("/ai/advice/:adviceId/decision", validate(decisionSchema), async (req, res) => {
  res.json(await decideAdvice({ adviceId: String(req.params.adviceId), status: req.body.status, note: req.body.note ?? null, actorLabel: actorLabel(req) }));
});

/* ============================== Managed backups ================================= */

/**
 * The backup module's whole state for the console: what each tier allows, every destination, every
 * organization's policy and its next run, and the recent runs.
 *
 * ONE READ, NOT FIVE. Every figure on that screen has to agree with every other — a queue that says
 * "next run tomorrow" beside a policy the tier no longer permits is worse than no screen — and five
 * independent endpoints cannot promise that.
 */
platformAdminConsoleRouter.get("/backups/overview", async (_req, res) => {
  const now = new Date();
  const [orgs, destinations, tierRows, recentRuns] = await Promise.all([
    controlPrisma.organization.findMany({
      where: { status: { in: ["ACTIVE", "GRACE", "SUSPENDED"] } },
      orderBy: { name: "asc" },
      include: { backupPolicy: { include: { destination: { select: { id: true, name: true, kind: true } } } }, database: { select: { databaseName: true } } }
    }),
    controlPrisma.backupDestination.findMany({ orderBy: [{ organizationId: "asc" }, { name: "asc" }], include: { organization: { select: { name: true, slug: true } }, _count: { select: { runs: true } } } }),
    controlPrisma.planTierLimit.findMany(),
    controlPrisma.backupRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 60,
      include: { organization: { select: { name: true, slug: true } }, destination: { select: { name: true, kind: true } } }
    })
  ]);

  const workspaces = await Promise.all(
    orgs.map(async (org) => {
      const entitlement = await backupEntitlement(org);
      const policy = org.backupPolicy;
      return {
        organizationId: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        planTier: org.planTier,
        trialTier: org.trialTier,
        hasDatabase: Boolean(org.database),
        entitlement,
        allowedFrequencies: allowedBackupFrequencies(entitlement.frequency),
        policy: policy
          ? {
              id: policy.id,
              enabled: policy.enabled,
              frequency: policy.frequency,
              hourUtc: policy.hourUtc,
              dayOfWeek: policy.dayOfWeek,
              destinationId: policy.destinationId,
              destinationName: policy.destination?.name ?? null,
              retentionMode: policy.retentionMode,
              keepCount: policy.keepCount,
              keepDays: policy.keepDays,
              gfsDaily: policy.gfsDaily,
              gfsWeekly: policy.gfsWeekly,
              gfsMonthly: policy.gfsMonthly,
              gfsYearly: policy.gfsYearly,
              alertEmails: policy.alertEmails,
              hasAlertWebhook: Boolean(policy.encryptedAlertWebhook),
              alertOnSuccess: policy.alertOnSuccess,
              alertOnFailure: policy.alertOnFailure,
              lastRunAt: policy.lastRunAt,
              lastStatus: policy.lastStatus,
              nextRunAt: policy.nextRunAt,
              // Recomputed rather than trusted: a policy edited by hand or a tier that changed
              // since the last run makes the stored value stale, and the console must not repeat it.
              projectedNextRunAt: policy.enabled ? nextRunAt(policy, now) : null,
              /** True when the tier no longer permits what this policy asks for. */
              overTier: !backupFrequencyAllowed(policy.frequency as BackupFrequency, entitlement.frequency)
            }
          : null
      };
    })
  );

  const tiers = tierRows.map((t) => ({
    tier: t.tier,
    backupFrequency: t.backupFrequency,
    backupFrequencyLabel: BACKUP_FREQUENCY_LABEL[t.backupFrequency as BackupFrequency],
    maxBackupDestinations: t.maxBackupDestinations,
    backupPitrEnabled: t.backupPitrEnabled
  }));

  res.json({
    tiers,
    frequencyLabels: BACKUP_FREQUENCY_LABEL,
    destinationKinds: Object.entries(DESTINATION_FIELDS).map(([kind, spec]) => ({ kind, label: spec.label, blurb: spec.blurb, fields: spec.fields })),
    destinations: destinations.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      /** null = a platform-owned destination any workspace may use. */
      organizationId: d.organizationId,
      organizationName: d.organization?.name ?? null,
      config: d.config,
      prefix: d.prefix,
      isDefault: d.isDefault,
      secretsSet: describeSecret(d as DestinationRecord),
      lastTestedAt: d.lastTestedAt,
      lastTestStatus: d.lastTestStatus,
      lastTestMessage: d.lastTestMessage,
      runCount: d._count.runs
    })),
    workspaces,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      organizationName: r.organization.name,
      slug: r.organization.slug,
      destinationName: r.destination?.name ?? null,
      destinationKind: r.destination?.kind ?? null,
      kind: r.kind,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      // BigInt does not survive JSON.stringify — Express would throw rather than serialise it.
      bytes: r.bytes === null ? null : Number(r.bytes),
      objectKey: r.objectKey,
      checksumSha256: r.checksumSha256,
      errorMessage: r.errorMessage,
      retentionTag: r.retentionTag
    }))
  });
});

const destinationBody = z.object({
  name: z.string().min(2).max(120),
  kind: z.enum(["LOCAL", "S3", "AZURE_BLOB", "GOOGLE_DRIVE", "ONEDRIVE", "SFTP"]),
  organizationId: z.string().nullable().optional(),
  config: z.record(z.string()).default({}),
  /** Write-only. Only the keys present are changed, so a save that leaves a field blank keeps it. */
  secrets: z.record(z.string()).optional(),
  prefix: z.string().max(255).nullable().optional(),
  isDefault: z.boolean().optional()
});

platformAdminConsoleRouter.post("/backups/destinations", validate(z.object({ body: destinationBody.strict() })), async (req, res) => {
  const b = req.body;
  if (b.organizationId) {
    const org = await controlPrisma.organization.findUnique({ where: { id: b.organizationId } });
    if (!org) throw new AppError(404, "Organization not found");
    const entitlement = await backupEntitlement(org);
    const existing = await controlPrisma.backupDestination.count({ where: { organizationId: b.organizationId } });
    if (existing >= entitlement.maxDestinations) {
      throw new AppError(409, `The ${entitlement.tier} plan allows ${entitlement.maxDestinations} destination${entitlement.maxDestinations === 1 ? "" : "s"} per workspace; ${org.slug} already has ${existing}.`);
    }
  }
  const row = await controlPrisma.backupDestination.create({
    data: {
      name: b.name.trim(),
      kind: b.kind as BackupDestinationKind,
      organizationId: b.organizationId ?? null,
      config: b.config,
      encryptedSecret: b.secrets && Object.keys(b.secrets).length ? encryptDestinationSecret(b.secrets) : null,
      prefix: b.prefix?.trim() || null,
      isDefault: b.isDefault ?? false
    }
  });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "backup.destination_created", "BackupDestination", row.id, { name: row.name, kind: row.kind });
  res.status(201).json({ id: row.id });
});

platformAdminConsoleRouter.patch(
  "/backups/destinations/:id",
  validate(z.object({ params: z.object({ id: z.string() }), body: destinationBody.partial().strict() })),
  async (req, res) => {
    const id = String(req.params.id);
    const current = await controlPrisma.backupDestination.findUnique({ where: { id } });
    if (!current) throw new AppError(404, "Destination not found");

    // MERGE the secrets rather than replace them: the console never receives the stored values, so
    // a form that submits only what was retyped must not blank the rest.
    let encryptedSecret = current.encryptedSecret;
    if (req.body.secrets && Object.keys(req.body.secrets).length) {
      const kept = describeSecret(current as DestinationRecord);
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.body.secrets as Record<string, string>)) if (value) merged[key] = value;
      // Anything already set and not retyped is preserved by re-reading and re-encrypting.
      if (current.encryptedSecret) {
        for (const key of Object.keys(kept)) if (kept[key] && merged[key] === undefined) merged[key] = "__KEEP__";
      }
      const { decryptSecret } = await import("../utils/encryption.js");
      const previous: Record<string, string> = current.encryptedSecret ? (JSON.parse(decryptSecret(current.encryptedSecret)) as Record<string, string>) : {};
      for (const key of Object.keys(merged)) if (merged[key] === "__KEEP__") merged[key] = previous[key];
      encryptedSecret = encryptDestinationSecret(merged);
    }

    const row = await controlPrisma.backupDestination.update({
      where: { id },
      data: {
        ...(req.body.name ? { name: req.body.name.trim() } : {}),
        ...(req.body.kind ? { kind: req.body.kind as BackupDestinationKind } : {}),
        ...(req.body.config ? { config: req.body.config } : {}),
        ...(req.body.prefix !== undefined ? { prefix: req.body.prefix?.trim() || null } : {}),
        ...(req.body.isDefault !== undefined ? { isDefault: req.body.isDefault } : {}),
        encryptedSecret
      }
    });
    await platformAudit("PLATFORM_ADMIN", actorLabel(req), "backup.destination_updated", "BackupDestination", row.id, { name: row.name });
    res.json({ id: row.id });
  }
);

platformAdminConsoleRouter.post("/backups/destinations/:id/test", async (req, res) => {
  const row = await controlPrisma.backupDestination.findUnique({ where: { id: String(req.params.id) } });
  if (!row) throw new AppError(404, "Destination not found");
  const result = await testDestination(row as DestinationRecord);
  // RECORDED, NEVER ENFORCED — the same rule the SSO connection test follows: a destination
  // unreachable from here can be perfectly reachable from a production host.
  await controlPrisma.backupDestination.update({
    where: { id: row.id },
    data: { lastTestedAt: new Date(), lastTestStatus: result.ok ? "PASS" : "FAIL", lastTestMessage: result.message }
  });
  res.json(result);
});

platformAdminConsoleRouter.delete("/backups/destinations/:id", async (req, res) => {
  const id = String(req.params.id);
  const inUse = await controlPrisma.orgBackupPolicy.count({ where: { destinationId: id } });
  if (inUse > 0) throw new AppError(409, `${inUse} backup polic${inUse === 1 ? "y is" : "ies are"} still pointed at this destination. Repoint them first.`);
  await controlPrisma.backupDestination.delete({ where: { id } }).catch(() => {
    throw new AppError(404, "Destination not found");
  });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "backup.destination_deleted", "BackupDestination", id);
  res.status(204).send();
});

const policyBody = z
  .object({
    enabled: z.boolean().optional(),
    frequency: z.enum(["NONE", "WEEKLY", "DAILY", "HOURLY"]).optional(),
    hourUtc: z.number().int().min(0).max(23).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    destinationId: z.string().nullable().optional(),
    retentionMode: z.enum(["COUNT", "AGE", "GFS"]).optional(),
    keepCount: z.number().int().min(1).max(500).optional(),
    keepDays: z.number().int().min(1).max(3650).optional(),
    gfsDaily: z.number().int().min(0).max(60).optional(),
    gfsWeekly: z.number().int().min(0).max(52).optional(),
    gfsMonthly: z.number().int().min(0).max(120).optional(),
    gfsYearly: z.number().int().min(0).max(20).optional(),
    alertEmails: z.string().max(1000).nullable().optional(),
    alertWebhook: z.string().max(2000).nullable().optional(),
    alertOnSuccess: z.boolean().optional(),
    alertOnFailure: z.boolean().optional()
  })
  .strict();

platformAdminConsoleRouter.put("/backups/policy/:orgId", validate(z.object({ params: z.object({ orgId: z.string() }), body: policyBody })), async (req, res) => {
  const orgId = String(req.params.orgId);
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new AppError(404, "Organization not found");

  const entitlement = await backupEntitlement(org);
  const wanted = (req.body.frequency ?? "NONE") as BackupFrequency;
  // The tier is a ceiling and the API says so plainly rather than silently downgrading a save — an
  // operator who asked for hourly deserves to be told why they did not get it.
  if (req.body.frequency && !backupFrequencyAllowed(wanted, entitlement.frequency)) {
    throw new AppError(
      403,
      `${org.slug} is on ${entitlement.tier}, which allows ${BACKUP_FREQUENCY_LABEL[entitlement.frequency].toLowerCase()} at most. Raise the plan tier to schedule ${BACKUP_FREQUENCY_LABEL[wanted].toLowerCase()}.`
    );
  }
  if (req.body.enabled && entitlement.frequency === "NONE") {
    throw new AppError(403, `The ${entitlement.tier} plan does not include managed backups.`);
  }
  if (req.body.destinationId) {
    const dest = await controlPrisma.backupDestination.findUnique({ where: { id: req.body.destinationId } });
    if (!dest) throw new AppError(404, "Destination not found");
    // A workspace-owned destination belongs to that workspace alone.
    if (dest.organizationId && dest.organizationId !== orgId) throw new AppError(403, `"${dest.name}" belongs to a different workspace.`);
  }

  const existing = await controlPrisma.orgBackupPolicy.findUnique({ where: { organizationId: orgId } });
  const merged = {
    enabled: req.body.enabled ?? existing?.enabled ?? false,
    frequency: (req.body.frequency ?? existing?.frequency ?? "NONE") as BackupFrequency,
    hourUtc: req.body.hourUtc ?? existing?.hourUtc ?? 2,
    dayOfWeek: req.body.dayOfWeek ?? existing?.dayOfWeek ?? 0
  };
  const webhookData =
    req.body.alertWebhook === undefined
      ? {}
      : { encryptedAlertWebhook: req.body.alertWebhook ? encryptSecret(req.body.alertWebhook) : null };

  const data = {
    ...merged,
    destinationId: req.body.destinationId !== undefined ? req.body.destinationId : (existing?.destinationId ?? null),
    retentionMode: req.body.retentionMode ?? existing?.retentionMode ?? "COUNT",
    keepCount: req.body.keepCount ?? existing?.keepCount ?? 7,
    keepDays: req.body.keepDays ?? existing?.keepDays ?? 30,
    gfsDaily: req.body.gfsDaily ?? existing?.gfsDaily ?? 7,
    gfsWeekly: req.body.gfsWeekly ?? existing?.gfsWeekly ?? 4,
    gfsMonthly: req.body.gfsMonthly ?? existing?.gfsMonthly ?? 12,
    gfsYearly: req.body.gfsYearly ?? existing?.gfsYearly ?? 3,
    alertEmails: req.body.alertEmails !== undefined ? req.body.alertEmails : (existing?.alertEmails ?? null),
    alertOnSuccess: req.body.alertOnSuccess ?? existing?.alertOnSuccess ?? false,
    alertOnFailure: req.body.alertOnFailure ?? existing?.alertOnFailure ?? true,
    nextRunAt: merged.enabled ? nextRunAt(merged, new Date()) : null,
    ...webhookData
  };

  const row = await controlPrisma.orgBackupPolicy.upsert({ where: { organizationId: orgId }, update: data, create: { organizationId: orgId, ...data } });
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "backup.policy_updated", "Organization", orgId, { slug: org.slug, enabled: row.enabled, frequency: row.frequency });
  res.json({ id: row.id, nextRunAt: row.nextRunAt });
});

/** What the retention rules WOULD keep and drop, against the runs that exist. No writes. */
platformAdminConsoleRouter.get("/backups/policy/:orgId/retention-preview", async (req, res) => {
  const policy = await controlPrisma.orgBackupPolicy.findUnique({ where: { organizationId: String(req.params.orgId) } });
  if (!policy) throw new AppError(404, "This workspace has no backup policy yet.");
  const runs = await controlPrisma.backupRun.findMany({
    where: { organizationId: String(req.params.orgId), status: "SUCCEEDED", objectKey: { not: null } },
    select: { id: true, startedAt: true, objectKey: true },
    orderBy: { startedAt: "desc" }
  });
  const decision = planRetention(runs, policy);
  res.json({
    total: runs.length,
    keep: decision.keep,
    drop: decision.drop.map((r) => ({ id: r.id, startedAt: r.startedAt, objectKey: r.objectKey }))
  });
});

platformAdminConsoleRouter.post("/backups/run/:orgId", validate(z.object({ params: z.object({ orgId: z.string() }), body: z.object({ destinationId: z.string().optional() }).strict().optional() })), async (req, res) => {
  const result = await runBackup(String(req.params.orgId), { kind: "MANUAL", actorLabel: actorLabel(req), destinationId: req.body?.destinationId });
  if (result.status === "FAILED") throw new AppError(502, result.message);
  res.json(result);
});

platformAdminConsoleRouter.post("/backups/sweep/:orgId", async (req, res) => {
  const policy = await controlPrisma.orgBackupPolicy.findUnique({ where: { organizationId: String(req.params.orgId) } });
  if (!policy) throw new AppError(404, "This workspace has no backup policy yet.");
  res.json(await sweepRetention(String(req.params.orgId), policy.id));
});

platformAdminConsoleRouter.post("/backups/runs/:runId/test-restore", async (req, res) => {
  const result = await testRestore(String(req.params.runId), actorLabel(req));
  if (!result.ok) throw new AppError(502, result.message);
  res.json(result);
});

platformAdminConsoleRouter.post("/backups/tick", validate(z.object({ body: z.object({ dryRun: z.boolean().optional() }).strict().optional() })), async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const result = await runBackupTick(new Date(), { dryRun, actorLabel: actorLabel(req) });
  if (!dryRun) await platformAudit("PLATFORM_ADMIN", actorLabel(req), "backup.tick_run", "PlatformRetentionSettings", "global", { ran: result.ran.length });
  res.json(result);
});

/* ================================== Snapshots ==================================== */

/* ============================ Pre-deletion snapshots ============================ */

/**
 * The snapshots the retention programme takes before it drops a workspace. See
 * `services/platform-backup.service.ts` for the safety rules — in particular that a restore can
 * never overwrite a workspace that still has a database.
 */
platformAdminConsoleRouter.get("/backups", async (_req, res) => {
  res.json(await listSnapshots());
});

/** Streams one snapshot to the operator. `Content-Disposition: attachment` so a browser saves the
 *  file rather than trying to render several hundred megabytes of SQL. */
platformAdminConsoleRouter.get("/backups/:id/download", async (req, res) => {
  const id = String(req.params.id);
  const { full, bytes } = await snapshotPath(id);
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "backup.snapshot_downloaded", "Snapshot", id, { bytes });
  res.setHeader("Content-Type", "application/sql");
  res.setHeader("Content-Length", String(bytes));
  // The id is validated against the directory listing before it reaches here, so it cannot carry a
  // path — but it is still quoted, because a filename is attacker-adjacent input by definition.
  res.setHeader("Content-Disposition", `attachment; filename="${id.replace(/"/g, "")}"`);
  createReadStream(full).pipe(res);
});

platformAdminConsoleRouter.post(
  "/backups/:id/restore",
  validate(z.object({ params: z.object({ id: z.string() }), body: z.object({ organizationId: z.string().min(1), confirmSlug: z.string().min(1) }).strict() })),
  async (req, res) => {
    res.json(await restoreSnapshot(String(req.params.id), req.body.organizationId, req.body.confirmSlug, actorLabel(req)));
  }
);

platformAdminConsoleRouter.delete("/backups/:id", async (req, res) => {
  res.json(await deleteSnapshot(String(req.params.id), actorLabel(req)));
});

/* Re-exported so the console's organizations page can show analytics for one org without a second loop. */
platformAdminConsoleRouter.get("/analytics/summary", async (_req, res) => {
  res.json(await getPlatformAnalytics());
});
