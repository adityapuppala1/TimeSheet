/**
 * Pure helpers for the leave screens (V17 UI v2): wording, request filtering, the team calendar's
 * busy-day detection, the overlap line on an approval card, and the .ics file for holidays. Kept out
 * of the components so each rule is unit-tested without a DOM (tests/unit/leave-ui.test.ts).
 */
import { foldIcsLine, icsEscape } from "@timesheet/shared";
import type { LeaveHalf, LeavePreview, LeaveRequestRow, LeaveStatus, TeamLeaveItem } from "../services/leave-api";

const DAY_MS = 86_400_000;
const addDays = (key: string, days: number) => new Date(new Date(`${key}T12:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const weekday = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "1 day", "2.5 days", "0.5 day". */
export function formatDays(n: number): string {
  const text = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return `${text} ${n === 1 ? "day" : "days"}`;
}

/** "12 Nov" or "12–14 Nov" or "30 Nov – 2 Dec", from YYYY-MM-DD keys. */
export function dateRangeText(start: string, end: string): string {
  const fmt = (key: string, opts: Intl.DateTimeFormatOptions) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  if (start === end) return fmt(start, { day: "numeric", month: "short" });
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  if (sameMonth) return `${Number(start.slice(8))}–${fmt(end, { day: "numeric", month: "short" })}`;
  return `${fmt(start, { day: "numeric", month: "short" })} – ${fmt(end, { day: "numeric", month: "short" })}`;
}

export function halfText(half: LeaveHalf): string {
  if (half === "FIRST_HALF") return "first half";
  if (half === "SECOND_HALF") return "second half";
  return "full day";
}

/** "12–14 Nov · 3 days" with a half-day note for a single half day. */
export function requestRangeText(r: Pick<LeaveRequestRow, "startDate" | "endDate" | "startHalf" | "endHalf" | "days">): string {
  const range = dateRangeText(r.startDate, r.endDate);
  const half = r.startDate === r.endDate && r.startHalf !== "FULL" ? ` (${halfText(r.startHalf)})` : "";
  return `${range}${half} · ${formatDays(r.days)}`;
}

export const REQUEST_STATUS_META: Record<LeaveStatus, { label: string; tone: "warning" | "success" | "destructive" | "muted" }> = {
  PENDING: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "destructive" },
  CANCELLED: { label: "Cancelled", tone: "muted" }
};

export type RequestFilter = "ALL" | "PENDING" | "PAST";

/** All; Pending (awaiting a decision); Past (the leave is over, whatever came of it). */
export function filterRequests<T extends Pick<LeaveRequestRow, "status" | "endDate">>(items: readonly T[], filter: RequestFilter, today: string): T[] {
  if (filter === "PENDING") return items.filter((r) => r.status === "PENDING");
  if (filter === "PAST") return items.filter((r) => r.endDate < today);
  return [...items];
}

/** Pending can always be withdrawn; approved only until it starts (after that an admin does it). */
export function canCancel(r: Pick<LeaveRequestRow, "status" | "startDate">, today: string): boolean {
  if (r.status === "PENDING") return true;
  return r.status === "APPROVED" && r.startDate > today;
}

/** "Today", "Tomorrow", "in 12 days", "3 days ago" from two keys. */
export function relativeDay(dateKey: string, today: string): string {
  const diff = Math.round((new Date(`${dateKey}T12:00:00Z`).getTime() - new Date(`${today}T12:00:00Z`).getTime()) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

/** The sticky summary's one line: "3 days · balance 3.5". */
export function summaryLine(p: Pick<LeavePreview, "days" | "balanceAfter" | "ok"> | null | undefined): string {
  if (!p || p.days <= 0) return "Pick your dates";
  const bal = p.balanceAfter == null ? "" : ` · balance ${trim(p.balanceAfter)}`;
  return `${formatDays(p.days)}${bal}`;
}

const trim = (n: number) => String(Math.round(n * 100) / 100);

/** "Balance 6.5 → 3.5". */
export function balanceChange(p: Pick<LeavePreview, "balanceBefore" | "balanceAfter">): string | null {
  if (p.balanceBefore == null || p.balanceAfter == null) return null;
  return `Balance ${trim(p.balanceBefore)} → ${trim(p.balanceAfter)}`;
}

/** "excludes Sat, Sun, Diwali" — weekdays by short name, holidays by name, in date order. */
export function excludedText(excluded: LeavePreview["excluded"]): string | null {
  if (excluded.length === 0) return null;
  const labels: string[] = [];
  for (const e of excluded) {
    const label = e.reason === "WEEKEND" ? e.label.slice(0, 3) : e.label;
    if (!labels.includes(label)) labels.push(label);
  }
  return `excludes ${labels.join(", ")}`;
}

/** 7.0.0 sandwich rule: "includes 2 enclosed weekend or holiday days" — why the count is higher. */
export function sandwichedText(sandwiched: readonly string[] | undefined): string | null {
  const n = sandwiched?.length ?? 0;
  if (n === 0) return null;
  return `includes ${n} enclosed weekend or holiday ${n === 1 ? "day" : "days"} (this leave type counts them)`;
}

/** When the type's rules would take the balance below zero, say so in the policy's own words. */
export function negativeBalanceMessage(p: Pick<LeavePreview, "balanceAfter" | "allowNegative">, typeName: string): string | null {
  if (p.balanceAfter == null || p.balanceAfter >= 0) return null;
  return p.allowNegative
    ? `This takes your ${typeName} balance below zero. Your workspace allows that, and it will be settled against future accrual.`
    : `${typeName} cannot go below zero in your workspace, so this request will be declined. Shorten it or pick another type.`;
}

/* --------------------------------- team calendar --------------------------------- */

export interface DayLoad {
  date: string;
  off: number;
  share: number;
  busy: boolean;
}

/** Every calendar day the item touches, as keys (capped, so a corrupt row cannot spin). */
export function itemDays(item: Pick<TeamLeaveItem, "startDate" | "endDate">): string[] {
  const out: string[] = [];
  for (let d = item.startDate; d <= item.endDate && out.length < 120; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * How many people are off on each day, and whether it crosses the busy threshold. A day is busy when
 * the share of the team that is off reaches `threshold` (default a quarter), with at least two people
 * off — one person away from a team of three is not a coverage problem. Weekend columns are never busy.
 */
export function dayLoads(days: readonly string[], items: readonly TeamLeaveItem[], teamSize: number, threshold = 0.25): DayLoad[] {
  const perDay = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.status === "REJECTED" || item.status === "CANCELLED") continue;
    for (const d of itemDays(item)) {
      const set = perDay.get(d) ?? new Set<string>();
      set.add(item.user.id);
      perDay.set(d, set);
    }
  }
  return days.map((date) => {
    const off = perDay.get(date)?.size ?? 0;
    const share = teamSize > 0 ? off / teamSize : 0;
    const weekend = weekday(date) === 0 || weekday(date) === 6;
    return { date, off, share, busy: !weekend && off >= 2 && share >= threshold };
  });
}

export interface PersonRow {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** People as rows (those with leave in the window first, then the rest by name), items by person and day. */
export function teamMatrix(people: readonly PersonRow[], items: readonly TeamLeaveItem[]) {
  const byPerson = new Map<string, Map<string, TeamLeaveItem>>();
  for (const item of items) {
    if (item.status === "REJECTED" || item.status === "CANCELLED") continue;
    const days = byPerson.get(item.user.id) ?? new Map<string, TeamLeaveItem>();
    for (const d of itemDays(item)) {
      // An approved entry wins the cell over a pending one.
      if (!days.has(d) || (days.get(d)!.status === "PENDING" && item.status === "APPROVED")) days.set(d, item);
    }
    byPerson.set(item.user.id, days);
  }
  const known = new Map(people.map((p) => [p.id, p]));
  for (const item of items) if (!known.has(item.user.id)) known.set(item.user.id, { id: item.user.id, name: item.user.name, avatarUrl: item.user.avatarUrl });
  const rows = [...known.values()].sort((a, b) => Number(byPerson.has(b.id)) - Number(byPerson.has(a.id)) || a.name.localeCompare(b.name));
  return { rows, cell: (personId: string, date: string) => byPerson.get(personId)?.get(date) ?? null };
}

/** The approval card's advisory line: "2 others off 24 Nov". Null when nobody overlaps. */
export function overlapLine(request: Pick<LeaveRequestRow, "id" | "startDate" | "endDate" | "user">, team: readonly TeamLeaveItem[]): string | null {
  const others = new Map<string, string>();
  for (const t of team) {
    if (t.user.id === request.user?.id || t.id === request.id) continue;
    if (t.status === "REJECTED" || t.status === "CANCELLED") continue;
    const from = t.startDate > request.startDate ? t.startDate : request.startDate;
    const to = t.endDate < request.endDate ? t.endDate : request.endDate;
    if (from > to) continue;
    if (!others.has(t.user.id) || from < others.get(t.user.id)!) others.set(t.user.id, from);
  }
  if (others.size === 0) return null;
  const first = [...others.values()].sort()[0];
  const when = new Date(`${first}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${others.size} ${others.size === 1 ? "other" : "others"} off ${when}`;
}

/* ------------------------------------- holidays ------------------------------------- */

export interface HolidayItem {
  date: string;
  name: string;
  isOptional: boolean;
}

/** "Falls on Sunday" for a holiday on a non-working weekday; null otherwise. */
export function fallsOnNote(dateKey: string, workingDays: readonly number[] = [1, 2, 3, 4, 5]): string | null {
  const wd = weekday(dateKey);
  return workingDays.includes(wd) ? null : `Falls on ${WEEKDAY_NAMES[wd]}`;
}

export function groupByMonth<T extends { date: string }>(items: readonly T[]): Array<{ month: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const month = item.date.slice(0, 7);
    map.set(month, [...(map.get(month) ?? []), item]);
  }
  return [...map.entries()].map(([month, list]) => ({ month, items: list }));
}

// 7.0.0: the RFC 5545 helpers live in @timesheet/shared, so the API's private calendar feed
// (services/calendar-feed.service.ts) writes exactly the same escaping and folding as this download.
export { foldIcsLine };

const compact = (key: string) => key.replaceAll("-", "");

/** An iCalendar file of all-day events, one per holiday. CRLF line ends, as the format requires. */
export function buildIcs(holidays: readonly HolidayItem[], calendarName: string, now: Date = new Date()): string {
  const stamp = `${now.toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}Z`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TimeSphere//Holidays//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsEscape(calendarName)}`];
  for (const h of holidays) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${compact(h.date)}-${icsEscape(h.name).replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 24)}@timesphere`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(h.date)}`,
      `DTEND;VALUE=DATE:${compact(addDays(h.date, 1))}`,
      `SUMMARY:${icsEscape(holidayLabel(h.name, h.isOptional))}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/** The line under a leave type in the picker. */
export function typeBalanceText(left: number | undefined, empty: boolean): string {
  if (left === undefined) return "Balance unavailable";
  if (empty) return "No days left. Ask an admin if you need more.";
  return `${Math.round(left * 100) / 100} ${left === 1 ? "day" : "days"} left`;
}

/** " (first half)" / " (second half)" / "" for a portion. */
export function halfNote(half: LeaveHalf): string {
  if (half === "FIRST_HALF") return " (first half)";
  if (half === "SECOND_HALF") return " (second half)";
  return "";
}

/** The portion of `date` this item covers: the start or end half on those days, otherwise a full day. */
export function portionOn(item: Pick<TeamLeaveItem, "startDate" | "endDate" | "startHalf" | "endHalf">, date: string): LeaveHalf {
  if (item.startDate === date && item.startHalf !== "FULL") return item.startHalf;
  if (item.endDate === date && item.endHalf !== "FULL") return item.endHalf;
  return "FULL";
}

/** Tooltip for a leave cell: "Privilege leave (first half), pending". */
export function leaveCellTitle(name: string, half: LeaveHalf, pending: boolean): string {
  return name + halfNote(half) + (pending ? ", pending" : "");
}

export const holidayLabel = (name: string, optional: boolean): string => (optional ? `${name} (optional)` : name);

export function submitLabel(pending: boolean, autoApproves: boolean): string {
  if (pending) return "Sending…";
  return autoApproves ? "Take leave" : "Send request";
}

export const FILTER_LABELS: Record<RequestFilter, string> = { ALL: "All", PENDING: "Pending", PAST: "Past" };
