/**
 * The headline a sprint card prints must agree with the chart under it; both read the same
 * burndown. Pins the counts-only fallback, the "as of today" rule, and the one-action machine.
 */
import { describe, expect, it } from "vitest";
import { nextSprintAction, sprintProgress, sprintRange } from "../../src/lib/sprints";

const point = (date: string, remainingPoints: number | null, remainingCount: number | null) => ({ date, remainingPoints, remainingCount, idealPoints: 0 });

describe("sprintProgress", () => {
  it("reads remaining as of the last day that has happened, never a future null", () => {
    const p = sprintProgress({ totalPoints: 10, ticketCount: 4, points: [point("d1", 10, 4), point("d2", 6, 3), point("d3", null, null)] });
    expect(p).toEqual({ remaining: 6, total: 10, percentDone: 40, countsOnly: false });
  });

  it("falls back to item counts when nobody estimated", () => {
    const p = sprintProgress({ totalPoints: 0, ticketCount: 4, points: [point("d1", 0, 4), point("d2", 0, 1)] });
    expect(p).toEqual({ remaining: 1, total: 4, percentDone: 75, countsOnly: true });
  });

  it("is 0% with nothing to burn, and never over 100", () => {
    expect(sprintProgress({ totalPoints: 0, ticketCount: 0, points: [] }).percentDone).toBe(0);
    expect(sprintProgress({ totalPoints: 5, ticketCount: 1, points: [point("d1", -1, 0)] }).percentDone).toBe(100);
  });
});

describe("nextSprintAction", () => {
  it("offers start, then complete, then nothing", () => {
    expect(nextSprintAction("PLANNED")?.to).toBe("ACTIVE");
    expect(nextSprintAction("ACTIVE")?.to).toBe("COMPLETED");
    expect(nextSprintAction("COMPLETED")).toBeNull();
  });
});

describe("sprintRange", () => {
  it("omits the year inside the current one and shows it otherwise", () => {
    const now = new Date("2026-09-16T00:00:00Z");
    expect(sprintRange("2026-09-08", "2026-09-19", now)).not.toMatch(/2026/);
    expect(sprintRange("2025-12-29", "2026-01-09", now)).toMatch(/2025/);
  });
});
