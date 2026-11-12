/**
 * WHAT: the rule that a timesheet entry cannot be dated more than the workspace's back-date window
 * before today — the mirror of the existing "Future dates are not allowed", and decided the same way:
 * on the AUTHOR's calendar, never the server's (see services/user-clock.service.ts).
 *
 * THE WINDOW IS A WORKSPACE SETTING (`GlobalTicketSettings.timesheetBackdateDays`, edited on
 * Workspace Settings → Ticketing): a number of days, 0 for today only, or NULL for no limit. 7 is the
 * default. The callers read it and pass it in, so this file stays pure.
 *
 * WHY IT IS A RULE ON THE WORK DATE AND NOT ON WHEN THE ROW WAS TOUCHED: the point is that nobody can
 * reconstruct a month from memory — hours logged a fortnight late are guesses, and approvers sign
 * them off as fact. The date on the entry is the only thing that says how late it is.
 *
 * WHERE IT IS ENFORCED, and where it deliberately is not (controllers/timesheet.controller.ts):
 *   - CREATING an entry, as a draft or a submission, from the web app or the MCP client — they all go
 *     through `saveTimesheet`, so there is one copy of the rule;
 *   - MOVING an entry to a new date, so an entry logged yesterday cannot be re-dated to last month;
 *   - SUBMITTING an existing draft, because that is the moment it stops being private working state;
 *   - NOT on an edit that leaves the date alone. Fixing the hours or the project on an entry that is
 *     already on the books corrects a record rather than backfilling one, and refusing it would send
 *     an author to their approver over a typo. Decided entries cannot be edited at all.
 *
 * Pure, so the boundary — the one place this goes wrong — is tested without a database.
 */
import { earliestLoggableDate } from "@timesheet/shared";
import { AppError } from "../middleware/error.js";

/** `YYYY-MM-DD` of a UTC-midnight work date. */
const keyOf = (date: Date) => date.toISOString().slice(0, 10);

/**
 * True when `workDate` is earlier than the earliest date the author may still log, given their
 * `today` and the workspace's window. A null window is "no limit": nothing is ever too old.
 */
export function isWorkDateTooOld(workDate: Date, today: Date, backdateDays: number | null): boolean {
  if (backdateDays === null) return false;
  return keyOf(workDate) < earliestLoggableDate(keyOf(today), backdateDays);
}

/**
 * Throws a 422 naming the earliest date that WOULD be accepted, so the message is an instruction
 * rather than a refusal. The code lets a client tell this apart from the other 422s.
 */
export function assertWorkDateInWindow(workDate: Date, today: Date, backdateDays: number | null): void {
  if (backdateDays === null || !isWorkDateTooOld(workDate, today, backdateDays)) return;
  const noun = backdateDays === 1 ? "day" : "days";
  const reach = backdateDays === 0 ? "for today only" : `up to ${backdateDays} ${noun} back`;
  throw new AppError(
    422,
    `Entries can only be logged ${reach} — the earliest date you can use is ${earliestLoggableDate(keyOf(today), backdateDays)}.`,
    { code: "TIMESHEET_TOO_OLD" }
  );
}
