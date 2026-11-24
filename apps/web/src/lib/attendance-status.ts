/**
 * The ONE place a day's status gets its colour, icon, word and letter (V17 UI v2).
 *
 * Every screen — My attendance calendar, Team board and table, the day sheet, the timeline — goes
 * through this module and <AttendanceStatusBadge>, so a status looks the same everywhere and is never
 * conveyed by colour alone: each carries an icon and a text label (WCAG 1.4.1). The colours are the
 * `--status-*` tokens in index.css (light and dark), applied through the `.status-*` classes.
 *
 * LATE is not a server status. It is PRESENT plus "punched in after the expected start", and exists
 * only when the admin switched lateness on; it is informational and never asks anyone for a reason.
 */
import { Check, Clock, Hourglass, Minus, Plane, Star, X, type LucideIcon } from "lucide-react";
import type { AttendanceDayStatus } from "./attendance-team";

export type StatusKey = "PRESENT" | "LATE" | "ABSENT" | "LEAVE" | "HOLIDAY" | "WEEKEND" | "PENDING";

export interface StatusMeta {
  key: StatusKey;
  label: string;
  /** One letter for a calendar cell, so a cell reads without its colour. */
  letter: string;
  icon: LucideIcon;
  /** The `.status-*` class from index.css that sets the colour variables. */
  className: string;
}

export const STATUS_META: Record<StatusKey, StatusMeta> = {
  PRESENT: { key: "PRESENT", label: "Present", letter: "P", icon: Check, className: "status-present" },
  LATE: { key: "LATE", label: "Late", letter: "L", icon: Clock, className: "status-late" },
  ABSENT: { key: "ABSENT", label: "Absent", letter: "A", icon: X, className: "status-absent" },
  LEAVE: { key: "LEAVE", label: "On leave", letter: "V", icon: Plane, className: "status-leave" },
  HOLIDAY: { key: "HOLIDAY", label: "Holiday", letter: "H", icon: Star, className: "status-holiday" },
  WEEKEND: { key: "WEEKEND", label: "Weekend", letter: "W", icon: Minus, className: "status-weekend" },
  PENDING: { key: "PENDING", label: "Not yet in", letter: "–", icon: Hourglass, className: "status-pending" }
};

/** Minutes after local midnight of an ISO instant, in the viewer's zone. */
export function localMinuteOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** How many minutes after `expectedStartMinute` the punch was; 0 when on time or earlier. */
export function minutesLate(punchInAt: string | null | undefined, expectedStartMinute: number | null | undefined): number {
  if (!punchInAt || expectedStartMinute == null) return 0;
  return Math.max(0, localMinuteOf(punchInAt) - expectedStartMinute);
}

export interface StatusInput {
  status: AttendanceDayStatus;
  punchInAt?: string | null;
  /** Pass only when the admin enabled lateness; otherwise LATE can never appear. */
  latenessEnabled?: boolean;
  expectedStartMinute?: number | null;
}

/** The display status of a day. PRESENT becomes LATE only with lateness on and a late punch. */
export function statusKeyFor(input: StatusInput): StatusKey {
  if (input.status === "PRESENT" && input.latenessEnabled && minutesLate(input.punchInAt, input.expectedStartMinute) > 0) return "LATE";
  return input.status;
}

export function statusMetaFor(input: StatusInput): StatusMeta {
  return STATUS_META[statusKeyFor(input)];
}

/** "12 Nov" for a YYYY-MM-DD key. */
export function shortDay(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function clockText(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/** The calendar cell's accessible name: "12 Nov, Present, in 09:42" / "25 Dec, Holiday, Christmas". */
export function dayAriaLabel(
  day: { date: string; status: AttendanceDayStatus; punchInAt?: string | null; holidayName?: string | null; leaveName?: string | null },
  meta: StatusMeta
): string {
  const parts = [shortDay(day.date), meta.label];
  if (day.punchInAt) parts.push(`in ${clockText(day.punchInAt)}`);
  else if (day.status === "HOLIDAY" && day.holidayName) parts.push(day.holidayName);
  else if (day.status === "LEAVE" && day.leaveName) parts.push(day.leaveName);
  return parts.join(", ");
}

/** The legend, in reading order; Late only with lateness on, Leave only with leave on. */
export function legendFor(opts: { latenessEnabled: boolean; leaveEnabled: boolean }): StatusMeta[] {
  const keys: StatusKey[] = ["PRESENT"];
  if (opts.latenessEnabled) keys.push("LATE");
  keys.push("ABSENT");
  if (opts.leaveEnabled) keys.push("LEAVE");
  keys.push("HOLIDAY", "WEEKEND", "PENDING");
  return keys.map((k) => STATUS_META[k]);
}

/** "7h 39m" for a duration in minutes (never negative). */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** Whole minutes between an ISO instant and `now`. */
export function minutesSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
}

/** The day sheet's punch line: "09:42 · Web", or "No punch". */
export function punchLine(punchInAt: string | null | undefined, sourceLabel: string | null | undefined): string {
  if (!punchInAt) return "No punch";
  return sourceLabel ? `${clockText(punchInAt)} · ${sourceLabel}` : clockText(punchInAt);
}
