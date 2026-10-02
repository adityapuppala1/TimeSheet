/**
 * `lib/format.ts` — the analytics surfaces' one formatter. The properties that matter: en-IN
 * grouping by default, money that wears the currency it came with (never a guessed "$"), hours
 * with exactly one decimal, "2 Oct 2026" dates, and "—" — not 0 — for a value that does not exist.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_VALUE,
  formatCompact,
  formatDate,
  formatDayMonth,
  formatHours,
  formatMoney,
  formatNumber,
  formatPercent,
  setFormatLocale
} from "../../src/lib/format";

afterEach(() => setFormatLocale(null));

describe("numbers", () => {
  it("groups in lakhs and crores by default", () => {
    expect(formatNumber(1234567)).toBe("12,34,567");
  });

  it("prints a dash, never a zero, for a value that does not exist", () => {
    for (const missing of [null, undefined, Number.NaN]) {
      expect(formatNumber(missing)).toBe(NO_VALUE);
      expect(formatHours(missing)).toBe(NO_VALUE);
      expect(formatPercent(missing)).toBe(NO_VALUE);
      expect(formatMoney(missing, "INR")).toBe(NO_VALUE);
      expect(formatCompact(missing)).toBe(NO_VALUE);
    }
    // A measured zero is still a zero.
    expect(formatNumber(0)).toBe("0");
    expect(formatPercent(0)).toBe("0%");
  });

  it("writes compact figures the Indian way", () => {
    expect(formatCompact(1_200_000)).toBe("12L");
    expect(formatCompact(12_000_000)).toBe("1.2Cr");
  });

  it("follows a locale it is given, and falls back to en-IN for junk", () => {
    setFormatLocale("en-US");
    expect(formatNumber(1234567)).toBe("1,234,567");
    setFormatLocale("not a locale !!");
    expect(formatNumber(1234567)).toBe("12,34,567");
  });
});

describe("hours", () => {
  it("always has exactly one decimal", () => {
    expect(formatHours(7.5)).toBe("7.5h");
    expect(formatHours(8)).toBe("8.0h");
    expect(formatHours(7.25)).toBe("7.3h");
    expect(formatHours(1234)).toBe("1,234.0h");
  });
});

describe("money", () => {
  it("wears the currency from the data", () => {
    expect(formatMoney(1234567.5, "INR")).toBe("₹12,34,567.50");
    expect(formatMoney(1200, "USD")).toBe("$1,200.00");
  });

  it("never invents a symbol when the data has no currency", () => {
    expect(formatMoney(1200, null)).toBe("1,200");
    expect(formatMoney(1200.5, "")).toBe("1,200.5");
  });

  it("prints an unknown code after the amount instead of throwing", () => {
    expect(formatMoney(10, "ZZZZ")).toBe("10 ZZZZ");
  });

  it("can be compact", () => {
    expect(formatMoney(12_345_678, "INR", { compact: true })).toBe("₹1.2Cr");
  });
});

describe("dates", () => {
  it("reads 2 Oct 2026, from a day key or a Date", () => {
    expect(formatDate("2026-10-02")).toBe("2 Oct 2026");
    expect(formatDate(new Date(2026, 9, 2, 15, 0))).toBe("2 Oct 2026");
  });

  it("treats a YYYY-MM-DD key as that calendar day, not as UTC midnight", () => {
    // Parsed as UTC midnight, the 2nd is the 1st anywhere west of Greenwich.
    expect(formatDayMonth("2026-10-02")).toBe("2 Oct");
  });

  it("dashes an empty or unreadable date", () => {
    expect(formatDate(null)).toBe(NO_VALUE);
    expect(formatDate("")).toBe(NO_VALUE);
    expect(formatDate("not a date")).toBe(NO_VALUE);
  });
});

describe("money in whole units", () => {
  it("drops the paise and cents where a page shows budgets in whole units", () => {
    expect(formatMoney(1234567.5, "INR", { whole: true })).toBe("₹12,34,568");
  });
});
