/**
 * WHAT: the month calendar view of work items — a 6×7 grid of days, each carrying the items
 * scheduled on it.
 *
 * WHY IT DISTINGUISHES "SCHEDULED" FROM "DUE": for most workspaces on day one, the only date a
 * ticket has is its SLA `dueAt`. A calendar that only plotted planned dates would look empty and
 * read as broken; one that plotted SLA dates as though they were commitments would be lying. So
 * both appear, and an unscheduled item is visually marked — the chip is outlined rather than
 * filled, and its tooltip says which date it is sitting on.
 *
 * WHY A MONTH GRID AND NOT A WEEK/AGENDA TOGGLE: the timeline already answers "what is happening
 * over the next quarter" far better than a week view would, and an agenda list is what "My work"
 * is. A month is the one shape neither of those covers.
 *
 * WHO renders this: the Calendar tab of `pages/Tickets.tsx`.
 */
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../lib/utils";
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

const CATEGORY_DOT: Record<WorkStatusCategoryValue, string> = {
  TODO: "bg-muted-foreground",
  ACTIVE: "bg-info",
  REVIEW: "bg-warning",
  DONE: "bg-success",
  CANCELLED: "bg-destructive"
};

/** Month grid always starts on a Monday and always renders 6 rows, so the grid never reflows
 *  between months — a calendar that changes height as you page through it is disorienting. */
function gridStart(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const dow = (first.getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(first, -dow);
}

export function PlanCalendar({
  items,
  year,
  month,
  onMonthChange,
  onOpenItem
}: {
  items: CalendarItemRow[];
  year: number;
  month: number;
  onMonthChange: (year: number, month: number) => void;
  onOpenItem?: (id: string) => void;
}) {
  const start = useMemo(() => gridStart(year, month), [year, month]);
  const today = dayKey(new Date());

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

  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(start, i)), [start]);

  const step = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1));
    onMonthChange(next.getUTCFullYear(), next.getUTCMonth());
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {MONTHS[month]} {year}
        </h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => step(-1)} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const now = new Date();
              onMonthChange(now.getUTCFullYear(), now.getUTCMonth());
            }}
          >
            Today
          </Button>
          <Button size="sm" variant="outline" onClick={() => step(1)} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* The grid owns its own horizontal scroll below sm — seven columns cannot go narrower than
          legibility allows, and the page must never scroll sideways (see index.css). */}
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-7 border-b border-border">
            {WEEKDAYS.map((d) => (
              <div key={d} className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell) => {
              const key = dayKey(cell);
              const inMonth = cell.getUTCMonth() === month;
              const dayItems = byDay.get(key) ?? [];
              const isToday = key === today;
              return (
                <div
                  key={key}
                  className={cn(
                    "min-h-[92px] border-b border-r border-border p-1.5",
                    !inMonth && "bg-muted/30",
                    isToday && "bg-accent/10"
                  )}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={cn(
                        "text-xs tabular-nums",
                        inMonth ? "text-foreground" : "text-muted-foreground/60",
                        isToday && "grid h-5 w-5 place-items-center rounded-full bg-accent font-semibold text-accent-foreground"
                      )}
                    >
                      {cell.getUTCDate()}
                    </span>
                    {dayItems.length > 3 && (
                      <span className="text-[10px] text-muted-foreground">+{dayItems.length - 3}</span>
                    )}
                  </div>
                  <div className="grid gap-1">
                    {dayItems.slice(0, 3).map((item) => (
                      <Tooltip key={`${key}-${item.id}`}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => onOpenItem?.(item.id)}
                            className={cn(
                              "flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px]",
                              // Filled = a real scheduled date. Outlined = only an SLA date, i.e.
                              // nobody has actually planned this yet.
                              item.isScheduled
                                ? "bg-primary/10 text-foreground hover:bg-primary/20"
                                : "border border-dashed border-border text-muted-foreground hover:bg-muted"
                            )}
                          >
                            {item.isMilestone ? (
                              <Diamond className="h-2.5 w-2.5 shrink-0 text-plan-today" />
                            ) : (
                              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CATEGORY_DOT[item.statusCategory])} />
                            )}
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
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-primary/20" /> Scheduled
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
