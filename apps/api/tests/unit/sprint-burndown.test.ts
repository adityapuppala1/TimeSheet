/**
 * The burndown is a pure replay over audited status changes. The invariants a chart reader relies
 * on: today's remaining equals what is open now; a ticket closed mid-sprint drops out on the day
 * it closed and not before; a ticket without points still counts as one item; days that have not
 * happened carry null rather than a guess; the ideal line runs from the total to zero.
 */
import { describe, expect, it } from "vitest";
import { assertSprintTransition, burndown, memberAtEndOf, sprintDays, statusAtEndOf, type BurndownTicket } from "../../src/services/sprint.service.js";

const d = (s: string) => new Date(`${s}T10:00:00.000Z`);
const t = (over: Partial<BurndownTicket> & { id: string }): BurndownTicket => ({
  createdAt: d("2026-09-01"),
  status: "OPEN",
  storyPoints: 3,
  transitions: [],
  ...over
});

describe("sprintDays", () => {
  it("is inclusive of both ends, in UTC calendar days", () => {
    expect(sprintDays(new Date("2026-09-07"), new Date("2026-09-09"))).toEqual(["2026-09-07", "2026-09-08", "2026-09-09"]);
    expect(sprintDays(new Date("2026-09-07"), new Date("2026-09-07"))).toEqual(["2026-09-07"]);
  });
});

describe("statusAtEndOf", () => {
  it("is null before the ticket existed, the last transition on or before the day otherwise, and the current status with no later transition", () => {
    const ticket = t({ id: "a", status: "CLOSED", transitions: [{ at: d("2026-09-03"), to: "IN_PROGRESS" }, { at: d("2026-09-05"), to: "CLOSED" }] });
    expect(statusAtEndOf(ticket, new Date("2026-08-31T23:59:59.999Z"))).toBeNull();
    expect(statusAtEndOf(ticket, new Date("2026-09-02T23:59:59.999Z"))).toBe("OPEN"); // before any transition: created open
    expect(statusAtEndOf(ticket, new Date("2026-09-03T23:59:59.999Z"))).toBe("IN_PROGRESS");
    expect(statusAtEndOf(ticket, new Date("2026-09-06T23:59:59.999Z"))).toBe("CLOSED");
  });
});

describe("burndown", () => {
  const days = sprintDays(new Date("2026-09-01"), new Date("2026-09-05"));
  const today = new Date("2026-09-04T12:00:00.000Z");

  it("drops a ticket out on the day it was resolved, not before, and ends today at what is open now", () => {
    const tickets = [
      t({ id: "a", storyPoints: 5, status: "RESOLVED", transitions: [{ at: d("2026-09-03"), to: "RESOLVED" }] }),
      t({ id: "b", storyPoints: 3 })
    ];
    const series = burndown(days, tickets, today);
    expect(series.map((p) => p.remainingPoints)).toEqual([8, 8, 3, 3, null]);
    expect(series.map((p) => p.remainingCount)).toEqual([2, 2, 1, 1, null]);
  });

  it("counts an unestimated ticket as one item and zero points", () => {
    const series = burndown(days, [t({ id: "a", storyPoints: null })], today);
    expect(series[0]).toMatchObject({ remainingPoints: 0, remainingCount: 1 });
  });

  it("draws the ideal line from the total to zero across the sprint", () => {
    const series = burndown(days, [t({ id: "a", storyPoints: 8 })], today);
    expect(series.map((p) => p.idealPoints)).toEqual([8, 6, 4, 2, 0]);
  });

  it("does not count a ticket before it was created", () => {
    const series = burndown(days, [t({ id: "late", createdAt: d("2026-09-03"), storyPoints: 2 })], today);
    expect(series.map((p) => p.remainingPoints)).toEqual([0, 0, 2, 2, null]);
  });

  it("is empty-safe: no tickets → zeros and a flat ideal line", () => {
    const series = burndown(days, [], today);
    expect(series.every((p) => p.idealPoints === 0)).toBe(true);
    expect(series[0]).toMatchObject({ remainingPoints: 0, remainingCount: 0 });
  });
});

describe("assertSprintTransition", () => {
  it("allows planned → active → completed and nothing else", () => {
    expect(() => assertSprintTransition("PLANNED", "ACTIVE")).not.toThrow();
    expect(() => assertSprintTransition("ACTIVE", "COMPLETED")).not.toThrow();
    expect(() => assertSprintTransition("PLANNED", "COMPLETED")).toThrow(/cannot move/);
    expect(() => assertSprintTransition("COMPLETED", "ACTIVE")).toThrow(/cannot move/);
    expect(() => assertSprintTransition("ACTIVE", "ACTIVE")).not.toThrow();
  });
});

/* V12 6.1 — membership replayed from `ticket.sprint_changed`. */
describe("memberAtEndOf", () => {
  const end = (s: string) => new Date(`${s}T23:59:59.999Z`);
  it("no events means a member throughout (sprints that predate the audit keep their series)", () => {
    expect(memberAtEndOf(t({ id: "a" }), end("2026-09-01"))).toBe(true);
  });
  it("a late join appears from the day it joined; the state before the first event is its opposite", () => {
    const late = t({ id: "b", membership: [{ at: d("2026-09-03"), joined: true }] });
    expect(memberAtEndOf(late, end("2026-09-02"))).toBe(false);
    expect(memberAtEndOf(late, end("2026-09-03"))).toBe(true);
  });
  it("an early leave keeps the days before it and loses the days after; a rejoin brings it back", () => {
    const gone = t({ id: "c", membership: [{ at: d("2026-09-03"), joined: false }] });
    expect(memberAtEndOf(gone, end("2026-09-02"))).toBe(true);
    expect(memberAtEndOf(gone, end("2026-09-03"))).toBe(false);
    const back = t({ id: "d", membership: [{ at: d("2026-09-03"), joined: false }, { at: d("2026-09-05"), joined: true }] });
    expect(memberAtEndOf(back, end("2026-09-04"))).toBe(false);
    expect(memberAtEndOf(back, end("2026-09-05"))).toBe(true);
  });
});

describe("burndown with membership", () => {
  const days = sprintDays(new Date("2026-09-01"), new Date("2026-09-05"));
  const today = new Date("2026-09-05T12:00:00.000Z");
  it("a ticket moved out on the 3rd counts on the 1st–3rd (leave at 10:00 → out by day end) and not after; the ideal line ignores it", () => {
    const stays = t({ id: "s", storyPoints: 5 });
    const moved = t({ id: "m", storyPoints: 3, membership: [{ at: d("2026-09-03"), joined: false }] });
    const points = burndown(days, [stays, moved], today);
    expect(points.map((p) => p.remainingPoints)).toEqual([8, 8, 5, 5, 5]);
    expect(points[0].idealPoints).toBe(5);
  });
  it("a ticket planned in on the 4th appears from the 4th", () => {
    const late = t({ id: "l", storyPoints: 2, membership: [{ at: d("2026-09-04"), joined: true }] });
    expect(burndown(days, [late], today).map((p) => p.remainingCount)).toEqual([0, 0, 0, 1, 1]);
  });
});
