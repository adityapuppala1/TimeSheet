/**
 * WHAT: the shared calendar grid every date surface in the app is built from — one month, one set
 * of day cells, one keyboard model.
 *
 * WHY REACT ARIA UNDERNEATH: a calendar grid is one of the few widgets where hand-rolled
 * accessibility is reliably wrong. It needs roving tabindex across a 2-D grid, arrow keys that
 * cross week and month boundaries, PageUp/PageDown for months, Home/End for week edges, correct
 * `role="grid"` semantics, and a live region announcing the month when it changes. React Aria ships
 * all of that, tested against real screen readers. We supply the styling.
 *
 * WHY IT IS STYLED WITH THIS APP'S TOKENS RATHER THAN A VENDOR'S: the design follows Untitled UI's
 * date pickers, but every colour here is one of the app's existing HSL custom properties. That is
 * what makes dark mode work on day one and keeps a date picker from looking like it was pasted in
 * from another product. It also means no Tailwind v4 migration — Untitled UI's own package needs
 * v4.3 and this app is on v3.4, which would have been a framework migration across every screen.
 *
 * WHY `@internationalized/date` AND NOT `Date`: JS `Date` is a timestamp, and a calendar deals in
 * calendar days. Mixing them is how a date picker lands on the wrong day for anyone east of UTC —
 * the exact class of bug the app already documents in localIsoDate(). `CalendarDate` has no time
 * and no zone, so "4 August" stays 4 August everywhere.
 */
import { type ReactNode } from "react";
import {
  Button as AriaButton,
  Calendar as AriaCalendar,
  CalendarCell as AriaCalendarCell,
  CalendarGrid as AriaCalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  Heading,
  RangeCalendar as AriaRangeCalendar
} from "react-aria-components";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "../../lib/utils";

/** Chevron month-stepper, shared so both calendars step identically. */
export function CalendarNavButton({ slot, children }: { slot: "previous" | "next"; children: ReactNode }) {
  return (
    <AriaButton
      slot={slot}
      className={cn(
        "focus-ring grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition",
        "hover:bg-muted hover:text-foreground",
        // React Aria marks a stepper disabled when it would leave the allowed range. Without this
        // the button looks live and does nothing, which reads as the calendar being broken.
        "disabled:pointer-events-none disabled:opacity-40"
      )}
    >
      {children}
    </AriaButton>
  );
}

export function CalendarHeader({ className }: { className?: string }) {
  return (
    <header className={cn("flex items-center justify-between px-1 pb-3", className)}>
      <CalendarNavButton slot="previous">
        <ChevronLeft className="h-4 w-4" />
      </CalendarNavButton>
      {/* React Aria renders the month name here and announces it on change. */}
      <Heading className="text-sm font-semibold" />
      <CalendarNavButton slot="next">
        <ChevronRight className="h-4 w-4" />
      </CalendarNavButton>
    </header>
  );
}

/**
 * Day-cell styling shared by the single and range calendars.
 *
 * The state order matters and is deliberate: selection beats today beats hover. A cell that is both
 * today and selected must read as selected — otherwise the "today" ring competes with the thing the
 * user just chose, and on a range the endpoints stop being obvious.
 */
const cellClass = ({
  isSelected,
  isSelectionStart,
  isSelectionEnd,
  isDisabled,
  isUnavailable,
  isOutsideMonth,
  isToday,
  inRange
}: {
  isSelected?: boolean;
  isSelectionStart?: boolean;
  isSelectionEnd?: boolean;
  isDisabled?: boolean;
  isUnavailable?: boolean;
  isOutsideMonth?: boolean;
  isToday?: boolean;
  inRange?: boolean;
}) =>
  cn(
    "relative grid h-9 w-9 cursor-pointer select-none place-items-center rounded-full text-sm outline-none transition",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    !isSelected && !inRange && "hover:bg-muted",
    // Days from the neighbouring month are shown but muted: hiding them makes the grid ragged, and
    // a person scanning for "the 1st" needs to see where the month actually begins.
    isOutsideMonth && "text-muted-foreground/40",
    isToday && !isSelected && "font-semibold text-primary ring-1 ring-inset ring-primary/40",
    inRange && !isSelectionStart && !isSelectionEnd && "rounded-none bg-primary/10 text-foreground",
    (isSelected || isSelectionStart || isSelectionEnd) && "bg-primary font-semibold text-primary-foreground",
    // Range endpoints keep their round edge on the outer side only, so the middle reads as one bar.
    isSelectionStart && !isSelectionEnd && "rounded-l-full rounded-r-none",
    isSelectionEnd && !isSelectionStart && "rounded-r-full rounded-l-none",
    (isDisabled || isUnavailable) && "cursor-not-allowed text-muted-foreground/30 hover:bg-transparent",
    isUnavailable && "line-through"
  );

const gridHeaderClass = "pb-1 text-xs font-medium text-muted-foreground";

/* ------------------------------------------------------------- day annotations */

/** One date's hover summary — a titled list of colored count rows ("Approved 3"). */
export interface CalendarDayAnnotation {
  /** Headline of the hover card, e.g. "4 entries". */
  title: string;
  rows: Array<{ label: string; count: number; dotClassName: string }>;
}

/** Keyed by ISO `yyyy-mm-dd`. Sparse: only dates that have something to say appear. */
export type CalendarDayAnnotations = Record<string, CalendarDayAnnotation>;

function annotationKey(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/**
 * The dot under the day number plus the hover/focus count card. Rendered inside the cell (which
 * gets `group` when annotated) so hover and keyboard focus both reveal it with zero JS state.
 * `aria-hidden` on the card: it duplicates counts the pages already present accessibly, and
 * injecting it into the cell's accessible name would fight React Aria's own date announcement.
 */
function DayAnnotationOverlay({ annotation }: { annotation: CalendarDayAnnotation }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute bottom-[3px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary group-data-[selected]:bg-primary-foreground/90"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden w-max min-w-[8.5rem] -translate-x-1/2 rounded-lg border border-border bg-popover p-2 text-left shadow-lg group-hover:block group-focus-visible:block"
      >
        <p className="text-[11px] font-semibold text-popover-foreground">{annotation.title}</p>
        <div className="mt-1 space-y-0.5">
          {annotation.rows.map((row) => (
            <p key={row.label} className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", row.dotClassName)} aria-hidden />
              {row.label}
              <span className="ml-auto pl-3 font-semibold tabular-nums text-popover-foreground">{row.count}</span>
            </p>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * A fixed height for the day grid, sized to the tallest month.
 *
 * Months span five or six week-rows depending on where the 1st falls, so without this the grid
 * changes height as you page through — and because the calendar lives in a popover that anchors to
 * a trigger, the whole panel jumps up and down under the cursor. Stepping from March to April then
 * becomes a game of chasing the chevron.
 *
 * WebKit made it worse than cosmetic: the popover re-positions on every resize, so it was never
 * "stable" and clicks queued behind an animation that restarted each time.
 *
 * SIZED TO INCLUDE THE WEEKDAY HEADER, learned the hard way: the first value here was 13.5rem —
 * exactly six h-9 rows and nothing else — so a six-row month still overflowed it by the header's
 * height and the popover kept jumping ~28px on 5-to-6-row transitions. Chromium clicked through
 * the wobble; WebKit's stability check timed out on it, but only under load, which made it read
 * as flake instead of geometry. 15rem = 6 x 2.25rem rows + the header row, with a little slack.
 */
const GRID_MIN_HEIGHT = "min-h-[15rem]";

/** One month of a single-date calendar. */
export function CalendarMonthGrid({ annotations }: { annotations?: CalendarDayAnnotations }) {
  return (
    <AriaCalendarGrid weekdayStyle="short" className={cn("w-full border-collapse", GRID_MIN_HEIGHT)}>
      <CalendarGridHeader>
        {(day) => <CalendarHeaderCell className={gridHeaderClass}>{day}</CalendarHeaderCell>}
      </CalendarGridHeader>
      <CalendarGridBody>
        {(date) => {
          const annotation = annotations?.[annotationKey(date)];
          return (
            <AriaCalendarCell date={date} className={({ isSelected, isDisabled, isUnavailable, isOutsideMonth, isFocused: _f }) =>
              cn(cellClass({ isSelected, isDisabled, isUnavailable, isOutsideMonth, isToday: false }), annotation && "group")
            }>
              {({ formattedDate }) =>
                annotation ? (
                  <>
                    {formattedDate}
                    <DayAnnotationOverlay annotation={annotation} />
                  </>
                ) : (
                  formattedDate
                )
              }
            </AriaCalendarCell>
          );
        }}
      </CalendarGridBody>
    </AriaCalendarGrid>
  );
}

/** One month of a range calendar — same cells, plus the in-range bar. */
export function RangeCalendarMonthGrid({
  offset,
  annotations
}: {
  offset?: { months: number };
  annotations?: CalendarDayAnnotations;
}) {
  return (
    <AriaCalendarGrid weekdayStyle="short" offset={offset} className={cn("w-full border-collapse", GRID_MIN_HEIGHT)}>
      <CalendarGridHeader>
        {(day) => <CalendarHeaderCell className={gridHeaderClass}>{day}</CalendarHeaderCell>}
      </CalendarGridHeader>
      <CalendarGridBody>
        {(date) => {
          const annotation = annotations?.[annotationKey(date)];
          return (
            <AriaCalendarCell
              date={date}
              className={({ isSelected, isSelectionStart, isSelectionEnd, isDisabled, isUnavailable, isOutsideMonth }) =>
                cn(
                  cellClass({
                    isSelected: isSelectionStart || isSelectionEnd,
                    isSelectionStart,
                    isSelectionEnd,
                    inRange: isSelected,
                    isDisabled,
                    isUnavailable,
                    isOutsideMonth
                  }),
                  annotation && "group"
                )
              }
            >
              {({ formattedDate }) =>
                annotation ? (
                  <>
                    {formattedDate}
                    <DayAnnotationOverlay annotation={annotation} />
                  </>
                ) : (
                  formattedDate
                )
              }
            </AriaCalendarCell>
          );
        }}
      </CalendarGridBody>
    </AriaCalendarGrid>
  );
}

export { AriaCalendar as Calendar, AriaRangeCalendar as RangeCalendar };
