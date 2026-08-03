/**
 * WHAT: portfolios — one grouping level above `Project` — and the roll-up that makes them worth
 * having: schedule, progress, budget burn and delivery health for a set of projects at once.
 *
 * WHY THE PORTFOLIO STORES ALMOST NOTHING: it holds a name, a code, an owner and a colour. Every
 * number on the portfolio page is DERIVED from its projects on read. The alternative — storing a
 * portfolio-level budget and schedule that someone maintains alongside the project-level ones —
 * is how portfolio tools end up disagreeing with themselves, and the disagreement always surfaces
 * in the meeting where it matters most.
 *
 * WHY BURN IS NOT A STORED NUMBER EITHER: it is summed live from `Timesheet.billedAmount`, the
 * rate snapshot captured at approval time. That is the same source a Verified Work Attestation
 * reads, so the figure on an executive dashboard and the figure on a document sent to a client
 * cannot drift apart.
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
import { computeProjectBudgets } from "../services/budget.service.js";
import { getPlanningQuota } from "../services/plan-limits.service.js";
import { assertPlanningEnabled } from "../services/planning.service.js";
import { buildPlan, dayKey, legacyCategory } from "../services/plan-schedule.service.js";
import { ticketProjectScope } from "../services/ticket.service.js";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

const OWNER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

portfolioRouter.get("/", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const portfolios = await prisma.portfolio.findMany({
    where: { deletedAt: null },
    include: {
      owner: { select: OWNER_SUMMARY },
      _count: { select: { projects: true } }
    },
    orderBy: { name: "asc" }
  });
  res.json(portfolios);
});

const bodySchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, hyphen or underscore."),
  description: z.string().max(4000).nullish(),
  ownerId: z.string().uuid().nullish(),
  color: z.string().max(20).nullish(),
  status: z.enum(["ACTIVE", "ON_HOLD", "ARCHIVED"]).optional()
});

portfolioRouter.post(
  "/",
  requirePermission(permissions.PORTFOLIOS_MANAGE),
  validate(z.object({ body: bodySchema })),
  async (req, res) => {
    await assertPlanningEnabled();

    // Quota counts LIVE portfolios only, so archiving one you no longer run frees the slot —
    // otherwise an org hits its ceiling permanently through normal use.
    const quota = await getPlanningQuota(requireTenantContext().orgId, "maxPortfolios");
    const used = await prisma.portfolio.count({ where: { deletedAt: null } });
    if (used >= quota) {
      throw new AppError(
        403,
        quota === 0
          ? "Portfolios are not included in this plan."
          : `This plan allows ${quota} portfolio(s) and ${used} exist. Archive one or upgrade.`
      );
    }

    const created = await prisma.portfolio.create({
      data: {
        name: req.body.name,
        code: req.body.code.toUpperCase(),
        description: req.body.description ?? null,
        ownerId: req.body.ownerId ?? null,
        color: req.body.color ?? null,
        status: req.body.status ?? "ACTIVE"
      },
      include: { owner: { select: OWNER_SUMMARY } }
    });
    await audit(req.user!.id, "portfolio.created", "Portfolio", created.id, { code: created.code });
    res.status(201).json(created);
  }
);

portfolioRouter.put(
  "/:id",
  requirePermission(permissions.PORTFOLIOS_MANAGE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: bodySchema })),
  async (req, res) => {
    await assertPlanningEnabled();
    const updated = await prisma.portfolio.update({
      where: { id: String(req.params.id) },
      data: {
        name: req.body.name,
        code: req.body.code.toUpperCase(),
        description: req.body.description ?? null,
        ownerId: req.body.ownerId ?? null,
        color: req.body.color ?? null,
        status: req.body.status ?? "ACTIVE"
      },
      include: { owner: { select: OWNER_SUMMARY } }
    });
    await audit(req.user!.id, "portfolio.updated", "Portfolio", updated.id);
    res.json(updated);
  }
);

/** Soft delete. The projects inside are NOT touched — `Project.portfolioId` is `SetNull`, so
 *  removing a grouping ungroups its projects rather than taking them with it. */
portfolioRouter.delete(
  "/:id",
  requirePermission(permissions.PORTFOLIOS_MANAGE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const id = String(req.params.id);
    await prisma.$transaction([
      prisma.project.updateMany({ where: { portfolioId: id }, data: { portfolioId: null } }),
      prisma.portfolio.update({ where: { id }, data: { deletedAt: new Date() } })
    ]);
    await audit(req.user!.id, "portfolio.deleted", "Portfolio", id);
    res.status(204).end();
  }
);

portfolioRouter.post(
  "/:id/projects",
  requirePermission(permissions.PORTFOLIOS_MANAGE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ projectIds: z.array(z.string().uuid()).max(500) }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    const id = String(req.params.id);
    await prisma.portfolio.findUniqueOrThrow({ where: { id } });

    // Set membership wholesale: projects listed join, projects previously in this portfolio and
    // now absent leave. A add-only endpoint would make "remove a project" need its own route and
    // its own race condition.
    await prisma.$transaction([
      prisma.project.updateMany({ where: { portfolioId: id, id: { notIn: req.body.projectIds } }, data: { portfolioId: null } }),
      prisma.project.updateMany({ where: { id: { in: req.body.projectIds } }, data: { portfolioId: id } })
    ]);
    await audit(req.user!.id, "portfolio.projects_set", "Portfolio", id, { count: req.body.projectIds.length });
    res.json({ count: req.body.projectIds.length });
  }
);

/* ---------- The roll-up ---------- */

/**
 * Everything the portfolio page shows, for one portfolio or for all of them.
 *
 * Runs the SAME solver the timeline uses (`buildPlan`) rather than a second, simpler
 * approximation — a portfolio that reported a different end date from the project's own timeline
 * would be worse than no portfolio view at all.
 */
portfolioRouter.get("/rollup", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  const scope = await ticketProjectScope(req);
  const portfolioId = typeof req.query.portfolioId === "string" ? req.query.portfolioId : undefined;

  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      ...(portfolioId ? { portfolioId } : {}),
      ...(scope.unrestricted ? {} : { id: { in: scope.projectIds } })
    },
    select: {
      id: true, code: true, name: true, status: true, portfolioId: true,
      budgetAmount: true, budgetCurrency: true, budgetAlertPct: true, billingCurrency: true,
      plannedStartDate: true, plannedEndDate: true,
      portfolio: { select: { id: true, code: true, name: true, color: true } }
    },
    orderBy: { name: "asc" }
  });
  if (projects.length === 0) return res.json({ projects: [], portfolios: [] });

  const projectIds = projects.map((p) => p.id);

  // Grouped queries, never per-project loops: a portfolio page over 40 projects would otherwise
  // fire 120 round trips and time out on exactly the workspace that most wants it.
  const [plan, counts] = await Promise.all([
    buildPlan({ projectIds, includeClosed: true }),
    prisma.ticket.groupBy({
      by: ["projectId", "status"],
      where: { projectId: { in: projectIds }, deletedAt: null },
      _count: { _all: true }
    })
  ]);

  const itemsByProject = new Map<string, typeof plan.items>();
  for (const item of plan.items) {
    const raw = plan.raw.find((r: any) => r.id === item.id) as any;
    const pid = raw?.projectId;
    if (!pid) continue;
    if (!itemsByProject.has(pid)) itemsByProject.set(pid, []);
    itemsByProject.get(pid)!.push(item);
  }

  const openByProject = new Map<string, number>();
  const doneByProject = new Map<string, number>();
  for (const row of counts) {
    const target = legacyCategory(row.status) === "DONE" ? doneByProject : openByProject;
    target.set(row.projectId, (target.get(row.projectId) ?? 0) + row._count._all);
  }

  // Progress must be computed before the budgets, because the forecast is burn scaled by it.
  const progressByProject = new Map<string, number>();
  for (const p of projects) {
    const items = itemsByProject.get(p.id) ?? [];
    const weight = (i: (typeof items)[number]) => (i.estimatedHours && i.estimatedHours > 0 ? i.estimatedHours : 1);
    const totalWeight = items.reduce((sum, i) => sum + weight(i), 0);
    progressByProject.set(
      p.id,
      totalWeight > 0 ? Math.round(items.reduce((sum, i) => sum + i.effectiveProgressPct * weight(i), 0) / totalWeight) : 0
    );
  }

  // Money comes from budget.service.ts rather than being summed here, so this page and the
  // project budget panel cannot end up with two different definitions of "burn".
  const budgets = await computeProjectBudgets(projectIds, progressByProject);
  const loggedHoursByProject = new Map(
    (
      await prisma.timesheet.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, status: "APPROVED", deletedAt: null },
        _sum: { totalHours: true }
      })
    ).map((r) => [r.projectId, Number(r._sum.totalHours ?? 0)])
  );

  const projectRows = projects.map((p) => {
    const items = itemsByProject.get(p.id) ?? [];
    const start = items.reduce<Date | null>((min, i) => (!min || i.resolvedStart < min ? i.resolvedStart : min), null);
    const end = items.reduce<Date | null>((max, i) => (!max || i.resolvedEnd > max ? i.resolvedEnd : max), null);

    // Effort-weighted, matching the roll-up inside a single project. A plain mean across items
    // would make a project with many tiny finished tasks look far healthier than it is.
    const progressPct = progressByProject.get(p.id) ?? 0;
    const money = budgets.get(p.id);

    const slipped = items.filter((i) => (i.slipDays ?? 0) > 0);
    const worstSlip = slipped.reduce((max, i) => Math.max(max, i.slipDays ?? 0), 0);

    return {
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      portfolio: p.portfolio,
      plannedStart: p.plannedStartDate ? dayKey(p.plannedStartDate) : null,
      plannedEnd: p.plannedEndDate ? dayKey(p.plannedEndDate) : null,
      scheduleStart: start ? dayKey(start) : null,
      scheduleEnd: end ? dayKey(end) : null,
      // The signal the risk scorer reads in Phase 5: the plan says one thing, the work says
      // another, and the gap between them is where a project goes wrong quietly.
      overrunsPlannedEnd: Boolean(p.plannedEndDate && end && end > p.plannedEndDate),
      itemCount: items.length,
      openCount: openByProject.get(p.id) ?? 0,
      doneCount: doneByProject.get(p.id) ?? 0,
      progressPct,
      criticalCount: items.filter((i) => i.isCritical).length,
      slippedCount: slipped.length,
      worstSlipDays: worstSlip,
      violationCount: items.reduce((sum, i) => sum + i.violations.length, 0),
      budget: money?.budget ?? null,
      currency: money?.currency ?? "USD",
      burn: money?.burn ?? 0,
      burnPct: money?.burnPct ?? null,
      forecastAtCompletion: money?.forecastAtCompletion ?? null,
      overBudgetRisk: money?.overBudgetRisk ?? false,
      budgetAlertPct: money?.budgetAlertPct ?? null,
      loggedHours: Number((loggedHoursByProject.get(p.id) ?? 0).toFixed(2))
    };
  });

  // Portfolio totals are sums/weighted-means of the project rows above — computed from the same
  // objects the client renders, so a total can never disagree with the rows under it.
  const portfolios = await prisma.portfolio.findMany({
    where: { deletedAt: null, ...(portfolioId ? { id: portfolioId } : {}) },
    include: { owner: { select: OWNER_SUMMARY } },
    orderBy: { name: "asc" }
  });

  const portfolioRows = portfolios.map((pf) => {
    const rows = projectRows.filter((p) => p.portfolio?.id === pf.id);
    const totalWeight = rows.reduce((sum, r) => sum + Math.max(1, r.itemCount), 0);
    return {
      id: pf.id,
      code: pf.code,
      name: pf.name,
      color: pf.color,
      status: pf.status,
      owner: pf.owner,
      projectCount: rows.length,
      itemCount: rows.reduce((s, r) => s + r.itemCount, 0),
      openCount: rows.reduce((s, r) => s + r.openCount, 0),
      progressPct: totalWeight > 0
        ? Math.round(rows.reduce((s, r) => s + r.progressPct * Math.max(1, r.itemCount), 0) / totalWeight)
        : 0,
      budget: rows.reduce((s, r) => s + (r.budget ?? 0), 0) || null,
      burn: Number(rows.reduce((s, r) => s + r.burn, 0).toFixed(2)),
      slippedCount: rows.reduce((s, r) => s + r.slippedCount, 0),
      atRiskProjects: rows.filter((r) => r.overBudgetRisk || r.overrunsPlannedEnd || r.worstSlipDays > 0).length,
      scheduleEnd: rows.reduce<string | null>((max, r) => (!max || (r.scheduleEnd && r.scheduleEnd > max) ? r.scheduleEnd : max), null)
    };
  });

  res.json({ projects: projectRows, portfolios: portfolioRows });
});
