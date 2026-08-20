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
import { isChangeManagementOn } from "../services/change.service.js";

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

/* ------------------------------------------------------------------ *
 * The home page's month rollup
 * ------------------------------------------------------------------ *
 *
 * WHY THIS EXISTS AS A ROUTE AT ALL: the home page used to build "My projects this month" in the
 * browser, by grouping whatever `GET /timesheets` returned. That list is capped at 100 rows
 * (documented on the route and in `timesheetApi.list`), and the cap is on the WHOLE list, newest
 * first — so on a busy account the older half of the month falls off the end and the projects only
 * logged against early in the month simply vanish from the card. It looked correct in development,
 * where nobody has 100 entries, and wrong in production, where people do. Counting in SQL removes
 * both the cap and the client-side arithmetic.
 *
 * WHY IT UNIONS ASSIGNED PROJECTS: the card is called "my projects", so a project somebody is
 * assigned to belongs in it whether or not they have logged against it yet. Deriving the list purely
 * from entries meant the card could only ever show work already done, which is the opposite of
 * useful on the first of the month.
 *
 * NULL, NEVER ZERO. Every percentage here is null when its denominator is empty. "Nothing has been
 * logged yet" and "nothing has been approved" are different facts, and a 0% approval rate over an
 * empty month is exactly the number somebody screenshots.
 */

/** A ceiling, stated rather than silent — a workspace with hundreds of projects would otherwise
 *  render a card nobody can read. Busiest first, so what is cut is what matters least. */
const ROLLUP_PROJECT_CAP = 60;

interface ProjectRollupRow {
  id: string;
  code: string;
  name: string;
  monthHours: number;
  approvedHours: number;
  entries: number;
  lastDate: string | null;
  /** Whether the viewer is actually assigned to it, as opposed to having merely logged against it. */
  assigned: boolean;
  /** The PROJECT's standing, plus the viewer's own share of it for the hover detail. */
  tickets: { open: number; closed: number; mineOpen: number; mineClosed: number };
  changes: { raised: number; closed: number } | null;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

dashboardRouter.get("/my-month", async (req, res) => {
  const userId = req.user!.id;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Whether change management is even on decides whether the card gets a third bar or two. Read
  // rather than assumed, and a failure here must not take the whole home page down with it.
  let changeEnabled = false;
  try {
    changeEnabled = await isChangeManagementOn();
  } catch {
    changeEnabled = false;
  }

  const [entries, assignments] = await Promise.all([
    // Every entry in the month, uncapped — this is the whole point of the route.
    prisma.timesheet.findMany({
      where: { userId, deletedAt: null, workDate: { gte: monthStart, lt: monthEnd } },
      select: { projectId: true, totalHours: true, status: true, workDate: true }
    }),
    prisma.userProjectAssignment.findMany({ where: { userId }, select: { projectId: true } })
  ]);

  const byProject = new Map<string, { monthHours: number; approvedHours: number; entries: number; lastDate: string | null }>();
  const totals = { monthHours: 0, approvedHours: 0, submittedHours: 0, draftHours: 0, rejectedHours: 0 };

  for (const e of entries) {
    const hours = Number(e.totalHours ?? 0);
    totals.monthHours += hours;
    if (e.status === "APPROVED") totals.approvedHours += hours;
    else if (e.status === "SUBMITTED") totals.submittedHours += hours;
    else if (e.status === "REJECTED") totals.rejectedHours += hours;
    else totals.draftHours += hours;

    if (!e.projectId) continue;
    const roll = byProject.get(e.projectId) ?? { monthHours: 0, approvedHours: 0, entries: 0, lastDate: null };
    roll.monthHours += hours;
    if (e.status === "APPROVED") roll.approvedHours += hours;
    roll.entries += 1;
    const day = e.workDate.toISOString().slice(0, 10);
    if (!roll.lastDate || day > roll.lastDate) roll.lastDate = day;
    byProject.set(e.projectId, roll);
  }

  const assignedIds = new Set(assignments.map((a) => a.projectId));
  // The union is the fix: logged-against OR assigned, not logged-against alone.
  const projectIds = [...new Set([...byProject.keys(), ...assignedIds])];

  if (projectIds.length === 0) {
    return res.json({
      month: { from: monthStart.toISOString(), to: monthEnd.toISOString() },
      projects: [],
      truncated: false,
      totals: { ...totals, tickets: { open: 0, closed: 0, total: 0 }, changes: changeEnabled ? { raised: 0, closed: 0, total: 0 } : null },
      completion: { timesheetPct: null, ticketPct: null, changePct: null }
    });
  }

  const [projects, ticketGroups, mineGroups, changeRows] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds }, deletedAt: null },
      select: { id: true, code: true, name: true }
    }),
    // Ticket standing per project. Grouped in SQL rather than counted per project in a loop, which
    // would be one query per row of the card.
    prisma.ticket.groupBy({
      by: ["projectId", "status"],
      where: { projectId: { in: projectIds }, deletedAt: null },
      _count: true
    }),
    // The viewer's own share, in the SAME request as the project totals. Fetching the two separately
    // is what let the card show a project's rows before its counts and print "0%" for "not known
    // yet" — different facts. One request cannot be half-arrived.
    prisma.ticket.groupBy({
      by: ["projectId", "status"],
      where: { projectId: { in: projectIds }, deletedAt: null, assigneeId: userId },
      _count: true
    }),
    changeEnabled
      ? prisma.changeRequest.findMany({
          where: { ticket: { projectId: { in: projectIds } } },
          select: { closedAt: true, createdAt: true, ticket: { select: { projectId: true } } }
        })
      : Promise.resolve([])
  ]);

  const CLOSED_TICKET_STATUSES = new Set(["RESOLVED", "CLOSED"]);
  const ticketsByProject = new Map<string, { open: number; closed: number; mineOpen: number; mineClosed: number }>();
  const tally = (groups: typeof ticketGroups, openKey: "open" | "mineOpen", closedKey: "closed" | "mineClosed") => {
    for (const g of groups) {
      if (!g.projectId) continue;
      const t = ticketsByProject.get(g.projectId) ?? { open: 0, closed: 0, mineOpen: 0, mineClosed: 0 };
      if (CLOSED_TICKET_STATUSES.has(String(g.status))) t[closedKey] += g._count;
      else t[openKey] += g._count;
      ticketsByProject.set(g.projectId, t);
    }
  };
  tally(ticketGroups, "open", "closed");
  tally(mineGroups, "mineOpen", "mineClosed");

  const changesByProject = new Map<string, { raised: number; closed: number }>();
  for (const c of changeRows) {
    const pid = c.ticket?.projectId;
    if (!pid) continue;
    const entry = changesByProject.get(pid) ?? { raised: 0, closed: 0 };
    entry.raised += 1;
    if (c.closedAt) entry.closed += 1;
    changesByProject.set(pid, entry);
  }

  const rows: ProjectRollupRow[] = projects.map((p) => {
    const roll = byProject.get(p.id);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      monthHours: Number((roll?.monthHours ?? 0).toFixed(2)),
      approvedHours: Number((roll?.approvedHours ?? 0).toFixed(2)),
      entries: roll?.entries ?? 0,
      lastDate: roll?.lastDate ?? null,
      assigned: assignedIds.has(p.id),
      tickets: ticketsByProject.get(p.id) ?? { open: 0, closed: 0, mineOpen: 0, mineClosed: 0 },
      changes: changeEnabled ? (changesByProject.get(p.id) ?? { raised: 0, closed: 0 }) : null
    };
  });

  // Hours first, then a project you are assigned to but have not touched, then alphabetical — so the
  // card opens on what you actually worked on without hiding what you are responsible for.
  rows.sort((a, b) => b.monthHours - a.monthHours || Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name));

  const ticketTotals = rows.reduce((acc, r) => ({ open: acc.open + r.tickets.open, closed: acc.closed + r.tickets.closed }), { open: 0, closed: 0 });
  const changeTotals = changeEnabled
    ? rows.reduce((acc, r) => ({ raised: acc.raised + (r.changes?.raised ?? 0), closed: acc.closed + (r.changes?.closed ?? 0) }), { raised: 0, closed: 0 })
    : null;

  res.json({
    month: { from: monthStart.toISOString(), to: monthEnd.toISOString() },
    projects: rows.slice(0, ROLLUP_PROJECT_CAP),
    truncated: rows.length > ROLLUP_PROJECT_CAP,
    totals: {
      ...totals,
      monthHours: Number(totals.monthHours.toFixed(2)),
      approvedHours: Number(totals.approvedHours.toFixed(2)),
      submittedHours: Number(totals.submittedHours.toFixed(2)),
      draftHours: Number(totals.draftHours.toFixed(2)),
      rejectedHours: Number(totals.rejectedHours.toFixed(2)),
      tickets: { ...ticketTotals, total: ticketTotals.open + ticketTotals.closed },
      changes: changeTotals ? { ...changeTotals, total: changeTotals.raised } : null
    },
    /** The three bars the home page draws. Each is "done ÷ total" for its own kind of work, so they
     *  are comparable to each other rather than three unrelated numbers sharing a row. */
    completion: {
      timesheetPct: pct(totals.approvedHours, totals.monthHours),
      ticketPct: pct(ticketTotals.closed, ticketTotals.open + ticketTotals.closed),
      changePct: changeTotals ? pct(changeTotals.closed, changeTotals.raised) : null
    }
  });
});
