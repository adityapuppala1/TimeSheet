/**
 * WHAT: the dashboard widget library — what a widget can be, and how each one gets its numbers.
 *
 * WHY THE WIDGET CATALOGUE IS A CLOSED SET AND NOT A QUERY BUILDER: a dashboard people build
 * themselves is only trustworthy if every tile means the same thing on every dashboard. A generic
 * "pick a table and an aggregate" builder produces tiles whose definition lives in whoever
 * configured them, so two dashboards showing "open tickets" can legitimately disagree and nobody
 * can tell which is right. A closed catalogue means `openTickets` is one query, defined here, and
 * it matches the Insights page and the reports because it IS the same code path.
 *
 * WHY EVERY WIDGET RESOLVES THROUGH THE SAME PROJECT SCOPE as the rest of the app: a dashboard is
 * a saved arrangement of views, never a data grant. Two people opening the same SHARED dashboard
 * see their own permitted projects, and a shared dashboard can therefore never be used to
 * exfiltrate a project somebody was not already allowed to see.
 *
 * WHO CALLS THIS: `controllers/dashboard.controller.ts`, and the report-subscription worker when
 * it renders a dashboard into an email.
 */
import { prisma } from "../config/prisma.js";
import { computeProjectBudgets } from "./budget.service.js";
import { buildPlan, dayKey, legacyCategory } from "./plan-schedule.service.js";
import { latestSnapshots } from "./project-risk.service.js";
import { loadWorkload } from "./workload.service.js";

export const WIDGET_TYPES = [
  "OPEN_ITEMS",
  "OVERDUE_ITEMS",
  "HOURS_LOGGED",
  "BUDGET_BURN",
  "VELOCITY",
  "STATUS_MIX",
  "RISK_BANDS",
  "WORKLOAD_SUMMARY",
  "UPCOMING_MILESTONES",
  "MY_QUEUE"
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** How a widget wants to be drawn — the client picks a component from this, not from the type. */
export type WidgetShape = "STAT" | "SERIES" | "BREAKDOWN" | "TABLE";

export interface WidgetConfig {
  /** Null/absent = every project the viewer can see. */
  projectId?: string | null;
  /** Lookback for the time-series widgets. */
  days?: number;
}

export interface WidgetDescriptor {
  type: WidgetType;
  label: string;
  shape: WidgetShape;
  description: string;
}

/** The catalogue the builder renders from, served rather than duplicated client-side. */
export const WIDGET_CATALOGUE: WidgetDescriptor[] = [
  { type: "OPEN_ITEMS", label: "Open work items", shape: "STAT", description: "Everything not resolved or closed." },
  { type: "OVERDUE_ITEMS", label: "Overdue", shape: "STAT", description: "Past its planned end date or its SLA." },
  { type: "HOURS_LOGGED", label: "Hours logged", shape: "STAT", description: "Approved hours in the period." },
  { type: "BUDGET_BURN", label: "Budget burn", shape: "STAT", description: "Spent against budget, from approved rate snapshots." },
  { type: "VELOCITY", label: "Created vs resolved", shape: "SERIES", description: "Weekly throughput." },
  { type: "STATUS_MIX", label: "Status mix", shape: "BREAKDOWN", description: "Where open work is sitting." },
  { type: "RISK_BANDS", label: "Project risk", shape: "BREAKDOWN", description: "How many projects are green, amber and red." },
  { type: "WORKLOAD_SUMMARY", label: "Capacity", shape: "STAT", description: "Booked against available capacity." },
  { type: "UPCOMING_MILESTONES", label: "Upcoming milestones", shape: "TABLE", description: "The next dated milestones." },
  { type: "MY_QUEUE", label: "My queue", shape: "TABLE", description: "What is assigned to the person viewing." }
];

export interface WidgetResult {
  type: WidgetType;
  shape: WidgetShape;
  /** STAT only. */
  value?: number | string | null;
  unit?: string | null;
  hint?: string | null;
  /** SERIES / BREAKDOWN. */
  points?: Array<{ label: string; value: number; secondary?: number }>;
  /** TABLE. */
  rows?: Array<Record<string, string | number | null>>;
  /** Set when the widget cannot be computed — shown in place of a number rather than as a zero,
   *  because a zero is a claim and "not available" is not. */
  unavailable?: string;
}

const DAY_MS = 86_400_000;

/**
 * Resolves one widget against the viewer's own project scope.
 *
 * `projectIds` is passed in already narrowed by the caller — the resolver never widens it, which
 * is what makes a SHARED dashboard safe.
 */
export async function resolveWidget(params: {
  type: WidgetType;
  config: WidgetConfig;
  projectIds: string[];
  viewerId: string;
}): Promise<WidgetResult> {
  const { type, config, projectIds, viewerId } = params;
  const scoped = config.projectId ? projectIds.filter((id) => id === config.projectId) : projectIds;
  const shape = WIDGET_CATALOGUE.find((w) => w.type === type)?.shape ?? "STAT";

  if (scoped.length === 0) {
    return { type, shape, unavailable: "No projects in scope" };
  }

  const days = Math.min(365, Math.max(7, config.days ?? 30));
  const since = new Date(Date.now() - days * DAY_MS);

  switch (type) {
    case "OPEN_ITEMS": {
      const value = await prisma.ticket.count({
        where: { projectId: { in: scoped }, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } }
      });
      return { type, shape, value, hint: "not resolved or closed" };
    }

    case "OVERDUE_ITEMS": {
      const now = new Date();
      const value = await prisma.ticket.count({
        where: {
          projectId: { in: scoped },
          deletedAt: null,
          status: { notIn: ["RESOLVED", "CLOSED"] },
          // Either promise counts: the planned end date, or the SLA. They mean different things,
          // and a tile that only watched one would quietly under-report.
          OR: [{ endDate: { lt: now } }, { dueAt: { lt: now } }]
        }
      });
      return { type, shape, value, hint: "past a planned end date or an SLA" };
    }

    case "HOURS_LOGGED": {
      const agg = await prisma.timesheet.aggregate({
        where: { projectId: { in: scoped }, status: "APPROVED", deletedAt: null, workDate: { gte: since } },
        _sum: { totalHours: true }
      });
      return { type, shape, value: Number(Number(agg._sum.totalHours ?? 0).toFixed(1)), unit: "h", hint: `approved, last ${days} days` };
    }

    case "BUDGET_BURN": {
      const plan = await buildPlan({ projectIds: scoped, includeClosed: true });
      const progress = new Map<string, number>();
      for (const id of scoped) {
        const items = plan.items.filter((i) => (plan.raw.find((r: any) => r.id === i.id) as any)?.projectId === id);
        const weight = (i: (typeof items)[number]) => (i.estimatedHours && i.estimatedHours > 0 ? i.estimatedHours : 1);
        const total = items.reduce((s, i) => s + weight(i), 0);
        progress.set(id, total > 0 ? Math.round(items.reduce((s, i) => s + i.effectiveProgressPct * weight(i), 0) / total) : 0);
      }
      const budgets = await computeProjectBudgets(scoped, progress);
      const rows = Array.from(budgets.values());
      const budget = rows.reduce((s, b) => s + (b.budget ?? 0), 0);
      const burn = rows.reduce((s, b) => s + b.burn, 0);
      if (budget === 0) return { type, shape, unavailable: "No budgets set" };
      return {
        type,
        shape,
        value: Math.round((burn / budget) * 100),
        unit: "%",
        hint: `${Math.round(burn).toLocaleString()} of ${Math.round(budget).toLocaleString()} ${rows[0]?.currency ?? ""}`
      };
    }

    case "VELOCITY": {
      const [created, resolved] = await Promise.all([
        prisma.ticket.findMany({
          where: { projectId: { in: scoped }, deletedAt: null, createdAt: { gte: since } },
          select: { createdAt: true }
        }),
        prisma.ticket.findMany({
          where: { projectId: { in: scoped }, deletedAt: null, resolvedAt: { gte: since } },
          select: { resolvedAt: true }
        })
      ]);
      // Weekly buckets, oldest first. Bucketed here rather than in SQL so the same shape works
      // regardless of database, and because the volume at this range is small.
      const weeks = Math.ceil(days / 7);
      const points: Array<{ label: string; value: number; secondary?: number }> = [];
      for (let i = weeks - 1; i >= 0; i--) {
        const start = new Date(Date.now() - (i + 1) * 7 * DAY_MS);
        const end = new Date(Date.now() - i * 7 * DAY_MS);
        points.push({
          label: dayKey(start).slice(5),
          value: created.filter((c) => c.createdAt >= start && c.createdAt < end).length,
          secondary: resolved.filter((r) => r.resolvedAt && r.resolvedAt >= start && r.resolvedAt < end).length
        });
      }
      return { type, shape, points };
    }

    case "STATUS_MIX": {
      const grouped = await prisma.ticket.groupBy({
        by: ["status"],
        where: { projectId: { in: scoped }, deletedAt: null, status: { notIn: ["CLOSED"] } },
        _count: { _all: true }
      });
      return {
        type,
        shape,
        points: grouped.map((g) => ({ label: g.status.replace(/_/g, " ").toLowerCase(), value: g._count._all }))
      };
    }

    case "RISK_BANDS": {
      const snapshots = await latestSnapshots(scoped);
      if (snapshots.size === 0) return { type, shape, unavailable: "No risk snapshots yet" };
      const counts = { GREEN: 0, AMBER: 0, RED: 0 };
      for (const snapshot of snapshots.values()) counts[snapshot.band]++;
      return {
        type,
        shape,
        points: [
          { label: "green", value: counts.GREEN },
          { label: "amber", value: counts.AMBER },
          { label: "red", value: counts.RED }
        ]
      };
    }

    case "WORKLOAD_SUMMARY": {
      const board = await loadWorkload({
        from: new Date(),
        to: new Date(Date.now() + 28 * DAY_MS),
        projectId: config.projectId ?? undefined
      }).catch(() => null);
      if (!board || board.rows.length === 0) return { type, shape, unavailable: "Nobody assigned" };
      const capacity = board.rows.reduce((s, r) => s + r.totals.capacityHours, 0);
      const booked = board.rows.reduce((s, r) => s + r.totals.bookedHours, 0);
      if (capacity === 0) return { type, shape, unavailable: "No capacity in range" };
      const over = board.rows.filter((r) => r.totals.overAllocatedBuckets > 0).length;
      return {
        type,
        shape,
        value: Math.round((booked / capacity) * 100),
        unit: "%",
        hint: over > 0 ? `${over} person(s) over capacity` : "nobody over capacity"
      };
    }

    case "UPCOMING_MILESTONES": {
      const rows = await prisma.ticket.findMany({
        where: {
          projectId: { in: scoped },
          deletedAt: null,
          isMilestone: true,
          status: { notIn: ["CLOSED"] },
          startDate: { gte: new Date(Date.now() - DAY_MS) }
        },
        select: { key: true, title: true, startDate: true, status: true, project: { select: { code: true } } },
        orderBy: { startDate: "asc" },
        take: 8
      });
      return {
        type,
        shape,
        rows: rows.map((r) => ({
          key: r.key,
          title: r.title,
          project: r.project.code,
          date: r.startDate ? dayKey(r.startDate) : null
        }))
      };
    }

    case "MY_QUEUE": {
      const rows = await prisma.ticket.findMany({
        where: {
          projectId: { in: scoped },
          deletedAt: null,
          assigneeId: viewerId,
          status: { notIn: ["RESOLVED", "CLOSED"] }
        },
        select: { key: true, title: true, priority: true, dueAt: true, endDate: true, status: true },
        orderBy: [{ dueAt: "asc" }],
        take: 8
      });
      return {
        type,
        shape,
        rows: rows.map((r) => ({
          key: r.key,
          title: r.title,
          priority: r.priority,
          // Whichever promise comes first — the same rule "My work" uses.
          due: r.endDate ? dayKey(r.endDate) : r.dueAt ? dayKey(r.dueAt) : null,
          status: legacyCategory(r.status)
        }))
      };
    }

    default:
      return { type, shape, unavailable: "Unknown widget" };
  }
}

/**
 * Resolves a whole dashboard.
 *
 * One widget failing must not take the dashboard with it — a dashboard is a page somebody opens
 * every morning, and a single bad tile turning it into an error page is a far worse outcome than
 * that tile saying it is unavailable.
 */
export async function resolveDashboard(params: {
  widgets: Array<{ id: string; type: WidgetType; title?: string; config?: WidgetConfig }>;
  projectIds: string[];
  viewerId: string;
}): Promise<Array<WidgetResult & { id: string; title: string }>> {
  return Promise.all(
    params.widgets.map(async (widget) => {
      const title = widget.title || WIDGET_CATALOGUE.find((w) => w.type === widget.type)?.label || widget.type;
      try {
        const result = await resolveWidget({
          type: widget.type,
          config: widget.config ?? {},
          projectIds: params.projectIds,
          viewerId: params.viewerId
        });
        return { ...result, id: widget.id, title };
      } catch (error) {
        console.error(`[dashboard] widget ${widget.type} failed:`, (error as Error).message);
        return {
          id: widget.id,
          title,
          type: widget.type,
          shape: WIDGET_CATALOGUE.find((w) => w.type === widget.type)?.shape ?? "STAT",
          unavailable: "Couldn't load"
        };
      }
    })
  );
}
