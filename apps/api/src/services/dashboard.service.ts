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
import { burnTotalsByCurrency, computeProjectBudgets, progressFromPlan } from "./budget.service.js";
import { buildPlan, dayKey, legacyCategory } from "./plan-schedule.service.js";
import { latestSnapshots } from "./project-risk.service.js";
import { loadWorkload } from "./workload.service.js";
import { istWeekStarts, weekIndexFor } from "./ticket-analytics.service.js";
import { OPEN_TICKET_STATUS } from "./workspace-metrics.js";
import { platformToday } from "../utils/date-window.js";
import { platformDayKey } from "../utils/platform-time.js";

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
  "MY_QUEUE",
  "PRIORITY_MIX",
  "PROJECT_MIX"
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
  // Labelled for what it counts. "Hours logged" over approved hours only read as the logged-hours
  // figure every other page shows (submitted + approved) and was not.
  { type: "HOURS_LOGGED", label: "Approved hours", shape: "STAT", description: "Approved hours in the period." },
  { type: "BUDGET_BURN", label: "Budget burn", shape: "STAT", description: "Spent against budget, from approved rate snapshots." },
  { type: "VELOCITY", label: "Created vs resolved", shape: "SERIES", description: "Weekly throughput." },
  { type: "STATUS_MIX", label: "Status mix", shape: "BREAKDOWN", description: "Where open work is sitting." },
  { type: "RISK_BANDS", label: "Project risk", shape: "BREAKDOWN", description: "How many projects are green, amber and red." },
  { type: "WORKLOAD_SUMMARY", label: "Capacity", shape: "STAT", description: "Booked against available capacity." },
  { type: "UPCOMING_MILESTONES", label: "Upcoming milestones", shape: "TABLE", description: "The next dated milestones." },
  { type: "MY_QUEUE", label: "My queue", shape: "TABLE", description: "What is assigned to the person viewing." },
  // Two more breakdowns over the same open-work definition STATUS_MIX uses, so the three tiles can
  // never disagree about what "open" means. Neither touches people, so neither needs the
  // inactive-user visibility rule.
  { type: "PRIORITY_MIX", label: "Priority mix", shape: "BREAKDOWN", description: "Open work by priority." },
  { type: "PROJECT_MIX", label: "Open work by project", shape: "BREAKDOWN", description: "Where open work sits across your projects." }
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

/** "7 Sept" — a week's Monday on the IST calendar, as the widget's axis label. */
function weekLabelShort(weekStart: Date): string {
  const [y, m, d] = platformDayKey(weekStart).split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "INR 42% (₹4,200 of ₹10,000)" — one currency's line of the budget-burn hint. */
function currencyBurnLine(t: { currency: string; burnPct: number | null; burn: number; budget: number }): string {
  return `${t.currency} ${t.burnPct ?? 0}% (${money(t.burn, t.currency)} of ${money(t.budget, t.currency)})`;
}

/** Money for a widget hint, in its own currency and the workspace's en-IN grouping. A tile used
 *  to print `toLocaleString()` with the server's locale and no symbol at all. */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

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

  switch (type) {
    case "OPEN_ITEMS": {
      const value = await prisma.ticket.count({
        where: { projectId: { in: scoped }, deletedAt: null, status: OPEN_TICKET_STATUS }
      });
      return { type, shape, value, hint: "not resolved or closed" };
    }

    case "OVERDUE_ITEMS": {
      const now = new Date();
      const value = await prisma.ticket.count({
        where: {
          projectId: { in: scoped },
          deletedAt: null,
          status: OPEN_TICKET_STATUS,
          // Either promise counts: the planned end date, or the SLA. They mean different things,
          // and a tile that only watched one would quietly under-report.
          //
          // `endDate` is a CALENDAR DAY (@db.Date): a ticket is late the day after it, so it is
          // compared with today's date — compared with `now`, it went overdue at 05:30 IST on the day
          // it was due. `dueAt` is an instant, and the SLA rule (workspace-metrics.ts) applies.
          OR: [{ endDate: { lt: platformToday(now) } }, { dueAt: { lt: now } }]
        }
      });
      return { type, shape, value, hint: "past a planned end date or an SLA" };
    }

    case "HOURS_LOGGED": {
      // Whole calendar days on the date column, ending today: `workDate >= now - N days` compared a
      // date with a timestamp, so it dropped the first day and let future-dated entries in.
      const today = platformToday();
      const agg = await prisma.timesheet.aggregate({
        where: {
          projectId: { in: scoped },
          status: "APPROVED",
          deletedAt: null,
          workDate: { gte: new Date(today.getTime() - (days - 1) * DAY_MS), lte: today }
        },
        _sum: { totalHours: true }
      });
      return { type, shape, value: Number(Number(agg._sum.totalHours ?? 0).toFixed(1)), unit: "h", hint: `approved, last ${days} days to today` };
    }

    case "BUDGET_BURN": {
      const plan = await buildPlan({ projectIds: scoped, includeClosed: true });
      // One id → project map, built once (budget.service.ts#progressFromPlan) — not a search of
      // every ticket for every item of every project.
      const { progressByProject } = progressFromPlan(plan, scoped);
      const budgets = await computeProjectBudgets(scoped, progressByProject);
      // Per currency, budgeted projects only: budgets in two currencies are never added, and burn on
      // a project with no budget is not a percentage of anybody's budget.
      const totals = burnTotalsByCurrency(budgets.values()).filter((t) => t.budgetedProjects > 0);
      if (totals.length === 0) return { type, shape, unavailable: "No budgets set" };
      if (totals.length > 1) {
        return {
          type,
          shape,
          value: null,
          unit: null,
          hint: totals.map(currencyBurnLine).join(" · ") + " — currencies are reported separately, never added"
        };
      }
      const [only] = totals;
      // Burn these budgeted projects billed in another currency: named beside the percentage, never
      // in it — there is no exchange rate to add it with.
      const elsewhere = new Map<string, number>();
      for (const b of budgets.values()) {
        if (b.budget === null || b.budget <= 0) continue;
        for (const o of b.otherCurrencyBurn ?? []) elsewhere.set(o.currency, (elsewhere.get(o.currency) ?? 0) + o.amount);
      }
      const elsewhereNote = [...elsewhere.entries()].map(([c, amount]) => ` · ${money(amount, c)} billed in ${c}, not counted`).join("");
      return {
        type,
        shape,
        value: only.burnPct,
        unit: "%",
        hint: `${money(only.burn, only.currency)} of ${money(only.budget, only.currency)} across ${only.budgetedProjects} budgeted project${only.budgetedProjects === 1 ? "" : "s"}${elsewhereNote}`
      };
    }

    case "VELOCITY": {
      // Whole Monday weeks on the IST calendar, the current one included — the same buckets the
      // Insights page draws. Rolling 7-day buckets from 30 days back left the oldest holding two days.
      const weekStarts = istWeekStarts(Math.ceil(days / 7), new Date());
      const from = weekStarts[0];
      const [created, resolved] = await Promise.all([
        prisma.ticket.findMany({
          where: { projectId: { in: scoped }, deletedAt: null, createdAt: { gte: from } },
          select: { createdAt: true }
        }),
        prisma.ticket.findMany({
          where: { projectId: { in: scoped }, deletedAt: null, resolvedAt: { gte: from } },
          select: { resolvedAt: true }
        })
      ]);
      const points = weekStarts.map((weekStart) => ({ label: weekLabelShort(weekStart), value: 0, secondary: 0 }));
      for (const c of created) {
        const i = weekIndexFor(c.createdAt, weekStarts);
        if (i >= 0) points[i].value += 1;
      }
      for (const r of resolved) {
        const i = r.resolvedAt ? weekIndexFor(r.resolvedAt, weekStarts) : -1;
        if (i >= 0) points[i].secondary += 1;
      }
      return { type, shape, points, hint: "created / resolved per week, weeks start Monday" };
    }

    case "STATUS_MIX": {
      const grouped = await prisma.ticket.groupBy({
        by: ["status"],
        where: { projectId: { in: scoped }, deletedAt: null, status: OPEN_TICKET_STATUS },
        _count: { _all: true }
      });
      return {
        type,
        shape,
        points: grouped.map((g) => ({ label: g.status.replace(/_/g, " ").toLowerCase(), value: g._count._all }))
      };
    }

    case "PRIORITY_MIX": {
      const grouped = await prisma.ticket.groupBy({
        by: ["priority"],
        where: { projectId: { in: scoped }, deletedAt: null, status: OPEN_TICKET_STATUS },
        _count: { _all: true }
      });
      // Fixed severity order, not count order: a tile that reshuffles as numbers move is harder to
      // read week over week than one where CRITICAL is always the first bar.
      const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
      return {
        type,
        shape,
        points: grouped
          .sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority))
          .map((g) => ({ label: g.priority.toLowerCase(), value: g._count._all }))
      };
    }

    case "PROJECT_MIX": {
      const [grouped, projects] = await Promise.all([
        prisma.ticket.groupBy({
          by: ["projectId"],
          where: { projectId: { in: scoped }, deletedAt: null, status: OPEN_TICKET_STATUS },
          _count: { _all: true }
        }),
        prisma.project.findMany({ where: { id: { in: scoped } }, select: { id: true, name: true } })
      ]);
      const nameOf = new Map(projects.map((p) => [p.id, p.name]));
      return {
        type,
        shape,
        points: grouped
          .map((g) => ({ label: nameOf.get(g.projectId) ?? g.projectId, value: g._count._all }))
          .sort((a, b) => b.value - a.value)
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
      // The viewer's own projects — the people assigned to them — not the whole workspace, which is
      // what a dashboard shared with a project lead used to show. A failure is NOT caught here:
      // resolveDashboard turns it into "Couldn't load", where `.catch(() => null)` used to turn it
      // into "Nobody assigned", a claim about the team rather than about the request.
      const today = platformToday();
      const board = await loadWorkload({ from: today, to: new Date(today.getTime() + 27 * DAY_MS), projectIds: scoped });
      if (board.rows.length === 0) return { type, shape, unavailable: "Nobody assigned" };
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
      // One person's open queue, sorted here by the promise that comes FIRST (planned end, else SLA),
      // undated work last. `orderBy dueAt asc` put every undated ticket at the top — MySQL sorts
      // NULLs first — and ignored the end date the row then displayed.
      const queue = await prisma.ticket.findMany({
        where: {
          projectId: { in: scoped },
          deletedAt: null,
          assigneeId: viewerId,
          status: OPEN_TICKET_STATUS
        },
        select: { key: true, title: true, priority: true, dueAt: true, endDate: true, status: true },
        take: 500
      });
      const promise = (r: { endDate: Date | null; dueAt: Date | null }) => (r.endDate ?? r.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
      const rows = [...queue].sort((a, b) => promise(a) - promise(b)).slice(0, 8);
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
