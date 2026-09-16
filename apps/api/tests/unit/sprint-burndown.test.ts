/**
 * The burndown is a pure replay over audited status changes. The invariants a chart reader relies
 * on: today's remaining equals what is open now; a ticket closed mid-sprint drops out on the day
 * it closed and not before; a ticket without points still counts as one item; days that have not
 * happened carry null rather than a guess; the ideal line runs from the total to zero.
 */
import { describe, expect, it } from "vitest";
import { assertSprintTransition, burndown, sprintDays, statusAtEndOf, type BurndownTicket } from "../../src/services/sprint.service.js";

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
