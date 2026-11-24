/**
 * 7.0.0 — the weekly digest's "expected hours" line.
 *
 * Only when Attendance & Leave is effectively on (toggle AND plan, attendanceOrLeaveOn). Off, this
 * answers "" and the digest is exactly what it was: the `{{expectedHoursHtml}}` placeholder renders
 * nothing. The figure is the person's own capacity for the week less mandatory holidays (and
 * optional ones they opted into) and approved leave — leave-capacity.service.ts#expectedHoursFor.
 * No reason, type or approver is shown: the line is a number, not a leave record.
 */
import { attendanceOrLeaveOn, expectedHoursFor } from "./leave-capacity.service.js";
import type { ExpectedHours } from "./leave-calc.js";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

/** Pure: the sentence for one person's week. Exported for the unit test. */
export function expectedHoursSentence(e: ExpectedHours, hoursLogged: number): string {
  const adjustments: string[] = [];
  if (e.holidays > 0) adjustments.push(plural(e.holidays, "holiday"));
  if (e.leaveDays > 0) adjustments.push(`${plural(e.leaveDays, "day")} of leave`);
  const why = adjustments.length ? ` (after ${adjustments.join(" and ")})` : "";
  return `Expected last week: ${fmt(e.expectedHours)}h${why}. Logged: ${fmt(Math.round(hoursLogged * 10) / 10)}h.`;
}

/** Pure: the HTML block. Inline styles only — email clients drop <style>. */
export function expectedHoursBlock(sentence: string): string {
  const safe = sentence.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p style="margin:0 0 12px;padding:10px 14px;border:1px solid #E2E8F0;border-left:4px solid #0EA5E9;border-radius:8px;background-color:#FAFBFC;font-size:14px;line-height:22px;color:#0F172A;">${safe}</p>`;
}

/** "" when the module is off or the person has no working days in the week. */
export async function digestExpectedHoursHtml(userId: string, fromKey: string, toKey: string, hoursLogged: number): Promise<string> {
  if (!(await attendanceOrLeaveOn())) return "";
  const e = (await expectedHoursFor([userId], fromKey, toKey)).get(userId);
  if (!e || e.workingDays === 0) return "";
  return expectedHoursBlock(expectedHoursSentence(e, hoursLogged));
}
