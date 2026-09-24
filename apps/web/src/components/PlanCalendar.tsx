/**
 * WHAT: the month calendar view of work items — a 6×7 grid of days, each carrying the items
 * scheduled on it. Styled after Untitled UI's calendar month view, drawn with this app's tokens.
 *
 * WHY IT DISTINGUISHES "SCHEDULED" FROM "DUE": for most workspaces on day one, the only date a
 * ticket has is its SLA `dueAt`. A calendar that only plotted planned dates would look empty and
 * read as broken; one that plotted SLA dates as though they were commitments would be lying. So
 * both appear, and an unscheduled item is visually distinct — a dashed outline rather than a
 * coloured chip, and its tooltip says which date it is actually sitting on.
 *
 * WHY CHIPS ARE COLOURED BY STATUS CATEGORY: the reference design colours events by calendar
 * (work/personal/…), which is its one categorical axis. Ours is delivery state — a month where
 * every chip is amber is a review bottleneck you can see from across the room, which a single
 * brand-coloured wash of chips cannot show. Same visual language, meaningful axis.
 *
 * WHY THE WEEK STARTS ON MONDAY when the reference shows Sunday: every weekly figure in this app
 * (reports, AI usage, workload buckets) keys weeks to Monday. A calendar that disagreed with the
 * reports about which week a Friday belongs to would be a worse fidelity failure than diverging
 * from a screenshot.
 *
 * V12 3.19 (source: the reference's Calendar view has Day / Week / Month periods and "drag and
 * drop existing tasks on the calendar to change their dates"): a WEEK period — one row of seven
 * taller cells, so a busy week is readable chip by chip — and drag-to-reschedule when the page
 * passes `onReschedule` (it does so only for people with plan:write). The arithmetic of a drop
 * lives in lib/calendar-drag.ts. Drag is pointer-only (HTML5 DnD, like the Timeline's bars);
 * keyboard users change dates in the ticket sheet's Plan tab, which is where the dates are shown.
 *
 * WHO renders this: the Calendar tab of `pages/Tickets.tsx`.
 */

export type CalendarPeriod = "month" | "week" | "4days" | "day";
/** Columns each linear period shows; month is the 6×7 grid and is handled apart. */
const SPAN: Record<Exclude<CalendarPeriod, "month">, number> = { week: 7, "4days": 4, day: 1 };
const PERIOD_LABEL: Record<CalendarPeriod, string> = { day: "Day", "4days": "4 days", week: "Week", month: "Month" };
const SPAN_GRID: Record<number, string> = { 7: "grid-cols-7", 4: "grid-cols-4", 1: "grid-cols-1" };
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { addDaysKey, shiftSchedule, weekDays, type SchedulePatch } from "../lib/calendar-drag";
import type { CalendarItemRow, WorkStatusCategoryValue } from "../services/api";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const toDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_PER_DAY);

/** Chip tints per delivery state — the calendar's categorical axis. Tinted background + coloured
 *  text, matching the reference chips, from the same tokens the Kanban and reports already use so
 *  "amber means review" stays true across the whole product. */
const CATEGORY_CHIP: Record<WorkStatusCategoryValue, string> = {
  TODO: "bg-muted text-muted-foreground hover:bg-muted/80",
  ACTIVE: "bg-info/10 text-info-ink hover:bg-info/20",
  REVIEW: "bg-warning/10 text-warning-ink hover:bg-warning/20",
  DONE: "bg-success/10 text-success-ink hover:bg-success/20",
  CANCELLED: "bg-destructive/10 text-destructive-ink hover:bg-destructive/20"
};

/** How many chips a cell shows before folding the rest into "N more…". Three keeps the tallest
 *  realistic month cell within the fixed row height; a week cell has the whole height to itself. */
const MAX_CHIPS_PER_DAY = 3;
const MAX_CHIPS_PER_WEEK_DAY = 12;

/** Month grid always starts on a Monday and always renders 6 rows, so the grid never reflows
 *  between months — a calendar that changes height as you page through it is disorienting. */
function gridStart(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const dow = (first.getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(first, -dow);
}

/** "Wed 16 Sep 2026" for a single day, "14 Sep – 20 Sep 2026" for a strip. */
function stripRange(cells: Date[]): string {
  const first = cells[0];
  const last = cells[cells.length - 1];
  const mon = (d: Date) => MONTHS[d.getUTCMonth()].slice(0, 3);
  if (cells.length === 1) return `${WEEKDAYS[(first.getUTCDay() + 6) % 7]} ${first.getUTCDate()} ${mon(first)} ${first.getUTCFullYear()}`;
  return `${first.getUTCDate()} ${mon(first)} – ${last.getUTCDate()} ${mon(last)} ${last.getUTCFullYear()}`;
}

export function PlanCalendar({
  items,
  year,
  month,
  onMonthChange,
  onOpenItem,
  period = "month",
  onPeriodChange,
  weekAnchor,
  onWeekAnchorChange,
  onReschedule
}: {
  items: CalendarItemRow[];
  year: number;
  month: number;
  onMonthChange: (year: number, month: number) => void;
  onOpenItem?: (id: string) => void;
  /** Month (default) or one week. The control is shown only when `onPeriodChange` is passed. */
  period?: CalendarPeriod;
  onPeriodChange?: (period: CalendarPeriod) => void;
  /** YYYY-MM-DD inside the week to show; required for the week period. */
  weekAnchor?: string;
  onWeekAnchorChange?: (day: string) => void;
  /** Passed only when the viewer may plan: chips become draggable and days accept drops. */
  onReschedule?: (id: string, patch: SchedulePatch) => void;
}) {
  const start = useMemo(() => gridStart(year, month), [year, month]);
  const now = new Date();
  const today = dayKey(now);
  // 7.1: Day / 4 days / Week are one linear strip of `span` columns anchored on `weekAnchor`
  // (Week snaps to Monday, the others start on the anchor); Month keeps its 6×7 grid.
  const isWeek = period !== "month" && Boolean(weekAnchor);
  const span = isWeek ? SPAN[period as Exclude<CalendarPeriod, "month">] : 7;
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const maxChips = isWeek ? MAX_CHIPS_PER_WEEK_DAY : MAX_CHIPS_PER_DAY;

  const dropOn = (day: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverDay(null);
    if (!onReschedule) return;
    const item = itemsById.get(e.dataTransfer.getData("text/plain"));
    if (!item) return;
    const patch = shiftSchedule(item, day);
    if (patch) onReschedule(item.id, patch);
  };
  /** Drop-target handlers for one day; nothing at all when the viewer cannot plan. */
  const dropTargetProps = (key: string) =>
    onReschedule
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            if (dragOverDay !== key) setDragOverDay(key);
          },
          onDragLeave: () => setDragOverDay((d) => (d === key ? null : d)),
          onDrop: (e: React.DragEvent) => dropOn(key, e)
        }
      : {};
  const dragSourceProps = (id: string) =>
    onReschedule
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData("text/plain", id);
            e.dataTransfer.effectAllowed = "move";
          }
        }
      : {};

  /**
   * An item occupies every day it SPANS, not just its start — a two-week task must be visible in
   * the second week or the calendar implies it finished on day one. Items without real dates
   * appear on their anchor day only.
   */
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItemRow[]>();
    const push = (key: string, item: CalendarItemRow) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    };
    for (const item of items) {
      if (item.isScheduled && item.startDate && item.endDate) {
        let cursor = toDay(item.startDate);
        const end = toDay(item.endDate);
        // Bounded: a mis-entered decade-long task must not build a 3,650-entry map per render.
        for (let i = 0; cursor <= end && i < 400; i++) {
          push(dayKey(cursor), item);
          cursor = addDays(cursor, 1);
        }
      } else {
        push(item.anchorDate, item);
      }
    }
    return map;
  }, [items]);

  const cells = useMemo(() => {
    if (!isWeek) return Array.from({ length: 42 }, (_, i) => addDays(start, i));
    if (span === 7) return weekDays(weekAnchor!).map(toDay);
    return Array.from({ length: span }, (_, i) => toDay(addDaysKey(weekAnchor!, i)));
  }, [isWeek, span, weekAnchor, start]);

  const step = (delta: number) => {
    if (isWeek) {
      onWeekAnchorChange?.(addDaysKey(weekAnchor!, span * delta));
      return;
    }
    const next = new Date(Date.UTC(year, month + delta, 1));
    onMonthChange(next.getUTCFullYear(), next.getUTCMonth());
  };
  const goToday = () => {
    onMonthChange(now.getUTCFullYear(), now.getUTCMonth());
    if (isWeek) onWeekAnchorChange?.(today);
  };
  const weekRange = isWeek ? stripRange(cells) : null;

  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const viewingCurrentMonth = now.getUTCFullYear() === year && now.getUTCMonth() === month;

  return (
    <div className="grid min-w-0 gap-3">
      {/* Header, after the reference: a date badge, the month with its full range underneath, and
          a segmented prev|Today|next. Wraps below sm instead of shrinking the tap targets. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border bg-background shadow-sm"
          >
            <span className="text-[9px] font-bold uppercase leading-none tracking-widest text-primary">
              {MONTHS[month].slice(0, 3)}
            </span>
            {/* Today's day-of-month in its own month, the 1st elsewhere — a badge that always said
                today's number while showing March would claim a date that is not on screen. */}
            <span className="text-lg font-black leading-tight tabular-nums">
              {viewingCurrentMonth ? now.getUTCDate() : 1}
            </span>
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {MONTHS[month]} {year}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {weekRange ?? `1 ${MONTHS[month].slice(0, 3)} ${year} – ${lastOfMonth} ${MONTHS[month].slice(0, 3)} ${year}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onPeriodChange && (
            <div role="radiogroup" aria-label="Calendar period" className="flex items-center rounded-lg border border-border shadow-sm">
              {(["day", "4days", "week", "month"] as const).map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant="ghost"
                  role="radio"
                  aria-checked={period === p}
                  className={cn("h-[44px] rounded-none first:rounded-l-lg last:rounded-r-lg", period === p && "bg-muted font-semibold")}
                  onClick={() => onPeriodChange(p)}
                >
                  {PERIOD_LABEL[p]}
                </Button>
              ))}
            </div>
          )}
          <div className="flex items-center rounded-lg border border-border shadow-sm">
            <Button size="sm" variant="ghost" className="h-[44px] rounded-r-none" onClick={() => step(-1)} aria-label={isWeek ? `Previous ${PERIOD_LABEL[period].toLowerCase()}` : "Previous month"}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="h-[44px] rounded-none border-x border-border font-semibold" onClick={goToday}>
              Today
            </Button>
            <Button size="sm" variant="ghost" className="h-[44px] rounded-l-none" onClick={() => step(1)} aria-label={isWeek ? `Next ${PERIOD_LABEL[period].toLowerCase()}` : "Next month"}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* The grid owns its own horizontal scroll below sm — seven columns cannot go narrower than
          legibility allows, and the page must never scroll sideways (see index.css). */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className={cn(span === 7 ? "min-w-[640px]" : "min-w-0")}>
          <div className={cn("grid border-b border-border bg-muted/30", SPAN_GRID[span])}>
            {(isWeek && span < 7 ? cells : null)?.map((c) => (
              // Day and 4-day strips label each column with its date; the week and month grids
              // keep the plain weekday row since the date sits in the cell.
              <div key={dayKey(c)} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                {WEEKDAYS[(c.getUTCDay() + 6) % 7]} {c.getUTCDate()}
              </div>
            )) ??
              WEEKDAYS.map((d) => (
                <div key={d} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                  {d}
                </div>
              ))}
          </div>
          <div className={cn("grid", SPAN_GRID[span])} data-calendar-period={isWeek ? period : "month"}>
            {cells.map((cell, index) => {
              const key = dayKey(cell);
              const inMonth = isWeek || cell.getUTCMonth() === month;
              const dayItems = byDay.get(key) ?? [];
              const isToday = key === today;
              const overflow = dayItems.length - maxChips;
              return (
                <div
                  key={key}
                  data-calendar-day={key}
                  {...dropTargetProps(key)}
                  className={cn(
                    isWeek ? "min-h-[360px]" : "min-h-[104px]",
                    "border-b border-r border-border p-1.5 transition-shadow last:border-r-0",
                    span === 7 && "[&:nth-child(7n)]:border-r-0",
                    (isWeek || index >= 35) && "border-b-0",
                    !inMonth && "bg-muted/20",
                    dragOverDay === key && "ring-2 ring-inset ring-primary"
                  )}
                >
                  <div className="mb-1 flex justify-center">
                    <span
                      className={cn(
                        "grid h-6 w-6 place-items-center rounded-full text-xs tabular-nums",
                        inMonth ? "text-foreground" : "text-muted-foreground/50",
                        isToday && "bg-primary font-semibold text-primary-foreground"
                      )}
                    >
                      {cell.getUTCDate()}
                    </span>
                  </div>
                  <div className="grid gap-1">
                    {dayItems.slice(0, maxChips).map((item) => (
                      <Tooltip key={`${key}-${item.id}`}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => onOpenItem?.(item.id)}
                            {...dragSourceProps(item.id)}
                            data-calendar-chip={item.id}
                            className={cn(
                              onReschedule && "cursor-grab active:cursor-grabbing",
                              "flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium transition",
                              // Coloured chip = a real scheduled date, tinted by delivery state.
                              // Dashed outline = only an SLA date; nobody has planned this yet,
                              // and dressing it as a commitment would be lying.
                              item.isScheduled
                                ? CATEGORY_CHIP[item.statusCategory]
                                : "border border-dashed border-border font-normal text-muted-foreground hover:bg-muted",
                              // Neighbouring-month chips stay visible but recede, so the month
                              // being read keeps the visual weight.
                              !inMonth && "opacity-50"
                            )}
                          >
                            {item.isMilestone && <Diamond className="h-2.5 w-2.5 shrink-0 text-plan-today" />}
                            <span className="truncate">{item.title}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs font-medium">
                            {item.key} — {item.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.isScheduled
                              ? `Scheduled ${item.startDate ?? "?"} → ${item.endDate ?? "?"}`
                              : `Not scheduled — shown on its SLA date (${item.dueAt})`}
                          </p>
                          {item.project && <p className="text-xs text-muted-foreground">{item.project.code}</p>}
                        </TooltipContent>
                      </Tooltip>
                    ))}
                    {overflow > 0 && (
                      <span className="px-1.5 text-[11px] text-muted-foreground">
                        {overflow} more…
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-info/20" /> Scheduled — coloured by status
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-border" /> SLA date only
        </span>
        <span className="inline-flex items-center gap-1">
          <Diamond className="h-3 w-3 text-plan-today" /> Milestone
        </span>
        {items.length === 0 && <Badge variant="outline">Nothing in this window</Badge>}
      </div>
    </div>
  );
}
