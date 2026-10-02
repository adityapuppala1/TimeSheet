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
import { startOfZonedDayUtc, zonedParts } from "./recipient-time.js";

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
