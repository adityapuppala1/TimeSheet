/**
 * WHAT: the rule that a timesheet entry cannot be dated more than `TIMESHEET_BACKDATE_DAYS` (a week)
 * before today — the mirror of the existing "Future dates are not allowed", and decided the same way:
 * on the AUTHOR's calendar, never the server's (see services/user-clock.service.ts).
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
import { earliestLoggableDate, TIMESHEET_BACKDATE_DAYS } from "@timesheet/shared";
import { AppError } from "../middleware/error.js";

/** `YYYY-MM-DD` of a UTC-midnight work date. */
const keyOf = (date: Date) => date.toISOString().slice(0, 10);

/** True when `workDate` is earlier than the earliest date the author may still log, given their `today`. */
export function isWorkDateTooOld(workDate: Date, today: Date): boolean {
  return keyOf(workDate) < earliestLoggableDate(keyOf(today));
}

/**
 * Throws a 422 naming the earliest date that WOULD be accepted, so the message is an instruction
 * rather than a refusal. The code lets a client tell this apart from the other 422s.
 */
export function assertWorkDateInWindow(workDate: Date, today: Date): void {
  if (!isWorkDateTooOld(workDate, today)) return;
  throw new AppError(
    422,
    `Entries can only be logged up to ${TIMESHEET_BACKDATE_DAYS} days back — the earliest date you can use is ${earliestLoggableDate(keyOf(today))}.`,
    { code: "TIMESHEET_TOO_OLD" }
  );
}
