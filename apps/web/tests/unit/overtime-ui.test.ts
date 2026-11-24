/** 7.0.0 overtime UI: the pure helpers behind the card and the inbox. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/PunchIn", () => ({ useMyToday: () => ({ data: undefined }) }));

const { canClaimWeek, hoursText, overtimeWeekLine } = await import("../../src/components/attendance/Overtime");

describe("overtime helpers", () => {
  it("formats hours and the week line", () => {
    expect(hoursText(2.456)).toBe("2.46h");
    expect(overtimeWeekLine({ weekStart: "2026-11-16", workedHours: 43, expectedHours: 40, overtimeHours: 3 })).toBe("Week of 2026-11-16 · 43h of 40h · 3h overtime");
  });
  it("a week can be claimed once over, with overtime, and no open claim", () => {
    const w = { weekStart: "2026-11-16", overtimeHours: 3, claim: null };
    expect(canClaimWeek(w, "2026-11-23")).toBe(true);
    expect(canClaimWeek(w, "2026-11-22")).toBe(false);
    expect(canClaimWeek({ ...w, overtimeHours: 0 }, "2026-11-23")).toBe(false);
    expect(canClaimWeek({ ...w, claim: { id: "c" } as never }, "2026-11-23")).toBe(false);
  });
});
