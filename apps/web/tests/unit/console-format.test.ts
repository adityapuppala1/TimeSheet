/**
 * The platform console's calendar and number formats, in one place.
 *
 *  - The console's days are the PLATFORM's days (India by default, as the API's utils/platform-time.ts),
 *    so a window the browser asks for is India's calendar whatever zone the operator's laptop is in.
 *    `toISOString().slice(0, 10)` was UTC's date: between 00:00 and 05:30 IST it named yesterday, and
 *    "the last 7 days" left out today entirely.
 */
import { describe, expect, it } from "vitest";
import { consoleDayKey, consoleRangeForDays } from "../../src/lib/console-format";

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
