/**
 * "YYYY-MM-DD" from a Date's LOCAL calendar components — the day the person at the keyboard is
 * living in.
 *
 * Never `toISOString().slice(0, 10)` for "today": that is the UTC date, which in India is still
 * yesterday from midnight to 05:30 and in New York is already tomorrow every evening from 20:00.
 * The timesheet form defaulted to and capped its picker at that date, so Friday evening's work in
 * New York was saved as Saturday. (Dashboard.tsx carries its own copy of this function for the same
 * reason; it can import this one.)
 */
export function localDateKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
