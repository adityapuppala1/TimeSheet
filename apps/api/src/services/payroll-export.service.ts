/**
 * 7.0.0 — the monthly payroll report: one row per person for a calendar month.
 *
 *   workingDays   scheduled working days (GlobalPlanningSettings.workingDays) minus the person's
 *                 holidays (their calendar; optional holidays only when opted into)
 *   holidays      holidays that fell on a scheduled working day
 *   present       working days with a punch (any source), judged by resolveDayStatus
 *   absent        working days that are OVER with no punch and no leave (resolveDayStatus ABSENT)
 *   leave         approved leave days by type code, on working days only (halves count 0.5)
 *   paidLeave / unpaidLeave (LOP)   the same split by LeaveType.isPaid
 *   compOffTaken  leave days of the comp-off type (GlobalAttendanceSettings.compOffLeaveTypeCode)
 *   compOffEarned approved comp-off credit for days worked in the month
 *   loggedHours   timesheet hours (not rejected, not deleted)
 *
 * LEAVE YEAR CLOSED: a month whose leave year has ended, or been settled by the year-end rollover,
 * is FLAGGED (`leaveYearClosed: true`, and a column in the CSV). Late changes to a closed year are
 * re-settled into the next one (leave-settlement.service.ts), so a payroll run for that month should
 * be treated as final; the flag says so rather than silently returning numbers that may differ from
 * an earlier export.
 *
 * Never a reason, a note or a location: payroll needs counts.
 */
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { resolveDayStatus, todayKeyFor } from "./attendance-day-status.js";
import { loadHolidays } from "./attendance-team.service.js";
import { attendanceOrLeaveOn } from "./leave-capacity.service.js";
import { addDaysKey, dayPortions, leaveYearBounds, leaveYearOf } from "./leave-calc.js";
import { overtimeHoursForPeriod } from "./attendance-overtime.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { COUNTED_PEOPLE } from "./people-visibility.service.js";
import { CSV_EOL, UTF8_BOM, csvCell } from "../utils/csv.js";

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const weekday = (k: string) => new Date(`${k}T12:00:00Z`).getUTCDay();

export interface PayrollRow {
  userId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  workingDays: number;
  holidays: number;
  present: number;
  absent: number;
  leave: Record<string, number>;
  paidLeave: number;
  unpaidLeave: number;
  compOffTaken: number;
  compOffEarned: number;
  loggedHours: number;
  /** 7.0.0: only while overtime is on (approved hours, or computed when approval is off). */
  overtimeHours?: number;
}

export interface PayrollReport {
  month: string;
  from: string;
  to: string;
  leaveYear: number;
  leaveYearClosed: boolean;
  leaveTypes: Array<{ code: string; name: string; isPaid: boolean }>;
  /** 7.0.0: present only while overtime is on. Weeks count in the month their Monday falls in. */
  overtime?: { basis: "APPROVED" | "COMPUTED" };
  rows: PayrollRow[];
}

/** Pure: "2026-11" → first and last day. */
export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError(422, "Pass month as YYYY-MM.");
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export async function buildPayrollReport(month: string, opts: { now?: Date; employee?: string } = {}): Promise<PayrollReport> {
  if (!(await attendanceOrLeaveOn())) throw new AppError(403, "Attendance & Leave is off for this workspace.");
  const now = opts.now ?? new Date();
  const { from, to } = monthRange(month);
  const [settings, planning] = await Promise.all([getAttendanceSettings(), getPlanningSettings()]);
  const startMonth = settings.leaveYearStartMonth ?? 1;
  const leaveYear = leaveYearOf(from, startMonth);
  const today = todayKeyFor(now, null, serverTimezone);

  const employee = opts.employee?.trim().slice(0, 191);
  const people = await prisma.user.findMany({
    where: { ...COUNTED_PEOPLE, ...(employee ? { OR: [{ email: employee.toLowerCase() }, { employeeCode: employee }] } : {}) },
    select: { id: true, name: true, email: true, employeeCode: true, timezone: true, holidayCalendarId: true },
    orderBy: { name: "asc" },
    take: 10_000
  });
  const ids = people.map((p) => p.id);
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);

  const [holidayOf, records, leaves, timesheets, compOffs, types, settled] = await Promise.all([
    loadHolidays(people.map((p) => p.holidayCalendarId), from, to),
    ids.length ? prisma.attendanceRecord.findMany({ where: { userId: { in: ids }, workDate: { gte: fromDate, lte: toDate } }, select: { userId: true, workDate: true } }) : [],
    ids.length && settings.leaveEnabled
      ? prisma.leaveRequest.findMany({
          where: { userId: { in: ids }, status: "APPROVED", startDate: { lte: toDate }, endDate: { gte: fromDate } },
          select: { userId: true, startDate: true, endDate: true, startHalf: true, endHalf: true, leaveType: { select: { code: true, isPaid: true } } }
        })
      : [],
    ids.length ? prisma.timesheet.findMany({ where: { userId: { in: ids }, workDate: { gte: fromDate, lte: toDate }, status: { not: "REJECTED" }, deletedAt: null }, select: { userId: true, totalHours: true } }) : [],
    ids.length ? prisma.compOffRequest.findMany({ where: { userId: { in: ids }, status: "APPROVED", workDate: { gte: fromDate, lte: toDate } }, select: { userId: true, days: true } }) : [],
    prisma.leaveType.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { code: true, name: true, isPaid: true } }),
    prisma.leaveBalanceLedger.findFirst({ where: { leaveYear, idempotencyKey: { startsWith: "EXPIRY:" } }, select: { id: true } })
  ]);

  const overtime = await overtimeHoursForPeriod(ids, from, to);
  const punched = new Set(records.map((r) => `${r.userId}|${toKey(r.workDate)}`));
  const hours = new Map<string, number>();
  for (const t of timesheets) hours.set(t.userId, (hours.get(t.userId) ?? 0) + Number(t.totalHours));
  const earned = new Map<string, number>();
  for (const c of compOffs) earned.set(c.userId, (earned.get(c.userId) ?? 0) + Number(c.days));
  const compOffCode = settings.compOffLeaveTypeCode ?? "CO";

  const rows: PayrollRow[] = people.map((p) => {
    const isHoliday = (d: string) => Boolean(holidayOf(p.holidayCalendarId, d, p.id));
    const isWorking = (d: string) => planning.workingDays.includes(weekday(d)) && !isHoliday(d);
    const totals = leaveTotals(leaves.filter((l) => l.userId === p.id), from, to, isWorking);
    const days = dayCounts({ from, to, workingDays: planning.workingDays, isHoliday, isWorking, fullLeave: totals.fullLeave, punched: (d) => punched.has(`${p.id}|${d}`), now, timeZone: p.timezone, countAbsent: Boolean(settings.attendanceEnabled) });
    return {
      userId: p.id,
      name: p.name,
      email: p.email,
      employeeCode: p.employeeCode ?? null,
      ...days,
      leave: totals.byType,
      paidLeave: r2(totals.paid),
      unpaidLeave: r2(totals.unpaid),
      compOffTaken: totals.byType[compOffCode] ?? 0,
      compOffEarned: r2(earned.get(p.id) ?? 0),
      loggedHours: r2(hours.get(p.id) ?? 0),
      ...(overtime ? { overtimeHours: overtime.hours.get(p.id) ?? 0 } : {})
    };
  });

  const yearEnded = leaveYearBounds(leaveYear, startMonth).to < today;
  return { month, from, to, leaveYear, leaveYearClosed: yearEnded || Boolean(settled), leaveTypes: types, ...(overtime ? { overtime: { basis: overtime.basis } } : {}), rows };
}

type LeaveRow = { startDate: Date; endDate: Date; startHalf: "FULL" | "FIRST_HALF" | "SECOND_HALF"; endHalf: "FULL" | "FIRST_HALF" | "SECOND_HALF"; leaveType: { code: string; isPaid: boolean } };

/** One person's approved leave inside [from, to], working days only: by type, paid / unpaid, and the full days. */
function leaveTotals(leaves: readonly LeaveRow[], from: string, to: string, isWorking: (d: string) => boolean) {
  const byType: Record<string, number> = {};
  const fullLeave = new Set<string>();
  let paid = 0;
  let unpaid = 0;
  const counted = (d: string) => d >= from && d <= to && isWorking(d);
  for (const l of leaves) {
    const portions = [...dayPortions({ startDate: toKey(l.startDate), endDate: toKey(l.endDate), startHalf: l.startHalf, endHalf: l.endHalf })].filter(([d]) => counted(d));
    for (const [d, half] of portions) {
      if (half === "FULL") fullLeave.add(d);
    }
    const days = portions.reduce((sum, [, half]) => sum + (half === "FULL" ? 1 : 0.5), 0);
    if (days === 0) continue;
    byType[l.leaveType.code] = r2((byType[l.leaveType.code] ?? 0) + days);
    if (l.leaveType.isPaid) paid += days;
    else unpaid += days;
  }
  return { byType, fullLeave, paid, unpaid };
}

/** Working days, holidays on scheduled days, present and absent (resolveDayStatus) for one person. */
function dayCounts(a: {
  from: string;
  to: string;
  workingDays: readonly number[];
  isHoliday: (d: string) => boolean;
  isWorking: (d: string) => boolean;
  fullLeave: ReadonlySet<string>;
  punched: (d: string) => boolean;
  now: Date;
  timeZone: string | null;
  countAbsent: boolean;
}) {
  const out = { workingDays: 0, holidays: 0, present: 0, absent: 0 };
  for (let d = a.from; d <= a.to; d = addDaysKey(d, 1)) {
    if (a.workingDays.includes(weekday(d)) && a.isHoliday(d)) out.holidays += 1;
    if (!a.isWorking(d)) continue;
    out.workingDays += 1;
    const status = resolveDayStatus({
      dateKey: d,
      workingDays: a.workingDays,
      holiday: null,
      leave: a.fullLeave.has(d) ? { type: "LEAVE", half: "FULL" } : null,
      punchedIn: a.punched(d),
      now: a.now,
      timeZone: a.timeZone,
      fallbackZone: serverTimezone
    }).status;
    if (status === "PRESENT") out.present += 1;
    else if (status === "ABSENT" && a.countAbsent) out.absent += 1;
  }
  return out;
}

/** The report as CSV: one column per leave type, then the totals. UTF-8 BOM and CRLF for Excel. */
export function payrollCsv(report: PayrollReport): string {
  const head = [
    "Month",
    "Employee code",
    "Name",
    "Email",
    "Working days",
    "Holidays",
    "Present",
    "Absent",
    ...report.leaveTypes.map((t) => `Leave ${t.code}${t.isPaid ? "" : " (unpaid)"}`),
    "Paid leave",
    "Unpaid leave (LOP)",
    "Comp-off taken",
    "Comp-off earned",
    "Logged hours",
    ...(report.overtime ? [report.overtime.basis === "APPROVED" ? "Overtime hours (approved)" : "Overtime hours"] : []),
    "Leave year closed"
  ];
  const lines = [head.map(csvCell).join(",")];
  for (const r of report.rows) {
    // A spreadsheet formula prefix in a name is neutralised: this file is opened in Excel by payroll.
    const safe = (v: string | null) => (v && /^[=+\-@]/.test(v) ? `'${v}` : v);
    lines.push(
      [
        report.month,
        safe(r.employeeCode),
        safe(r.name),
        safe(r.email),
        r.workingDays,
        r.holidays,
        r.present,
        r.absent,
        ...report.leaveTypes.map((t) => r.leave[t.code] ?? 0),
        r.paidLeave,
        r.unpaidLeave,
        r.compOffTaken,
        r.compOffEarned,
        r.loggedHours,
        ...(report.overtime ? [r.overtimeHours ?? 0] : []),
        report.leaveYearClosed ? "yes" : "no"
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return UTF8_BOM + lines.join(CSV_EOL) + CSV_EOL;
}
