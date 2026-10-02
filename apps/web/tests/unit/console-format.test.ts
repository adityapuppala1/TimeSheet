/**
 * The platform console's calendar and number formats, in one place.
 *
 *  - The console's days are the PLATFORM's days (India by default, as the API's utils/platform-time.ts),
 *    so a window the browser asks for is India's calendar whatever zone the operator's laptop is in.
 *    `toISOString().slice(0, 10)` was UTC's date: between 00:00 and 05:30 IST it named yesterday, and
 *    "the last 7 days" left out today entirely.
 */
import { describe, expect, it } from "vitest";
import { consoleDayKey, consoleRangeForDays, dayMonth, formatCount, formatMinor, formatUsd, monthLabel, summariseCounts, trendTick } from "../../src/lib/console-format";

describe("consoleDayKey", () => {
  it("names the day as India sees it — 19:00 UTC on 1 Oct is already 2 Oct", () => {
    expect(consoleDayKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02");
    expect(consoleDayKey(new Date("2026-10-01T18:29:59Z"))).toBe("2026-10-01");
  });
});

describe("consoleRangeForDays", () => {
  it("ends the range on India's today, even in the first hours after its midnight", () => {
    // 01:30 IST on 2 Oct. UTC still says 1 Oct, and a range ending there excluded today's mail.
    expect(consoleRangeForDays(7, new Date("2026-10-01T20:00:00Z"))).toEqual({ from: "2026-09-26", to: "2026-10-02" });
  });

  it("spans exactly the number of days asked for, today included", () => {
    expect(consoleRangeForDays(1, new Date("2026-10-02T08:00:00Z"))).toEqual({ from: "2026-10-02", to: "2026-10-02" });
    expect(consoleRangeForDays(30, new Date("2026-10-02T08:00:00Z"))).toEqual({ from: "2026-09-03", to: "2026-10-02" });
  });
});

describe("dayMonth", () => {
  it("names a date-only key as a day and a short month, never MM-DD", () => {
    // A date-only key has no zone: 13 July is 13 July wherever the browser is.
    expect(dayMonth("2026-07-13")).toBe("13 Jul");
    expect(dayMonth("2026-01-01")).toBe("1 Jan");
  });
});

describe("summariseCounts — a chart's text alternative", () => {
  it("states the total, the peak and the latest point", () => {
    const text = summariseCounts(
      [
        { label: "the week of 13 Jul", total: 2 },
        { label: "the week of 20 Jul", total: 7 },
        { label: "the week of 27 Jul", total: 1 }
      ],
      { noun: "new workspace", span: "3 weeks" }
    );
    expect(text).toBe("10 new workspaces in the last 3 weeks. The most, 7, in the week of 20 Jul; 1 in the week of 27 Jul.");
  });

  it("says plainly when there is nothing to chart", () => {
    expect(summariseCounts([{ label: "today", total: 0 }], { noun: "email", span: "7 days" })).toBe("No emails in the last 7 days.");
  });
});

describe("formatMinor — the console's one money formatter", () => {
  it("formats in Indian digit grouping, in the currency the DATA carries", () => {
    // The Revenue page hard-coded en-US, so an en-IN browser showed 1,00,000 beside $100,000.
    expect(formatMinor(12_345_600, "INR")).toBe("₹1,23,456");
    expect(formatMinor(80_000, "USD", 2)).toBe("$800.00");
    expect(formatMinor(5_000, "EUR")).toBe("€50");
  });

  it("never renders an unknown amount as money", () => {
    expect(formatMinor(null, "USD")).toBe("—");
    expect(formatMinor(undefined, "INR")).toBe("—");
  });

  it("keeps AI spend in US dollars, as the providers bill it", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("—");
  });

  it("counts in Indian digit grouping", () => {
    expect(formatCount(1_234_567)).toBe("12,34,567");
  });
});

describe("chart labels", () => {
  it("names a month key as a month, not as 26-10", () => {
    expect(monthLabel("2026-10")).toBe("Oct 2026");
  });

  it("labels an hourly series with the hour when the window is short enough to need it", () => {
    // Hourly samples labelled by date only gave twenty-four points the same tick.
    expect(trendTick("2026-10-02T08:30:00Z", 7)).toBe("2 Oct, 14:00");
    expect(trendTick("2026-10-02T08:30:00Z", 90)).toBe("2 Oct");
  });
});
