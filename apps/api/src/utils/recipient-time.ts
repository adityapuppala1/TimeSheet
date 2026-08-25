/**
 * WHAT: what day and hour it is *for the person being emailed*, rather than for the server.
 * WHY: every scheduled notification in this app used to answer "is it a weekday?" and "is it the
 * reminder hour?" with `now.getDay()` / `now.getHours()` — which are the SERVER's answers. The
 * server defaults to `Asia/Kolkata` (config/env.ts), and `User.timezone` has existed the whole
 * time and is populated (the seed ships `America/New_York`), so the two routinely disagree.
 *
 * ── THE BUG THIS EXISTS TO CLOSE, stated concretely ────────────────────────────────────────────
 *
 * IST is UTC+5:30, ahead of every western timezone. For a New York user in August:
 *
 *     NY Fri 14:00  →  IST Fri 23:30      (still Friday on the server — reminder sends)
 *     NY Fri 15:00  →  IST Sat 00:30      (server says SATURDAY — weekend filter drops it)
 *     NY Fri 17:00  →  IST Sat 02:30      (dropped)
 *
 * So from roughly 2:30pm Friday onward, a westward user's reminder was silently suppressed by a
 * weekend check about somebody else's weekend — and the next tick that is not a weekend on the
 * server is MONDAY. That is exactly the reported symptom: "no mail on Friday, it turns up Monday
 * morning." The escalation notice the dashboard shows ("file today's entry before 5 PM") sits
 * squarely inside the dead zone.
 *
 * The same reasoning applies to any recipient east of the server, in the other direction — their
 * Monday morning is still Sunday to the server.
 *
 * ── WHY Intl AND NOT A DATE LIBRARY ────────────────────────────────────────────────────────────
 *
 * `Intl.DateTimeFormat` with a `timeZone` is the platform's own IANA database, already correct
 * about DST transitions and already present in Node. Adding a date library to answer "what hour is
 * it there" would be a dependency carrying a second, separately-updated copy of the tz data.
 *
 * WHO calls this: workers/daily-reminder.worker.ts, and any future worker that emails a person on
 * a schedule. If you are writing one: the recipient's clock is the one that matters.
 */

/** Sunday = 0 ... Saturday = 6, matching `Date#getDay` so call sites read the same either way. */
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ZonedParts {
  /** 0 = Sunday ... 6 = Saturday, in `timeZone`. */
  weekday: number;
  /** 0-23, in `timeZone`. */
  hour: number;
  /** `YYYY-MM-DD` of the local calendar day in `timeZone` — the correct key for "once per day". */
  dateKey: string;
  /** The zone actually used, after falling back. Useful in logs when a stored value was junk. */
  timeZone: string;
}

/**
 * Formatters are expensive to construct and this runs per user per tick, so they are memoised by
 * zone. The set of zones in a workspace is small and bounded by the staff list, not by traffic.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false
    });
    formatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    // An unknown or malformed IANA name. Not an error worth throwing over: a user with a typo in
    // their profile should still get their mail on the server's clock, which is the behaviour
    // every one of them had before this file existed.
    return null;
  }
}

/**
 * The recipient's local weekday, hour and calendar day.
 *
 * `fallbackZone` is consulted when `timeZone` is null/empty/invalid — pass the workspace default
 * so an unset profile follows the workspace rather than the process. With neither, the server's
 * own zone is used, which reproduces the historical behaviour exactly.
 */
export function zonedParts(instant: Date, timeZone?: string | null, fallbackZone?: string | null): ZonedParts {
  const candidates = [timeZone, fallbackZone].map((z) => z?.trim()).filter((z): z is string => Boolean(z));

  for (const zone of candidates) {
    const formatter = formatterFor(zone);
    if (!formatter) continue;

    const parts = formatter.formatToParts(instant);
    const lookup = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const weekday = WEEKDAY_INDEX[lookup("weekday")];
    // `hour12: false` still yields "24" for midnight in some ICU versions — normalise it, because
    // an off-by-24 here would make a midnight reminder never match its configured hour.
    const hour = Number(lookup("hour")) % 24;
    if (weekday === undefined || Number.isNaN(hour)) continue;

    return { weekday, hour, dateKey: `${lookup("year")}-${lookup("month")}-${lookup("day")}`, timeZone: zone };
  }

  // No usable zone — answer on the server's clock, which is what every caller did before.
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    weekday: instant.getDay(),
    hour: instant.getHours(),
    dateKey: `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`,
    timeZone: serverZone
  };
}

/** Saturday or Sunday, in whatever zone the parts were computed for. */
export const isWeekendDay = (weekday: number): boolean => weekday === 0 || weekday === 6;

/**
 * "Yesterday" in business terms, as a `YYYY-MM-DD` key: Mon→Fri, Tue→Mon, ..., Sat→Fri, Sun→Fri.
 *
 * Computed from the recipient's own local day, so a user whose Monday has not started yet on the
 * server is still asked about *their* Friday rather than the server's Thursday.
 */
export function previousBusinessDayKey(parts: ZonedParts): string {
  // Monday looks back across the weekend to Friday; Sunday looks back two. Saturday and every
  // weekday look back one — Saturday's "yesterday" IS Friday, so it needs no special case.
  let offset = 1;
  if (parts.weekday === 1) offset = 3;
  else if (parts.weekday === 0) offset = 2;
  const [y, m, d] = parts.dateKey.split("-").map(Number);
  // UTC arithmetic on a date-only value: no zone involved, so no DST cliff to fall off.
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() - offset);
  return shifted.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → the UTC midnight `Date` this codebase stores `workDate` as. */
export function dateKeyToUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * How far `timeZone` is from UTC at this instant, in milliseconds. Derived by formatting the
 * instant into the zone and reading the wall-clock back as if it were UTC — the difference IS the
 * offset, and because it is measured AT the instant it is automatically right on both sides of a
 * DST transition.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const p = Object.fromEntries(formatter.formatToParts(instant).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  // Second-resolution on both sides, so the sub-second part of `instant` cannot leak in as a
  // spurious few hundred milliseconds of "offset".
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the recipient's local calendar day began.
 *
 * This is what a "once per day" check must compare `createdAt` against. Using the SERVER's
 * midnight instead — which is what the reminder worker did — means a recipient far enough west
 * shares one server-day with two of their own local days, so the second one is silently treated
 * as a duplicate and never sent.
 */
export function startOfZonedDayUtc(instant: Date, timeZone?: string | null, fallbackZone?: string | null): Date {
  const parts = zonedParts(instant, timeZone, fallbackZone);
  const [y, m, d] = parts.dateKey.split("-").map(Number);
  const offset = formatterFor(parts.timeZone) ? zoneOffsetMs(instant, parts.timeZone) : 0;
  return new Date(Date.UTC(y, m - 1, d) - offset);
}
