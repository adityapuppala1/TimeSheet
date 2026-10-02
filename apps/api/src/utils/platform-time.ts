/**
 * WHAT: the platform's own calendar — which DAY, HOUR and MINUTE it is in the deployment's configured
 * zone (`TZ`, Asia/Kolkata unless an operator chose another; config/env.ts), for the console and the
 * operator emails: the daily signup summary's day, the hourly alert's hour, a trial's end date, the
 * Signups page's day buckets — and the period every scheduled tick claims (job-claim.service.ts).
 *
 * WHY NOT `toISOString().slice(0, 10)`: that is UTC's day. IST is UTC+5:30, so from 18:30 UTC it is
 * already tomorrow in India — a summary sent at 08:15 IST was labelled with the right day only by
 * luck of the hour, and a workspace created at 01:00 IST was counted on the previous day.
 *
 * Built on `recipient-time.ts#zonedParts` (the platform's own IANA data via Intl), so there is one
 * implementation of "what day is it there" in the codebase, not two.
 */
import { env } from "../config/env.js";
import { dateKeyToUtc, startOfZonedDayUtc, zonedParts } from "./recipient-time.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of `instant` in the platform's zone. */
export function platformDayKey(instant: Date): string {
  return zonedParts(instant, env.TZ).dateKey;
}

/**
 * The last instant of the calendar day `dateKey` (`YYYY-MM-DD`) in the platform's zone — one
 * millisecond before the next day begins there. What a "status at the end of each day" replay (the
 * sprint burndown) compares against, so a day ends at midnight where the team is, not at UTC's.
 *
 * Found as the start of the NEXT local day, located from noon UTC on it: noon UTC falls inside that
 * calendar day in every zone from UTC-12 to UTC+11, and the one correction below covers the zones
 * further east, where noon UTC is already the day after.
 */
export function platformDayEnd(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  let probe = new Date(Date.UTC(y, m - 1, d + 1, 12));
  if (zonedParts(probe, env.TZ).dateKey > nextKey) probe = new Date(probe.getTime() - 86_400_000);
  return new Date(startOfZonedDayUtc(probe, env.TZ).getTime() - 1);
}

/** `YYYY-MM` of `instant` in the platform's zone — the console's month key (cohorts, feedback). */
export function platformMonthKey(instant: Date): string {
  return platformDayKey(instant).slice(0, 7);
}

/**
 * The platform calendar date of `instant`, encoded as UTC midnight of that date — the date-only shape
 * `OrgUsageSnapshot.day` stores. NOT an instant: 2 Oct in India is written `2026-10-02T00:00:00Z`
 * whatever the hour, so a reader takes the date back with `getUTC*`/`toISOString().slice(0, 10)`.
 */
export function platformDate(instant: Date): Date {
  return dateKeyToUtc(platformDayKey(instant));
}

/** `YYYY-MM-DD` shifted by whole days. Date-only arithmetic, so no zone and no DST cliff. */
export function shiftDayKey(dayKey: string, days: number): string {
  return new Date(dateKeyToUtc(dayKey).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant a platform calendar day began. India's 2 Oct starts at 18:30 UTC on 1 Oct, so a window
 * "from 2 Oct" must start there, not at `2026-10-02T00:00:00Z` (05:30 IST) — which is what
 * `new Date("2026-10-02")` gives and what left mail sent after midnight IST out of "today".
 */
export function platformDayStart(dayKey: string): Date {
  // Noon UTC of the date is the same calendar date in every zone from UTC−11 to UTC+11; nudged a day
  // for the few zones beyond that, then the zone's own midnight is found from inside the right day.
  let probe = new Date(dateKeyToUtc(dayKey).getTime() + DAY_MS / 2);
  const probed = platformDayKey(probe);
  if (probed > dayKey) probe = new Date(probe.getTime() - DAY_MS);
  else if (probed < dayKey) probe = new Date(probe.getTime() + DAY_MS);
  return startOfZonedDayUtc(probe, env.TZ);
}

/** The instant the platform calendar month containing `instant` began — what "month to date" means. */
export function startOfPlatformMonth(instant: Date): Date {
  return platformDayStart(`${platformMonthKey(instant)}-01`);
}

/** `YYYY-MM-DD` of the Monday that starts the platform calendar week (Mon–Sun) containing `instant`. */
export function platformWeekStartKey(instant: Date): string {
  const parts = zonedParts(instant, env.TZ);
  // `weekday` is 0 = Sunday … 6 = Saturday; a Monday week puts Sunday at the END, six days in.
  return shiftDayKey(parts.dateKey, -((parts.weekday + 6) % 7));
}

/** `YYYY-MM-DDTHH` of `instant` in the platform's zone — the key for "once per hour". */
export function platformHourKey(instant: Date): string {
  const parts = zonedParts(instant, env.TZ);
  return `${parts.dateKey}T${String(parts.hour).padStart(2, "0")}`;
}

let minuteFormatter: { zone: string; format: Intl.DateTimeFormat | null } | null = null;

/**
 * The minute of the hour in the platform's zone. NOT `getUTCMinutes()`: India is UTC+5:30, so UTC's
 * minute is thirty off — 03:40 UTC is 09:10 there. An unknown zone falls back to the process clock,
 * the same fallback `zonedParts` makes for the day and hour beside it.
 */
function platformMinute(instant: Date): number {
  if (minuteFormatter?.zone !== env.TZ) {
    let format: Intl.DateTimeFormat | null = null;
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone: env.TZ, minute: "2-digit" });
    } catch {
      format = null;
    }
    minuteFormatter = { zone: env.TZ, format };
  }
  const minute = Number(minuteFormatter.format?.formatToParts(instant).find((p) => p.type === "minute")?.value);
  return Number.isInteger(minute) ? minute : instant.getMinutes();
}

/** `YYYY-MM-DDTHH:mm` of `instant` in the platform's zone — the key for "once per minute". */
export function platformMinuteKey(instant: Date): string {
  return `${platformHourKey(instant)}:${String(platformMinute(instant)).padStart(2, "0")}`;
}
