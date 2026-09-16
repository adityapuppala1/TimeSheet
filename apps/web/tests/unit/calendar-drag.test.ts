import { describe, expect, it } from "vitest";
import { addDaysKey, shiftSchedule, weekDays } from "../../src/lib/calendar-drag";

describe("shiftSchedule", () => {
  it("moves a scheduled item keeping its length, across a month end", () => {
    expect(shiftSchedule({ isScheduled: true, startDate: "2026-09-28", endDate: "2026-09-30" }, "2026-10-30"))
      .toEqual({ startDate: "2026-10-30", endDate: "2026-11-01" });
  });
  it("returns null when dropped on its own start day", () => {
    expect(shiftSchedule({ isScheduled: true, startDate: "2026-09-10T00:00:00.000Z", endDate: "2026-09-12" }, "2026-09-10")).toBeNull();
  });
  it("schedules an unscheduled item on the drop day, one day long", () => {
    expect(shiftSchedule({ isScheduled: false, startDate: null, endDate: null }, "2026-09-16")).toEqual({ startDate: "2026-09-16", endDate: "2026-09-16" });
  });
  it("ignores a malformed drop key", () => {
    expect(shiftSchedule({ isScheduled: false, startDate: null, endDate: null }, "not-a-day")).toBeNull();
  });
});

describe("weekDays", () => {
  it("is Monday to Sunday around any day, across a year end", () => {
    expect(weekDays("2026-01-01")).toEqual(["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(weekDays("2026-09-20")[0]).toBe("2026-09-14"); // a Sunday belongs to the week that started on Monday
  });
  it("addDaysKey steps whole days", () => {
    expect(addDaysKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysKey("2026-03-01", -1)).toBe("2026-02-28");
  });
});
