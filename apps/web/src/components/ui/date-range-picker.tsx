/**
 * WHAT: the date-range picker used everywhere the app asks for a from/to — presets down the side,
 * two months side by side, editable date fields and an explicit Apply.
 *
 * WHY PRESETS ARE THE MAIN EVENT, not a convenience: almost every range anybody actually wants is
 * one of eight ("this month", "last week"). Making those one click means the two-month grid is for
 * the rare custom case rather than the default path. It also removes a whole class of mistake —
 * picking the 1st and the 30th by hand and quietly missing the 31st.
 *
 * WHY APPLY IS EXPLICIT, and this is the decision that shapes the component: a range is two values,
 * and the moment after the first click the range is momentarily nonsense (start set, end still the
 * old one). Committing on every click would fire a query against that intermediate state — visible
 * to the user as the numbers on the page flickering to something wrong before settling. Cancel
 * restores what was there, so opening the picker to look is free.
 *
 * WHY IT REPLACED PAIRS OF `<input type="date">`: those were two independent fields with no
 * relationship. Nothing stopped `to` being before `from`, nothing offered "last month", and on iOS
 * each one opens a separate native wheel. Here the range is one value with one validity rule.
 */
import { useEffect, useMemo, useState } from "react";
import { CalendarDate, getLocalTimeZone, today } from "@internationalized/date";
import { CalendarIcon } from "lucide-react";

import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Calendar, CalendarHeader, RangeCalendar, RangeCalendarMonthGrid } from "./calendar-primitives";
import { cn } from "../../lib/utils";

export interface DateRangeValue {
  /** ISO yyyy-mm-dd, or empty for "unbounded". */
  from: string;
  to: string;
}

function toCalendarDate(iso: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new CalendarDate(y, m, d);
}

function toIso(date: CalendarDate | null | undefined): string {
  if (!date) return "";
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function formatDisplay(iso: string): string {
  const date = toCalendarDate(iso);
  if (!date) return "";
  return date.toDate(getLocalTimeZone()).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

/**
 * The presets, computed at open time rather than module load.
 *
 * Computing them once at import would freeze "today" for the life of the tab — a dashboard left
 * open overnight would offer yesterday's "This month" and silently report the wrong window.
 */
function buildPresets(): Array<{ label: string; range: () => DateRangeValue }> {
  const now = today(getLocalTimeZone());
  const startOfWeek = (date: CalendarDate) => date.subtract({ days: (date.toDate(getLocalTimeZone()).getDay() + 6) % 7 });

  return [
    { label: "Today", range: () => ({ from: toIso(now), to: toIso(now) }) },
    { label: "Yesterday", range: () => ({ from: toIso(now.subtract({ days: 1 })), to: toIso(now.subtract({ days: 1 })) }) },
    { label: "This week", range: () => ({ from: toIso(startOfWeek(now)), to: toIso(now) }) },
    {
      label: "Last week",
      range: () => {
        const lastWeekStart = startOfWeek(now).subtract({ weeks: 1 });
        return { from: toIso(lastWeekStart), to: toIso(lastWeekStart.add({ days: 6 })) };
      }
    },
    {
      label: "This month",
      range: () => ({ from: toIso(new CalendarDate(now.year, now.month, 1)), to: toIso(now) })
    },
    {
      label: "Last month",
      range: () => {
        const firstOfThis = new CalendarDate(now.year, now.month, 1);
        const lastMonthEnd = firstOfThis.subtract({ days: 1 });
        return { from: toIso(new CalendarDate(lastMonthEnd.year, lastMonthEnd.month, 1)), to: toIso(lastMonthEnd) };
      }
    },
    { label: "This year", range: () => ({ from: toIso(new CalendarDate(now.year, 1, 1)), to: toIso(now) }) },
    {
      label: "Last year",
      range: () => ({ from: toIso(new CalendarDate(now.year - 1, 1, 1)), to: toIso(new CalendarDate(now.year - 1, 12, 31)) })
    },
    // Empty strings mean "no bound", which every consumer's filter parser already treats as
    // "don't constrain this side".
    { label: "All time", range: () => ({ from: "", to: "" }) }
  ];
}

export interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** Shown when no range is set. */
  placeholder?: string;
  /** Hides the "All time" preset where an unbounded range is not meaningful — analytics, for
   *  instance, cannot compute utilisation without a period. */
  allowAllTime?: boolean;
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = "Select a date range",
  allowAllTime = true,
  id,
  className,
  disabled
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRangeValue>(value);

  // Re-seed only when the picker OPENS. Syncing on every change to `value` would fight the user
  // mid-edit the moment a parent re-rendered — the same bug that made the face-verification
  // settings appear not to save.
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const presets = useMemo(() => {
    const all = buildPresets();
    return allowAllTime ? all : all.filter((p) => p.label !== "All time");
  }, [allowAllTime]);

  const rangeValue = useMemo(() => {
    const start = toCalendarDate(draft.from);
    const end = toCalendarDate(draft.to);
    return start && end ? { start, end } : null;
  }, [draft.from, draft.to]);

  // Derived ENTIRELY from `value`, never from `draft`.
  //
  // It used to test `draft` and then render `value`, which meant opening the picker, choosing a
  // range and pressing Cancel left the trigger describing a range that had never been applied —
  // the button said "Start – Today" while the report was still showing everything. The rule is
  // simple and worth keeping: the trigger states what is COMMITTED. The draft only exists inside
  // the popover.
  const label =
    value.from || value.to
      ? `${formatDisplay(value.from) || "Start"} – ${formatDisplay(value.to) || "Today"}`
      : placeholder;

  const activePreset = presets.find((p) => {
    const r = p.range();
    return r.from === value.from && r.to === value.to;
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("h-9 justify-start gap-2 font-normal", !value.from && !value.to && "text-muted-foreground", className)}
        >
          <CalendarIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{activePreset && activePreset.label !== "All time" ? activePreset.label : label}</span>
        </Button>
      </PopoverTrigger>

      {/* Width is content-driven and the whole thing scrolls on small screens: two months plus a
          preset rail cannot fit a 390px phone, and squeezing them produces a grid too small to tap
          accurately. Below `sm` the second month is hidden rather than shrunk. */}
      <PopoverContent align="start" className="w-auto max-w-[min(46rem,calc(100vw-2rem))] overflow-x-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
            {presets.map((preset) => {
              const isActive = activePreset?.label === preset.label;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setDraft(preset.range())}
                  className={cn(
                    "focus-ring shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition",
                    isActive ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted"
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="min-w-0 p-3">
            <RangeCalendar
              aria-label="Select a date range"
              value={rangeValue}
              visibleDuration={{ months: 2 }}
              onChange={(next) =>
                setDraft({ from: toIso(next?.start as CalendarDate), to: toIso(next?.end as CalendarDate) })
              }
            >
              <CalendarHeader />
              <div className="flex gap-6">
                <RangeCalendarMonthGrid />
                {/* Second month is desktop-only — see the width note above. */}
                <div className="hidden md:block">
                  <RangeCalendarMonthGrid offset={{ months: 1 }} />
                </div>
              </div>
            </RangeCalendar>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                {draft.from || draft.to
                  ? `${formatDisplay(draft.from) || "Start"} – ${formatDisplay(draft.to) || "Today"}`
                  : "All time"}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    // Reset as well as close. The open-effect re-seeds anyway, but leaving a stale
                    // draft behind means any state derived from it is briefly wrong on the way out.
                    setDraft(value);
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onChange(draft);
                    setOpen(false);
                  }}
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { Calendar };
