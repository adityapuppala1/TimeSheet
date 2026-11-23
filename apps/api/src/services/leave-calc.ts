/**
 * V17 Phase B — the arithmetic of leave, as PURE functions.
 *
 * WHY PURE: every number a person argues about ("why is this 2.5 days?", "where did my 3 days go
 * at year end?") comes out of this file, and each of them depends only on a handful of facts —
 * the dates, the halves, the workspace's working days, the person's holidays, the type's quota
 * rules and the ledger sum. Keeping I/O out makes every edge (half days at both ends, a holiday in
 * the middle, an April leave year, carry-forward of a negative balance) testable without a
 * database — tests/unit/leave-calc.test.ts.
 *
 * DATES are `YYYY-MM-DD` calendar keys throughout, compared as strings, stepped at UTC noon so no
 * zone or DST rule can move a day (the attendance-day-status.ts convention).
 */

export type LeaveHalf = "FULL" | "FIRST_HALF" | "SECOND_HALF";

const DAY_MS = 86_400_000;

export function addDaysKey(dateKey: string, days: number): string {
  return new Date(new Date(`${dateKey}T12:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

export const portionFraction = (half: LeaveHalf): number => (half === "FULL" ? 1 : 0.5);

const HALF_SUFFIX: Record<LeaveHalf, string> = { FULL: "", FIRST_HALF: "first half", SECOND_HALF: "second half" };

/** "first half" / "second half" / "" — for labels. */
export function halfLabel(half: LeaveHalf): string {
  return HALF_SUFFIX[half];
}

/** `2026-11-30` or `2026-11-30 to 2026-12-02`. */
export function rangeLabel(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate} to ${endDate}`;
}

export interface LeaveSpan {
  startDate: string;
  endDate: string;
  startHalf: LeaveHalf;
  endHalf: LeaveHalf;
}

/**
 * The shape rules for halves, as a list of problems (empty = fine).
 * - single day: any of FULL / FIRST_HALF / SECOND_HALF, and endHalf must match startHalf;
 * - several days: the start may only be FULL or SECOND_HALF (leave from the afternoon), the end
 *   only FULL or FIRST_HALF (back after lunch) — anything else would leave a hole in the middle.
 */
export function spanErrors(span: LeaveSpan, allowHalfDay = true): string[] {
  const errors: string[] = [];
  if (span.endDate < span.startDate) errors.push("The end date is before the start date.");
  const halves = span.startHalf !== "FULL" || span.endHalf !== "FULL";
  if (halves && !allowHalfDay) errors.push("This leave type does not allow half days.");
  if (span.startDate === span.endDate) {
    if (span.endHalf !== span.startHalf) errors.push("A one-day request has a single half: send the same startHalf and endHalf.");
  } else {
    if (span.startHalf === "FIRST_HALF") errors.push("A request spanning several days can only start FULL or SECOND_HALF.");
    if (span.endHalf === "SECOND_HALF") errors.push("A request spanning several days can only end FULL or FIRST_HALF.");
  }
  return errors;
}

/** Each calendar day the span touches, with the portion of it taken. Weekends included. */
export function dayPortions(span: LeaveSpan): Map<string, LeaveHalf> {
  const out = new Map<string, LeaveHalf>();
  if (span.endDate < span.startDate) return out;
  if (span.startDate === span.endDate) {
    out.set(span.startDate, span.startHalf);
    return out;
  }
  for (let d = span.startDate; d <= span.endDate; d = addDaysKey(d, 1)) {
    let half: LeaveHalf = "FULL";
    if (d === span.startDate && span.startHalf === "SECOND_HALF") half = "SECOND_HALF";
    if (d === span.endDate && span.endHalf === "FIRST_HALF") half = "FIRST_HALF";
    out.set(d, half);
    if (out.size > 800) break;
  }
  return out;
}

export interface DayRules {
  /** GlobalPlanningSettings.workingDays — 0 = Sunday … 6 = Saturday. */
  workingDays: readonly number[];
  /** True when `dateKey` is a holiday in the person's calendar. */
  isHoliday: (dateKey: string) => boolean;
}

/**
 * What a request COSTS: working days in the span that are not holidays, a half counting 0.5.
 * A request made entirely of weekends and holidays costs 0 (and the service refuses it).
 */
export function countLeaveDays(span: LeaveSpan, rules: DayRules): number {
  let total = 0;
  for (const [d, half] of dayPortions(span)) {
    if (!rules.workingDays.includes(weekdayOf(d))) continue;
    if (rules.isHoliday(d)) continue;
    total += portionFraction(half);
  }
  return total;
}

/** Two portions of the SAME day clash unless they are the two different halves. */
export function portionsClash(a: LeaveHalf, b: LeaveHalf): boolean {
  if (a === "FULL" || b === "FULL") return true;
  return a === b;
}

/**
 * The first existing request (pending or approved) that clashes with `span`, or null. A morning
 * off and an afternoon off on the same day do not clash; anything else on a shared day does.
 */
export function findClash<T extends LeaveSpan>(span: LeaveSpan, existing: readonly T[]): T | null {
  const mine = dayPortions(span);
  for (const other of existing) {
    if (other.endDate < span.startDate || other.startDate > span.endDate) continue;
    for (const [d, half] of dayPortions(other)) {
      const own = mine.get(d);
      if (own && portionsClash(own, half)) return other;
    }
  }
  return null;
}

/** Two halves of one day make a full day; anything with FULL is FULL. */
export function mergePortions(a: LeaveHalf | undefined, b: LeaveHalf): LeaveHalf {
  if (!a) return b;
  if (a === "FULL" || b === "FULL" || a !== b) return "FULL";
  return a;
}

/* ------------------------------------------------------------------ *
 * Leave years
 * ------------------------------------------------------------------ */

/** The leave year a day belongs to, named by the calendar year it STARTS in. */
export function leaveYearOf(dateKey: string, startMonth: number): number {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  return month >= startMonth ? year : year - 1;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** First and last day of leave year `year`. */
export function leaveYearBounds(year: number, startMonth: number): { from: string; to: string } {
  const from = `${year}-${pad2(startMonth)}-01`;
  const next = startMonth === 1 ? `${year + 1}-01-01` : `${year + 1}-${pad2(startMonth)}-01`;
  return { from, to: addDaysKey(next, -1) };
}

/** 0 for the first month of the leave year … 11 for the last. */
export function monthIndexInLeaveYear(dateKey: string, startMonth: number): number {
  const month = Number(dateKey.slice(5, 7));
  return (month - startMonth + 12) % 12;
}

/* ------------------------------------------------------------------ *
 * Accrual, carry-forward, projection
 * ------------------------------------------------------------------ */

export interface QuotaRules {
  annualQuota: number;
  accrual: "YEARLY_UPFRONT" | "MONTHLY_PRORATA";
  carryForwardMax: number;
  allowNegative?: boolean;
}

export interface AccrualSlot {
  /** `YYYY-MM` of the month the credit lands in — part of the ledger idempotency key. */
  period: string;
  /** The day it lands on (the first of that month). */
  dateKey: string;
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The year's credits. Monthly pro-rata splits the quota into twelve 2-dp slices and gives the
 * rounding remainder to the LAST month, so the twelve always sum to exactly the quota (18 / 12 is
 * 1.5 every month; 10 / 12 is 0.83 × 11 + 0.87).
 */
export function accrualSchedule(rules: Pick<QuotaRules, "annualQuota" | "accrual">, year: number, startMonth: number): AccrualSlot[] {
  if (rules.annualQuota <= 0) return [];
  const { from } = leaveYearBounds(year, startMonth);
  if (rules.accrual === "YEARLY_UPFRONT") {
    return [{ period: from.slice(0, 7), dateKey: from, amount: round2(rules.annualQuota) }];
  }
  const slice = Math.floor((rules.annualQuota / 12) * 100) / 100;
  const slots: AccrualSlot[] = [];
  for (let i = 0; i < 12; i++) {
    const month = ((startMonth - 1 + i) % 12) + 1;
    const y = startMonth - 1 + i >= 12 ? year + 1 : year;
    const dateKey = `${y}-${pad2(month)}-01`;
    const amount = i === 11 ? round2(rules.annualQuota - slice * 11) : slice;
    slots.push({ period: dateKey.slice(0, 7), dateKey, amount });
  }
  return slots;
}

/**
 * The slots that have landed by `dateKey` (inclusive) for someone who joined on `joinedKey`.
 * A joiner is entitled from their joining MONTH: monthly pro-rata simply skips the months before
 * it; yearly-upfront lands once, on the first of the joining month, scaled to the months left
 * (joining in month 7 of 12 gets 6/12 of the quota). Someone who joined before the year began gets
 * the plain schedule. The worker and the balance projection both call this, so they agree.
 */
export function accrualDueThrough(
  rules: Pick<QuotaRules, "annualQuota" | "accrual">,
  year: number,
  startMonth: number,
  dateKey: string,
  joinedKey?: string | null
): AccrualSlot[] {
  const bounds = leaveYearBounds(year, startMonth);
  let slots = accrualSchedule(rules, year, startMonth);
  if (joinedKey && joinedKey > bounds.from) {
    if (joinedKey > bounds.to) return [];
    const joinPeriod = joinedKey.slice(0, 7);
    if (rules.accrual === "MONTHLY_PRORATA") {
      slots = slots.filter((s) => s.period >= joinPeriod);
    } else {
      const remaining = 12 - monthIndexInLeaveYear(joinedKey, startMonth);
      slots = [{ period: joinPeriod, dateKey: `${joinPeriod}-01`, amount: round2((rules.annualQuota * remaining) / 12) }];
    }
  }
  return slots.filter((s) => s.dateKey <= dateKey);
}

/**
 * Year-end for one person and type. Positive unused days: up to carryForwardMax carry, the rest
 * expire. A NEGATIVE balance (allowNegative types) is a debt: it carries in full and nothing
 * expires — forgiving it would make "borrow" free.
 *
 * Returned as two ledger deltas: `expire` is posted to the CLOSING year (bringing it to zero) and
 * `carry` to the NEW year. Both zero when the balance is zero.
 */
export function rolloverDeltas(closingBalance: number, carryForwardMax: number): { expire: number; carry: number } {
  const balance = round2(closingBalance);
  if (balance === 0) return { expire: 0, carry: 0 };
  if (balance < 0) return { expire: round2(-balance), carry: balance };
  const carry = round2(Math.min(balance, Math.max(0, carryForwardMax)));
  return { expire: -balance, carry };
}

export interface ProjectionInput {
  /** Sum of every ledger row for (person, type, leave year). */
  ledgerSum: number;
  /** Sum of the ACCRUAL rows among them. */
  postedAccrual: number;
  /** What the schedule says has accrued by the date being asked about. */
  dueAccrual: number;
  /** Days already asked for and not yet decided (they are not in the ledger yet). */
  pendingDays: number;
}

/**
 * What can still be asked for. The worker may not have run yet today (or this month), so accrual
 * that is DUE but not yet POSTED counts — otherwise a request made at 00:05 on the 1st would be
 * refused for want of a credit that lands at 01:00. Pending requests are reserved.
 */
export function availableBalance(p: ProjectionInput): number {
  const unposted = Math.max(0, round2(p.dueAccrual - p.postedAccrual));
  return round2(p.ledgerSum + unposted - p.pendingDays);
}

/* ------------------------------------------------------------------ *
 * Expected hours
 * ------------------------------------------------------------------ */

export interface ExpectedHoursInput extends DayRules {
  from: string;
  to: string;
  /** Leave taken on `dateKey` as a fraction (0, 0.5 or 1). */
  leaveFraction: (dateKey: string) => number;
  weeklyCapacityHours: number;
}

export interface ExpectedHours {
  workingDays: number;
  holidays: number;
  leaveDays: number;
  expectedDays: number;
  dailyHours: number;
  expectedHours: number;
}

/**
 * (working days − holidays − leave days) × daily hours, where daily hours = weekly capacity ÷ the
 * workspace's working days per week and a half day of leave counts 0.5. Leave on a holiday or a
 * weekend costs nothing (it is not counted twice).
 */
export function expectedHours(input: ExpectedHoursInput): ExpectedHours {
  let workingDays = 0;
  let holidays = 0;
  let leaveDays = 0;
  for (let d = input.from; d <= input.to; d = addDaysKey(d, 1)) {
    if (!input.workingDays.includes(weekdayOf(d))) continue;
    workingDays += 1;
    if (input.isHoliday(d)) {
      holidays += 1;
      continue;
    }
    leaveDays += Math.min(1, Math.max(0, input.leaveFraction(d)));
  }
  const perWeek = input.workingDays.length;
  const dailyHours = perWeek > 0 ? round2(input.weeklyCapacityHours / perWeek) : 0;
  const expectedDays = round2(workingDays - holidays - leaveDays);
  return {
    workingDays,
    holidays,
    leaveDays: round2(leaveDays),
    expectedDays,
    dailyHours,
    expectedHours: round2(expectedDays * (perWeek > 0 ? input.weeklyCapacityHours / perWeek : 0))
  };
}
