/**
 * WHAT: resource management — the workload board, booking CRUD, per-person capacity, and one
 * project's budget/variance panel.
 *
 * WHY BOOKINGS ARE NEVER REFUSED FOR OVERLAPPING: double-booking is sometimes deliberate — a
 * person genuinely split across two projects for a fortnight — and a system that rejects the
 * second booking forces planners to record something untrue to get past it. Conflicts are
 * surfaced (`GET /resources/conflicts`, and the red cells on the board) rather than prevented.
 * The board's job is to make the truth visible, not to enforce a policy it cannot know.
 *
 * WHY THE BOARD READS APPROVED TIMESHEETS TOO: this is the one thing a pure PM tool cannot do.
 * Every competitor can only compare a plan against another plan. Putting planned, actual and
 * capacity on the same axis turns "Ana is booked at 110%" (a forecast) into "Ana was booked at
 * 110% and logged 46 hours" (evidence).
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { computeEffortVariance, computeProjectBudgets } from "../services/budget.service.js";
import { buildPlan, dayKey, toDay } from "../services/plan-schedule.service.js";
// `assertPlanningEnabled` as well as the resource-specific gate: budgets live in this file for
// proximity to workload, but they are a TEAM-tier capability while resource management is
// Enterprise-only. Gating the budget panel on `assertResourcesEnabled` would quietly sell it one
// tier higher than the pricing page says.
import { assertPlanningCapability, assertPlanningEnabled, getPlanningSettings } from "../services/planning.service.js";
import { ticketProjectScope } from "../services/ticket.service.js";
import { findConflicts, loadWorkload, type BookingSpan } from "../services/workload.service.js";

export const resourceRouter = Router();
resourceRouter.use(requireAuth);

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

/** Resource management has its own toggle AND its own tier gate, both required. */
const assertResourcesEnabled = () =>
  assertPlanningCapability("enableResourceManagement", "resourceMgmtEnabled", "Resource management");

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/** Default window when none is given: the current week plus seven more. Long enough to plan
 *  against, short enough that the grid stays readable without horizontal scrolling on a laptop. */
function defaultWindow() {
  const today = toDay(new Date());
  const from = new Date(today.getTime() - 7 * 86_400_000);
  const to = new Date(today.getTime() + 49 * 86_400_000);
  return { from, to };
}

/* ---------- The board ---------- */

resourceRouter.get("/workload", requirePermission(permissions.RESOURCES_MANAGE), async (req, res) => {
  await assertResourcesEnabled();

  const window = defaultWindow();
  const from = typeof req.query.from === "string" ? toDay(req.query.from) : window.from;
  const to = typeof req.query.to === "string" ? toDay(req.query.to) : window.to;
  if (to < from) throw new AppError(422, "The end of the range is before its start.");

  const granularity = req.query.granularity === "day" ? "day" : "week";
  const projectId = typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : undefined;

  const { buckets, rows, workingDays } = await loadWorkload({ from, to, granularity, projectId });

  res.json({
    from: dayKey(from),
    to: dayKey(to),
    granularity,
    workingDays,
    buckets,
    rows,
    summary: {
      people: rows.length,
      overAllocated: rows.filter((r) => r.totals.overAllocatedBuckets > 0).length,
      // "Nobody is booked at all" is a genuinely useful signal on a board that looks empty —
      // it distinguishes "no capacity problem" from "nobody has planned anything yet".
      unbooked: rows.filter((r) => r.totals.bookedHours === 0).length,
      totalCapacityHours: Number(rows.reduce((s, r) => s + r.totals.capacityHours, 0).toFixed(2)),
      totalBookedHours: Number(rows.reduce((s, r) => s + r.totals.bookedHours, 0).toFixed(2)),
      totalLoggedHours: Number(rows.reduce((s, r) => s + r.totals.loggedHours, 0).toFixed(2))
    }
  });
});

/** Overlapping bookings that together exceed someone's daily capacity. Informational. */
resourceRouter.get("/conflicts", requirePermission(permissions.RESOURCES_MANAGE), async (req, res) => {
  await assertResourcesEnabled();
  const settings = await getPlanningSettings();
  const window = defaultWindow();
  const from = typeof req.query.from === "string" ? toDay(req.query.from) : window.from;
  const to = typeof req.query.to === "string" ? toDay(req.query.to) : window.to;

  const bookings = await prisma.resourceBooking.findMany({
    where: { startDate: { lte: to }, endDate: { gte: from } },
    include: {
      user: { select: { ...USER_SUMMARY, weeklyCapacityHours: true, plannedUtilizationPct: true } },
      project: { select: { id: true, code: true, name: true } }
    }
  });

  const byUser = new Map<string, typeof bookings>();
  for (const b of bookings) {
    if (!byUser.has(b.userId)) byUser.set(b.userId, []);
    byUser.get(b.userId)!.push(b);
  }

  const defaults = {
    weeklyCapacityHours: settings.defaultWeeklyCapacityHours,
    workingDaysPerWeek: settings.workingDays.length || 5
  };

  const out: unknown[] = [];
  for (const [userId, theirs] of byUser) {
    const user = theirs[0].user;
    const spans: BookingSpan[] = theirs.map((b) => ({
      id: b.id,
      userId: b.userId,
      projectId: b.projectId,
      ticketId: b.ticketId,
      startDate: b.startDate,
      endDate: b.endDate,
      hoursPerDay: Number(b.hoursPerDay),
      isTimeOff: b.isTimeOff,
      note: b.note
    }));
    for (const c of findConflicts(
      spans,
      {
        weeklyCapacityHours: user.weeklyCapacityHours ? Number(user.weeklyCapacityHours) : null,
        plannedUtilizationPct: user.plannedUtilizationPct
      },
      defaults
    )) {
      const a = theirs.find((b) => b.id === c.aId);
      const b = theirs.find((x) => x.id === c.bId);
      out.push({
        userId,
        user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
        overlapStart: c.overlapStart,
        overlapEnd: c.overlapEnd,
        combinedHoursPerDay: c.combinedHoursPerDay,
        bookings: [a, b].filter(Boolean).map((x) => ({
          id: x!.id,
          project: x!.project,
          hoursPerDay: Number(x!.hoursPerDay),
          note: x!.note
        }))
      });
    }
  }

  res.json(out);
});

/* ---------- Bookings ---------- */

resourceRouter.get("/bookings", requirePermission(permissions.RESOURCES_MANAGE), async (req, res) => {
  await assertResourcesEnabled();
  const window = defaultWindow();
  const from = typeof req.query.from === "string" ? toDay(req.query.from) : window.from;
  const to = typeof req.query.to === "string" ? toDay(req.query.to) : window.to;

  const bookings = await prisma.resourceBooking.findMany({
    where: {
      startDate: { lte: to },
      endDate: { gte: from },
      ...(typeof req.query.userId === "string" && req.query.userId ? { userId: req.query.userId } : {}),
      ...(typeof req.query.projectId === "string" && req.query.projectId ? { projectId: req.query.projectId } : {})
    },
    include: {
      user: { select: USER_SUMMARY },
      project: { select: { id: true, code: true, name: true } },
      ticket: { select: { id: true, key: true, title: true } }
    },
    orderBy: [{ startDate: "asc" }]
  });

  res.json(
    bookings.map((b) => ({
      ...b,
      startDate: dayKey(b.startDate),
      endDate: dayKey(b.endDate),
      hoursPerDay: Number(b.hoursPerDay)
    }))
  );
});

const bookingBody = z
  .object({
    userId: z.string().uuid(),
    projectId: z.string().uuid().nullish(),
    ticketId: z.string().uuid().nullish(),
    startDate: DATE,
    endDate: DATE,
    /** Per WORKING day. Capped at 24 because a per-day figure above that is a data-entry error,
     *  not an ambitious plan. */
    hoursPerDay: z.number().min(0.25).max(24),
    note: z.string().max(300).nullish(),
    isTimeOff: z.boolean().optional()
  })
  .strict();

async function assertBookingTargets(body: z.infer<typeof bookingBody>) {
  if (body.startDate > body.endDate) throw new AppError(422, "The booking ends before it starts.");
  const user = await prisma.user.findFirst({ where: { id: body.userId, deletedAt: null }, select: { id: true } });
  if (!user) throw new AppError(404, "That person no longer has an account here.");

  if (body.ticketId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: body.ticketId, deletedAt: null },
      select: { id: true, projectId: true }
    });
    if (!ticket) throw new AppError(404, "That work item no longer exists.");
    // A booking against a ticket implies its project; disagreeing values would make the board and
    // the project filter report different things about the same row.
    if (body.projectId && body.projectId !== ticket.projectId) {
      throw new AppError(422, "That work item belongs to a different project.");
    }
    return { ...body, projectId: ticket.projectId };
  }
  return body;
}

resourceRouter.post(
  "/bookings",
  requirePermission(permissions.RESOURCES_MANAGE),
  validate(z.object({ body: bookingBody })),
  async (req, res) => {
    await assertResourcesEnabled();
    const body = await assertBookingTargets(req.body);

    const created = await prisma.resourceBooking.create({
      data: {
        userId: body.userId,
        projectId: body.projectId ?? null,
        ticketId: body.ticketId ?? null,
        startDate: toDay(body.startDate),
        endDate: toDay(body.endDate),
        hoursPerDay: body.hoursPerDay,
        note: body.note ?? null,
        isTimeOff: body.isTimeOff ?? false,
        createdById: req.user!.id
      },
      include: { user: { select: USER_SUMMARY }, project: { select: { id: true, code: true, name: true } } }
    });
    await audit(req.user!.id, "resource.booking.created", "ResourceBooking", created.id, {
      userId: body.userId,
      hoursPerDay: body.hoursPerDay
    });
    res.status(201).json({ ...created, startDate: dayKey(created.startDate), endDate: dayKey(created.endDate), hoursPerDay: Number(created.hoursPerDay) });
  }
);

resourceRouter.put(
  "/bookings/:id",
  requirePermission(permissions.RESOURCES_MANAGE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: bookingBody })),
  async (req, res) => {
    await assertResourcesEnabled();
    const body = await assertBookingTargets(req.body);
    const updated = await prisma.resourceBooking.update({
      where: { id: String(req.params.id) },
      data: {
        userId: body.userId,
        projectId: body.projectId ?? null,
        ticketId: body.ticketId ?? null,
        startDate: toDay(body.startDate),
        endDate: toDay(body.endDate),
        hoursPerDay: body.hoursPerDay,
        note: body.note ?? null,
        isTimeOff: body.isTimeOff ?? false
      },
      include: { user: { select: USER_SUMMARY }, project: { select: { id: true, code: true, name: true } } }
    });
    await audit(req.user!.id, "resource.booking.updated", "ResourceBooking", updated.id);
    res.json({ ...updated, startDate: dayKey(updated.startDate), endDate: dayKey(updated.endDate), hoursPerDay: Number(updated.hoursPerDay) });
  }
);

resourceRouter.delete(
  "/bookings/:id",
  requirePermission(permissions.RESOURCES_MANAGE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertResourcesEnabled();
    await prisma.resourceBooking.delete({ where: { id: String(req.params.id) } });
    await audit(req.user!.id, "resource.booking.deleted", "ResourceBooking", String(req.params.id));
    res.status(204).end();
  }
);

/* ---------- Capacity ---------- */

/** Everyone's capacity, for the settings-style editor on the workload page. */
resourceRouter.get("/capacity", requirePermission(permissions.RESOURCES_MANAGE), async (_req, res) => {
  await assertResourcesEnabled();
  const settings = await getPlanningSettings();
  const people = await prisma.user.findMany({
    where: { deletedAt: null, status: "ACTIVE" },
    select: { ...USER_SUMMARY, designation: true, weeklyCapacityHours: true, plannedUtilizationPct: true },
    orderBy: { name: "asc" }
  });
  res.json({
    defaultWeeklyCapacityHours: settings.defaultWeeklyCapacityHours,
    people: people.map((p) => ({
      ...p,
      weeklyCapacityHours: p.weeklyCapacityHours ? Number(p.weeklyCapacityHours) : null
    }))
  });
});

resourceRouter.patch(
  "/capacity/:userId",
  requirePermission(permissions.RESOURCES_MANAGE),
  validate(
    z.object({
      params: z.object({ userId: z.string().uuid() }),
      body: z
        .object({
          // Null clears the override and returns the person to the workspace default — which is
          // a different fact from "their week happens to equal the default", and only the first
          // should follow a later change to that default.
          weeklyCapacityHours: z.number().min(1).max(168).nullable().optional(),
          plannedUtilizationPct: z.number().int().min(1).max(100).nullable().optional()
        })
        .strict()
    })
  ),
  async (req, res) => {
    await assertResourcesEnabled();
    const data: Record<string, unknown> = {};
    if ("weeklyCapacityHours" in req.body) data.weeklyCapacityHours = req.body.weeklyCapacityHours;
    if ("plannedUtilizationPct" in req.body) data.plannedUtilizationPct = req.body.plannedUtilizationPct;

    const updated = await prisma.user.update({
      where: { id: String(req.params.userId) },
      data,
      select: { ...USER_SUMMARY, weeklyCapacityHours: true, plannedUtilizationPct: true }
    });
    await audit(req.user!.id, "resource.capacity.updated", "User", updated.id, data);
    res.json({ ...updated, weeklyCapacityHours: updated.weeklyCapacityHours ? Number(updated.weeklyCapacityHours) : null });
  }
);

/* ---------- Budget ---------- */

/**
 * One project's money and effort accuracy.
 *
 * Progress comes from the same solver the timeline uses, so the percentage driving the forecast
 * here is the percentage shown on the Gantt. Computing it separately would let a project be 60%
 * done on one screen and 45% on another.
 */
resourceRouter.get("/budget/:projectId", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  const projectId = String(req.params.projectId);
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && !scope.projectIds.includes(projectId)) throw new AppError(403, "Forbidden");

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, code: true, name: true, plannedStartDate: true, plannedEndDate: true }
  });
  if (!project) throw new AppError(404, "Project not found");

  const plan = await buildPlan({ projectIds: [projectId], includeClosed: true });
  const weight = (i: (typeof plan.items)[number]) => (i.estimatedHours && i.estimatedHours > 0 ? i.estimatedHours : 1);
  const totalWeight = plan.items.reduce((s, i) => s + weight(i), 0);
  const progressPct =
    totalWeight > 0
      ? Math.round(plan.items.reduce((s, i) => s + i.effectiveProgressPct * weight(i), 0) / totalWeight)
      : 0;

  const [budgets, variance] = await Promise.all([
    computeProjectBudgets([projectId], new Map([[projectId, progressPct]])),
    computeEffortVariance({ projectIds: [projectId], limit: 25 })
  ]);

  res.json({
    project: {
      ...project,
      plannedStart: project.plannedStartDate ? dayKey(project.plannedStartDate) : null,
      plannedEnd: project.plannedEndDate ? dayKey(project.plannedEndDate) : null
    },
    progressPct,
    schedule: {
      start: plan.start ? dayKey(plan.start) : null,
      end: plan.end ? dayKey(plan.end) : null,
      overrunsPlannedEnd: Boolean(project.plannedEndDate && plan.end && plan.end > project.plannedEndDate)
    },
    budget: budgets.get(projectId) ?? null,
    variance
  });
});
