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

/** One month of a single-date calendar. */
export function CalendarMonthGrid() {
  return (
    <AriaCalendarGrid weekdayStyle="short" className="w-full border-collapse">
      <CalendarGridHeader>
        {(day) => <CalendarHeaderCell className={gridHeaderClass}>{day}</CalendarHeaderCell>}
      </CalendarGridHeader>
      <CalendarGridBody>
        {(date) => (
          <AriaCalendarCell date={date} className={({ isSelected, isDisabled, isUnavailable, isOutsideMonth, isFocused: _f }) =>
            cellClass({ isSelected, isDisabled, isUnavailable, isOutsideMonth, isToday: false })
          }>
            {({ formattedDate }) => formattedDate}
          </AriaCalendarCell>
        )}
      </CalendarGridBody>
    </AriaCalendarGrid>
  );
}

/** One month of a range calendar — same cells, plus the in-range bar. */
export function RangeCalendarMonthGrid({ offset }: { offset?: { months: number } }) {
  return (
    <AriaCalendarGrid weekdayStyle="short" offset={offset} className="w-full border-collapse">
      <CalendarGridHeader>
        {(day) => <CalendarHeaderCell className={gridHeaderClass}>{day}</CalendarHeaderCell>}
      </CalendarGridHeader>
      <CalendarGridBody>
        {(date) => (
          <AriaCalendarCell
            date={date}
            className={({ isSelected, isSelectionStart, isSelectionEnd, isDisabled, isUnavailable, isOutsideMonth }) =>
              cellClass({
                isSelected: isSelectionStart || isSelectionEnd,
                isSelectionStart,
                isSelectionEnd,
                inRange: isSelected,
                isDisabled,
                isUnavailable,
                isOutsideMonth
              })
            }
          >
            {({ formattedDate }) => formattedDate}
          </AriaCalendarCell>
        )}
      </CalendarGridBody>
    </AriaCalendarGrid>
  );
}

export { AriaCalendar as Calendar, AriaRangeCalendar as RangeCalendar };
