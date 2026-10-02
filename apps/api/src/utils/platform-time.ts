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
import { zonedParts } from "./recipient-time.js";

/** `YYYY-MM-DD` of `instant` in the platform's zone. */
export function platformDayKey(instant: Date): string {
  return zonedParts(instant, env.TZ).dateKey;
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
