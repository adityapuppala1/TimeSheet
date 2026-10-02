/**
 * The ticket analytics behind Insights and the Reports page's ticket tiles
 * (services/ticket-analytics.service.ts), against the shared definitions in workspace-metrics.ts.
 *
 *   - M1: weekly buckets started on Monday 00:00 UTC — 05:30 IST — so a ticket raised at 02:00 IST
 *     on a Monday counted in the previous week.
 *   - M8: resolution time was the MEAN of the last 200 resolutions of all time, compared "vs last
 *     week" against a different-sized sample, and 0 when there were none; first response was the
 *     first comment by ANYONE, the reporter and the intake bot included, over 500 tickets with no
 *     order, and never-answered tickets silently dropped.
 *   - LOW: the reopen rate divided "ever reopened" by "ever resolved" without intersecting them, so
 *     it could pass 100%.
 *   - M6: one SLA definition — (resolvedAt ?? now) > dueAt.
 */
import { describe, expect, it } from "vitest";
import {
  firstResponseStats,
  istWeekStarts,
  reopenRate,
  resolutionStats,
  slaComplianceByWeek,
  weekIndexFor
} from "../../src/services/ticket-analytics.service.js";

const HOUR = 3_600_000;

describe("IST weeks", () => {
  // Thursday 1 October 2026, 10:00 IST.
  const now = new Date("2026-10-01T04:30:00.000Z");

  it("starts each week at Monday 00:00 IST", () => {
    const weeks = istWeekStarts(2, now);
    expect(weeks.map((w) => w.toISOString())).toEqual(["2026-09-20T18:30:00.000Z", "2026-09-27T18:30:00.000Z"]);
  });

  it("puts a ticket raised at 02:00 IST on Monday in that Monday's week", () => {
    const weeks = istWeekStarts(2, now);
    // 20:30 UTC on Sunday the 27th is 02:00 IST on Monday the 28th.
    expect(weekIndexFor(new Date("2026-09-27T20:30:00.000Z"), weeks)).toBe(1);
    // 17:00 UTC on Sunday the 27th is still Sunday in India.
    expect(weekIndexFor(new Date("2026-09-27T17:00:00.000Z"), weeks)).toBe(0);
  });
});

describe("resolution time (M8)", () => {
  it("is the median over the window, and null — not 0h — when nothing was resolved", () => {
    const created = new Date("2026-09-01T00:00:00.000Z");
    const rows = [1, 2, 3, 100].map((h) => ({ createdAt: created, resolvedAt: new Date(created.getTime() + h * HOUR) }));
    // A mean would be 26.5h — set by the one ancient ticket. The median is 2.5h.
    expect(resolutionStats(rows)).toEqual({ medianHours: 2.5, sampleSize: 4 });
    expect(resolutionStats([])).toEqual({ medianHours: null, sampleSize: 0 });
  });
});

describe("first response (M8)", () => {
  const t0 = new Date("2026-09-01T00:00:00.000Z");
  const tickets = [
    { id: "t1", reporterId: "rep", createdAt: t0 },
    { id: "t2", reporterId: "rep", createdAt: t0 },
    { id: "t3", reporterId: "rep", createdAt: t0 }
  ];
  const person = (email: string) => ({ email, isAgent: false });

  it("is the first comment by someone other than the reporter, an agent or a system account", () => {
    const stats = firstResponseStats(tickets, [
      // t1: the reporter adds detail, the intake bot echoes the email, an AI agent replies — none of
      // those is somebody answering. The engineer at +5h is.
      { ticketId: "t1", authorId: "rep", createdAt: new Date(t0.getTime() + 1 * HOUR), author: person("rep@acme.test") },
      { ticketId: "t1", authorId: "bot", createdAt: new Date(t0.getTime() + 2 * HOUR), author: person("email-intake@system.local") },
      { ticketId: "t1", authorId: "ai", createdAt: new Date(t0.getTime() + 3 * HOUR), author: { email: "agent@acme.test", isAgent: true } },
      { ticketId: "t1", authorId: "eng", createdAt: new Date(t0.getTime() + 5 * HOUR), author: person("eng@acme.test") },
      { ticketId: "t2", authorId: "eng", createdAt: new Date(t0.getTime() + 1 * HOUR), author: person("eng@acme.test") }
    ]);
    expect(stats).toEqual({ medianHours: 3, sampleSize: 2, unanswered: 1 });
  });

  it("is null when no ticket has been answered", () => {
    expect(firstResponseStats(tickets, [])).toEqual({ medianHours: null, sampleSize: 0, unanswered: 3 });
  });
});

describe("reopen rate (LOW)", () => {
  const since = new Date("2026-09-01T00:00:00.000Z");
  const at = (iso: string) => new Date(iso);

  it("counts only reopenings of tickets resolved in the window, so it cannot pass 100%", () => {
    const rate = reopenRate(
      [
        { entityId: "a", metadata: { to: "RESOLVED" }, createdAt: at("2026-09-02T00:00:00Z") },
        { entityId: "a", metadata: { to: "REOPENED" }, createdAt: at("2026-09-03T00:00:00Z") },
        { entityId: "b", metadata: { to: "RESOLVED" }, createdAt: at("2026-09-04T00:00:00Z") },
        // Reopened without ever being resolved in the window (resolved last year): not in the ratio.
        { entityId: "c", metadata: { to: "REOPENED" }, createdAt: at("2026-09-05T00:00:00Z") },
        { entityId: "d", metadata: { to: "REOPENED" }, createdAt: at("2026-09-06T00:00:00Z") }
      ],
      since
    );
    expect(rate).toEqual({ reopenedCount: 1, everResolvedCount: 2, pct: 50 });
  });

  it("does not count a reopening that came before the resolution", () => {
    const rate = reopenRate(
      [
        { entityId: "a", metadata: { to: "REOPENED" }, createdAt: at("2026-09-02T00:00:00Z") },
        { entityId: "a", metadata: { to: "RESOLVED" }, createdAt: at("2026-09-03T00:00:00Z") }
      ],
      since
    );
    expect(rate.pct).toBe(0);
  });
});

describe("SLA compliance (M6)", () => {
  it("uses the one breach definition: resolved after its due date", () => {
    const weeks = istWeekStarts(1, new Date("2026-10-01T04:30:00.000Z"));
    const due = new Date("2026-09-29T10:00:00.000Z");
    const result = slaComplianceByWeek(
      [
        { resolvedAt: new Date("2026-09-29T09:00:00.000Z"), dueAt: due },
        { resolvedAt: new Date("2026-09-29T11:00:00.000Z"), dueAt: due },
        { resolvedAt: new Date("2026-09-29T11:00:00.000Z"), dueAt: null }
      ],
      weeks
    );
    expect(result).toEqual([{ weekStart: "2026-09-28", compliant: 1, breached: 1, pct: 50 }]);
  });
});
