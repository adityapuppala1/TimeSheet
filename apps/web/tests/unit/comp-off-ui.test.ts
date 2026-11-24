import { describe, expect, it } from "vitest";
import { compOffDaysText, compOffLine } from "../../src/components/attendance/CompOff";

describe("comp-off text", () => {
  it("says day or days", () => {
    expect(compOffDaysText(1)).toBe("1 day");
    expect(compOffDaysText(0.5)).toBe("0.5 days");
  });

  it("names the kind of day, the hours and the credit", () => {
    expect(compOffLine({ workDate: "2026-11-21", dayKind: "WEEKEND", hoursLogged: 8, days: 1 })).toBe("Weekend 2026-11-21 · 8h logged · 1 day");
    expect(compOffLine({ workDate: "2026-11-19", dayKind: "HOLIDAY", hoursLogged: 5, days: 0.5 })).toBe("Holiday 2026-11-19 · 5h logged · 0.5 days");
  });
});
