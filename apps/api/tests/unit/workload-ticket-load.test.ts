/**
 * V12 3.20 — tickets as a unit of workload. The rule is the calendar's: a scheduled ticket sits in
 * every bucket its span overlaps; an unscheduled one sits where its SLA date is; closed ones are
 * not load. Points sum over the same set.
 */
import { describe, expect, it } from "vitest";
import { buildWorkload, ticketLoadForBucket, type Bucket, type TicketLoad } from "../../src/services/workload.service.js";

const week = (start: string, end: string): Bucket => ({ start, end, label: start, workingDays: 5 });
const W1 = week("2026-09-14", "2026-09-20");
const W2 = week("2026-09-21", "2026-09-27");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const tickets: TicketLoad[] = [
  { userId: "u1", startDate: d("2026-09-17"), endDate: d("2026-09-23"), dueAt: d("2026-09-01"), storyPoints: 3 }, // spans both weeks
  { userId: "u1", startDate: null, endDate: null, dueAt: d("2026-09-22"), storyPoints: 2.5 }, // SLA date in W2
  { userId: "u1", startDate: null, endDate: null, dueAt: d("2026-10-05"), storyPoints: 8 }, // outside
  { userId: "u2", startDate: d("2026-09-14"), endDate: d("2026-09-14"), dueAt: null, storyPoints: null } // one day, no points
];

describe("ticketLoadForBucket", () => {
  it("counts a spanning ticket in every bucket it overlaps and an unscheduled one only on its SLA date", () => {
    expect(ticketLoadForBucket(tickets.filter((t) => t.userId === "u1"), W1)).toEqual({ ticketCount: 1, storyPoints: 3 });
    expect(ticketLoadForBucket(tickets.filter((t) => t.userId === "u1"), W2)).toEqual({ ticketCount: 2, storyPoints: 5.5 });
  });
  it("a ticket without points counts as a ticket and zero points", () => {
    expect(ticketLoadForBucket(tickets.filter((t) => t.userId === "u2"), W1)).toEqual({ ticketCount: 1, storyPoints: 0 });
    expect(ticketLoadForBucket(tickets.filter((t) => t.userId === "u2"), W2)).toEqual({ ticketCount: 0, storyPoints: 0 });
  });
});

describe("buildWorkload with tickets", () => {
  const people = [{ id: "u1", name: "Ana", email: "a@x", avatarUrl: null, weeklyCapacityHours: 40, plannedUtilizationPct: null }];
  it("carries per-bucket counts and DISTINCT totals across the window", () => {
    const rows = buildWorkload({ people, bookings: [], logged: [], tickets, buckets: [W1, W2], workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 });
    expect(rows[0].cells.map((c) => c.ticketCount)).toEqual([1, 2]);
    expect(rows[0].cells.map((c) => c.storyPoints)).toEqual([3, 5.5]);
    expect(rows[0].totals.ticketCount).toBe(2); // the spanning ticket once, not twice
    expect(rows[0].totals.storyPoints).toBe(5.5);
  });
  it("omitting tickets leaves every count at zero and nothing else changed", () => {
    const rows = buildWorkload({ people, bookings: [], logged: [], buckets: [W1], workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 });
    expect(rows[0].cells[0]).toMatchObject({ ticketCount: 0, storyPoints: 0, capacityHours: 40, bookedHours: 0 });
  });
});
