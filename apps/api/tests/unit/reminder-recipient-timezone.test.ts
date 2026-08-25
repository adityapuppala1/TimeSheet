/**
 * "Some users are not receiving mails on Friday — they arrive Monday morning instead."
 *
 * The cause was not the mail queue and not a failed send. `daily-reminder.worker.ts` asked two
 * questions with `now.getDay()` and `now.getHours()` — the SERVER's clock. The server defaults to
 * Asia/Kolkata (config/env.ts) while `User.timezone` is populated per person (the seed ships
 * `America/New_York`), and IST is far enough ahead that the two disagree about what day it is for
 * most of a western Friday afternoon:
 *
 *     New York Fri 14:00  ->  IST Fri 23:30   (sent)
 *     New York Fri 15:00  ->  IST Sat 00:30   (dropped by the weekend filter)
 *     New York Fri 17:00  ->  IST Sat 02:30   (dropped)
 *
 * `remindOnWeekdaysOnly` then suppressed the whole tick, and the next tick that is not a weekend
 * ON THE SERVER is Monday. The escalation copy the dashboard shows — "file today's entry before
 * 5 PM" — sits inside that dead zone, which is why it was the one people noticed.
 *
 * These tests pin the clock arithmetic in utils/recipient-time.ts rather than the worker's Prisma
 * plumbing: it is where the decision now lives, and it is the part that was wrong. A test that
 * mocked the worker's queries would have passed against the broken version too, because the
 * broken version never got as far as a query.
 */
import { describe, expect, it } from "vitest";

import { isWeekendDay, previousBusinessDayKey, startOfZonedDayUtc, zonedParts } from "../../src/utils/recipient-time.js";

/** The instant of a given New York wall-clock time in August (EDT, UTC-4). */
const nyAugust = (day: number, hour: number) => new Date(Date.UTC(2026, 7, day, hour + 4, 0));

const IST = "Asia/Kolkata";
const NY = "America/New_York";

describe("the Friday-becomes-Monday bug", () => {
  it.each([
    [14, "Fri", false],
    [15, "Sat", true],
    [17, "Sat", true],
    [20, "Sat", true]
  ])("New York Friday %i:00 is %s on an IST server (weekend=%s)", (hour, expectedIstDay, istSaysWeekend) => {
    // 2026-08-28 is a Friday.
    const instant = nyAugust(28, hour);
    const server = zonedParts(instant, IST);
    expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][server.weekday]).toBe(expectedIstDay);
    expect(isWeekendDay(server.weekday)).toBe(istSaysWeekend);
  });

  it.each([14, 15, 17, 20])("but it is still Friday, and still a weekday, for the recipient at %i:00", (hour) => {
    // THE REGRESSION GUARD. Every one of these hours must be a sendable Friday for a New York
    // recipient. Under the old server-clock logic the last three were silently dropped.
    const recipient = zonedParts(nyAugust(28, hour), NY);
    expect(recipient.weekday).toBe(5);
    expect(isWeekendDay(recipient.weekday)).toBe(false);
    expect(recipient.dateKey).toBe("2026-08-28");
    expect(recipient.hour).toBe(hour);
  });

  it("a genuine recipient-local weekend is still suppressed", () => {
    // The weekend filter is not being weakened -- it is being asked of the right clock. Saturday
    // in New York is a weekend no matter what the server thinks.
    const recipient = zonedParts(nyAugust(29, 11), NY);
    expect(recipient.weekday).toBe(6);
    expect(isWeekendDay(recipient.weekday)).toBe(true);
  });

  it("gets the mirror-image case right, for a recipient AHEAD of the server", () => {
    // The same mismatch runs the other way and produces the opposite fault: a reminder landing IN
    // someone's weekend rather than being withheld from their Friday.
    //
    // Auckland is UTC+12 in August, 6.5h ahead of IST. Their Saturday 06:00 is still Friday 23:30
    // to the server, so the weekend filter would NOT fire and the mail would go out on their
    // Saturday. Judged on the recipient's clock it is correctly suppressed.
    const aucklandSaturday6am = new Date(Date.UTC(2026, 7, 28, 18, 0));
    expect(zonedParts(aucklandSaturday6am, "Pacific/Auckland").weekday).toBe(6);
    expect(isWeekendDay(zonedParts(aucklandSaturday6am, "Pacific/Auckland").weekday)).toBe(true);
    // ...while the server still thinks it is Friday, a working day.
    expect(zonedParts(aucklandSaturday6am, IST).weekday).toBe(5);
    expect(isWeekendDay(zonedParts(aucklandSaturday6am, IST).weekday)).toBe(false);
  });
});

describe("previousBusinessDayKey, in the recipient's own week", () => {
  it.each([
    ["2026-08-31", 1, "2026-08-28", "Monday asks about Friday"],
    ["2026-08-28", 5, "2026-08-27", "Friday asks about Thursday"],
    ["2026-08-25", 2, "2026-08-24", "Tuesday asks about Monday"],
    ["2026-08-30", 0, "2026-08-28", "Sunday asks about Friday"],
    ["2026-08-29", 6, "2026-08-28", "Saturday asks about Friday"]
  ])("%s (weekday %i) -> %s (%s)", (dateKey, weekday, expected) => {
    expect(previousBusinessDayKey({ dateKey, weekday, hour: 9, timeZone: NY })).toBe(expected);
  });
});

describe("startOfZonedDayUtc", () => {
  it("is the recipient's midnight, not the server's", () => {
    // 2026-08-28 15:00 in New York. Their day began at 04:00 UTC; the IST server's day began at
    // 18:30 UTC the PREVIOUS date. Using the server's boundary for a once-per-day check is how a
    // second reminder gets swallowed as a duplicate.
    const instant = nyAugust(28, 15);
    expect(startOfZonedDayUtc(instant, NY).toISOString()).toBe("2026-08-28T04:00:00.000Z");
    expect(startOfZonedDayUtc(instant, IST).toISOString()).toBe("2026-08-28T18:30:00.000Z");
  });

  it("survives a DST boundary, because the offset is measured at the instant", () => {
    // US DST ended 2026-11-01. A naive fixed-offset implementation is an hour out on one side.
    const beforeDst = new Date(Date.UTC(2026, 9, 15, 16, 0)); // Oct 15, EDT (-4)
    const afterDst = new Date(Date.UTC(2026, 10, 15, 17, 0)); // Nov 15, EST (-5)
    expect(startOfZonedDayUtc(beforeDst, NY).toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(startOfZonedDayUtc(afterDst, NY).toISOString()).toBe("2026-11-15T05:00:00.000Z");
  });
});

describe("fallbacks", () => {
  it("an unset timezone follows the workspace zone", () => {
    expect(zonedParts(nyAugust(28, 15), null, IST).timeZone).toBe(IST);
  });

  it("a junk timezone falls through rather than throwing", () => {
    // A typo in a profile must not take down a scheduled job for everyone else in the loop.
    const parts = zonedParts(nyAugust(28, 15), "Not/AZone", IST);
    expect(parts.timeZone).toBe(IST);
  });

  it("with no zone at all it answers on the server clock, as it always did", () => {
    const instant = nyAugust(28, 15);
    const parts = zonedParts(instant, null, null);
    expect(parts.weekday).toBe(instant.getDay());
    expect(parts.hour).toBe(instant.getHours());
  });
});
