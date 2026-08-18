/**
 * WHAT: the planning surface — the timeline feed, work-item hierarchy and dates, scheduling
 * dependencies, baselines, the calendar feed, "My work", and saved views.
 *
 * WHY IT IS A SEPARATE CONTROLLER FROM `ticket.controller.ts` even though every route here
 * operates on `Ticket` rows: the ticket controller owns the ISSUE — who reported it, what its
 * SLA is, whether it can move to RESOLVED. This one owns the PLAN — when work happens, what
 * blocks what, how it rolls up. They have different permissions (`plan:write` vs
 * `tickets:write`, deliberately: someone who can fix a typo in a ticket should not necessarily
 * be able to move the whole delivery schedule), different gates (every route here 403s unless
 * planning is on and the tier includes it), and different read shapes. Bolting them together
 * would have meant every existing ticket route growing a planning branch.
 *
 * WHY EVERY ROUTE RE-CHECKS PROJECT SCOPE: `ticketProjectScope()` from `ticket.service.ts` is
 * reused verbatim, so the timeline can never show a project the caller can't already see in the
 * ticket list. A planning view that quietly widened visibility would be a data leak wearing a
 * Gantt chart.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions, planViewTypes, savedViewScopes, ticketLinkTypes } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { computeMyWork } from "../services/my-work.service.js";
import { assertPlanningEnabled } from "../services/planning.service.js";
import {
  assertNoCycle,
  assertNoParentCycle,
  buildPlan,
  dayKey,
  legacyCategory,
  readWorkingDays,
  toDay,
  type PlanDependency
} from "../services/plan-schedule.service.js";
import { assertTicketVisible, canModifyTicket, ticketProjectScope } from "../services/ticket.service.js";

export const planRouter = Router();
planRouter.use(requireAuth);

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

/**
 * Depth-first tree order: each item immediately followed by its own descendants.
 *
 * Items whose parent isn't in the result set (filtered out by a date window, or closed while its
 * children are open) are treated as roots rather than dropped — an orphaned row still represents
 * real work, and silently hiding it is how a timeline ends up quietly missing tasks.
 */
function toTreeOrder<T extends { id: string; parentId: string | null }>(items: T[]): T[] {
  const present = new Set(items.map((i) => i.id));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    if (item.parentId && present.has(item.parentId)) {
      if (!childrenOf.has(item.parentId)) childrenOf.set(item.parentId, []);
      childrenOf.get(item.parentId)!.push(item);
    } else {
      roots.push(item);
    }
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (node: T) => {
    // Guard against a hand-edited database producing a parent cycle; the API prevents one, but
    // a request must not hang because a row was edited outside it.
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
    for (const child of childrenOf.get(node.id) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  for (const item of items) if (!seen.has(item.id)) out.push(item);
  return out;
}

/** Every project the caller may see, honouring the same scope the ticket list uses. */
async function visibleProjectIds(req: any, requested?: string[]): Promise<string[]> {
  const scope = await ticketProjectScope(req);
  if (scope.unrestricted) {
    if (requested?.length) return requested;
    const all = await prisma.project.findMany({ where: { deletedAt: null }, select: { id: true } });
    return all.map((p) => p.id);
  }
  if (requested?.length) {
    const allowed = requested.filter((id) => scope.projectIds.includes(id));
    // Silently narrowing would show a confusingly empty timeline; say what happened.
    if (allowed.length === 0) throw new AppError(403, "You don't have access to those projects.");
    return allowed;
  }
  return scope.projectIds;
}

const csv = (value: unknown): string[] | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
};

/* ---------- Timeline ---------- */

/**
 * The Gantt feed: every work item in scope, with resolved dates, float, critical path, progress
 * roll-up, baseline slip and any scheduling conflicts.
 *
 * Returns the SOLVED shape rather than raw rows because the arithmetic must be identical
 * everywhere it is shown — the timeline, the portfolio roll-up, the risk score in Phase 5 and a
 * scheduled PDF must not each re-derive "is this critical" in their own way and disagree.
 */
planRouter.get("/timeline", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  const projectIds = await visibleProjectIds(req, csv(req.query.projectIds));
  if (projectIds.length === 0) {
    return res.json({ items: [], start: null, end: null, criticalPath: [], violations: [], workingDays: await readWorkingDays() });
  }

  const from = typeof req.query.from === "string" ? toDay(req.query.from) : undefined;
  const to = typeof req.query.to === "string" ? toDay(req.query.to) : undefined;

  const plan = await buildPlan({
    projectIds,
    includeClosed: req.query.includeClosed === "true",
    from,
    to
  });

  const rawById = new Map(plan.raw.map((r: any) => [r.id, r]));
  // Tree order — a parent immediately followed by its own subtree — computed HERE rather than in
  // the client, because the timeline, a CSV export and (later) a scheduled PDF must all present
  // the same plan in the same order. Three independent sorts is three chances to disagree.
  const ordered = toTreeOrder(plan.items);
  res.json({
    workingDays: await readWorkingDays(),
    start: plan.start ? dayKey(plan.start) : null,
    end: plan.end ? dayKey(plan.end) : null,
    criticalPath: plan.criticalPath,
    violations: plan.violations,
    items: ordered.map((item) => {
      const raw: any = rawById.get(item.id) ?? {};
      return {
        id: item.id,
        key: item.key,
        title: item.title,
        parentId: item.parentId,
        depth: item.depth,
        // Both the entered dates and the resolved ones. The UI renders an inferred bar
        // differently, so it must be able to tell which is which.
        startDate: item.startDate ? dayKey(item.startDate) : null,
        endDate: item.endDate ? dayKey(item.endDate) : null,
        resolvedStart: dayKey(item.resolvedStart),
        resolvedEnd: dayKey(item.resolvedEnd),
        isInferred: item.isInferred,
        durationDays: item.durationDays,
        isMilestone: item.isMilestone,
        progressPct: item.progressPct,
        effectiveProgressPct: item.effectiveProgressPct,
        totalFloatDays: item.totalFloatDays,
        isCritical: item.isCritical,
        slipDays: item.slipDays,
        baselineStart: item.baselineStartDate ? dayKey(item.baselineStartDate) : null,
        baselineEnd: item.baselineEndDate ? dayKey(item.baselineEndDate) : null,
        violations: item.violations,
        status: item.status,
        statusCategory: item.statusCategory,
        statusLabel: raw.workflowStatus?.name ?? null,
        statusColor: raw.workflowStatus?.color ?? null,
        priority: raw.priority,
        type: raw.type,
        estimatedHours: item.estimatedHours,
        assignee: raw.assignee ?? null,
        project: raw.project ?? null
      };
    })
  });
});

/** The dependency edges for the items on screen, so the timeline can draw arrows without
 *  re-deriving them from each item's links. */
planRouter.get("/dependencies", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  const projectIds = await visibleProjectIds(req, csv(req.query.projectIds));
  if (projectIds.length === 0) return res.json([]);

  const tickets = await prisma.ticket.findMany({ where: { projectId: { in: projectIds }, deletedAt: null }, select: { id: true } });
  const ids = tickets.map((t) => t.id);
  const links = await prisma.ticketLink.findMany({
    where: {
      type: { in: ["BLOCKS", "FINISH_TO_START", "START_TO_START", "FINISH_TO_FINISH", "START_TO_FINISH"] },
      sourceTicketId: { in: ids },
      targetTicketId: { in: ids }
    },
    select: { id: true, sourceTicketId: true, targetTicketId: true, type: true, lagDays: true }
  });
  res.json(links.map((l) => ({ id: l.id, fromId: l.sourceTicketId, toId: l.targetTicketId, type: l.type, lagDays: l.lagDays ?? 0 })));
});

/* ---------- Editing the plan ---------- */

const planPatchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      // `null` clears a date; omitting the key leaves it alone. The distinction matters —
      // a partial update must never wipe a field the caller never mentioned.
      startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullable().optional(),
      endDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullable().optional(),
      parentId: z.string().uuid().nullable().optional(),
      isMilestone: z.boolean().optional(),
      progressPct: z.number().int().min(0).max(100).nullable().optional(),
      sortOrder: z.number().int().min(0).max(1_000_000).optional(),
      estimatedHours: z.number().min(0).max(100_000).nullable().optional()
    })
    .strict()
});

planRouter.patch("/items/:id", requirePermission(permissions.PLAN_WRITE), validate(planPatchSchema), async (req, res) => {
  await assertPlanningEnabled();

  const existing = await prisma.ticket.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    select: { id: true, key: true, projectId: true, reporterId: true, assigneeId: true, parentId: true, startDate: true, endDate: true, isMilestone: true }
  });
  if (!existing) throw new AppError(404, "Work item not found");
  await assertTicketVisible(req, existing.projectId);
  if (!canModifyTicket(req, existing)) throw new AppError(403, "Forbidden");

  const data: Record<string, unknown> = {};
  if ("startDate" in req.body) data.startDate = req.body.startDate ? toDay(req.body.startDate) : null;
  if ("endDate" in req.body) data.endDate = req.body.endDate ? toDay(req.body.endDate) : null;
  if (typeof req.body.isMilestone === "boolean") data.isMilestone = req.body.isMilestone;
  if ("progressPct" in req.body) data.progressPct = req.body.progressPct;
  if (typeof req.body.sortOrder === "number") data.sortOrder = req.body.sortOrder;
  if ("estimatedHours" in req.body) data.estimatedHours = req.body.estimatedHours;

  // An end before a start is refused rather than silently swapped: a swap guesses which of the
  // two the person meant, and guessing wrong writes a plan they didn't ask for.
  const nextStart = ("startDate" in req.body ? (data.startDate as Date | null) : existing.startDate) ?? null;
  const nextEnd = ("endDate" in req.body ? (data.endDate as Date | null) : existing.endDate) ?? null;
  if (nextStart && nextEnd && nextEnd < nextStart) {
    throw new AppError(422, "The end date can't be before the start date.");
  }
  // A milestone is a single instant on the timeline, so its two dates must agree.
  const willBeMilestone = typeof req.body.isMilestone === "boolean" ? req.body.isMilestone : existing.isMilestone;
  if (willBeMilestone && nextStart) data.endDate = nextStart;

  if ("parentId" in req.body) {
    const parentId = req.body.parentId as string | null;
    if (parentId) {
      const parent = await prisma.ticket.findFirst({
        where: { id: parentId, deletedAt: null },
        select: { id: true, projectId: true }
      });
      if (!parent) throw new AppError(404, "Parent item not found");
      // Cross-project parents are refused: the hierarchy is what the timeline, the roll-up and
      // the portfolio all walk, and an item whose parent lives in a project the viewer can't see
      // would render as an orphan with a hole where its ancestor should be.
      if (parent.projectId !== existing.projectId) {
        throw new AppError(422, "A work item's parent must be in the same project.");
      }
      const all = await prisma.ticket.findMany({
        where: { projectId: existing.projectId, deletedAt: null },
        select: { id: true, parentId: true }
      });
      assertNoParentCycle(existing.id, parentId, new Map(all.map((t) => [t.id, t.parentId])));
    }
    data.parentId = parentId;
  }

  const updated = await prisma.ticket.update({
    where: { id: existing.id },
    data,
    select: {
      id: true, key: true, title: true, parentId: true, startDate: true, endDate: true,
      isMilestone: true, progressPct: true, sortOrder: true, estimatedHours: true
    }
  });
  await audit(req.user!.id, "plan.item.updated", "Ticket", updated.id, data);
  res.json(updated);
});

/**
 * Freeze or clear the baseline.
 *
 * WHY IT IS AN EXPLICIT ACTION AND NEVER AUTOMATIC: slip is `endDate - baselineEndDate`, and it
 * is only meaningful because the baseline is frozen at a moment a human called "the agreed plan".
 * A baseline that refreshed itself whenever dates changed would make every project look
 * permanently on time — precisely the failure baselines exist to prevent.
 */
planRouter.post(
  "/items/:id/baseline",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ clear: z.boolean().optional() }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    const existing = await prisma.ticket.findFirst({
      where: { id: String(req.params.id), deletedAt: null },
      select: { id: true, projectId: true, reporterId: true, assigneeId: true, startDate: true, endDate: true, estimatedHours: true }
    });
    if (!existing) throw new AppError(404, "Work item not found");
    await assertTicketVisible(req, existing.projectId);
    if (!canModifyTicket(req, existing)) throw new AppError(403, "Forbidden");

    if (req.body.clear) {
      const cleared = await prisma.ticket.update({
        where: { id: existing.id },
        data: { baselineStartDate: null, baselineEndDate: null, baselineEffortHours: null, baselineSetAt: null }
      });
      await audit(req.user!.id, "plan.baseline.cleared", "Ticket", cleared.id);
      return res.json({ baselineStart: null, baselineEnd: null, baselineSetAt: null });
    }

    if (!existing.startDate || !existing.endDate) {
      throw new AppError(422, "Give the item start and end dates before setting a baseline — there is nothing to freeze otherwise.");
    }

    const updated = await prisma.ticket.update({
      where: { id: existing.id },
      data: {
        baselineStartDate: existing.startDate,
        baselineEndDate: existing.endDate,
        baselineEffortHours: existing.estimatedHours,
        baselineSetAt: new Date()
      }
    });
    await audit(req.user!.id, "plan.baseline.set", "Ticket", updated.id);
    res.json({
      baselineStart: dayKey(updated.baselineStartDate!),
      baselineEnd: dayKey(updated.baselineEndDate!),
      baselineSetAt: updated.baselineSetAt
    });
  }
);

/** Baseline every dated item in a project in one action — the realistic workflow, since nobody
 *  freezes a 200-item plan one row at a time. */
planRouter.post(
  "/projects/:projectId/baseline",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ projectId: z.string().uuid() }), body: z.object({ clear: z.boolean().optional() }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    const projectId = String(req.params.projectId);
    await assertTicketVisible(req, projectId);

    if (req.body.clear) {
      const { count } = await prisma.ticket.updateMany({
        where: { projectId, deletedAt: null },
        data: { baselineStartDate: null, baselineEndDate: null, baselineEffortHours: null, baselineSetAt: null }
      });
      await audit(req.user!.id, "plan.baseline.project_cleared", "Project", projectId, { count });
      return res.json({ count });
    }

    // Only items that HAVE dates — baselining a dateless item would freeze nothing and then
    // report a slip against it, which is worse than having no baseline.
    const items = await prisma.ticket.findMany({
      where: { projectId, deletedAt: null, startDate: { not: null }, endDate: { not: null } },
      select: { id: true, startDate: true, endDate: true, estimatedHours: true }
    });
    const now = new Date();
    await prisma.$transaction(
      items.map((t) =>
        prisma.ticket.update({
          where: { id: t.id },
          data: { baselineStartDate: t.startDate, baselineEndDate: t.endDate, baselineEffortHours: t.estimatedHours, baselineSetAt: now }
        })
      )
    );
    await audit(req.user!.id, "plan.baseline.project_set", "Project", projectId, { count: items.length });
    res.json({ count: items.length });
  }
);

/* ---------- Dependencies ---------- */

const dependencySchema = z.object({
  body: z
    .object({
      fromId: z.string().uuid(),
      toId: z.string().uuid(),
      type: z.enum(ticketLinkTypes),
      lagDays: z.number().int().min(-365).max(365).optional()
    })
    .strict()
});

planRouter.post("/dependencies", requirePermission(permissions.PLAN_WRITE), validate(dependencySchema), async (req, res) => {
  await assertPlanningEnabled();
  const { fromId, toId, type } = req.body;
  if (fromId === toId) throw new AppError(422, "An item can't depend on itself.");

  const [from, to] = await Promise.all([
    prisma.ticket.findFirst({ where: { id: fromId, deletedAt: null }, select: { id: true, key: true, projectId: true } }),
    prisma.ticket.findFirst({ where: { id: toId, deletedAt: null }, select: { id: true, key: true, projectId: true } })
  ]);
  if (!from || !to) throw new AppError(404, "One of those work items no longer exists.");
  await assertTicketVisible(req, from.projectId);
  await assertTicketVisible(req, to.projectId);

  // Cycle check runs BEFORE the write, against the graph as it WOULD be. Refusing at the moment
  // someone creates the loop is the only point where they still have the context to know which
  // link they meant — discovering it later as a wrong-looking timeline gives them no way to tell
  // which of forty links is the culprit.
  const projectIds = Array.from(new Set([from.projectId, to.projectId]));
  const tickets = await prisma.ticket.findMany({
    where: { projectId: { in: projectIds }, deletedAt: null },
    select: { id: true, key: true }
  });
  const existing = await prisma.ticketLink.findMany({
    where: { sourceTicketId: { in: tickets.map((t) => t.id) }, type: { in: ["BLOCKS", "FINISH_TO_START", "START_TO_START", "FINISH_TO_FINISH", "START_TO_FINISH"] } },
    select: { id: true, sourceTicketId: true, targetTicketId: true, type: true, lagDays: true }
  });
  const graph: PlanDependency[] = existing.map((l) => ({
    id: l.id,
    fromId: l.sourceTicketId,
    toId: l.targetTicketId,
    type: l.type as any,
    lagDays: l.lagDays ?? 0
  }));
  graph.push({ id: "__proposed__", fromId, toId, type, lagDays: req.body.lagDays ?? 0 });
  assertNoCycle(tickets, graph);

  const created = await prisma.ticketLink.upsert({
    where: { sourceTicketId_targetTicketId_type: { sourceTicketId: fromId, targetTicketId: toId, type } },
    update: { lagDays: req.body.lagDays ?? 0 },
    create: { sourceTicketId: fromId, targetTicketId: toId, type, lagDays: req.body.lagDays ?? 0 }
  });
  await audit(req.user!.id, "plan.dependency.created", "TicketLink", created.id, { from: from.key, to: to.key, type });
  res.status(201).json({ id: created.id, fromId, toId, type, lagDays: created.lagDays ?? 0 });
});

planRouter.patch(
  "/dependencies/:id",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ lagDays: z.number().int().min(-365).max(365) }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    const link = await prisma.ticketLink.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, sourceTicket: { select: { projectId: true } } }
    });
    if (!link) throw new AppError(404, "Dependency not found");
    await assertTicketVisible(req, link.sourceTicket.projectId);

    const updated = await prisma.ticketLink.update({ where: { id: link.id }, data: { lagDays: req.body.lagDays } });
    await audit(req.user!.id, "plan.dependency.updated", "TicketLink", updated.id, { lagDays: req.body.lagDays });
    res.json({ id: updated.id, lagDays: updated.lagDays });
  }
);

planRouter.delete(
  "/dependencies/:id",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const link = await prisma.ticketLink.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, sourceTicket: { select: { projectId: true } } }
    });
    if (!link) throw new AppError(404, "Dependency not found");
    await assertTicketVisible(req, link.sourceTicket.projectId);
    await prisma.ticketLink.delete({ where: { id: link.id } });
    await audit(req.user!.id, "plan.dependency.deleted", "TicketLink", link.id);
    res.status(204).end();
  }
);

/* ---------- Calendar ---------- */

/**
 * Dated work items in a window, for the calendar view.
 *
 * Deliberately does NOT run the solver: a calendar shows what is *scheduled*, and an inferred bar
 * with no real dates has no business appearing on a specific day as though someone committed to
 * it. The timeline is where inference belongs, because there it is visibly marked as such.
 */
planRouter.get("/calendar", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  const projectIds = await visibleProjectIds(req, csv(req.query.projectIds));
  if (projectIds.length === 0) return res.json([]);

  const from = typeof req.query.from === "string" ? toDay(req.query.from) : toDay(new Date());
  const to = typeof req.query.to === "string" ? toDay(req.query.to) : toDay(new Date(Date.now() + 90 * 86_400_000));

  const items = await prisma.ticket.findMany({
    where: {
      projectId: { in: projectIds },
      deletedAt: null,
      OR: [
        // Overlap, not containment: an item spanning the whole window is very much on screen.
        { startDate: { lte: to }, endDate: { gte: from } },
        { startDate: { gte: from, lte: to }, endDate: null },
        { startDate: null, endDate: { gte: from, lte: to } },
        // SLA due dates are shown too — for most workspaces on day one, `dueAt` is the only
        // date a ticket has, and a calendar that looked empty would read as broken.
        { startDate: null, endDate: null, dueAt: { gte: from, lte: to } }
      ]
    },
    select: {
      id: true, key: true, title: true, startDate: true, endDate: true, dueAt: true, isMilestone: true,
      status: true, priority: true, type: true,
      workflowStatus: { select: { name: true, category: true, color: true } },
      assignee: { select: USER_SUMMARY },
      project: { select: { id: true, code: true, name: true } }
    },
    orderBy: [{ startDate: "asc" }, { dueAt: "asc" }],
    take: 1000
  });

  res.json(
    items.map((t) => ({
      id: t.id,
      key: t.key,
      title: t.title,
      startDate: t.startDate ? dayKey(t.startDate) : null,
      endDate: t.endDate ? dayKey(t.endDate) : null,
      dueAt: t.dueAt ? dayKey(t.dueAt) : null,
      /** What the calendar should place this on — real dates if present, else the SLA date. */
      anchorDate: dayKey(t.startDate ?? t.dueAt ?? t.endDate ?? new Date()),
      isScheduled: Boolean(t.startDate || t.endDate),
      isMilestone: t.isMilestone,
      status: t.status,
      statusCategory: t.workflowStatus?.category ?? legacyCategory(t.status),
      statusLabel: t.workflowStatus?.name ?? null,
      priority: t.priority,
      type: t.type,
      assignee: t.assignee,
      project: t.project
    }))
  );
});

/* ---------- My work ---------- */

/**
 * One person's cross-project queue, bucketed.
 *
 * WHY BUCKETED SERVER-SIDE: "overdue", "today", "this week" and "blocked" are the same four
 * questions every morning, and the definition of each has to match what the dashboard and the
 * notification emails already use. Computing them in the client would mean three implementations
 * of "overdue" that drift.
 *
 * No permission gate beyond authentication and no planning gate: this is the caller's OWN work,
 * it reads dates that exist whether or not planning is on, and a personal to-do list is not a
 * feature worth selling separately.
 */
planRouter.get("/my-work", async (req, res) => {
  // The bucketing lives in services/my-work.service.ts because the Inbox brief counts the same
  // four buckets. Two callers, one definition of "overdue".
  res.json(await computeMyWork(req.user!.id));
});

/* ---------- Saved views ---------- */

const savedViewSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(120),
      scope: z.enum(savedViewScopes).optional(),
      viewType: z.enum(planViewTypes).optional(),
      filters: z.record(z.unknown()).nullable().optional(),
      columns: z.array(z.string()).nullable().optional(),
      sort: z.record(z.unknown()).nullable().optional(),
      isDefault: z.boolean().optional()
    })
    .strict()
});

planRouter.get("/views", async (req, res) => {
  await assertPlanningEnabled();
  const views = await prisma.savedView.findMany({
    // Own views plus anything published to the workspace. A SHARED view is visible to everyone
    // by design — it is a saved FILTER, not a data grant: opening one still runs every normal
    // project-scope check, so it can never widen what its viewer can see.
    where: { OR: [{ ownerId: req.user!.id }, { scope: "SHARED" }] },
    include: { owner: { select: { id: true, name: true } } },
    orderBy: [{ viewType: "asc" }, { name: "asc" }]
  });
  res.json(views);
});

planRouter.post("/views", validate(savedViewSchema), async (req, res) => {
  await assertPlanningEnabled();
  // Publishing to the whole workspace is the only part that needs a right beyond "logged in".
  if (req.body.scope === "SHARED" && !req.user!.permissions.includes(permissions.DASHBOARDS_SHARE)) {
    throw new AppError(403, "You can save personal views, but publishing one to the workspace needs the share permission.");
  }
  const created = await prisma.savedView.create({
    data: {
      ownerId: req.user!.id,
      name: req.body.name,
      scope: req.body.scope ?? "PERSONAL",
      viewType: req.body.viewType ?? "LIST",
      filters: req.body.filters ?? undefined,
      columns: req.body.columns ?? undefined,
      sort: req.body.sort ?? undefined,
      isDefault: req.body.isDefault ?? false
    }
  });
  if (created.isDefault) await clearOtherDefaults(req.user!.id, created.viewType, created.id);
  await audit(req.user!.id, "plan.view.created", "SavedView", created.id, { name: created.name });
  res.status(201).json(created);
});

planRouter.put(
  "/views/:id",
  validate(savedViewSchema.extend({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const existing = await prisma.savedView.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, "View not found");
    // Only the owner edits a view — including a shared one. Anyone else who wants it different
    // can duplicate it, which leaves the original's other users unaffected.
    if (existing.ownerId !== req.user!.id) throw new AppError(403, "Only the person who saved a view can change it.");
    if (req.body.scope === "SHARED" && !req.user!.permissions.includes(permissions.DASHBOARDS_SHARE)) {
      throw new AppError(403, "Publishing a view to the workspace needs the share permission.");
    }

    const updated = await prisma.savedView.update({
      where: { id: existing.id },
      data: {
        name: req.body.name,
        scope: req.body.scope ?? existing.scope,
        viewType: req.body.viewType ?? existing.viewType,
        filters: req.body.filters ?? undefined,
        columns: req.body.columns ?? undefined,
        sort: req.body.sort ?? undefined,
        isDefault: req.body.isDefault ?? existing.isDefault
      }
    });
    if (updated.isDefault) await clearOtherDefaults(req.user!.id, updated.viewType, updated.id);
    res.json(updated);
  }
);

planRouter.delete("/views/:id", validate(z.object({ params: z.object({ id: z.string().uuid() }) })), async (req, res) => {
  await assertPlanningEnabled();
  const existing = await prisma.savedView.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "View not found");
  if (existing.ownerId !== req.user!.id) throw new AppError(403, "Only the person who saved a view can delete it.");
  await prisma.savedView.delete({ where: { id: existing.id } });
  res.status(204).end();
});

/** One default per person per view type — otherwise "which view opens?" has no answer. */
async function clearOtherDefaults(ownerId: string, viewType: string, keepId: string) {
  await prisma.savedView.updateMany({
    where: { ownerId, viewType, id: { not: keepId }, isDefault: true },
    data: { isDefault: false }
  });
}
