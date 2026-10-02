/**
 * The platform's own calendar — the day and hour in the deployment's configured zone (`TZ`,
 * Asia/Kolkata unless an operator chose another), never UTC's. Pinned with the instants where the
 * two disagree: IST is UTC+5:30, so from 18:30 UTC it is already tomorrow in India.
 */
import { describe, expect, it, vi } from "vitest";

const envMock: { TZ?: string } = { TZ: "Asia/Kolkata" };
vi.mock("../../src/config/env.js", () => ({ env: envMock }));

const { platformDayEnd, platformDayKey, platformHourKey } = await import("../../src/utils/platform-time.js");

describe("platform time", () => {
  it("names the day as India sees it — 19:00 UTC on the 1st is already the 2nd", () => {
    expect(platformDayKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02");
    expect(platformDayKey(new Date("2026-10-01T18:29:59Z"))).toBe("2026-10-01");
  });

  it("names the hour as India sees it, half-hour offset included", () => {
    expect(platformHourKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02T00");
    expect(platformHourKey(new Date("2026-10-02T08:15:00Z"))).toBe("2026-10-02T13");
  });

  it("follows an operator's own choice of zone", () => {
    envMock.TZ = "UTC";
    expect(platformDayKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-01");
    envMock.TZ = "Asia/Kolkata";
  });
});

describe("platformDayEnd — the last instant of a calendar day where the platform is", () => {
  const cases: Array<[string, string, string]> = [
    // zone, day, the instant that day ends (UTC)
    ["Asia/Kolkata", "2026-10-05", "2026-10-05T18:29:59.999Z"],
    ["UTC", "2026-10-05", "2026-10-05T23:59:59.999Z"],
    // Far east: noon UTC on the 6th is already the 7th there — the correction case.
    ["Pacific/Kiritimati", "2026-10-05", "2026-10-05T09:59:59.999Z"],
    // West, on a DST day: 1 Nov 2026 is 25 hours long in Los Angeles (PDT -> PST at 02:00).
    ["America/Los_Angeles", "2026-11-01", "2026-11-02T07:59:59.999Z"]
  ];
  for (const [zone, day, end] of cases) {
    it(`${zone}: ${day} ends at ${end}`, () => {
      envMock.TZ = zone;
      try {
        expect(platformDayEnd(day).toISOString()).toBe(end);
        // And it really is that day's last instant: one millisecond on is the next day there.
        expect(platformDayKey(platformDayEnd(day))).toBe(day);
        expect(platformDayKey(new Date(platformDayEnd(day).getTime() + 1))).not.toBe(day);
      } finally {
        envMock.TZ = "Asia/Kolkata";
      }
    });
  }
});
