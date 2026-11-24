/**
 * WHAT: the save orchestration behind the Attendance & Leave settings tab's single "Save" button —
 * which of the two PUTs to send, in which order, and what to tell the admin when only one landed.
 * Pure (the API calls are passed in), so both plan tiers and the half-saved case are unit-tested.
 *
 * WHY IT IS ITS OWN MODULE: the tab stages attendance AND leave changes together, but they are two
 * endpoints. Two bugs lived in the inline version:
 *   - it refused to save anything unless the LEAVE settings had loaded — on the Team plan
 *     (attendance without leave) or when the leave GET failed, no attendance change could be saved;
 *   - when the first PUT succeeded and the second failed, the toast said "nothing was lost; your
 *     changes are still staged" — but half of them were already live, and re-saving would send them
 *     again as if they were not.
 * Here the leave PUT is sent only when leave settings are loaded AND changed, and a half-save is
 * reported as exactly that, so the card can re-baseline the saved half and keep only the rest staged.
 */

export interface SettingsSavePlan<A, L> {
  /** The attendance PUT body, or null when nothing attendance-side changed. */
  attendance: A | null;
  /** The leave PUT body, or null when leave is not loaded (not in the plan / GET failed) or unchanged. */
  leave: L | null;
}

/** Decide the two bodies from what is staged. Leave is optional: only `attendanceLoaded` is required. */
export function planSettingsSave<A extends object, L extends object>(input: {
  attendancePayload: A;
  leaveLoaded: boolean;
  leaveChangeCount: number;
  leaveDraft: L;
}): SettingsSavePlan<A, L> {
  return {
    attendance: Object.keys(input.attendancePayload).length > 0 ? input.attendancePayload : null,
    leave: input.leaveLoaded && input.leaveChangeCount > 0 ? input.leaveDraft : null
  };
}

export type SettingsSaveOutcome =
  /** Everything that was sent landed. */
  | { status: "saved"; attendanceSaved: boolean; leaveSaved: boolean }
  /** The attendance half is live; the leave half failed and is still staged. */
  | { status: "partial"; attendanceSaved: true; leaveSaved: false; error: unknown }
  /** Nothing landed. */
  | { status: "failed"; error: unknown };

export async function runSettingsSave<A, L>(
  plan: SettingsSavePlan<A, L>,
  api: { saveAttendance: (body: A) => Promise<unknown>; saveLeave: (body: L) => Promise<unknown> }
): Promise<SettingsSaveOutcome> {
  let attendanceSaved = false;
  try {
    if (plan.attendance) {
      await api.saveAttendance(plan.attendance);
      attendanceSaved = true;
    }
  } catch (error) {
    return { status: "failed", error };
  }
  try {
    if (plan.leave) await api.saveLeave(plan.leave);
  } catch (error) {
    return attendanceSaved ? { status: "partial", attendanceSaved: true, leaveSaved: false, error } : { status: "failed", error };
  }
  return { status: "saved", attendanceSaved, leaveSaved: Boolean(plan.leave) };
}
