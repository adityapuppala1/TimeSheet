/**
 * 7.0.0 — "Draft my week" and the missed-day reason. The server refuses the FIRST entry for a past
 * working day with nothing logged (MISSED_DAY_REASON_REQUIRED). The panel now asks for that reason
 * inline, once per day, and sends it with the first row of that day; later rows on the same day
 * no longer need one (the server records it with the first entry).
 */
import { missedReasonProblem, type MissedReasonOption } from "./missed-day-reason";

export interface DayReason {
  code: string;
  note: string;
}

export interface ReasonFields {
  missedReasonCode?: string;
  missedReasonNote?: string;
}

/** For each row, the reason fields to send: only on the first selected row of a day that needs one. Pure. */
export function reasonFieldsFor<T extends { workDate: string }>(
  rows: readonly T[],
  needed: Readonly<Record<string, readonly MissedReasonOption[]>>,
  reasons: Readonly<Record<string, DayReason>>
): ReasonFields[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!needed[r.workDate] || seen.has(r.workDate)) return {};
    seen.add(r.workDate);
    const reason = reasons[r.workDate];
    return reason?.code ? { missedReasonCode: reason.code, missedReasonNote: reason.note.trim() } : {};
  });
}

/** Days (among the selected rows) whose reason is missing or incomplete, with the field message. Pure. */
export function reasonProblems<T extends { workDate: string }>(
  rows: readonly T[],
  needed: Readonly<Record<string, readonly MissedReasonOption[]>>,
  reasons: Readonly<Record<string, DayReason>>
): Record<string, { field: "missedReasonCode" | "missedReasonNote"; message: string }> {
  const out: Record<string, { field: "missedReasonCode" | "missedReasonNote"; message: string }> = {};
  for (const day of new Set(rows.map((r) => r.workDate))) {
    const options = needed[day];
    if (!options) continue;
    const problem = missedReasonProblem(options, reasons[day]?.code, reasons[day]?.note);
    if (problem) out[day] = problem;
  }
  return out;
}
