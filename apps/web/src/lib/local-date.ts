/**
 * "YYYY-MM-DD" from a Date's LOCAL calendar components — the day the person at the keyboard is
 * living in.
 *
 * Never `toISOString().slice(0, 10)` for "today": that is the UTC date, which in India is still
 * yesterday from midnight to 05:30 and in New York is already tomorrow every evening from 20:00.
 * The timesheet form defaulted to and capped its picker at that date, so Friday evening's work in
 * New York was saved as Saturday. (Dashboard.tsx carries its own copy of this function for the same
 * reason; it can import this one.)
 *
 * `timeZone` is the person's PROFILE zone (`AuthUser.timezone`) where the caller has it, and it wins
 * over the device's: the server refuses a work date later than today in the profile's zone
 * (services/user-clock.service.ts), so a form defaulting to the device's day offered a New York
 * profile used from India, 00:00–09:30 IST, a date it was about to refuse as "in the future". No
 * zone, or one this browser does not know, falls back to the device — as the server falls back to
 * its own when the profile has none.
 */
export function localDateKey(date: Date = new Date(), timeZone?: string | null): string {
  if (timeZone) {
    try {
      // Assembled from parts rather than trusting a locale's own date pattern. Throws RangeError for
      // a zone this browser does not know.
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
      const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    } catch {
      /* fall through to the device's calendar */
    }
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
