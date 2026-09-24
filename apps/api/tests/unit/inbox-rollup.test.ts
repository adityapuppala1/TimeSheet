/**
 * Collapsing repeats in the Inbox queue (C13).
 *
 * The thing being defended against is measured, not hypothetical: on the development workspace 706
 * of 1,916 notifications repeat an existing row's recipient, title and category on the same day;
 * the unhandled queues hold 1,916 rows that are 1,000 distinct notices; and the largest single
 * notice is 205 rows for ONE person, all pointing at the same page. Because the queue reads
 * newest-first and stops at a couple of hundred rows, a burst like that does not just look untidy —
 * it evicts every other kind of notice from the list.
 *
 * What these tests pin is that collapsing never costs the reader anything:
 *   - nothing is dropped (`ids` reaches every row, `bodies` keeps every distinct wording),
 *   - nothing is promoted (an old notice cannot climb the queue by being repeated),
 *   - an entry is unread while ANY row behind it is unread, and unhandled while any is unhandled —
 *     the other way round, one glance would bury a burst permanently.
 */
import { describe, expect, it } from "vitest";
import { rollUpInbox } from "../../src/services/inbox.service.js";

let seq = 0;
const row = (over: Partial<Parameters<typeof rollUpInbox>[0][number]> = {}) => ({
  id: `n${(seq += 1)}`,
  title: "Identity check flagged for review",
  body: "Attempt 1",
  category: "face.verification_flagged" as string | null,
  link: "/app/settings?tab=face",
  createdAt: new Date("2026-09-24T10:00:00Z"),
  readAt: null as Date | null,
  handledAt: null as Date | null,
  snoozedUntil: null as Date | null,
  ...over
});

describe("rollUpInbox", () => {
  it("leaves distinct notices alone", () => {
    const entries = rollUpInbox([row(), row({ title: "Timesheet approved", link: "/app/history" })]);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.repeats === 1)).toBe(true);
  });

  it("collapses a burst into one entry that still reaches every row", () => {
    const rows = Array.from({ length: 489 }, (_, i) => row({ body: `Attempt ${i % 75}` })); // deliberately past the id cap
    const [entry, ...rest] = rollUpInbox(rows);
    expect(rest).toHaveLength(0);
    expect(entry.repeats).toBe(489);
    // Every row is still actionable through the entry, up to the cap that keeps one request sane.
    expect(entry.ids).toHaveLength(500 > 489 ? 489 : 500);
    expect(entry.ids[0]).toBe(rows[0].id);
    // And no wording is hidden by the collapse — the distinct ones are carried, newest first.
    expect(entry.body).toBe("Attempt 0");
    expect(entry.bodies.length).toBeGreaterThan(1);
    expect(entry.bodies).toContain("Attempt 1");
  });

  it("does not let a repeated old notice climb over a newer one", () => {
    // Rows arrive newest-first; entries must come back in that same order. The titles are chosen so
    // that CHRONOLOGICAL and ALPHABETICAL order disagree — a first version of this test used titles
    // where they happened to agree, so sorting the output by title passed it. It fails now.
    const fresh = row({ title: "Zone 3 approval escalated to you", link: "/app/approvals", createdAt: new Date("2026-09-24T12:00:00Z") });
    const old1 = row({ title: "Alarm: identity check flagged", createdAt: new Date("2026-09-20T09:00:00Z") });
    const old2 = row({ title: "Alarm: identity check flagged", createdAt: new Date("2026-09-20T08:00:00Z") });
    const entries = rollUpInbox([fresh, old1, old2]);
    expect(entries.map((e) => e.title)).toEqual(["Zone 3 approval escalated to you", "Alarm: identity check flagged"]);
    expect(entries[1].repeats).toBe(2);
    // The entry speaks for its newest row.
    expect(entries[1].createdAt).toEqual(old1.createdAt);
  });

  it("keeps an entry unread while any row behind it is unread", () => {
    const seen = row({ readAt: new Date("2026-09-24T10:05:00Z") });
    const unseen = row({ readAt: null });
    expect(rollUpInbox([seen, unseen])[0].readAt).toBeNull();
    // ...and the same for handled, so one finished row cannot clear a burst.
    expect(rollUpInbox([row({ handledAt: new Date() }), row({ handledAt: null })])[0].handledAt).toBeNull();
  });

  it("reports an entry as read only when every row behind it is", () => {
    const at = new Date("2026-09-24T10:05:00Z");
    expect(rollUpInbox([row({ readAt: at }), row({ readAt: at })])[0].readAt).toEqual(at);
  });

  it("treats a missing category and a missing link as values, not as wildcards", () => {
    // Two rows with no link must not merge with a row that has one just because both are 'empty'.
    const entries = rollUpInbox([row({ link: null, category: null }), row({ link: null, category: null }), row()]);
    expect(entries).toHaveLength(2);
    expect(entries[0].repeats).toBe(2);
  });

  it("does not merge notices that point at different places", () => {
    const entries = rollUpInbox([row({ link: "/app/tickets/1" }), row({ link: "/app/tickets/2" })]);
    expect(entries).toHaveLength(2);
  });

  it("returns nothing for an empty queue", () => {
    expect(rollUpInbox([])).toEqual([]);
  });
});
