/**
 * WHAT: two pickers sharing one calendar — a plain date picker, and a date+time picker that offers
 * a scrollable list of times beside the month.
 *
 * WHY THE TIME IS A LIST OF SLOTS RATHER THAN A FREE-TEXT FIELD: `<input type="time">` renders
 * completely differently in every browser (a spinner in Firefox, a wheel on iOS, a masked field in
 * Chrome), takes 24-hour input in some locales and 12-hour in others, and accepts 03:37 when the
 * thing being scheduled only ever happens on the half hour. A list of real choices is one tap, is
 * identical everywhere, and cannot produce a value the system does not want.
 *
 * WHY BOTH LIVE IN ONE FILE: they are the same widget with one column added. Splitting them meant
 * two calendars to keep in step, and the first thing to drift is always the day-cell states.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDate, Time, getLocalTimeZone, today } from "@internationalized/date";
import {
  DateInput as AriaDateInput,
  DateSegment as AriaDateSegment,
  TimeField as AriaTimeField
} from "react-aria-components";
import { CalendarIcon } from "lucide-react";

import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Calendar, CalendarHeader, CalendarMonthGrid, type CalendarDayAnnotations } from "./calendar-primitives";
import { cn } from "../../lib/utils";

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

/** "14:30" -> "2:30 PM", in the reader's own locale. */
export function formatTimeLabel(value: string): string {
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h)) return value;
  const date = new Date();
  date.setHours(h, m || 0, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Every `stepMinutes` slot between two 24-hour times, inclusive of the start. */
export function buildTimeSlots(from = "09:00", to = "18:00", stepMinutes = 30): string[] {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const slots: string[] = [];
  for (let mins = fh * 60 + fm; mins <= th * 60 + tm; mins += stepMinutes) {
    slots.push(`${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
  }
  return slots;
}

interface BasePickerProps {
  id?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  /** ISO yyyy-mm-dd. Dates after this are not selectable. */
  maxValue?: string;
  minValue?: string;
}

/* ------------------------------------------------------------------ date only */

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  id,
  className,
  disabled,
  minValue,
  maxValue,
  dayAnnotations
}: BasePickerProps & {
  value: string;
  onChange: (iso: string) => void;
  /** Per-date hover summaries (dot + count card) — see CalendarDayAnnotations. */
  dayAnnotations?: CalendarDayAnnotations;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("h-10 w-full justify-start gap-2 font-normal", !value && "text-muted-foreground", className)}
        >
          <CalendarIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{value ? formatDisplay(value) : placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <Calendar
          aria-label={placeholder}
          value={toCalendarDate(value)}
          minValue={minValue ? toCalendarDate(minValue) ?? undefined : undefined}
          maxValue={maxValue ? toCalendarDate(maxValue) ?? undefined : undefined}
          onChange={(next) => {
            onChange(toIso(next as CalendarDate));
            // A single date is complete the moment it is clicked, so there is nothing to confirm.
            // Only the range and date+time pickers need an Apply, because they are not finished
            // after one interaction.
            setOpen(false);
          }}
        >
          <CalendarHeader />
          <CalendarMonthGrid annotations={dayAnnotations} />
        </Calendar>
        <div className="mt-2 flex justify-between border-t border-border pt-2">
          <Button variant="ghost" size="sm" onClick={() => { onChange(toIso(today(getLocalTimeZone()))); setOpen(false); }}>
            Today
          </Button>
          {value && (
            <Button variant="ghost" size="sm" onClick={() => { onChange(""); setOpen(false); }}>
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ date + time */

export function DateTimePicker({
  date,
  time,
  onChange,
  slots,
  placeholder = "Pick a date and time",
  id,
  className,
  disabled,
  minValue,
  maxValue,
  minDateTime
}: BasePickerProps & {
  /** ISO yyyy-mm-dd. */
  date: string;
  /** 24-hour HH:mm. */
  time: string;
  onChange: (next: { date: string; time: string }) => void;
  /** Defaults to every half hour of a 9-6 day. */
  slots?: string[];
  /**
   * The earliest moment this picker may express, as a local `YYYY-MM-DDTHH:mm`.
   *
   * `minValue` already stops the CALENDAR offering an earlier day. This is the other half: on the
   * floor's own day, the time slots before it are offered too, so a maintenance window could be
   * scheduled to start at 09:00 on a day when it is already 14:00 — the server refuses it, but
   * only after the admin has picked it, read a plausible-looking form, and pressed Save.
   *
   * Past slots are DISABLED rather than hidden, matching how the calendar treats past dates: a
   * greyed row says "not that one", a missing row says nothing and quietly renumbers the list.
   */
  minDateTime?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ date, time });

  // Seeded on open only — never on every render — so a parent re-render cannot discard a
  // half-finished choice.
  useEffect(() => {
    if (open) setDraft({ date, time });
  }, [open, date, time]);

  const timeSlots = useMemo(() => {
    const base = slots ?? buildTimeSlots();
    // If the CURRENT value is not on the grid, keep it as an option.
    //
    // Without this, opening the picker on an existing 02:15 window silently offers no way to keep
    // it: the value is not in the list, so nothing is highlighted, and pressing Apply after
    // touching anything else would round it to a slot the user never chose. A picker must always
    // be able to express the value it was handed.
    if (draft.time && !base.includes(draft.time)) {
      return [...base, draft.time].sort();
    }
    return base;
  }, [slots, draft.time]);

  /**
   * Which slots the floor rules out, and whether any are.
   *
   * Only ever applies ON the floor's own date — a later date has no earlier moment to be before.
   * `HH:mm` strings compare correctly with `<` (zero-padded, 24-hour), so no parsing is needed.
   *
   * THE VALUE THE PICKER WAS HANDED IS ALWAYS ALLOWED, even when it is below the floor. An
   * already-running maintenance window legitimately started in the past, and the server says so
   * explicitly — a picker that refuses to re-express the value it was opened on would make
   * editing that window's END impossible.
   */
  const [minDate, minTime] = minDateTime ? minDateTime.split("T") : [undefined, undefined];
  const isBlockedSlot = (slot: string) =>
    Boolean(minDate && minTime) && draft.date === minDate && slot < minTime! && slot !== time;
  const blockedCount = timeSlots.filter(isBlockedSlot).length;

  /**
   * Open the list on the first slot the user can actually pick.
   *
   * Without this the floor makes the picker WORSE than it was: at 3pm the list opens on 12:00 AM
   * and the admin scrolls past thirty greyed rows to reach anything live. Runs when the popover
   * opens and whenever the chosen date changes, because both change which slot is first.
   *
   * `block: "start"` on the container's own scroller rather than `scrollIntoView` on the element:
   * the latter also scrolls the PAGE behind the popover, which drags the trigger out from under
   * the floating panel.
   */
  const slotListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const list = slotListRef.current;
    if (!list) return;
    const target = list.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (!target) return;
    list.scrollTop = Math.max(0, target.offsetTop - list.offsetTop);
    // `draft.date` is listed deliberately even though the body never reads it: the effect must
    // re-aim the list when the chosen day changes, not only when the panel opens.
  }, [open, draft.date]);

  const label = date
    ? `${formatDisplay(date)}${time ? ` · ${formatTimeLabel(time)}` : ""}`
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("h-10 w-full justify-start gap-2 font-normal", !date && "text-muted-foreground", className)}
        >
          <CalendarIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="p-3">
            <Calendar
              aria-label="Choose a date"
              value={toCalendarDate(draft.date)}
              minValue={minValue ? toCalendarDate(minValue) ?? undefined : undefined}
              maxValue={maxValue ? toCalendarDate(maxValue) ?? undefined : undefined}
              onChange={(next) => setDraft((d) => ({ ...d, date: toIso(next as CalendarDate) }))}
            >
              <CalendarHeader />
              <CalendarMonthGrid />
            </Calendar>
          </div>

          <div className="flex min-w-0 flex-col border-t border-border sm:w-44 sm:border-l sm:border-t-0">
            <p className="px-3 pt-3 text-sm font-semibold">Available times</p>
            {/* Capped height with its own scroll: a full day of half-hours is 48 rows, and letting
                that grow the popover pushes the Apply button off a laptop screen. */}
            <div ref={slotListRef} className="max-h-56 min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
              {timeSlots.map((slot) => {
                const blocked = isBlockedSlot(slot);
                return (
                  <button
                    key={slot}
                    type="button"
                    disabled={blocked}
                    title={blocked ? "That time has already passed today." : undefined}
                    onClick={() => setDraft((d) => ({ ...d, time: slot }))}
                    className={cn(
                      "focus-ring w-full rounded-md border px-3 py-2 text-sm transition",
                      blocked
                        ? "cursor-not-allowed border-dashed border-border text-muted-foreground/50"
                        : draft.time === slot
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-muted"
                    )}
                  >
                    {formatTimeLabel(slot)}
                  </button>
                );
              })}
            </div>
            {/* Says WHY rows are greyed, once, instead of leaving the reader to infer it from a
                run of disabled buttons. Only while some actually are. */}
            {blockedCount > 0 && (
              <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                Earlier times today have already passed.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft((d) => ({ ...d, date: toIso(today(getLocalTimeZone())) }))}
          >
            Today
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              // A date with no time is not a datetime. Refusing to apply is clearer than applying
              // half of one and letting the caller discover the gap. A blocked slot cannot be
              // clicked, but the draft can still hold one if the date changed under it — so the
              // floor is enforced here too rather than trusted to the buttons.
              disabled={!draft.date || !draft.time || isBlockedSlot(draft.time)}
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ time only */

/**
 * A segmented time field — hh : mm with an AM/PM segment in locales that use one.
 *
 * WHY THIS AND NOT THE SLOT LIST ABOVE: timesheet start/end times accept any `HH:mm` the server's
 * regex allows, and people really do log 09:15–10:45. Offering half-hour slots here would quietly
 * make a currently-valid entry impossible, which is a data-entry regression dressed as a design
 * improvement. The slot list belongs where the domain genuinely has fixed slots.
 *
 * WHY NOT LEAVE `<input type="time">`: it renders as a spinner in Firefox, a wheel on iOS and a
 * masked field in Chrome, and its 12/24-hour behaviour follows the OS rather than the app. This is
 * the same control everywhere, arrow keys step each segment, and it still emits plain `HH:mm`.
 */
export function TimeField({
  value,
  onChange,
  id,
  className,
  disabled,
  "aria-label": ariaLabel
}: {
  /** 24-hour HH:mm. */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const parsed = /^\d{1,2}:\d{2}$/.test(value) ? new Time(Number(value.split(":")[0]), Number(value.split(":")[1])) : null;

  return (
    <AriaTimeField
      id={id}
      aria-label={ariaLabel ?? "Time"}
      value={parsed}
      isDisabled={disabled}
      hourCycle={12}
      onChange={(next) =>
        onChange(next ? `${String(next.hour).padStart(2, "0")}:${String(next.minute).padStart(2, "0")}` : "")
      }
      className={cn("w-full", className)}
    >
      <AriaDateInput
        className={cn(
          "focus-within:ring-ring flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm",
          "focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-background",
          disabled && "cursor-not-allowed opacity-60"
        )}
      >
        {(segment) => (
          <AriaDateSegment
            segment={segment}
            className={cn(
              "rounded px-0.5 tabular-nums outline-none",
              "focus:bg-primary focus:text-primary-foreground",
              // React Aria renders unfilled segments as placeholder text; without this they look
              // like real values and people submit "hh:mm".
              segment.isPlaceholder && "text-muted-foreground"
            )}
          />
        )}
      </AriaDateInput>
    </AriaTimeField>
  );
}
