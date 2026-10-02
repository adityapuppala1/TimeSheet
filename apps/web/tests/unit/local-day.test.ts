/**
 * Days on the viewer's clock. Pinned in India's zone, where `toISOString().slice(0, 10)` — what the
 * Workload board used for "today" — names YESTERDAY until 05:30 every morning.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
});
afterAll(() => {
  process.env.TZ = previousTz;
});

const { localDateKey, localWindowFromToday, isoToLocalDate, addLocalDays } = await import("../../src/lib/local-day");

describe("local days", () => {
  it("names the viewer's day, not UTC's, in the hours the two disagree", () => {
    // 01:00 IST on 1 October is 19:30 UTC on 30 September.
    const earlyMorning = new Date("2026-09-30T19:30:00.000Z");
    expect(earlyMorning.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(localDateKey(earlyMorning)).toBe("2026-10-01");
  });

  it("builds a forward window from the viewer's today", () => {
    expect(localWindowFromToday(56, new Date("2026-09-30T19:30:00.000Z"))).toEqual({ from: "2026-10-01", to: "2026-11-26" });
  });

  it("round-trips a key through a local date", () => {
    expect(localDateKey(isoToLocalDate("2026-10-02")!)).toBe("2026-10-02");
    expect(localDateKey(addLocalDays(isoToLocalDate("2026-10-31")!, 1))).toBe("2026-11-01");
    expect(isoToLocalDate("2026-10-2")).toBeNull();
  });
});
