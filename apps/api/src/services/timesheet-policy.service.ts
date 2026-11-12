/**
 * WHAT: the workspace's timesheet back-date window — how many calendar days before the author's
 * today an entry may still be dated. Set by a workspace admin on Workspace Settings → Ticketing and
 * stored on the `GlobalTicketSettings` singleton (`timesheetBackdateDays`).
 *
 * THE TWO "EMPTY" CASES, WHICH MEAN OPPOSITE THINGS:
 *   - NO ROW YET (a workspace nobody has opened settings for): the shipped default, 7 days.
 *   - A ROW WITH A NULL COLUMN: the admin chose "no limit". Never too old.
 * Collapsing them — treating a missing row as "no limit", say — would quietly turn the limit off for
 * every workspace that has never visited settings, which is most of them.
 *
 * WHY A READ AND NOT `getGlobalTicketSettings()`: that one upserts, so calling it on every timesheet
 * save would be a write on the hottest path in the product to learn one number.
 *
 * WHO CALLS THIS: controllers/timesheet.controller.ts, at the three places the limit is enforced
 * (see utils/timesheet-window.ts for the rule itself, which stays pure).
 */
import { TIMESHEET_BACKDATE_DAYS } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";

/** Days back an entry may be dated, 0 for today only, or `null` for no limit. */
export async function getTimesheetBackdateDays(): Promise<number | null> {
  const row = await prisma.globalTicketSettings.findUnique({
    where: { id: "global" },
    select: { timesheetBackdateDays: true }
  });
  return row ? row.timesheetBackdateDays : TIMESHEET_BACKDATE_DAYS;
}
