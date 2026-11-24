import { describe, expect, it } from "vitest";
import { reasonFieldsFor, reasonProblems } from "../../src/lib/week-draft-reasons";

const OPTIONS = [
  { code: "SICK", label: "Unwell", requiresNote: false },
  { code: "OTHER", label: "Other", requiresNote: true }
];
const rows = [{ workDate: "2026-11-16" }, { workDate: "2026-11-16" }, { workDate: "2026-11-17" }];

describe("Draft my week missed-day reason", () => {
  it("sends the reason only with the first row of a day that needs one", () => {
    const fields = reasonFieldsFor(rows, { "2026-11-16": OPTIONS }, { "2026-11-16": { code: "SICK", note: " x " } });
    expect(fields).toEqual([{ missedReasonCode: "SICK", missedReasonNote: "x" }, {}, {}]);
  });

  it("refuses to add until each flagged day has a valid reason", () => {
    expect(reasonProblems(rows, { "2026-11-16": OPTIONS }, {})).toEqual({ "2026-11-16": { field: "missedReasonCode", message: "Choose why this day was missed." } });
    expect(reasonProblems(rows, { "2026-11-16": OPTIONS }, { "2026-11-16": { code: "OTHER", note: "" } })["2026-11-16"].field).toBe("missedReasonNote");
    expect(reasonProblems(rows, { "2026-11-16": OPTIONS }, { "2026-11-16": { code: "SICK", note: "" } })).toEqual({});
  });

  it("asks nothing when no day was flagged (module off: identical requests)", () => {
    expect(reasonFieldsFor(rows, {}, {})).toEqual([{}, {}, {}]);
    expect(reasonProblems(rows, {}, {})).toEqual({});
  });
});
