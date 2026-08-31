/**
 * The second half of the platform-admin console's API (3.12.0): the overview, platform mail
 * settings, the platform email templates with preview/test/log/resend/analytics, the trial
 * retention programme, customer feedback, the sales leads the public contact form captures
 * (4.0.0), the control-plane audit trail, and platform-admin
 * account management. Mounted at the same `/api/platform-admin` prefix as
 * `platform-admin.controller.ts`, before tenant resolution, with the same auth.
 *
 * Kept as its own router so the original file stays the org-lifecycle file it was; everything here
 * is about running the platform rather than one tenant.
 */
import { createReadStream } from "node:fs";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import {
  capturePlatformReason,
  requirePlatformAdmin,
  requirePlatformCapability,
  requirePlatformReason,
  requirePlatformRole
} from "../middleware/platform-admin-auth.js";
import { validate } from "../middleware/validate.js";
import { encryptSecret } from "../utils/encryption.js";
import { generateTempPassword, hashPassword } from "../utils/security.js";
import { sanitizeEmailHtml } from "../utils/sanitize.js";
import { platformAudit, platformAuditFor } from "../services/platform-audit.service.js";
import {
  approvePlatformAction,
  listPendingPlatformActions,
  queuePlatformAction,
  registerTwoPersonAction,
  rejectPlatformAction,
  type TwoPersonContext
} from "../services/platform-governance.service.js";
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
import { resolveSalesInbox, SALES_LEAD_STATUSES } from "../services/sales-lead.service.js";
import { captureOrgUsageSnapshots, getPlatformAnalytics } from "../services/platform-admin-analytics.service.js";
import { getBilledRevenueReconciliation, getFleetAccountHealth, getFleetUsageTrend, getOrgUsageProfile, getRevenueOverview } from "../services/platform-revenue.service.js";
import { reconcileBilledRevenue } from "../services/platform-billing-reconcile.service.js";
import { getPlatformEmailAnalytics } from "../services/platform-email-analytics.service.js";
import { deleteSnapshot, listSnapshots, restoreSnapshot, snapshotPath } from "../services/platform-backup.service.js";
import { broadcastMaintenance, getFleetMaintenance, listBroadcasts } from "../services/platform-maintenance.service.js";
import { getDatabaseMetrics, getFleetHealth, getTenantHealth } from "../services/platform-tenant-health.service.js";
import { ALERT_SEVERITIES, deliverAlertWebhook, getAlertsOverview, runAlertDigest, updateAlertSettings } from "../services/platform-alerts.service.js";
import { getFleetSchemaDrift } from "../services/tenant-schema-check.service.js";
import { getOrgTimeline } from "../services/platform-org-timeline.service.js";
import { getOrgFeatureOverrides, setOrgFeatureOverrides } from "../services/platform-feature-overrides.service.js";
import { getTenantDbTrend, runMaintenanceOperation, sampleAllTenantDatabases } from "../services/tenant-db-metrics.service.js";
import { adviseWorkspace, decideAdvice, getPlatformAiSettings, listAdvice, updatePlatformAiSettings, ADVISOR_ACTIONS } from "../services/platform-ai.service.js";
import { DESTINATION_FIELDS, describeSecret, encryptDestinationSecret, testDestination, type BackupDestinationKind, type DestinationRecord } from "../services/backup-destination.service.js";
import { backupEntitlement, nextRunAt, planRetention, runBackup, runBackupTick, sweepRetention, testRestore } from "../services/backup.service.js";
import {
  allowedBackupFrequencies,
  BACKUP_FREQUENCY_LABEL,
  backupFrequencyAllowed,
  platformCapabilities,
  platformRoles,
  platformTwoPersonActions,
  type BackupFrequency,
  type PlatformRole,
  type PlatformTwoPersonAction
} from "@timesheet/shared";

export const platformAdminConsoleRouter = Router();
/** ONE `router.use`, unlike platform-admin.controller.ts's per-route repetition, because every
 *  route on this router is authenticated — there is no `/auth/login` here to keep open. */
platformAdminConsoleRouter.use(requirePlatformAdmin);
platformAdminConsoleRouter.use(capturePlatformReason);

/*
 * The four capability gates, named once so a route reads as "who may do this" rather than as a
 * function call. See @timesheet/shared's PLATFORM_ROLE_CAPABILITIES for what each role holds and
 * why SUPPORT and BILLING are siblings rather than rungs on a ladder.
 *
 * Anything NOT carrying one of these is read-only by construction: `requirePlatformAdmin` above
 * already proved the caller is an active operator, and READ_ONLY is what an operator is before
 * anything else is granted. That is the correct default for a GET — with exactly one exception,
 * `GET /backups/:id/download`, which is marked below and explains itself there.
 */
const support = requirePlatformCapability(platformCapabilities.PLATFORM_SUPPORT);
const billing = requirePlatformCapability(platformCapabilities.PLATFORM_BILLING);
const operate = requirePlatformCapability(platformCapabilities.PLATFORM_OPERATE);
const owner = requirePlatformRole(["OWNER"]);

const actorLabel = (req: { platformAdmin?: { email: string } }) => req.platformAdmin?.email ?? "platform-admin";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Declares a two-person action once: the live route becomes "queue it", and the very same function
 * is what runs on approval.
 *
 * Written as one helper rather than a route plus a separately-registered executor because the two
 * halves drifting apart is the failure this whole mechanism cannot survive — an approval that runs
 * something subtly different from what was requested is worse than no approval at all. Here they
 * are the same closure, so they cannot.
 *
 * NOTHING BUSINESS-LEVEL IS CHECKED AT REQUEST TIME. The route's zod schema still runs (a
 * malformed body should be refused immediately, not queued), but whether the workspace exists,
 * whether the slug matches, whether the tier allows it — all of that happens inside `execute`, at
 * approval, against the database as it is then. See the service header for why.
 */
function twoPerson(action: PlatformTwoPersonAction, execute: (ctx: TwoPersonContext) => Promise<unknown>): RequestHandler {
  registerTwoPersonAction(action, execute);
  return async (req, res) => {
    const queued = await queuePlatformAction({
      action,
      route: req.originalUrl.split("?")[0],
      method: req.method,
      params: req.params as Record<string, string>,
      body: req.body,
      reason: req.platformReason!,
      requester: { id: req.platformAdmin!.id, email: req.platformAdmin!.email },
      ipAddress: req.ip
    });
    // 202, not 200: the request was accepted and nothing has happened yet, which is exactly what
    // "Accepted" means and exactly what the console has to render differently from a success.
    res.status(202).json(queued);
  };
}

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
    salesInboxAddress: row?.salesInboxAddress ?? "",
    /* The address that would actually be used, so the field's placeholder can say what "leave it
       blank" means rather than leaving the operator to guess. */
    salesInboxEffective: await resolveSalesInbox(),
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
      replyTo: z.string().max(255).optional(),
      /* Where a contact-form notification lands. Blank restores the shipped default rather than
         switching the notification off — an unreachable sales inbox loses leads silently, which is
         the one failure this whole feature exists to prevent. */
      salesInboxAddress: z.string().max(255).optional()
    })
    .strict()
});

platformAdminConsoleRouter.put("/mail-settings", operate, validate(mailSettingsSchema), async (req, res) => {
  const b = req.body;
  const passwordData = b.clearPassword ? { encryptedPassword: null } : b.password ? { encryptedPassword: encryptSecret(b.password) } : {};
  const row = await controlPrisma.platformMailSettings.upsert({
    where: { id: "global" },
    update: { host: b.host.trim() || null, port: b.port, secure: b.secure, user: b.user?.trim() || null, fromAddress: b.fromAddress?.trim() || null, replyTo: b.replyTo?.trim() || null, salesInboxAddress: b.salesInboxAddress?.trim() || null, ...passwordData },
    create: { id: "global", host: b.host.trim() || null, port: b.port, secure: b.secure, user: b.user?.trim() || null, fromAddress: b.fromAddress?.trim() || null, replyTo: b.replyTo?.trim() || null, salesInboxAddress: b.salesInboxAddress?.trim() || null, ...passwordData }
  });
  await platformAuditFor(req)("platform_mail.updated", "PlatformMailSettings", "global", { host: row.host, port: row.port, secure: row.secure });
  res.json({ ok: true, updatedAt: row.updatedAt, effective: await getPlatformTransportStatus(), salesInboxEffective: await resolveSalesInbox() });
});

platformAdminConsoleRouter.post("/mail-settings/test", support, validate(z.object({ body: z.object({ to: z.string().email() }).strict() })), async (req, res) => {
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
  operate,
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
    await platformAuditFor(req)("platform_email_template.updated", "PlatformEmailTemplate", key);
    res.json(row);
  }
);

platformAdminConsoleRouter.delete("/email-templates/:key", operate, validate(templateKeyParam), async (req, res) => {
  const key = requireKey(String(req.params.key));
  await controlPrisma.platformEmailTemplate.deleteMany({ where: { key } });
  await platformAuditFor(req)("platform_email_template.reverted", "PlatformEmailTemplate", key);
  res.status(204).send();
});

/** Render for the editor: the SAVED version by default, or an unsaved draft passed in the body. */
platformAdminConsoleRouter.post(
  "/email-templates/:key/preview",
  support,
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
  support,
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

platformAdminConsoleRouter.post("/email-log/:id/resend", support, requirePlatformReason, async (req, res) => {
  const result = await resendPlatformEmail(String(req.params.id), actorLabel(req));
  await platformAuditFor(req)("platform_email.resent", "PlatformEmailLog", String(req.params.id), { status: result.status });
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

platformAdminConsoleRouter.put("/retention/settings", operate, validate(retentionSettingsSchema), async (req, res) => {
  res.json(await updateRetentionSettings(req.body, actorLabel(req)));
});

platformAdminConsoleRouter.post("/retention/run", operate, requirePlatformReason, validate(z.object({ body: z.object({ dryRun: z.boolean().optional(), simulateNow: z.string().datetime().optional() }).strict().optional() })), async (req, res) => {
  const now = req.body?.simulateNow ? new Date(req.body.simulateNow) : new Date();
  // A simulated clock is a DRY RUN by definition. Deleting a workspace because an operator typed a
  // date in the future is not a feature anybody wants.
  const dryRun = Boolean(req.body?.dryRun) || Boolean(req.body?.simulateNow);
  const result = await runRetentionTick(now, { dryRun, actorLabel: actorLabel(req) });
  if (!dryRun) await platformAuditFor(req)("retention.tick_run", "PlatformRetentionSettings", "global", { sent: result.sent.length, deleted: result.deleted.length });
  res.json(result);
});

platformAdminConsoleRouter.post("/retention/:orgId/hold", operate, requirePlatformReason, validate(z.object({ params: z.object({ orgId: z.string() }), body: z.object({ hold: z.boolean() }).strict() })), async (req, res) => {
  res.json(await setRetentionHold(String(req.params.orgId), req.body.hold, actorLabel(req)));
});

platformAdminConsoleRouter.post("/retention/:orgId/send/:marker", support, requirePlatformReason, async (req, res) => {
  const marker = String(req.params.marker);
  if (!RETENTION_MARKER_TEMPLATE[marker]) throw new AppError(404, "Unknown retention stage");
  const result = await sendRetentionMarker(String(req.params.orgId), marker, { actorLabel: actorLabel(req), force: true });
  if (!result.ok) throw new AppError(502, `Email NOT delivered: ${result.errorMessage ?? "the relay refused it"}`);
  res.json(result);
});

/**
 * Delete a workspace and its database. The most irreversible thing this console can do, and the
 * first of the five that now needs a second signature.
 *
 * Typing the slug is still required and is still not enough on its own: a confirmation dialog
 * proves the operator meant it, and proves nothing about whether it should happen. The slug check
 * has moved INTO the executor, so it runs against the org as it is at approval time — a workspace
 * renamed between the request and the approval correctly fails to match.
 */
platformAdminConsoleRouter.post(
  "/retention/:orgId/delete",
  operate,
  requirePlatformReason,
  validate(z.object({ params: z.object({ orgId: z.string() }), body: z.object({ confirmSlug: z.string().min(1) }).strict() })),
  twoPerson(platformTwoPersonActions.RETENTION_DELETE, async (ctx) => {
    const org = await controlPrisma.organization.findUnique({ where: { id: String(ctx.params.orgId) }, select: { slug: true } });
    if (!org) throw new AppError(404, "Organization not found");
    // Typing the slug is the only confirmation a destructive console action should accept.
    if (org.slug !== String(ctx.body.confirmSlug ?? "").trim().toLowerCase()) throw new AppError(422, "The slug you typed does not match this workspace.");
    const result = await deleteWorkspaceUnderPolicy(String(ctx.params.orgId), { actorLabel: ctx.actorLabel, force: true });
    await platformAudit("PLATFORM_ADMIN", ctx.actorLabel, "retention.deleted_with_approval", "Organization", String(ctx.params.orgId), {
      slug: org.slug,
      requestedBy: ctx.requester.label
    }, { reason: ctx.reason, ipAddress: ctx.ipAddress });
    return result;
  })
);

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

/* ================================== Sales leads ================================= */

/**
 * Everything the public contact form has captured, and where each conversation got to.
 *
 * UNFILTERED AND UNPAGINATED, on purpose and for now. A lead is a rare, high-value row — a
 * deployment that takes ten a week has a busy quarter — so the whole table is a screen, and the
 * console filters by status in the browser rather than round-tripping for four rows. `take` is a
 * ceiling against a spam run, not a page size; if a deployment ever hits it, this wants the same
 * offset paging the audit trail has, not a bigger number.
 *
 * The counts are computed FROM THE SAME ROWS rather than by a second `groupBy`. Two queries against
 * a table that is being written to by a public endpoint can disagree with each other, and a KPI
 * strip whose numbers do not add up to the list underneath it is worse than no KPI strip.
 */
platformAdminConsoleRouter.get("/sales-leads", async (_req, res) => {
  const rows = await controlPrisma.salesLead.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  const counts = Object.fromEntries(SALES_LEAD_STATUSES.map((status) => [status, rows.filter((r) => r.status === status).length]));
  res.json({
    count: rows.length,
    counts,
    /** How many arrived from a personal address — shown because it is a fact about the funnel, and
     *  because somebody will eventually propose blocking them and should see the number first. */
    freeMailCount: rows.filter((r) => r.isFreeMailDomain).length,
    newThisWeek: rows.filter((r) => r.createdAt >= new Date(Date.now() - 7 * DAY_MS)).length,
    statuses: SALES_LEAD_STATUSES,
    rows
  });
});

const salesLeadPatchSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      status: z.enum(SALES_LEAD_STATUSES).optional(),
      ownerLabel: z.string().max(255).nullable().optional(),
      notes: z.string().max(8000).nullable().optional()
    })
    .strict()
});

/**
 * The pipeline half: who owns it, where it got to, and what was said. Nothing a customer submitted
 * is editable here — a lead is a record of what somebody actually wrote, and a console that can
 * rewrite it is a console whose rows cannot be trusted as evidence of anything.
 *
 * `contactedAt` is STAMPED BY THE MOVE, not typed. It is set the first time a lead leaves NEW and
 * then left alone, so "how long did we take to answer" stays answerable after the lead moves on to
 * QUALIFIED or LOST. Re-stamping it on every later transition would quietly convert the one number
 * worth measuring into "when did somebody last touch this".
 */
platformAdminConsoleRouter.patch("/sales-leads/:id", support, validate(salesLeadPatchSchema), async (req, res) => {
  const id = String(req.params.id);
  const existing = await controlPrisma.salesLead.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "That lead no longer exists.");

  const b = req.body as z.infer<typeof salesLeadPatchSchema>["body"];
  const movedOffNew = b.status !== undefined && b.status !== "NEW" && existing.status === "NEW";

  // Assembled field by field rather than as conditional spreads, because `undefined` and `null`
  // mean different things to Prisma here: a key that is absent leaves the column alone, a key set
  // to null clears it, and "clear the owner" is a thing the console has to be able to do.
  const data: { status?: string; ownerLabel?: string | null; notes?: string | null; contactedAt?: Date } = {};
  if (b.status !== undefined) data.status = b.status;
  if (b.ownerLabel !== undefined) data.ownerLabel = b.ownerLabel?.trim() || null;
  if (b.notes !== undefined) data.notes = b.notes?.trim() || null;
  if (movedOffNew && !existing.contactedAt) data.contactedAt = new Date();

  const row = await controlPrisma.salesLead.update({ where: { id }, data });

  await platformAuditFor(req)("sales_lead.updated", "SalesLead", id, {
    from: existing.status,
    to: row.status,
    ownerLabel: row.ownerLabel,
    notesChanged: b.notes !== undefined
  });
  res.json(row);
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
    select: { id: true, email: true, name: true, status: true, role: true, mfaEnabled: true, createdAt: true, lastLoginAt: true, _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } } }
  });
  res.json(
    rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      status: r.status,
      role: r.role,
      mfaEnabled: r.mfaEnabled,
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
      /** Doubles as the "who could countersign right now" signal the approval queue needs — an
       *  OWNER who last signed in in March is a name, not an approver. */
      liveSessions: r._count.sessions
    }))
  );
});

/**
 * Creating a platform admin is the console's clearest privilege escalation: the response body
 * contains a working temporary password for a brand-new account with access to every customer.
 * OWNER-only AND two-person — one operator must not be able to mint a colleague, or a sock puppet,
 * on their own.
 *
 * The role is chosen at creation but the account still starts at whatever was asked for and no
 * higher: the request is queued, so the role that lands is the one a second owner read and agreed
 * to, not one slipped in afterwards.
 */
platformAdminConsoleRouter.post(
  "/admins",
  owner,
  requirePlatformReason,
  validate(
    z.object({
      body: z.object({ email: z.string().email(), name: z.string().min(2).max(120), role: z.enum(platformRoles).default("READ_ONLY") }).strict()
    })
  ),
  twoPerson(platformTwoPersonActions.ADMIN_CREATE, async (ctx) => {
    const email = String(ctx.body.email).trim().toLowerCase();
    const existing = await controlPrisma.platformAdminUser.findUnique({ where: { email } });
    if (existing) throw new AppError(409, "A platform admin with that email already exists.");
    // Generated, never chosen: the person creating the account should never know a colleague's password.
    const password = generateTempPassword();
    /*
     * `.default("READ_ONLY")` on the schema does NOT reach here, and relying on it would be a real
     * bug: `middleware/validate.ts` parses to check the shape and THROWS AWAY the parsed value, so
     * the handler always sees the raw body. Every zod default and coercion in this codebase is
     * decorative for exactly that reason. Defaulted here instead, and re-checked against the known
     * list so an unrecognised value fails closed rather than being written to the column.
     */
    const asked = String(ctx.body.role ?? "READ_ONLY");
    const role: PlatformRole = (platformRoles as readonly string[]).includes(asked) ? (asked as PlatformRole) : "READ_ONLY";
    const row = await controlPrisma.platformAdminUser.create({
      data: { email, name: String(ctx.body.name).trim(), role, passwordHash: await hashPassword(password), status: "ACTIVE" }
    });
    await platformAudit("PLATFORM_ADMIN", ctx.actorLabel, "platform_admin.created", "PlatformAdminUser", row.id, { email, role, requestedBy: ctx.requester.label }, {
      reason: ctx.reason,
      ipAddress: ctx.ipAddress,
      after: { email, role, status: "ACTIVE" }
    });
    /** The temporary password comes back to whoever APPROVED it, once. That is a change of
     *  recipient from the pre-5.0.0 behaviour and it is the correct one: the approver is the last
     *  person to make a decision here, and they can hand it to the new operator directly. */
    return { id: row.id, email: row.email, name: row.name, role: row.role, temporaryPassword: password };
  })
);

const adminRoleChangeRoute = twoPerson(platformTwoPersonActions.ADMIN_ROLE_CHANGE, async (ctx) => {
  const id = String(ctx.params.id);
  const target = await controlPrisma.platformAdminUser.findUnique({ where: { id } });
  if (!target) throw new AppError(404, "Not found");

  const asked = String(ctx.body.role ?? "");
  if (!(platformRoles as readonly string[]).includes(asked)) throw new AppError(422, `"${asked}" is not a platform role.`);
  const role = asked as PlatformRole;
  /*
   * RE-VALIDATED AT APPROVAL, NOT AT REQUEST. Between the two, somebody else may have demoted the
   * last remaining owner — and this is the check that would then correctly refuse. A request-time
   * check would have passed and a stored decision would have gone through.
   */
  if (target.role === "OWNER" && role !== "OWNER") {
    const owners = await controlPrisma.platformAdminUser.count({ where: { status: "ACTIVE", role: "OWNER" } });
    if (owners <= 1) throw new AppError(409, "That is the last active owner. Promote somebody else first — a platform with no owner cannot grant anybody anything.");
  }

  const row = await controlPrisma.platformAdminUser.update({ where: { id }, data: { role } });
  await platformAudit("PLATFORM_ADMIN", ctx.actorLabel, "platform_admin.role_changed", "PlatformAdminUser", id, {
    email: row.email,
    from: target.role,
    to: row.role,
    requestedBy: ctx.requester.label
  }, { reason: ctx.reason, ipAddress: ctx.ipAddress, before: { role: target.role }, after: { role: row.role } });
  return { id: row.id, role: row.role, status: row.status };
});

/**
 * Two different authorities behind one PATCH, split on purpose.
 *
 * A ROLE CHANGE IS TWO-PERSON. Promoting somebody to OWNER hands them everything including the
 * ability to promote others, and an operator who can do that alone has a one-step path from
 * READ_ONLY-for-everyone to a second account that owns the platform.
 *
 * A STATUS CHANGE IS NOT, and that is deliberate rather than an omission. Deactivating an account
 * is how a compromised credential gets cut off, and it is reversible. Making the emergency
 * response wait for a colleague to wake up would mean an attacker keeps their session for as long
 * as the second operator takes to answer their phone — the two-person rule would be protecting the
 * attacker. It stays OWNER-only and immediate.
 */
platformAdminConsoleRouter.patch(
  "/admins/:id",
  owner,
  requirePlatformReason,
  validate(
    z.object({
      params: z.object({ id: z.string() }),
      body: z.object({ status: z.enum(["ACTIVE", "INACTIVE"]).optional(), role: z.enum(platformRoles).optional() }).strict()
    })
  ),
  async (req, res, next) => {
    // A role change (with or without a status change alongside it) goes to the queue; a
    // status-only change runs now. Routed here rather than on two separate paths so the console
    // keeps one endpoint and the decision lives beside the reasoning above.
    if (req.body.role !== undefined) return adminRoleChangeRoute(req, res, next);

    const id = String(req.params.id);
    if (req.body.status === undefined) throw new AppError(422, "Nothing to change — send a status, a role, or both.");
    if (id === req.platformAdmin!.id && req.body.status === "INACTIVE") throw new AppError(409, "You cannot deactivate the account you are signed in with.");
    const active = await controlPrisma.platformAdminUser.count({ where: { status: "ACTIVE" } });
    const target = await controlPrisma.platformAdminUser.findUnique({ where: { id } });
    if (!target) throw new AppError(404, "Not found");
    if (req.body.status === "INACTIVE" && target.status === "ACTIVE" && active <= 1) throw new AppError(409, "That is the last active platform admin. Create another one first.");
    const row = await controlPrisma.platformAdminUser.update({ where: { id }, data: { status: req.body.status } });
    if (req.body.status === "INACTIVE") await controlPrisma.platformAdminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await platformAuditFor(req)(`platform_admin.${req.body.status.toLowerCase()}`, "PlatformAdminUser", id, { email: row.email }, {
      before: { status: target.status },
      after: { status: row.status }
    });
    res.json({ id: row.id, status: row.status, role: row.role });
  }
);


/* ============================== The approval queue ============================== */

/**
 * Everyone can SEE the queue — a pending deletion of a customer's workspace is not a secret from
 * the operators who work on it, and hiding it would mean the person best placed to say "wait, no"
 * never learns it was asked.
 */
platformAdminConsoleRouter.get("/governance/requests", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ rows: await listPendingPlatformActions(req.platformAdmin!.id, limit) });
});

/** Only an OWNER may countersign, and never their own request — the service enforces the second
 *  half, because a role check cannot see who asked. */
platformAdminConsoleRouter.post("/governance/requests/:id/approve", owner, async (req, res) => {
  res.json(await approvePlatformAction(String(req.params.id), { id: req.platformAdmin!.id, email: req.platformAdmin!.email }, { ipAddress: req.ip }));
});

/**
 * Saying no. Open to any operator who could have approved it AND to the person who raised it —
 * withdrawing your own request is not an exercise of authority, and needing to find an owner to
 * un-ask a question is how a queue fills up with things nobody meant.
 */
platformAdminConsoleRouter.post(
  "/governance/requests/:id/reject",
  validate(z.object({ params: z.object({ id: z.string() }), body: z.object({ note: z.string().min(1).max(500) }).strict() })),
  async (req, res) => {
    const row = await controlPrisma.pendingPlatformAction.findUnique({ where: { id: String(req.params.id) }, select: { requestedById: true } });
    if (!row) throw new AppError(404, "That request no longer exists.");
    if (row.requestedById !== req.platformAdmin!.id && req.platformAdmin!.role !== "OWNER") {
      throw new AppError(403, "Only an OWNER can refuse somebody else's request. You can withdraw your own.");
    }
    res.json(await rejectPlatformAction(String(req.params.id), { id: req.platformAdmin!.id, email: req.platformAdmin!.email }, req.body.note));
  }
);

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
  await platformAuditFor(req)("platform_admin.sessions_revoked", "PlatformAdminUser", req.platformAdmin!.id, { count: result.count });
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

platformAdminConsoleRouter.post("/maintenance/broadcast", operate, requirePlatformReason, validate(broadcastSchema), async (req, res) => {
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
platformAdminConsoleRouter.post("/monitoring/sample", operate, async (req, res) => {
  const result = await sampleAllTenantDatabases();
  // `platformAudit`, not the tenant `audit`: this touched every workspace and belongs to none of
  // them, so it goes in the control plane's own trail where the operator's other actions are.
  await platformAuditFor(req)("tenant_db.sampled", "Organization", undefined, {
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
platformAdminConsoleRouter.post("/monitoring/:orgId/operation", operate, requirePlatformReason, validate(operationSchema), async (req, res) => {
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

platformAdminConsoleRouter.put("/ai/settings", operate, validate(aiSettingsSchema), async (req, res) => {
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
platformAdminConsoleRouter.post("/ai/advise/:orgId", support, async (req, res) => {
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

platformAdminConsoleRouter.post("/ai/advice/:adviceId/decision", support, validate(decisionSchema), async (req, res) => {
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

platformAdminConsoleRouter.post("/backups/destinations", operate, validate(z.object({ body: destinationBody.strict() })), async (req, res) => {
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
  await platformAuditFor(req)("backup.destination_created", "BackupDestination", row.id, { name: row.name, kind: row.kind });
  res.status(201).json({ id: row.id });
});

platformAdminConsoleRouter.patch(
  "/backups/destinations/:id",
  operate,
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
    await platformAuditFor(req)("backup.destination_updated", "BackupDestination", row.id, { name: row.name });
    res.json({ id: row.id });
  }
);

platformAdminConsoleRouter.post("/backups/destinations/:id/test", operate, async (req, res) => {
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

platformAdminConsoleRouter.delete("/backups/destinations/:id", operate, async (req, res) => {
  const id = String(req.params.id);
  const inUse = await controlPrisma.orgBackupPolicy.count({ where: { destinationId: id } });
  if (inUse > 0) throw new AppError(409, `${inUse} backup polic${inUse === 1 ? "y is" : "ies are"} still pointed at this destination. Repoint them first.`);
  await controlPrisma.backupDestination.delete({ where: { id } }).catch(() => {
    throw new AppError(404, "Destination not found");
  });
  await platformAuditFor(req)("backup.destination_deleted", "BackupDestination", id);
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

platformAdminConsoleRouter.put("/backups/policy/:orgId", billing, validate(z.object({ params: z.object({ orgId: z.string() }), body: policyBody })), async (req, res) => {
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
  await platformAuditFor(req)("backup.policy_updated", "Organization", orgId, { slug: org.slug, enabled: row.enabled, frequency: row.frequency });
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

platformAdminConsoleRouter.post("/backups/run/:orgId", operate, requirePlatformReason, validate(z.object({ params: z.object({ orgId: z.string() }), body: z.object({ destinationId: z.string().optional() }).strict().optional() })), async (req, res) => {
  const result = await runBackup(String(req.params.orgId), { kind: "MANUAL", actorLabel: actorLabel(req), destinationId: req.body?.destinationId });
  if (result.status === "FAILED") throw new AppError(502, result.message);
  res.json(result);
});

platformAdminConsoleRouter.post("/backups/sweep/:orgId", operate, requirePlatformReason, async (req, res) => {
  const policy = await controlPrisma.orgBackupPolicy.findUnique({ where: { organizationId: String(req.params.orgId) } });
  if (!policy) throw new AppError(404, "This workspace has no backup policy yet.");
  const result = await sweepRetention(String(req.params.orgId), policy.id);
  // A sweep DELETES backups, and until 5.0.0 it left no trace of having done so — the one class of
  // action where "we cannot tell whether this ran" and "we cannot tell what it destroyed" are the
  // same sentence.
  await platformAuditFor(req)("backup.swept", "Organization", String(req.params.orgId), result as unknown as Record<string, unknown>);
  res.json(result);
});

platformAdminConsoleRouter.post("/backups/runs/:runId/test-restore", operate, async (req, res) => {
  const result = await testRestore(String(req.params.runId), actorLabel(req));
  if (!result.ok) throw new AppError(502, result.message);
  res.json(result);
});

platformAdminConsoleRouter.post("/backups/tick", operate, validate(z.object({ body: z.object({ dryRun: z.boolean().optional() }).strict().optional() })), async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const result = await runBackupTick(new Date(), { dryRun, actorLabel: actorLabel(req) });
  if (!dryRun) await platformAuditFor(req)("backup.tick_run", "PlatformRetentionSettings", "global", { ran: result.ran.length });
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

/**
 * Streams one snapshot to the operator. `Content-Disposition: attachment` so a browser saves the
 * file rather than trying to render several hundred megabytes of SQL.
 *
 * THE ONE GET IN THIS FILE THAT IS NOT READ-ONLY, AND THE MOST IMPORTANT GUARD IN IT.
 *
 * Every other GET here returns a summary, a count, a status. This one returns an entire customer's
 * database as SQL — every user, every timesheet, every ticket, every attachment path, in plain
 * text, down a browser. It is by a wide margin the largest exfiltration surface in the console, and
 * its verb disguises that completely: "it's a GET, so READ_ONLY should have it" is the reasonable
 * inference and it is catastrophically wrong. OPERATOR/OWNER only, and it demands a reason like
 * every other action that touches a customer, because "who pulled a copy of Acme's database, and
 * why" is precisely the question this row will be asked.
 */
platformAdminConsoleRouter.get("/backups/:id/download", operate, requirePlatformReason, async (req, res) => {
  const id = String(req.params.id);
  const { full, bytes } = await snapshotPath(id);
  await platformAuditFor(req)("backup.snapshot_downloaded", "Snapshot", id, { bytes });
  res.setHeader("Content-Type", "application/sql");
  res.setHeader("Content-Length", String(bytes));
  // The id is validated against the directory listing before it reaches here, so it cannot carry a
  // path — but it is still quoted, because a filename is attacker-adjacent input by definition.
  res.setHeader("Content-Disposition", `attachment; filename="${id.replace(/"/g, "")}"`);
  createReadStream(full).pipe(res);
});

/**
 * Restoring a snapshot writes a whole database over a workspace. There is no undo and no second
 * copy of what was there a moment before — two-person, like the deletion it mirrors.
 *
 * The service's own safety rules (it refuses to overwrite a workspace that still has a database,
 * and it checks the typed slug) all run inside the executor, at approval time, against the world
 * as it is then.
 */
platformAdminConsoleRouter.post(
  "/backups/:id/restore",
  operate,
  requirePlatformReason,
  validate(z.object({ params: z.object({ id: z.string() }), body: z.object({ organizationId: z.string().min(1), confirmSlug: z.string().min(1) }).strict() })),
  twoPerson(platformTwoPersonActions.SNAPSHOT_RESTORE, async (ctx) => {
    const result = await restoreSnapshot(String(ctx.params.id), String(ctx.body.organizationId), String(ctx.body.confirmSlug), ctx.actorLabel);
    await platformAudit("PLATFORM_ADMIN", ctx.actorLabel, "backup.snapshot_restored_with_approval", "Snapshot", String(ctx.params.id), {
      organizationId: ctx.body.organizationId,
      requestedBy: ctx.requester.label
    }, { reason: ctx.reason, ipAddress: ctx.ipAddress });
    return result;
  })
);

/** Deleting a snapshot destroys the last copy of a workspace that may already be gone — the thing
 *  a restore would have needed. Two-person for the same reason the restore is. */
platformAdminConsoleRouter.delete(
  "/backups/:id",
  operate,
  requirePlatformReason,
  twoPerson(platformTwoPersonActions.SNAPSHOT_DELETE, async (ctx) => {
    const result = await deleteSnapshot(String(ctx.params.id), ctx.actorLabel);
    await platformAudit("PLATFORM_ADMIN", ctx.actorLabel, "backup.snapshot_deleted_with_approval", "Snapshot", String(ctx.params.id), {
      requestedBy: ctx.requester.label
    }, { reason: ctx.reason, ipAddress: ctx.ipAddress });
    return result;
  })
);

/* Re-exported so the console's organizations page can show analytics for one org without a second loop. */
platformAdminConsoleRouter.get("/analytics/summary", async (_req, res) => {
  res.json(await getPlatformAnalytics());
});

/* ============================= Revenue, health and snapshots ============================ */

/*
 * All READS, on `platform:read` — which is what every operator holds, and correctly so: a revenue
 * or health number is aggregate, carries no customer content, and an operator who cannot see the
 * business cannot run it. There are exactly TWO writes, and they carry different capabilities on
 * purpose: triggering the usage sweep by hand is `platform:operate`, for the same reason `POST
 * /monitoring/sample` is — it opens a connection to every tenant database in the fleet, which is a
 * load decision rather than a reporting one. Reconciling against Stripe is `platform:billing`,
 * because it spends our payment processor's quota and what it fetches is money.
 *
 * EDITING A LIST PRICE IS NOT HERE. It is a field on `PATCH /plan-tier-limits/:tier` in
 * platform-admin.controller.ts, already gated on `platform:billing` — money belongs to the finance
 * role, and putting a second price-editing route on this router would be a second gate to keep in
 * step with the first.
 */

/** `days` is the churn/retention comparison window. Clamped rather than validated into an error:
 *  an operator typing 5000 into a query string wants "as much as you have", not a 400. */
const windowDays = (raw: unknown, fallback: number, max = 365): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.round(parsed), max) : fallback;
};

/**
 * MRR, ARR, ARPA, revenue by tier, churn, NRR, trial conversion and the signup cohort table.
 *
 * EVERY FIGURE IS LIST PRICE. The payload carries `basis: "list-price"` and the console labels it,
 * because a list-price MRR is not billed revenue: a discounted, annual or negotiated customer pays
 * something else. Reads the nightly snapshots only — no tenant database is opened.
 */
platformAdminConsoleRouter.get("/analytics/revenue", async (req, res) => {
  res.json(await getRevenueOverview(windowDays(req.query.days, 30)));
});

/** Per-workspace account health, each band carrying the signal that produced it, plus the seat
 *  overage list — the workspaces at or above 90% of a real seat ceiling. */
platformAdminConsoleRouter.get("/analytics/health", async (req, res) => {
  res.json(await getFleetAccountHealth(windowDays(req.query.days, 30)));
});

/** Seats, tickets and AI spend across the whole fleet, per day. The chart the console could not
 *  draw before there was a history to draw it from. */
platformAdminConsoleRouter.get("/analytics/usage-trend", async (req, res) => {
  res.json({ points: await getFleetUsageTrend(windowDays(req.query.days, 90, 1100)) });
});

/** One workspace's usage series, health and list MRR — the usage half of the Org 360 page. The
 *  other halves (identity, plan, database trend, backups, emails, audit, AI advice) are the
 *  endpoints that already exist; that page COMPOSES them rather than replacing them. */
platformAdminConsoleRouter.get("/analytics/org/:orgId", async (req, res) => {
  res.json(await getOrgUsageProfile(req.params.orgId, windowDays(req.query.days, 60)));
});

/**
 * Take today's snapshot now rather than waiting for 03:40 UTC.
 *
 * `platform:operate`, matching `POST /monitoring/sample`: this opens a connection to every tenant
 * database in the fleet. Safe to run twice — the pass upserts on (organizationId, day), so a
 * second run of the same day corrects the row instead of appending one and doubling every fleet
 * total that sums it.
 */
platformAdminConsoleRouter.post("/analytics/snapshot", operate, async (req, res) => {
  const result = await captureOrgUsageSnapshots();
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "usage_snapshot.captured", "Organization", null, {
    captured: result.captured,
    failed: result.failed.length,
    prunedRows: result.prunedRows
  });
  res.json(result);
});

/**
 * The stored billed-revenue reconciliation on its own — list against billed, and the gap.
 *
 * `platform:read`, like every other figure on that screen: it is an aggregate about our own
 * business with no customer content in it, and an operator who cannot see the discounting cannot
 * argue about it. Null when Stripe is not configured, which is the common deployment and not an
 * error — the console renders no card at all rather than a zero.
 *
 * A SEPARATE ROUTE FROM `/analytics/revenue`, which already carries the same object, because the
 * console refetches JUST this card after a reconcile. Re-running the whole revenue overview — a
 * cohort table, a churn window and a fleet scan — to refresh three numbers would be the expensive
 * half of the page paying for the cheap half.
 */
platformAdminConsoleRouter.get("/analytics/billed-revenue", async (_req, res) => {
  res.json(await getBilledRevenueReconciliation());
});

/**
 * Reconcile against Stripe NOW rather than waiting for 03:50 UTC.
 *
 * `platform:billing`, and this is the one route on this screen that is not `platform:read`. It is
 * the only action in the console that spends our Stripe API quota, and what it fetches is money —
 * the same reasoning that puts `PATCH /plan-tier-limits/:tier` (the LIST price) on the finance
 * role. Note the deliberate difference from `POST /analytics/snapshot` above, which is
 * `platform:operate`: that one opens a connection to every tenant database, which is a load
 * decision an on-call operator makes. This one talks to our payment processor.
 *
 * Safe to run twice — each pass overwrites the same columns per workspace — and one workspace's
 * failure is recorded against that workspace rather than aborting the sweep.
 */
platformAdminConsoleRouter.post("/analytics/reconcile-billing", billing, async (req, res) => {
  const result = await reconcileBilledRevenue();
  await platformAudit("PLATFORM_ADMIN", actorLabel(req), "billed_revenue.reconciled", "Organization", null, {
    configured: result.configured,
    attempted: result.attempted,
    reconciled: result.reconciled,
    // The failing workspaces by SLUG, not just a count: the audit row is where somebody looks to
    // find out which customer's billing has been unreadable for a week.
    failed: result.failed.map((entry) => entry.slug)
  });
  res.json(result);
});

/* ========================= Fleet alerts, and how they leave =========================== */

/**
 * WHY THERE IS A PAGE FOR THIS AT ALL (5.0.0). `deriveAlerts` has computed real fleet alerts since
 * 4.0.0 and every one of them existed only while somebody had the Monitoring page open. These four
 * routes are the delivery: what is wrong right now, where those should go, and a way to prove the
 * pipe works without waiting six hours for the worker to prove it for you.
 */

/**
 * Everything the Alerts page shows, in ONE read: the live sweep, the delivery settings, and how
 * long each open condition has been standing.
 *
 * `platform:read`. Every figure is an operational aggregate about our own fleet and carries no
 * customer content — and an operator who cannot see what is broken cannot be on call for it. The
 * settings are visible to READ_ONLY for the same reason a firewall rule is: knowing where alerts go
 * is not the same as being able to change it, and the write below is `platform:operate`.
 */
platformAdminConsoleRouter.get("/alerts", async (_req, res) => {
  res.json(await getAlertsOverview());
});

const alertSettingsSchema = z.object({
  body: z
    .object({
      digestEnabled: z.boolean(),
      minSeverity: z.enum(ALERT_SEVERITIES),
      /** Empty means "every ACTIVE platform admin" — see `resolveAlertRecipients` for why that is
       *  the right default and not a convenience. */
      recipients: z.array(z.string().email().max(255)).max(25).default([]),
      webhookUrl: z.string().url().max(500).nullable().optional(),
      /** Omitted keeps the stored secret; "" clears it. Same three-state contract as every other
       *  secret field in this console, so editing a URL never silently drops the signature. */
      webhookSecret: z.string().max(255).optional()
    })
    .strict()
});

platformAdminConsoleRouter.put("/alerts/settings", operate, validate(alertSettingsSchema), async (req, res) => {
  res.json(
    await updateAlertSettings({
      digestEnabled: Boolean(req.body.digestEnabled),
      minSeverity: String(req.body.minSeverity),
      recipients: (req.body.recipients ?? []) as string[],
      webhookUrl: (req.body.webhookUrl ?? null) as string | null,
      webhookSecret: req.body.webhookSecret,
      actorLabel: actorLabel(req),
      reason: req.platformReason
    })
  );
});

/**
 * Run a digest pass now.
 *
 * `dryRun: true` is the console's Preview: it sweeps and diffs and reports what WOULD go out
 * without sending anything and without recording anything, which is what makes it safe to press
 * repeatedly. A real run spends the one chance to say each thing, so it is `platform:operate` —
 * the same reasoning as `POST /monitoring/sample`, plus the fact that it mails people.
 */
platformAdminConsoleRouter.post("/alerts/digest/run", operate, async (req, res) => {
  res.json(await runAlertDigest({ dryRun: Boolean(req.body?.dryRun), actorLabel: actorLabel(req) }));
});

/**
 * Prove the webhook works, with a payload shaped exactly like a real digest and marked `test: true`.
 *
 * The alternative — waiting for something to break to find out whether the alert about it can be
 * delivered — is how an alerting pipeline turns out to have been broken for a month.
 */
platformAdminConsoleRouter.post("/alerts/webhook/test", operate, async (req, res) => {
  const outcome = await deliverAlertWebhook({
    event: "platform.alert_digest",
    test: true,
    deliveredAt: new Date().toISOString(),
    totals: { critical: 0, warning: 0, info: 0, workspaces: 0 },
    appeared: [
      {
        slug: "example",
        name: "Example workspace",
        key: "test.ping",
        severity: "info",
        title: "Test alert",
        detail: "Sent from the console to prove this endpoint is reachable."
      }
    ],
    escalated: [],
    cleared: []
  });
  await platformAuditFor(req)("platform_alerts.webhook_tested", "PlatformAlertSettings", "global", { status: outcome.status });
  // 200 either way: "not configured" and "the endpoint answered 404" are both ANSWERS the operator
  // needs to read, not failures of this request.
  res.json(outcome);
});

/* ============================== Fleet schema drift ============================== */

/**
 * Which tenants are on which migration, and which are behind the code that is running.
 *
 * READ-ONLY, AND THERE IS DELIBERATELY NO BUTTON. The fix is a fan-out that opens, migrates and
 * closes every tenant database in turn, and it can fail on any one of them. That wants a terminal
 * with a human watching, not a browser tab that times out at thirty seconds and leaves the operator
 * guessing which half of the fleet moved. The response carries the exact command instead, and the
 * page prints it.
 *
 * MOUNTED AT `/fleet/schema-drift` RATHER THAN `/monitoring/schema-drift` on purpose: the latter
 * would be matched by `GET /monitoring/:orgId` with `orgId = "schema-drift"` unless this route were
 * registered first, and a route whose correctness depends on the order two lines appear in is a
 * trap for whoever tidies this file next.
 */
platformAdminConsoleRouter.get("/fleet/schema-drift", async (_req, res) => {
  res.json(await getFleetSchemaDrift());
});

/* ============================== Org 360 extras ============================== */

/**
 * One workspace's incident timeline — the audit trail, backup runs, alert conditions coming and
 * going, maintenance broadcasts and failed platform email, merged and sorted.
 *
 * Composed from rows that already exist; nothing here measures anything new. See the service for
 * why the merge lives on the server rather than in the page.
 */
platformAdminConsoleRouter.get("/organizations/:orgId/timeline", async (req, res) => {
  res.json(await getOrgTimeline(String(req.params.orgId), windowDays(req.query.days, 90)));
});

/** What this workspace has been given or held back, and what each override DOES against its tier. */
platformAdminConsoleRouter.get("/organizations/:orgId/feature-overrides", async (req, res) => {
  res.json(await getOrgFeatureOverrides(String(req.params.orgId)));
});

const featureOverrideSchema = z.object({
  body: z
    .object({
      /**
       * Replace, not merge — `{}` clears every override. See the service for why merging leaves
       * keys nobody can see and therefore nobody can remove.
       *
       * THIS SCHEMA CHECKS SHAPE ONLY: is the value a boolean or a number. Whether a number is
       * negative, fractional or absurd is decided ONE layer down, by `validateOverrideInput` in
       * utils/feature-overrides.ts, and deliberately not here as well. A quota is now settable from
       * the console, so its refusal has to be a sentence naming the key rather than a generic
       * "invalid body" — and a rule written in two places is a rule that eventually disagrees with
       * itself about which value was allowed. The allowlist of KEYS is the same story: it lives in
       * that util, so a key this schema has never heard of is dropped there rather than rejected
       * here.
       */
      overrides: z.record(z.string().max(64), z.union([z.boolean(), z.number()])).default({}),
      /** Required only when something is being GRANTED beyond the plan. The service names which. */
      acknowledgeGrants: z.boolean().default(false)
    })
    .strict()
});

/**
 * `platform:operate`, plus a reason.
 *
 * NOT `platform:billing`, despite touching entitlements, and the distinction is the one this
 * console draws everywhere else: BILLING moves a workspace between PLANS, which changes what the
 * customer pays. An override changes nothing anybody pays — it is a deployment-level exception a
 * platform operator makes and answers for, and it is the on-call role that grants a design partner
 * a beta at four in the afternoon.
 *
 * A WRITTEN REASON is demanded at the door, because this acts on a customer from outside their
 * workspace — which is exactly the row a reviewer will read six months from now. (The middleware is
 * named on the registration line below rather than in this comment on purpose: the drift guard in
 * apps/web/tests/unit/platform-reason.test.ts chunks the file BETWEEN route registrations, so a
 * mention of it up here would be attributed to the GET above and invent a phantom route for the
 * console's prompt table. That test's own header warns about exactly this shape of false positive.)
 */
platformAdminConsoleRouter.put("/organizations/:orgId/feature-overrides", operate, requirePlatformReason, validate(featureOverrideSchema), async (req, res) => {
  res.json(
    await setOrgFeatureOverrides({
      orgId: String(req.params.orgId),
      overrides: req.body.overrides ?? {},
      acknowledgeGrants: Boolean(req.body.acknowledgeGrants),
      actorLabel: actorLabel(req),
      reason: req.platformReason,
      ipAddress: req.ip
    })
  );
});
