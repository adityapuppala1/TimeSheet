/**
 * "Today" for the timesheet form — the LOCAL calendar day, never the UTC one.
 *
 * THE DEFECT (audit 2026-10, timesheets #6): the log form's default work date, its date picker's
 * upper bound and the entry dialog's picker all used `new Date().toISOString().slice(0, 10)` — the
 * UTC date. In India (UTC+5:30) that is still YESTERDAY from midnight to 05:30, so the form opened on
 * the wrong day and today could not even be picked; in New York it was already TOMORROW every
 * evening from 20:00, which is how Friday's work got saved as Saturday.
 */
import { afterEach, describe, expect, it } from "vitest";
import { localDateKey } from "../../src/lib/local-date";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

describe("localDateKey", () => {
  it("is today in India at 02:00 IST, where the UTC date is still yesterday", () => {
    process.env.TZ = "Asia/Kolkata";
    const twoAmIst = new Date("2026-10-01T20:30:00.000Z");
    expect(twoAmIst.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(localDateKey(twoAmIst)).toBe("2026-10-02");
  });

  it("is still today in New York at 21:00, where the UTC date is already tomorrow", () => {
    process.env.TZ = "America/New_York";
    const ninePmFriday = new Date("2026-10-03T01:00:00.000Z");
    expect(ninePmFriday.toISOString().slice(0, 10)).toBe("2026-10-03");
    expect(localDateKey(ninePmFriday)).toBe("2026-10-02");
  });

  it("pads month and day", () => {
    process.env.TZ = "UTC";
    expect(localDateKey(new Date("2026-03-04T12:00:00.000Z"))).toBe("2026-03-04");
  });
});

/**
 * "Today" is the PROFILE's day when the person has set a time zone — the day the server checks a
 * work date against (User.timezone, services/user-clock.service.ts). THE DEFECT (audit 2026-10 R3):
 * the form used the DEVICE's day, so a New York profile used from India between 00:00 and 09:30 IST
 * defaulted the date to a day the server refused as "in the future".
 */
describe("localDateKey in the profile's time zone", () => {
  it("is still 2 October for a New York profile on an Indian device at 08:00 IST", () => {
    process.env.TZ = "Asia/Kolkata";
    const eightAmIst = new Date("2026-10-03T02:30:00.000Z");
    expect(localDateKey(eightAmIst)).toBe("2026-10-03");
    expect(localDateKey(eightAmIst, "America/New_York")).toBe("2026-10-02");
  });

  it("is the profile's today when it is AHEAD of the device too", () => {
    process.env.TZ = "America/New_York";
    const ninePmFriday = new Date("2026-10-03T01:00:00.000Z");
    expect(localDateKey(ninePmFriday, "Asia/Kolkata")).toBe("2026-10-03");
  });

  it("falls back to the device's day with no profile zone, or one the browser does not know", () => {
    process.env.TZ = "Asia/Kolkata";
    const eightAmIst = new Date("2026-10-03T02:30:00.000Z");
    expect(localDateKey(eightAmIst, null)).toBe("2026-10-03");
    expect(localDateKey(eightAmIst, "")).toBe("2026-10-03");
    expect(localDateKey(eightAmIst, "Mars/Olympus_Mons")).toBe("2026-10-03");
  });
});
