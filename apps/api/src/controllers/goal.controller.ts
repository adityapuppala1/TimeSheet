/**
 * WHAT: goals/OKRs — the objective tree, its links to real work, and the measured progress that
 * makes a goal something other than a sentence somebody typed.
 *
 * WHY READING NEEDS NO PERMISSION: a goal nobody can see aligns nobody. Every signed-in user
 * reads the tree; `goals:manage` gates writing. That is the same split as the plan itself
 * (an employee reads the timeline, `plan:write` moves it).
 *
 * WHY PROGRESS IS NEVER STORED: see goal-progress.service.ts. Every number on this surface is
 * derived on read from the same tables the portfolio and attestation read, so a goals page and a
 * client-facing document cannot disagree.
 *
 * WHY THE OVERRIDE ROUTE APPENDS INSTEAD OF UPDATING: decision 4 in
 * docs/AGENTIC_WORK_MANAGEMENT.md §7. An override records who said what, when, and what the
 * measurement said at that moment. Editing or deleting one would be precisely the unrecorded
 * adjustment the whole measured design exists to prevent, so there is no PATCH and no DELETE for
 * overrides — a correction is another row.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions, UNLIMITED_PLAN_ITEMS } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { measureGoal, SOURCE_DIRECTION, type GoalMeasurement } from "../services/goal-progress.service.js";
import { getPlanningQuota } from "../services/plan-limits.service.js";
import { assertGoalsEnabled } from "../services/planning.service.js";

export const goalRouter = Router();
goalRouter.use(requireAuth);

const OWNER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

const GOAL_INCLUDE = {
  owner: { select: OWNER_SUMMARY },
  createdBy: { select: OWNER_SUMMARY },
  links: true,
  overrides: {
    orderBy: { createdAt: "desc" },
    take: 1,
    include: { createdBy: { select: OWNER_SUMMARY } }
  },
  _count: { select: { children: true, overrides: true } }
} as const;

const progressSources = [
  "MANUAL",
  "APPROVED_HOURS",
  "BUDGET_SPEND",
  "TICKETS_CLOSED",
  "ON_TIME_RATE",
  "SLA_BREACHES",
  "RISK_SCORE"
] as const;

const linkSchema = z.object({
  targetType: z.enum(["PROJECT", "PORTFOLIO", "TICKET"]),
  targetId: z.string().min(1).max(191)
});

const bodySchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(200),
      description: z.string().max(4000).nullish(),
      parentId: z.string().uuid().nullish(),
      ownerId: z.string().uuid().nullish(),
      startDate: z.string().date().nullish(),
      endDate: z.string().date().nullish(),
      progressSource: z.enum(progressSources).optional(),
      targetValue: z.number().min(0).max(99_999_999_999.99).nullish(),
      unit: z.string().max(20).nullish(),
      manualProgressPct: z.number().int().min(0).max(100).nullish(),
      links: z.array(linkSchema).max(50).optional()
    })
    .strict()
});

const patchSchema = z.object({
  body: bodySchema.shape.body.partial().extend({
    status: z.enum(["ACTIVE", "ACHIEVED", "CLOSED"]).optional()
  })
});

/** A period that ends before it starts silently breaks every pace calculation downstream, and
 *  reads as "0% elapsed" rather than as an error — so it is refused at the edge. */
function assertPeriodOrder(startDate?: string | null, endDate?: string | null) {
  if (startDate && endDate && startDate > endDate) {
    throw new AppError(422, "The goal's end date cannot be before its start date.");
  }
}

/**
 * Objective → key result, and no deeper. Enforced here rather than in the schema because a
 * database cannot express "no grandchildren" without a maintained depth column, and two levels
 * is what an OKR actually is — a third level is a task, and this product already has tickets.
 */
async function assertParentDepth(parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw new AppError(422, "A goal cannot be its own parent.");
  const parent = await prisma.goal.findFirst({
    where: { id: parentId, deletedAt: null },
    select: { id: true, parentId: true }
  });
  if (!parent) throw new AppError(404, "Parent goal not found.");
  if (parent.parentId) {
    throw new AppError(422, "Goals nest two levels deep — an objective and its key results. Pick a top-level objective as the parent.");
  }
  if (selfId) {
    const childCount = await prisma.goal.count({ where: { parentId: selfId, deletedAt: null } });
    if (childCount > 0) {
      throw new AppError(422, "This goal already has key results of its own, so it cannot become a key result.");
    }
  }
}

/** MEASURED sources need a target to mean anything; MANUAL must not carry one, or the page would
 *  show a target the stated percentage is not measured against. Refused rather than ignored. */
function assertSourceShape(source: string | undefined, targetValue: number | null | undefined) {
  if (!source) return;
  if (source === "MANUAL" && targetValue != null) {
    throw new AppError(422, "A manually tracked goal states a percentage and takes no target value.");
  }
}

type GoalRow = Awaited<ReturnType<typeof prisma.goal.findFirstOrThrow<{ include: typeof GOAL_INCLUDE }>>>;

/**
 * One goal, plus its measurement and — when an override exists — BOTH numbers. The UI shows the
 * stated figure with the measured one beside it, never instead of it: that is what makes an
 * override an annotation rather than a rewrite.
 */
async function decorate(goal: GoalRow, now: Date) {
  const measurement: GoalMeasurement = await measureGoal(goal, now);
  const override = goal.overrides[0] ?? null;
  return {
    ...goal,
    targetValue: goal.targetValue == null ? null : Number(goal.targetValue),
    direction: SOURCE_DIRECTION[goal.progressSource],
    measurement,
    override: override
      ? {
          progressPct: override.progressPct,
          measuredValue: override.measuredValue == null ? null : Number(override.measuredValue),
          measuredPct: override.measuredPct,
          note: override.note,
          createdAt: override.createdAt,
          createdBy: override.createdBy
        }
      : null,
    /** What the UI renders as the headline. An override wins the display; the measurement stays
     *  visible next to it. */
    effectiveProgressPct: override?.progressPct ?? measurement.progressPct
  };
}

goalRouter.get("/", async (_req, res) => {
  await assertGoalsEnabled();
  const goals = await prisma.goal.findMany({
    where: { deletedAt: null },
    include: GOAL_INCLUDE,
    orderBy: [{ status: "asc" }, { endDate: "asc" }, { createdAt: "desc" }]
  });
  const now = new Date();
  // Sequential rather than Promise.all: each measurement is a handful of aggregates, and firing
  // 7 queries x N goals at the tenant pool at once is how one page view exhausts the per-tenant
  // connection ceiling (see config/prisma.ts's withConnectionLimit).
  const decorated = [];
  for (const goal of goals) decorated.push(await decorate(goal, now));
  res.json(decorated);
});

goalRouter.get("/:id", async (req, res) => {
  await assertGoalsEnabled();
  const goal = await prisma.goal.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    include: {
      ...GOAL_INCLUDE,
      overrides: { orderBy: { createdAt: "desc" }, include: { createdBy: { select: OWNER_SUMMARY } } },
      children: { where: { deletedAt: null }, include: GOAL_INCLUDE, orderBy: { createdAt: "asc" } }
    }
  });
  if (!goal) throw new AppError(404, "Goal not found.");
  const now = new Date();
  const children = [];
  for (const child of goal.children) children.push(await decorate(child, now));
  res.json({ ...(await decorate(goal as unknown as GoalRow, now)), children });
});

goalRouter.post("/", requirePermission(permissions.GOALS_MANAGE), validate(bodySchema), async (req, res) => {
  await assertGoalsEnabled();
  const body = req.body as z.infer<typeof bodySchema>["body"];
  assertPeriodOrder(body.startDate, body.endDate);
  assertSourceShape(body.progressSource, body.targetValue);
  await assertParentDepth(body.parentId);

  // The quota counts ACTIVE goals only: an org that closed last quarter's twenty-five is not
  // still using them, and making history count against the ceiling would push people to delete
  // the record of what they were aiming at.
  const quota = await getPlanningQuota(requireTenantContext().orgId, "maxGoals");
  if (quota < UNLIMITED_PLAN_ITEMS) {
    const active = await prisma.goal.count({ where: { deletedAt: null, status: "ACTIVE" } });
    if (active >= quota) {
      throw new AppError(403, `This plan allows ${quota} active goal${quota === 1 ? "" : "s"}. Close one, or upgrade for more.`);
    }
  }

  const goal = await prisma.goal.create({
    data: {
      title: body.title,
      description: body.description ?? null,
      parentId: body.parentId ?? null,
      ownerId: body.ownerId ?? null,
      startDate: body.startDate ? new Date(body.startDate) : null,
      endDate: body.endDate ? new Date(body.endDate) : null,
      progressSource: body.progressSource ?? "MANUAL",
      targetValue: body.targetValue ?? null,
      unit: body.unit ?? null,
      manualProgressPct: body.manualProgressPct ?? null,
      createdById: req.user!.id,
      links: body.links ? { create: body.links } : undefined
    },
    include: GOAL_INCLUDE
  });
  await audit(req.user!.id, "goal.created", "Goal", goal.id, { title: goal.title, progressSource: goal.progressSource });
  res.status(201).json(await decorate(goal, new Date()));
});

goalRouter.patch("/:id", requirePermission(permissions.GOALS_MANAGE), validate(patchSchema), async (req, res) => {
  await assertGoalsEnabled();
  const body = req.body as z.infer<typeof patchSchema>["body"];
  const existing = await prisma.goal.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Goal not found.");

  assertPeriodOrder(
    body.startDate === undefined ? existing.startDate?.toISOString().slice(0, 10) : body.startDate,
    body.endDate === undefined ? existing.endDate?.toISOString().slice(0, 10) : body.endDate
  );
  const nextSource = body.progressSource ?? existing.progressSource;
  const nextTarget = body.targetValue === undefined ? (existing.targetValue == null ? null : Number(existing.targetValue)) : body.targetValue;
  assertSourceShape(nextSource, nextTarget);
  if (body.parentId !== undefined) await assertParentDepth(body.parentId, existing.id);

  const goal = await prisma.$transaction(async (tx) => {
    if (body.links) {
      // Replace wholesale: links are a set, and a diff-and-patch of a set the UI already sends
      // in full is extra failure modes for no gain.
      await tx.goalLink.deleteMany({ where: { goalId: existing.id } });
      if (body.links.length > 0) {
        await tx.goalLink.createMany({ data: body.links.map((l) => ({ ...l, goalId: existing.id })) });
      }
    }
    return tx.goal.update({
      where: { id: existing.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
        ...(body.startDate !== undefined ? { startDate: body.startDate ? new Date(body.startDate) : null } : {}),
        ...(body.endDate !== undefined ? { endDate: body.endDate ? new Date(body.endDate) : null } : {}),
        ...(body.progressSource !== undefined ? { progressSource: body.progressSource } : {}),
        ...(body.targetValue !== undefined ? { targetValue: body.targetValue } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.manualProgressPct !== undefined ? { manualProgressPct: body.manualProgressPct } : {}),
        ...(body.status !== undefined ? { status: body.status } : {})
      },
      include: GOAL_INCLUDE
    });
  });
  await audit(req.user!.id, "goal.updated", "Goal", goal.id, { fields: Object.keys(body) });
  res.json(await decorate(goal, new Date()));
});

const overrideSchema = z.object({
  body: z
    .object({
      progressPct: z.number().int().min(0).max(100),
      // Required, and not merely encouraged: "why does the stated number differ from the
      // measured one" is the entire reason this row exists.
      note: z.string().min(3).max(500)
    })
    .strict()
});

goalRouter.post("/:id/override", requirePermission(permissions.GOALS_MANAGE), validate(overrideSchema), async (req, res) => {
  await assertGoalsEnabled();
  const body = req.body as z.infer<typeof overrideSchema>["body"];
  const goal = await prisma.goal.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!goal) throw new AppError(404, "Goal not found.");
  if (goal.progressSource === "MANUAL") {
    throw new AppError(422, "This goal's progress is already stated manually — edit the goal instead of overriding a measurement.");
  }

  // The receipt: what the measurement said at the moment of the override. Captured here rather
  // than read later, because "later" is a different number and the point is what was on screen
  // when somebody decided to disagree with it.
  const measurement = await measureGoal(goal);
  const override = await prisma.goalProgressOverride.create({
    data: {
      goalId: goal.id,
      progressPct: body.progressPct,
      measuredValue: measurement.currentValue ?? null,
      measuredPct: measurement.progressPct ?? null,
      note: body.note,
      createdById: req.user!.id
    },
    include: { createdBy: { select: OWNER_SUMMARY } }
  });
  await audit(req.user!.id, "goal.overridden", "Goal", goal.id, {
    statedPct: body.progressPct,
    measuredPct: measurement.progressPct,
    measuredValue: measurement.currentValue,
    note: body.note
  });
  res.status(201).json(override);
});

/** Soft delete, like Portfolio: a goal that shaped a quarter's decisions is audit trail, and its
 *  override history is the record of how its number was argued about. */
goalRouter.delete("/:id", requirePermission(permissions.GOALS_MANAGE), async (req, res) => {
  await assertGoalsEnabled();
  const goal = await prisma.goal.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!goal) throw new AppError(404, "Goal not found.");
  const children = await prisma.goal.count({ where: { parentId: goal.id, deletedAt: null } });
  if (children > 0) {
    throw new AppError(422, "Delete or re-parent this objective's key results first.");
  }
  await prisma.goal.update({ where: { id: goal.id }, data: { deletedAt: new Date() } });
  await audit(req.user!.id, "goal.deleted", "Goal", goal.id, { title: goal.title });
  res.status(204).end();
});
