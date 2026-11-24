/** 7.0.0 regularisation: the pure helpers behind "Request correction". */
import { describe, expect, it } from "vitest";
import { canRequestCorrection, punchInstants, timeOf } from "../../src/components/attendance/Regularization";

describe("canRequestCorrection", () => {
  it("allows past days inside the window only", () => {
    expect(canRequestCorrection("2026-11-23", "2026-11-23", 7)).toBe(false);
    expect(canRequestCorrection("2026-11-24", "2026-11-23", 7)).toBe(false);
    expect(canRequestCorrection("2026-11-16", "2026-11-23", 7)).toBe(true);
    expect(canRequestCorrection("2026-11-15", "2026-11-23", 7)).toBe(false);
  });
});

describe("punchInstants", () => {
  it("reads both times on the day, in the browser's zone", () => {
    const r = punchInstants("2026-11-20", "09:00", "17:30");
    expect(r.punchInAt).toBe(new Date("2026-11-20T09:00:00").toISOString());
    expect(r.punchOutAt).toBe(new Date("2026-11-20T17:30:00").toISOString());
    expect(timeOf(r.punchInAt)).toBe("09:00");
  });
  it("an out time before the in time is the next morning (night shift)", () => {
    expect(punchInstants("2026-11-20", "22:00", "06:00").punchOutAt).toBe(new Date("2026-11-21T06:00:00").toISOString());
  });
  it("no out time = no punch-out", () => {
    expect(punchInstants("2026-11-20", "09:00", "").punchOutAt).toBeNull();
  });
});
