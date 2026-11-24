/**
 * The Attendance & Leave settings tab's Save (lib/attendance-settings-save.ts): on the Team plan
 * there is no leave half and attendance changes must still save; when only one of the two PUTs
 * lands the outcome says so, so the card re-baselines that half and keeps the rest staged.
 */
import { describe, expect, it, vi } from "vitest";
import { planSettingsSave, runSettingsSave } from "../../src/lib/attendance-settings-save";

const api = (over: Partial<{ saveAttendance: (b: unknown) => Promise<unknown>; saveLeave: (b: unknown) => Promise<unknown> }> = {}) => ({
  saveAttendance: vi.fn(over.saveAttendance ?? (async () => ({}))),
  saveLeave: vi.fn(over.saveLeave ?? (async () => ({})))
});

describe("planSettingsSave", () => {
  it("Team tier (attendance without leave): leave not loaded → only the attendance body", () => {
    expect(planSettingsSave({ attendancePayload: { punchInEnabled: true }, leaveLoaded: false, leaveChangeCount: 0, leaveDraft: {} })).toEqual({
      attendance: { punchInEnabled: true },
      leave: null
    });
  });

  it("the leave GET failed: a stale leave draft is never sent", () => {
    expect(planSettingsSave({ attendancePayload: { punchInEnabled: true }, leaveLoaded: false, leaveChangeCount: 1, leaveDraft: { leaveEnabled: true } }).leave).toBeNull();
  });

  it("Enterprise tier: both bodies when both changed; neither when nothing did", () => {
    expect(planSettingsSave({ attendancePayload: { a: 1 }, leaveLoaded: true, leaveChangeCount: 1, leaveDraft: { leaveEnabled: true } })).toEqual({
      attendance: { a: 1 },
      leave: { leaveEnabled: true }
    });
    expect(planSettingsSave({ attendancePayload: {}, leaveLoaded: true, leaveChangeCount: 0, leaveDraft: {} })).toEqual({ attendance: null, leave: null });
  });
});

describe("runSettingsSave", () => {
  it("Team tier saves attendance and never calls the leave endpoint", async () => {
    const calls = api();
    const out = await runSettingsSave({ attendance: { punchInEnabled: true }, leave: null }, calls);
    expect(out).toEqual({ status: "saved", attendanceSaved: true, leaveSaved: false });
    expect(calls.saveAttendance).toHaveBeenCalledWith({ punchInEnabled: true });
    expect(calls.saveLeave).not.toHaveBeenCalled();
  });

  it("Enterprise tier saves both, attendance first", async () => {
    const order: string[] = [];
    const calls = api({ saveAttendance: async () => order.push("attendance"), saveLeave: async () => order.push("leave") });
    expect(await runSettingsSave({ attendance: { a: 1 }, leave: { leaveEnabled: true } }, calls)).toEqual({ status: "saved", attendanceSaved: true, leaveSaved: true });
    expect(order).toEqual(["attendance", "leave"]);
  });

  it("a leave-only change saves leave alone", async () => {
    const calls = api();
    expect(await runSettingsSave({ attendance: null, leave: { leaveEnabled: true } }, calls)).toEqual({ status: "saved", attendanceSaved: false, leaveSaved: true });
    expect(calls.saveAttendance).not.toHaveBeenCalled();
  });

  it("first PUT ok, second fails → partial (the attendance half is live)", async () => {
    const boom = { response: { data: { message: "The leave year start month can't be changed" } } };
    const out = await runSettingsSave({ attendance: { a: 1 }, leave: { leaveYearStartMonth: 4 } }, api({ saveLeave: async () => Promise.reject(boom) }));
    expect(out).toEqual({ status: "partial", attendanceSaved: true, leaveSaved: false, error: boom });
  });

  it("first PUT fails → failed, and the second is not attempted", async () => {
    const calls = api({ saveAttendance: async () => Promise.reject(new Error("nope")) });
    const out = await runSettingsSave({ attendance: { a: 1 }, leave: { leaveEnabled: true } }, calls);
    expect(out.status).toBe("failed");
    expect(calls.saveLeave).not.toHaveBeenCalled();
  });

  it("leave-only change that fails → failed, not partial", async () => {
    const out = await runSettingsSave({ attendance: null, leave: { leaveEnabled: true } }, api({ saveLeave: async () => Promise.reject(new Error("x")) }));
    expect(out.status).toBe("failed");
  });
});
