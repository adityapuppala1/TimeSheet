/**
 * WHAT: custom dashboards and the scheduled deliveries that mail them out.
 *
 * WHY A SHARED DASHBOARD IS NOT A DATA GRANT: it stores an arrangement of widgets, and every
 * widget resolves against the VIEWER's own project scope (see dashboard.service.ts). Two people
 * opening the same shared dashboard see their own permitted projects. That is what makes sharing
 * one safe to do casually — publishing a layout can never publish data.
 *
 * WHY RECIPIENTS ARE EMAIL STRINGS RATHER THAN USER IDS: the point of a scheduled report is
 * reaching a stakeholder who does not have an account. But that is also why the worker resolves
 * the widgets as the subscription's OWNER — an email address is not an identity the app can scope
 * data by, so it uses the identity of the person who set the delivery up and is accountable for
 * it. See the worker.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { resolveDashboard, WIDGET_CATALOGUE, WIDGET_TYPES } from "../services/dashboard.service.js";
import { getPlanningQuota } from "../services/plan-limits.service.js";
import { ticketProjectScope } from "../services/ticket.service.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/** The viewer's own scope, never the dashboard author's. */
async function visibleProjectIds(req: any): Promise<string[]> {
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted) return scope.projectIds;
  const all = await prisma.project.findMany({ where: { deletedAt: null }, select: { id: true } });
  return all.map((p) => p.id);
}

/** Served rather than duplicated in the client, so the builder can never offer a widget the
 *  resolver does not implement. */
dashboardRouter.get("/catalogue", (_req, res) => res.json(WIDGET_CATALOGUE));

dashboardRouter.get("/", async (req, res) => {
  const dashboards = await prisma.dashboard.findMany({
    where: { OR: [{ ownerId: req.user!.id }, { scope: "SHARED" }] },
    include: { owner: { select: { id: true, name: true } } },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }]
  });
  res.json(dashboards);
});

/** The dashboard plus its resolved data, in one request — a grid of eight tiles that each fetched
 *  separately would be eight round trips on every page load. */
dashboardRouter.get(
  "/:id/data",
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const dashboard = await prisma.dashboard.findUnique({ where: { id: String(req.params.id) } });
    if (!dashboard) throw new AppError(404, "Dashboard not found");
    if (dashboard.ownerId !== req.user!.id && dashboard.scope !== "SHARED") {
      throw new AppError(403, "That dashboard is private to someone else.");
    }

    const widgets = (dashboard.widgets as unknown as Array<{ id: string; type: never; title?: string; config?: never }>) ?? [];
    const results = await resolveDashboard({
      widgets,
      projectIds: await visibleProjectIds(req),
      viewerId: req.user!.id
    });
    res.json({ dashboard, widgets: results });
  }
);

const widgetSchema = z.object({
  id: z.string().min(1).max(60),
  type: z.enum(WIDGET_TYPES),
  title: z.string().max(120).optional(),
  config: z
    .object({ projectId: z.string().uuid().nullish(), days: z.number().int().min(7).max(365).optional() })
    .strict()
    .optional(),
  x: z.number().int().min(0).max(12).optional(),
  y: z.number().int().min(0).max(200).optional(),
  w: z.number().int().min(1).max(12).optional(),
  h: z.number().int().min(1).max(12).optional()
});

const bodySchema = z.object({
  name: z.string().min(1).max(160),
  scope: z.enum(["PERSONAL", "SHARED"]).optional(),
  isDefault: z.boolean().optional(),
  widgets: z.array(widgetSchema).max(24)
});

dashboardRouter.post("/", validate(z.object({ body: bodySchema })), async (req, res) => {
  if (req.body.scope === "SHARED" && !req.user!.permissions.includes(permissions.DASHBOARDS_SHARE)) {
    throw new AppError(403, "You can build your own dashboards, but publishing one to the workspace needs the share permission.");
  }

  // Quota counts the caller's OWN dashboards: a per-workspace cap would let one enthusiastic
  // person exhaust everyone else's allowance.
  const quota = await getPlanningQuota(requireTenantContext().orgId, "maxDashboards");
  const used = await prisma.dashboard.count({ where: { ownerId: req.user!.id } });
  if (used >= quota) {
    throw new AppError(
      403,
      quota === 0 ? "Custom dashboards are not included in this plan." : `This plan allows ${quota} dashboard(s) each.`
    );
  }

  const created = await prisma.dashboard.create({
    data: {
      ownerId: req.user!.id,
      name: req.body.name,
      scope: req.body.scope ?? "PERSONAL",
      isDefault: req.body.isDefault ?? false,
      widgets: req.body.widgets
    }
  });
  if (created.isDefault) await clearOtherDefaults(req.user!.id, created.id);
  await audit(req.user!.id, "dashboard.created", "Dashboard", created.id, { name: created.name });
  res.status(201).json(created);
});

dashboardRouter.put(
  "/:id",
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: bodySchema })),
  async (req, res) => {
    const existing = await prisma.dashboard.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, "Dashboard not found");
    // Only the owner edits — including a shared one. Anyone else who wants it different can
    // duplicate it, which leaves the original's other viewers unaffected.
    if (existing.ownerId !== req.user!.id) throw new AppError(403, "Only the person who built a dashboard can change it.");
    if (req.body.scope === "SHARED" && !req.user!.permissions.includes(permissions.DASHBOARDS_SHARE)) {
      throw new AppError(403, "Publishing a dashboard to the workspace needs the share permission.");
    }

    const updated = await prisma.dashboard.update({
      where: { id: existing.id },
      data: {
        name: req.body.name,
        scope: req.body.scope ?? existing.scope,
        isDefault: req.body.isDefault ?? existing.isDefault,
        widgets: req.body.widgets
      }
    });
    if (updated.isDefault) await clearOtherDefaults(req.user!.id, updated.id);
    res.json(updated);
  }
);

dashboardRouter.delete("/:id", validate(z.object({ params: z.object({ id: z.string().uuid() }) })), async (req, res) => {
  const existing = await prisma.dashboard.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "Dashboard not found");
  if (existing.ownerId !== req.user!.id) throw new AppError(403, "Only the person who built a dashboard can delete it.");
  await prisma.dashboard.delete({ where: { id: existing.id } });
  res.status(204).end();
});

async function clearOtherDefaults(ownerId: string, keepId: string) {
  await prisma.dashboard.updateMany({ where: { ownerId, id: { not: keepId }, isDefault: true }, data: { isDefault: false } });
}

/* ---------- Scheduled delivery ---------- */

dashboardRouter.get("/subscriptions/all", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const subscriptions = await prisma.reportSubscription.findMany({
    where: { createdById: req.user!.id },
    include: { dashboard: { select: { id: true, name: true } } },
    orderBy: { name: "asc" }
  });
  res.json(subscriptions);
});

const subscriptionSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(160),
      dashboardId: z.string().uuid(),
      cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional(),
      dayOfWeek: z.number().int().min(0).max(6).nullish(),
      dayOfMonth: z.number().int().min(1).max(28).nullish(),
      hourUtc: z.number().int().min(0).max(23).optional(),
      recipients: z.array(z.string().email()).min(1).max(50),
      isActive: z.boolean().optional()
    })
    .strict()
});

dashboardRouter.post(
  "/subscriptions",
  requirePermission(permissions.REPORTS_VIEW),
  validate(subscriptionSchema),
  async (req, res) => {
    const dashboard = await prisma.dashboard.findUnique({ where: { id: req.body.dashboardId } });
    if (!dashboard) throw new AppError(404, "Dashboard not found");
    if (dashboard.ownerId !== req.user!.id && dashboard.scope !== "SHARED") {
      throw new AppError(403, "That dashboard is private to someone else.");
    }

    const created = await prisma.reportSubscription.create({
      data: {
        name: req.body.name,
        dashboardId: req.body.dashboardId,
        cadence: req.body.cadence ?? "WEEKLY",
        // Monday by default: a weekly report that lands on a Monday morning is read; one that
        // lands on a Friday afternoon is not.
        dayOfWeek: req.body.dayOfWeek ?? 1,
        dayOfMonth: req.body.dayOfMonth ?? null,
        hourUtc: req.body.hourUtc ?? 7,
        recipients: req.body.recipients,
        format: "HTML",
        isActive: req.body.isActive ?? true,
        createdById: req.user!.id
      },
      include: { dashboard: { select: { id: true, name: true } } }
    });
    await audit(req.user!.id, "report_subscription.created", "ReportSubscription", created.id, {
      recipients: req.body.recipients.length
    });
    res.status(201).json(created);
  }
);

dashboardRouter.delete(
  "/subscriptions/:id",
  requirePermission(permissions.REPORTS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const existing = await prisma.reportSubscription.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, "Subscription not found");
    if (existing.createdById !== req.user!.id) throw new AppError(403, "Only the person who set up a delivery can remove it.");
    await prisma.reportSubscription.delete({ where: { id: existing.id } });
    res.status(204).end();
  }
);
