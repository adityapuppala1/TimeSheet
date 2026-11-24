import { describe, expect, it } from "vitest";
import { lastMonth } from "../../src/components/attendance/PayrollExport";

describe("lastMonth", () => {
  it("is the month that just ended, across a year boundary too", () => {
    expect(lastMonth("2026-11-24")).toBe("2026-10");
    expect(lastMonth("2027-01-03")).toBe("2026-12");
  });
});
