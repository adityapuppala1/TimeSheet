import { describe, expect, it } from "vitest";
import { missedReasonProblem, readMissedDayRefusal } from "../../src/lib/missed-day-reason";

const OPTIONS = [
  { code: "SICK", label: "Sick", requiresNote: false },
  { code: "OTHER", label: "Other", requiresNote: true }
];

describe("missedReasonProblem", () => {
  it("needs a reason", () => {
    expect(missedReasonProblem(OPTIONS, "", "")?.field).toBe("missedReasonCode");
  });
  it("refuses a code that is not offered", () => {
    expect(missedReasonProblem(OPTIONS, "FORGOT", "")?.field).toBe("missedReasonCode");
  });
  it("needs a note only for a reason marked so", () => {
    expect(missedReasonProblem(OPTIONS, "SICK", "")).toBeNull();
    expect(missedReasonProblem(OPTIONS, "OTHER", "  ")?.field).toBe("missedReasonNote");
    expect(missedReasonProblem(OPTIONS, "OTHER", "Power cut")).toBeNull();
  });
});

const refusal = (status: number, data: unknown) => ({ response: { status, data } });

describe("readMissedDayRefusal", () => {
  it("reads the server's 422 into the prompt's options and field", () => {
    const out = readMissedDayRefusal(
      refusal(422, { code: "MISSED_DAY_REASON_REQUIRED", message: "Tell us why", details: { field: "missedReasonCode", options: OPTIONS } })
    );
    // The server's REQUIRED text is for API callers; the form says it in plain words.
    expect(out).toEqual({ options: OPTIONS, field: "missedReasonCode", message: "Choose why this day was missed." });
  });
  it("keeps the server's own words for an invalid reason", () => {
    expect(readMissedDayRefusal(refusal(422, { code: "MISSED_DAY_REASON_INVALID", message: 'Add a note for "Other".', details: {} }))?.message).toBe(
      'Add a note for "Other".'
    );
  });
  it("points at the note for an invalid note", () => {
    expect(readMissedDayRefusal(refusal(422, { code: "MISSED_DAY_REASON_INVALID", details: { field: "missedReasonNote", options: OPTIONS } }))?.field).toBe(
      "missedReasonNote"
    );
  });
  it("ignores every other error", () => {
    expect(readMissedDayRefusal(refusal(422, { message: "Validation failed" }))).toBeNull();
    expect(readMissedDayRefusal(refusal(409, { code: "MISSED_DAY_REASON_REQUIRED" }))).toBeNull();
    expect(readMissedDayRefusal(new Error("network"))).toBeNull();
    expect(readMissedDayRefusal(undefined)).toBeNull();
  });
  it("drops malformed options rather than rendering them", () => {
    const out = readMissedDayRefusal(refusal(422, { code: "MISSED_DAY_REASON_REQUIRED", details: { options: [{ code: 1 }, OPTIONS[0]] } }));
    expect(out?.options).toEqual([OPTIONS[0]]);
  });
});
