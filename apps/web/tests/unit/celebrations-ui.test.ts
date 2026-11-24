/** 7.0.0 celebrations strip: day and month only, years of service only when >= 1. */
import { describe, expect, it } from "vitest";
import { celebrationText, dayMonthLabel } from "../../src/components/attendance/Celebrations";

const base = { userId: "u", name: "Asha", avatarUrl: null, date: "2026-11-25" };

describe("celebration labels", () => {
  it("shows day and month, never a year", () => {
    expect(dayMonthLabel("11-25")).toBe("25 Nov");
    const text = celebrationText({ ...base, kind: "BIRTHDAY", monthDay: "11-25" });
    expect(text).toBe("Asha · birthday · 25 Nov");
    expect(text).not.toMatch(/\d{4}/);
  });
  it("shows years of service only when 1 or more", () => {
    expect(celebrationText({ ...base, kind: "ANNIVERSARY", monthDay: "11-25", years: 1 })).toBe("Asha · work anniversary · 1 year · 25 Nov");
    expect(celebrationText({ ...base, kind: "ANNIVERSARY", monthDay: "11-25", years: 4 })).toContain("4 years");
    expect(celebrationText({ ...base, kind: "ANNIVERSARY", monthDay: "11-25", years: 0 })).toBe("Asha · work anniversary · 25 Nov");
  });
});
