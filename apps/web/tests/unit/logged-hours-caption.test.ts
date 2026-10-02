/**
 * The Reports page shows two hour totals for the same range, one above the other: the grouped
 * report (status filter defaults to "any status") and the Analytics panel (LOGGED hours only —
 * submitted + approved). Both definitions are deliberate. What is not acceptable is the reader
 * finding two different totals with nothing saying why, so the panel's caption states the rule and
 * the exact hours it left out.
 */
import { describe, expect, it } from "vitest";

import { loggedHoursCaption } from "../../src/lib/logged-hours";

describe("the analytics caption", () => {
  it("states the logged-hours rule and how many draft and rejected hours are not counted", () => {
    const caption = loggedHoursCaption({ draftHours: 2, rejectedHours: 1.5, draftEntries: 1, rejectedEntries: 1 });
    expect(caption).toBe("Logged = submitted + approved; 3.5h in drafts or rejected not counted.");
  });

  it("still states the rule when nothing was left out", () => {
    expect(loggedHoursCaption({ draftHours: 0, rejectedHours: 0, draftEntries: 0, rejectedEntries: 0 })).toBe(
      "Logged = submitted + approved."
    );
  });

  it("reads an older server that sends no excluded figures as nothing left out", () => {
    expect(loggedHoursCaption(undefined)).toBe("Logged = submitted + approved.");
  });
});
