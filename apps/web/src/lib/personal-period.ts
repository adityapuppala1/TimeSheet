/**
 * WHAT: the home page's personal figures for one period — hours, their status split, the rhythm
 * chart's buckets, where the hours went, the target to date, and the comparison period.
 *
 * WHY IT IS A PURE FUNCTION OUT OF THE PAGE: the cards it feeds are headed "Your logged hours", and
 * they used to be built from whatever `GET /timesheets` returned — which, for anyone holding
 * reports:view (managers, team leads, admins), is EVERY row in the workspace. A manager's "your
 * hours" was the team's, "awaiting review" was the team's queue, and the target meter overflowed.
 * The page now asks for the person's own rows, and this function refuses anybody else's anyway, so
 * a wider list (the shared, unscoped cache the calendars read) can never leak back into a figure.
 *
 * THE DEFINITIONS, shared with the server (apps/api/src/services/workspace-metrics.ts):
 *   - logged hours = SUBMITTED + APPROVED. Drafts and rejected hours are SHOWN, by state, on the
 *     card that splits hours by state — they are never added into "logged".
 *   - the target counts working days in the range up to today, never days still to come.
 *   - the comparison is like-for-like: the same weekdays, shifted back by whole weeks. "This week so
 *     far" against the days just before it would compare Mon–Thu with Thu–Sun, and every delta would
 *     read as growth because the baseline contains a weekend.
 */
import { addLocalDays as addDays, isoToLocalDate, localDateKey } from "./local-day";

export interface PersonalRow {
  id: string;
  workDate: string;
  startTime: string;
  totalHours: number | string;
  status: string;
  project?: { id?: string; name?: string; code?: string };
  user?: { id?: string; name?: string };
  userId?: string;
}

/** The statuses whose hours count as LOGGED. The server's `LOGGED_TIMESHEET_STATUSES`. */
export const LOGGED_STATUSES: ReadonlySet<string> = new Set(["SUBMITTED", "APPROVED"]);

export const isLoggedStatus = (status: string): boolean => LOGGED_STATUSES.has(status);

const DAY_MS = 86_400_000;

function daysBetweenInclusive(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1);
}

function toMinutes(time: string): number {
  const [h, m] = String(time).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Monday to Friday — the working week until planning settings say otherwise (0 = Sunday … 6). */
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** The workspace's working days in an inclusive range; zero when the range is empty. */
function countWorkingDays(from: Date, to: Date, workingDays: readonly number[]): number {
  const working = new Set(workingDays);
  let count = 0;
  for (let day = new Date(from); day <= to; day = addDays(day, 1)) {
    if (working.has(day.getDay())) count += 1;
  }
  return count;
}

/** Rows by `YYYY-MM-DD`, each day's list in clock order. Rows without a usable date are skipped. */
function groupByDay<Row extends PersonalRow>(rows: Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row.workDate).slice(0, 10);
    if (!isoToLocalDate(key)) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  return map;
}

/** The row's author, from the scalar the list returns or the nested `user` an approver's view adds. */
const ownerOf = (row: PersonalRow): string | undefined => row.userId ?? row.user?.id;

export interface ComparisonWindow {
  from: string;
  to: string;
  /** Visible text for the delta — "vs the same days last week". */
  label: string;
}

/**
 * The like-for-like period a delta compares against: the same weekdays, whole weeks earlier.
 *
 * The shift is the range's length rounded UP to whole weeks, so the two windows never overlap and
 * always carry the same mix of weekdays. A range that runs past today compares only its days to date
 * — "this week" on a Thursday is Mon–Thu against last Mon–Thu, not against last week's full seven.
 */
export function likeForLikeWindow(from: string, to: string, today: Date): ComparisonWindow | null {
  const start = isoToLocalDate(from);
  const end = isoToLocalDate(to);
  if (!start || !end || end < start) return null;
  const dayCount = daysBetweenInclusive(start, end);
  const weeks = Math.ceil(dayCount / 7);
  const todayLocal = isoToLocalDate(localDateKey(today))!;
  const effectiveEnd = end > todayLocal && todayLocal >= start ? todayLocal : end;
  let label = `vs the same days ${weeks} weeks earlier`;
  if (dayCount === 1) label = weeks === 1 ? "vs the same day last week" : label;
  else if (weeks === 1) label = "vs the same days last week";
  return {
    from: localDateKey(addDays(start, -7 * weeks)),
    to: localDateKey(addDays(effectiveEnd, -7 * weeks)),
    label
  };
}

/**
 * One honest sentence about where the period's hours sit — computed, never invented. `hours` is
 * LOGGED hours, so a period of nothing but drafts is called what it is rather than "nothing logged".
 */
export function periodNote(hours: number, pendingCount: number, byStatus: Record<string, number>, periodLabel: string): string {
  if (hours === 0) {
    return (byStatus.DRAFT ?? 0) > 0
      ? "Everything so far is still a draft — submit it to start the review clock."
      : `No hours logged ${periodLabel} — your entries will show up here as you add them.`;
  }
  if (pendingCount > 0) return `${pendingCount} ${pendingCount === 1 ? "entry is" : "entries are"} waiting on a reviewer.`;
  const approvedShare = Math.round(((byStatus.APPROVED ?? 0) / hours) * 100);
  if (approvedShare >= 100) return `Every logged hour ${periodLabel} is approved. Nothing outstanding.`;
  return `${approvedShare}% of these hours are approved.`;
}

export interface PersonalPeriodInput<Row extends PersonalRow> {
  /** The person's rows for the range. Rows of anyone else are ignored, whatever the list held. */
  rows: Row[];
  /** The person's rows for `comparison`'s window, when they have been fetched. */
  prevRows?: Row[];
  from: string;
  to: string;
  /** The signed-in person. */
  userId: string | undefined;
  today?: Date;
  /** The workspace's working weekdays from planning settings (0 = Sunday … 6 = Saturday) — the set
   *  the server's utilisation counts. Monday to Friday until they have loaded. */
  workingDays?: readonly number[];
}

export function summarisePersonalPeriod<Row extends PersonalRow>({
  rows,
  prevRows,
  from,
  to,
  userId,
  today = new Date(),
  workingDays = DEFAULT_WORKING_DAYS
}: PersonalPeriodInput<Row>) {
  const rangeStart = isoToLocalDate(from) ?? isoToLocalDate(localDateKey(today))!;
  const rangeEnd = isoToLocalDate(to) ?? rangeStart;
  const dayCount = daysBetweenInclusive(rangeStart, rangeEnd);
  const todayKey = localDateKey(today);
  const todayLocal = isoToLocalDate(todayKey)!;
  const mine = (row: Row) => userId === undefined || ownerOf(row) === undefined || ownerOf(row) === userId;

  // The rhythm chart's x-axis. Up to a fortnight it is one bucket per day; beyond that the labels
  // collide, so days collapse into buckets — a 90-day range drawn as 90 unreadable ticks is worse
  // than the same shape drawn as twelve.
  const bucketDays = dayCount <= 14 ? 1 : Math.ceil(dayCount / 12);
  const bucketCount = Math.ceil(dayCount / bucketDays);
  const bucketLabel = (index: number) => {
    const day = addDays(rangeStart, index * bucketDays);
    if (dayCount <= 7) return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(day.getDay() + 6) % 7];
    return day.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  };
  const buckets: Array<{ day: string; hours: number }> = Array.from({ length: bucketCount }, (_, i) => ({
    day: bucketLabel(i),
    hours: 0
  }));

  const ownRows = rows.filter(mine);
  /** The person's entries grouped by calendar day — the calendars and the day strip read this. */
  const entriesByDate = groupByDay(ownRows);
  const inRange = ownRows.filter((row) => {
    const key = String(row.workDate).slice(0, 10);
    return key >= localDateKey(rangeStart) && key <= localDateKey(rangeEnd);
  });

  const byStatus = { APPROVED: 0, SUBMITTED: 0, REJECTED: 0, DRAFT: 0 } as Record<string, number>;
  for (const row of inRange) byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.totalHours ?? 0);
  const pendingCount = inRange.filter((row) => row.status === "SUBMITTED").length;

  let loggedHours = 0;
  /** Distinct people with logged hours in the range — 1 for a personal view, the head count behind
   *  a team view's target (one person's 8h/day target against a whole team's hours read 600%). */
  const people = new Set<string>();
  /** Logged hours per project. Keyed by the DISPLAY LABEL rather than the id, so entries whose
   *  project was removed collapse into one honest "No project" row. */
  const byProjectLabel = new Map<string, number>();
  /** Days in the range carrying logged hours — "weekdays logged", and the daily average's divisor. */
  const daysLogged = new Set<string>();
  for (const row of inRange.filter((r) => isLoggedStatus(r.status))) {
    const key = String(row.workDate).slice(0, 10);
    const hours = Number(row.totalHours ?? 0);
    loggedHours += hours;
    daysLogged.add(key);
    people.add(ownerOf(row) ?? "");
    const offsetDays = daysBetweenInclusive(rangeStart, isoToLocalDate(key)!) - 1;
    buckets[Math.min(bucketCount - 1, Math.floor(offsetDays / bucketDays))].hours += hours;
    const projectLabel = row.project?.code ?? row.project?.name ?? "No project";
    byProjectLabel.set(projectLabel, (byProjectLabel.get(projectLabel) ?? 0) + hours);
  }

  const comparison = likeForLikeWindow(from, to, today) ?? { from, to, label: "vs the previous period" };
  /** Null, not zero, until the previous window's rows have arrived: "no comparison available" and
   *  "they logged nothing" are different statements and must not look alike. */
  const prevLoggedHours =
    prevRows === undefined
      ? null
      : prevRows
          .filter((row) => mine(row) && isLoggedStatus(row.status))
          .filter((row) => {
            const key = String(row.workDate).slice(0, 10);
            return key >= comparison.from && key <= comparison.to;
          })
          .reduce((sum, row) => sum + Number(row.totalHours ?? 0), 0);

  return {
    todayKey,
    dayCount,
    /** Working days from the range's start to today (or to its end, if that is earlier) — what the
     *  target scales against. Counting the days still to come would make every Thursday look behind. */
    workingDaysToDate: countWorkingDays(rangeStart, rangeEnd < todayLocal ? rangeEnd : todayLocal, workingDays),
    daysLogged: daysLogged.size,
    people: people.size,
    loggedHours,
    prevLoggedHours,
    pendingCount,
    byStatus,
    // Biggest first, so the card can take the top few and total the rest.
    rangeProjects: [...byProjectLabel.entries()].map(([label, hours]) => ({ label, hours })).sort((a, b) => b.hours - a.hours),
    entriesByDate,
    comparison,
    trend: buckets.map((b) => ({ day: b.day, hours: Number(b.hours.toFixed(2)) }))
  };
}
