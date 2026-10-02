/**
 * utils/date-window.ts's day boundaries under every platform zone an operator can choose (`TZ`).
 *
 * `platformDayStart` probed noon UTC with no correction for zones east of UTC+11, where noon UTC is
 * already the next day — so under Pacific/Auckland every timestamp window began a day late, and
 * `platformUtcOffset` (built on it) answered "-11:00" for a +13:00 zone, putting the CONVERT_TZ
 * email and face day-buckets a whole day off. utils/platform-time.ts had the correction; there were
 * two implementations and they disagreed. IST, London and New York were right and must stay so.
 * The cases are the review's probe (scratchpad vt/r4), run under four zones.
 */
import { describe, expect, it, vi } from "vitest";

const envMock: { TZ?: string } = { TZ: "Asia/Kolkata" };
vi.mock("../../src/config/env.js", () => ({ env: envMock }));

const { platformDayStart, platformUtcOffset, resolveTimestampWindow, parseDayWindow } = await import("../../src/utils/date-window.js");
const { platformDayStart: platformDayStartOfKey } = await import("../../src/utils/platform-time.js");

function inZone<T>(zone: string, fn: () => T): T {
  envMock.TZ = zone;
  try {
    return fn();
  } finally {
    envMock.TZ = "Asia/Kolkata";
  }
}

const DAY = new Date("2026-10-02T00:00:00.000Z");
const NOW = new Date("2026-10-02T06:00:00.000Z");

const cases: Array<{ zone: string; dayStart: string; offsetNow: string; offsetJan: string }> = [
  { zone: "Asia/Kolkata", dayStart: "2026-10-01T18:30:00.000Z", offsetNow: "+05:30", offsetJan: "+05:30" },
  { zone: "Pacific/Auckland", dayStart: "2026-10-01T11:00:00.000Z", offsetNow: "+13:00", offsetJan: "+13:00" },
  { zone: "Europe/London", dayStart: "2026-10-01T23:00:00.000Z", offsetNow: "+01:00", offsetJan: "+00:00" },
  { zone: "America/New_York", dayStart: "2026-10-02T04:00:00.000Z", offsetNow: "-04:00", offsetJan: "-05:00" }
];

describe("date-window day boundaries", () => {
  for (const c of cases) {
    it(`${c.zone}: 2 Oct begins at ${c.dayStart}, the same instant platform-time.ts gives`, () => {
      inZone(c.zone, () => {
        expect(platformDayStart(DAY).toISOString()).toBe(c.dayStart);
        expect(platformDayStart(DAY).toISOString()).toBe(platformDayStartOfKey("2026-10-02").toISOString());
        // A window from 1 Oct starts at 1 Oct's midnight there — not at 2 Oct's.
        const win = resolveTimestampWindow(parseDayWindow({ from: "2026-10-01", to: "2026-10-02" }), NOW);
        expect(win.start.toISOString()).toBe(new Date(new Date(c.dayStart).getTime() - 86_400_000).toISOString());
      });
    });

    it(`${c.zone}: the CONVERT_TZ offset is ${c.offsetNow} now and ${c.offsetJan} in January`, () => {
      inZone(c.zone, () => {
        expect(platformUtcOffset(NOW)).toBe(c.offsetNow);
        expect(platformUtcOffset(new Date("2026-01-15T06:00:00.000Z"))).toBe(c.offsetJan);
      });
    });
  }

  it("Pacific/Kiritimati (UTC+14): the furthest-east zone still gets its own day and offset", () => {
    inZone("Pacific/Kiritimati", () => {
      expect(platformDayStart(DAY).toISOString()).toBe("2026-10-01T10:00:00.000Z");
      expect(platformUtcOffset(NOW)).toBe("+14:00");
    });
  });
});
