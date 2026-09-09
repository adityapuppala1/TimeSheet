/**
 * WHAT: the single definition of "a person whose own numbers the UI still shows", and the helper
 * every screen-facing per-person breakdown resolves its names through.
 *
 * WHY IT EXISTS: deactivating somebody did not remove them from the charts. They stayed on the
 * leaderboard, kept a row in the workload heatmap, held a lane in the utilisation table, remained
 * on their manager's team page with a clickable hours trend, and were still offered in the
 * "Raised by" picker. So a workspace that had turned over half its team read as twice its real
 * size, and every per-person comparison was partly against people who had left. Some screens
 * already filtered and some did not, which is worse than either: the same person was present on
 * one page and absent from the next, and nothing said which was right.
 *
 * WHAT IT MEANS, AND WHY IT IS NOT `status: "ACTIVE"`:
 *   - `INACTIVE` is the deactivated state — set by an admin, by SCIM deprovisioning, and by the
 *     soft delete (which writes `deletedAt` AND flips the status). This is what gets hidden.
 *   - `deletedAt` is checked as well rather than trusted to follow, because it is the older of the
 *     two signals and a row could carry it on its own.
 *   - `PENDING_VERIFICATION` is deliberately NOT hidden, and this is the whole reason the
 *     predicate is written as "not INACTIVE" rather than as "is ACTIVE". Somebody invited
 *     yesterday has not been deactivated; they are on their way in, not out. Under `status:
 *     "ACTIVE"` a new joiner would be missing from their own manager's team page for as long as
 *     they took to click the verification link — a new bug, on the first day of employment, in
 *     the name of fixing this one.
 *
 * That distinction is why the constant is named for what it excludes. Several older queries filter
 * on `status: "ACTIVE"` for a different question ("who can be staffed / assigned / emailed", where
 * an unverified account genuinely does not qualify), and those are left exactly as they are. A
 * call site reading `...NOT_DEACTIVATED` cannot be mistaken for one of them.
 *
 * WHERE THIS MUST NOT BE USED — the boundary is the point:
 *   - Anything downloaded or emailed. `/reports/export.{csv,xlsx,pdf}`, the weekly digest, the
 *     practice update. An export is a record of what happened, and a quarter's hours that quietly
 *     omit the two people who left mid-quarter is not a record, it is a wrong number with nothing
 *     on it to say so. Those paths still see everyone, on purpose.
 *   - The audit log, and anything else that answers "who did this". Hiding an actor is tampering.
 *   - Anything that lists PEOPLE in order to administer them — the Users table, bulk actions,
 *     SCIM — which is exactly where somebody goes to find the deactivated account.
 *
 * The rule is narrow on purpose: hide a deactivated person's OWN numbers, never the work itself. A
 * ticket assigned to somebody who has left still appears on the board and still counts in every
 * total, because somebody has to notice it and reassign it.
 */
import { prisma } from "../config/prisma.js";

/**
 * The predicate, as a Prisma fragment, for spreading into a larger `where`.
 *
 * Exported as a value rather than retyped per call site so that "who is still shown" has exactly
 * one answer. Two screens disagreeing about that is the bug this file exists for.
 */
export const NOT_DEACTIVATED = { status: { not: "INACTIVE" }, deletedAt: null } as const;

/**
 * Resolve display names for a set of people, keeping only those who are still shown.
 *
 * Returns a Map rather than an array because every caller is replacing the same shape — a
 * `groupBy` keyed on a user id, a second query for names, then `.find()` per row. The Map makes
 * that lookup O(1) instead of O(n²), and — the reason it exists — makes the filtering half hard to
 * skip: a caller that keeps a row whose id is absent from this map has to write that decision
 * down, rather than inherit it by not thinking about it.
 *
 * `null`/`undefined` ids are accepted and ignored, so a nullable column can be passed straight in.
 */
export async function resolveVisiblePeopleNames(
  ids: Iterable<string | null | undefined>
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const people = await prisma.user.findMany({
    where: { id: { in: wanted }, ...NOT_DEACTIVATED },
    select: { id: true, name: true }
  });
  return new Map(people.map((person) => [person.id, person.name]));
}

/**
 * Drop rows belonging to people who are no longer shown, and SAY how many went.
 *
 * The count is not decoration. A breakdown that quietly returns five rows where a manager expects
 * seven looks like data loss, and the reader's next move is to distrust the whole chart. Handing
 * the caller `hiddenInactive` lets the screen say so in a footnote — the same posture the rest of
 * this codebase takes wherever a figure cannot cover everything it was asked about (see
 * `timesheet-analytics.service.ts`'s `unmeasurable`, and the status report admitting when it
 * covers 12 of 30 projects).
 *
 * Workspace TOTALS are deliberately never recomputed anywhere this is used. The hours an
 * ex-employee logged were really worked and really billed; removing them from a total would change
 * what the total means and stop it reconciling with the export of the same period. Only the
 * per-person rows go.
 */
export function withoutHiddenPeople<T>(
  rows: readonly T[],
  personIdOf: (row: T) => string | null | undefined,
  visible: ReadonlyMap<string, string>
): { rows: T[]; hiddenInactive: number } {
  const kept = rows.filter((row) => {
    const id = personIdOf(row);
    return Boolean(id) && visible.has(id!);
  });
  return { rows: kept, hiddenInactive: rows.length - kept.length };
}
