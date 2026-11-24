/**
 * Missed-day reason (V17 A4) — "why was this day missed?", asked once, with no approval.
 *
 * THE RULE (isMissedDayReasonRequired, pure): a reason is required when somebody creates the FIRST
 * entry for a working day that is already over for them —
 *   (a) the work date is before the author's own today (their timezone, not the server's);
 *   (b) it is a working day (GlobalPlanningSettings.workingDays) and not a holiday in their calendar;
 *   (c) they have ZERO entries on that date (any status — a rejected entry is still a logged day);
 *   (d) the module is on (workspace toggle + plan) and missedDayReasonEnabled is set;
 * and no MissedDayReason already exists for that day — it is asked once per day, never again.
 *
 * WHERE IT IS ENFORCED: timesheet.controller.ts#saveTimesheet, the single function every way of
 * creating an entry goes through (web form, file uploads, MCP log_timesheet_entry, the in-app AI
 * chat action). The public API has no timesheet write. One enforcement point means no door skips it.
 *
 * THE REFUSAL is a 422 with code MISSED_DAY_REASON_REQUIRED (or MISSED_DAY_REASON_INVALID) and the
 * enabled options in `details`, so any client can render the prompt without a second round trip.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { findHoliday, findLeaveForDay, isAttendanceOn } from "./attendance-punch.service.js";
import { weekdayOfDateKey } from "./attendance-day-status.js";
import { getPlanningSettings } from "./planning.service.js";

export const MISSED_DAY_REASON_REQUIRED = "MISSED_DAY_REASON_REQUIRED";
export const MISSED_DAY_REASON_INVALID = "MISSED_DAY_REASON_INVALID";

export interface MissedReasonOptionView {
  code: string;
  label: string;
  requiresNote: boolean;
}

export interface MissedDayRuleInput {
  /** The entry's work date, YYYY-MM-DD. */
  workDateKey: string;
  /** The author's local today, YYYY-MM-DD. */
  todayKey: string;
  workingDays: readonly number[];
  isHoliday: boolean;
  /** Entries the author already has on that date (not deleted, any status). */
  existingEntries: number;
  /** A MissedDayReason already exists for (author, date). */
  hasReason: boolean;
  /** Module on (toggle + plan) AND missedDayReasonEnabled. */
  enabled: boolean;
}

/** Pure. See the file header for the rule. */
export function isMissedDayReasonRequired(input: MissedDayRuleInput): boolean {
  if (!input.enabled) return false;
  // YYYY-MM-DD compares correctly as a string. Today and the future never need a reason.
  if (input.workDateKey >= input.todayKey) return false;
  if (!input.workingDays.includes(weekdayOfDateKey(input.workDateKey))) return false;
  if (input.isHoliday) return false;
  if (input.existingEntries > 0) return false;
  return !input.hasReason;
}

export interface MissedReasonInput {
  code?: string | null;
  note?: string | null;
}

/** Pure: null when the given reason is acceptable, else the field-specific message. */
export function validateMissedReason(
  options: readonly MissedReasonOptionView[],
  reason: MissedReasonInput
): { field: "missedReasonCode" | "missedReasonNote"; message: string } | null {
  const code = reason.code?.trim();
  if (!code) return { field: "missedReasonCode", message: "Choose why this day was missed." };
  const option = options.find((o) => o.code === code);
  if (!option) return { field: "missedReasonCode", message: `"${code}" is not one of this workspace's reasons.` };
  if (option.requiresNote && !reason.note?.trim()) {
    return { field: "missedReasonNote", message: `Add a note for "${option.label}".` };
  }
  return null;
}

export async function listEnabledMissedReasonOptions(): Promise<MissedReasonOptionView[]> {
  return prisma.missedReasonOption.findMany({
    where: { enabled: true },
    orderBy: [{ order: "asc" }, { label: "asc" }],
    select: { code: true, label: true, requiresNote: true }
  });
}

/** Module on AND the reason setting on. */
async function isMissedDayReasonOn(): Promise<boolean> {
  const settings = await getAttendanceSettings();
  if (!settings?.missedDayReasonEnabled) return false;
  return isAttendanceOn();
}

/**
 * Is a reason required for this author on this date, right now? Reads everything the pure rule
 * needs. `client` lets saveTimesheet re-ask inside its Serializable transaction.
 */
export async function missedDayReasonState(
  userId: string,
  workDateKey: string,
  todayKey: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<{ required: boolean; options: MissedReasonOptionView[] }> {
  // Cheap exits first: the module gate, then the calendar facts, before any per-day query.
  if (workDateKey >= todayKey || !(await isMissedDayReasonOn())) return { required: false, options: [] };
  const planning = await getPlanningSettings();
  if (!planning.workingDays.includes(weekdayOfDateKey(workDateKey))) return { required: false, options: [] };
  const user = await client.user.findUnique({ where: { id: userId }, select: { holidayCalendarId: true } });
  const workDate = new Date(`${workDateKey}T00:00:00Z`);
  const [holiday, existingEntries, reason] = await Promise.all([
    findHoliday(user?.holidayCalendarId ?? null, workDateKey, userId),
    client.timesheet.count({ where: { userId, workDate, deletedAt: null } }),
    client.missedDayReason.findUnique({ where: { userId_workDate: { userId, workDate } }, select: { id: true } })
  ]);
  // Phase B: a FULL day of approved leave makes the day not a working day. A half day does not —
  // the other half was owed, so an empty day still needs its reason.
  const leave = await findLeaveForDay(userId, workDateKey);
  const fullDayLeave = Boolean(leave) && (!leave?.half || leave.half === "FULL");
  const required = isMissedDayReasonRequired({
    workDateKey,
    todayKey,
    workingDays: planning.workingDays,
    isHoliday: Boolean(holiday) || fullDayLeave,
    existingEntries,
    hasReason: Boolean(reason),
    enabled: true
  });
  if (!required) return { required: false, options: [] };
  const options = await listEnabledMissedReasonOptions();
  // Fail open: with every option disabled nobody could answer the prompt, so the rule would block
  // all backfill. The settings API refuses to get here; this covers data that slipped past it.
  if (options.length === 0) {
    console.warn("[missed-day-reason] missedDayReasonEnabled is on but no reason option is enabled; not requiring a reason");
    return { required: false, options: [] };
  }
  return { required: true, options };
}

/**
 * Throws the 422 a client renders as the prompt, or returns the validated reason to save.
 * Returns null when no reason is needed (anything the client sent is then ignored).
 */
export async function assertMissedDayReason(
  userId: string,
  workDateKey: string,
  todayKey: string,
  reason: MissedReasonInput,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<{ code: string; note: string | null } | null> {
  const state = await missedDayReasonState(userId, workDateKey, todayKey, client);
  if (!state.required) return null;
  const problem = validateMissedReason(state.options, reason);
  if (problem) {
    const missing = !reason.code?.trim();
    const codes = state.options.map((o) => o.code).join(", ");
    const noteHint = state.options.some((o) => o.requiresNote) ? " and missedReasonNote where the reason needs one" : "";
    const requiredMessage = `${workDateKey} has no entries yet, so tell us why it was missed: send missedReasonCode (one of ${codes})${noteHint}.`;
    throw new AppError(
      422,
      missing ? requiredMessage : problem.message,
      {
        code: missing ? MISSED_DAY_REASON_REQUIRED : MISSED_DAY_REASON_INVALID,
        details: { field: problem.field, workDate: workDateKey, options: state.options }
      }
    );
  }
  const note = reason.note?.trim();
  return { code: reason.code!.trim(), note: note ? note.slice(0, 2000) : null };
}

/** Inside saveTimesheet's transaction, after the entry exists. Upsert: a concurrent first entry
 *  that also carried a reason must not turn into a unique-constraint 409. */
export async function saveMissedDayReason(
  tx: Prisma.TransactionClient,
  args: { userId: string; workDate: Date; code: string; note: string | null; timesheetId: string }
): Promise<void> {
  await tx.missedDayReason.upsert({
    where: { userId_workDate: { userId: args.userId, workDate: args.workDate } },
    update: {},
    create: { userId: args.userId, workDate: args.workDate, reasonCode: args.code, note: args.note, timesheetId: args.timesheetId }
  });
}
