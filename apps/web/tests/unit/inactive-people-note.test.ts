/**
 * The footnote that stops a deliberately shortened chart from reading as a broken one.
 *
 * Deactivated people no longer appear in the UI's per-person breakdowns (see
 * `apps/api/src/services/people-visibility.service.ts`). That is what was asked for, and it creates
 * a second problem the server cannot solve on its own: a manager who knows seven people logged time
 * this month and counts five rows has no way to tell an intentional exclusion from data loss. The
 * server returns a count of what it dropped; this decides whether and how to say it.
 *
 * Two things here are worth pinning, and both would ship unnoticed:
 *
 *   1. AN ABSENT COUNT MUST READ AS "NOTHING HIDDEN", NOT AS ZERO-SHAPED TRUTH. Every one of these
 *      API fields is optional, so that a browser holding a newer SPA against an older server
 *      degrades to silence rather than to a note claiming "undefined inactive people are hidden".
 *   2. THE PLURAL. "1 inactive people are hidden" is a small error in a sentence whose only job is
 *      to make a chart look considered. Getting it wrong undoes the whole point of printing it.
 */
import { describe, expect, it } from "vitest";

import { describeHiddenPeople } from "../../src/utils/inactive-people";

describe("when nothing was hidden, there is nothing to say", () => {
  it("says nothing for zero, for a missing field, and for null", () => {
    // Zero is the ordinary case — most workspaces have never deactivated anybody, and every chart
    // on the page calls this on every render.
    expect(describeHiddenPeople(0)).toBeNull();
    // `undefined` is an older API build that does not send the field at all.
    expect(describeHiddenPeople(undefined)).toBeNull();
    expect(describeHiddenPeople(null)).toBeNull();
  });

  it("says nothing for a nonsense count rather than repeating it on screen", () => {
    // A negative or a NaN means something upstream is wrong. Printing it turns a server-side bug
    // into a user-visible one, and tells the reader nothing they can act on.
    expect(describeHiddenPeople(-1)).toBeNull();
    expect(describeHiddenPeople(Number.NaN)).toBeNull();
    expect(describeHiddenPeople(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("when somebody was hidden, it says so and says where they went", () => {
  it("agrees with itself about number", () => {
    expect(describeHiddenPeople(1)).toContain("1 inactive person is hidden");
    expect(describeHiddenPeople(2)).toContain("2 inactive people are hidden");
    expect(describeHiddenPeople(11)).toContain("11 inactive people are hidden");
  });

  it("promises the totals and the export are still whole, because they are", () => {
    // Not decoration: it is the difference between "this chart is missing data" and "this chart is
    // showing current staff". Both halves are true by construction — the API narrows only the
    // per-person rows, never the totals, and never the download.
    const note = describeHiddenPeople(3)!;
    expect(note).toContain("still counts towards the totals");
    expect(note).toContain("exported reports still include them");
  });
});
