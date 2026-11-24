import { describe, expect, it } from "vitest";
import { expectedHoursBlock, expectedHoursSentence } from "../../src/services/weekly-digest-expected.service.js";

const base = { workingDays: 5, holidays: 0, leaveDays: 0, expectedDays: 5, dailyHours: 8, expectedHours: 40 };

describe("weekly digest expected hours", () => {
  it("states the plain week", () => {
    expect(expectedHoursSentence(base, 38.25)).toBe("Expected last week: 40h. Logged: 38.3h.");
  });
  it("names holidays and leave days that reduced the figure", () => {
    expect(expectedHoursSentence({ ...base, holidays: 1, leaveDays: 1.5, expectedDays: 2.5, expectedHours: 20 }, 20)).toBe(
      "Expected last week: 20h (after 1 holiday and 1.5 days of leave). Logged: 20h."
    );
  });
  it("escapes the block", () => {
    expect(expectedHoursBlock("a<b")).toContain("a&lt;b");
  });
});
