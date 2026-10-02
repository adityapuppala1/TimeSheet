/**
 * A Workload cell's over-capacity state must not be carried by colour alone (WCAG 1.4.1). Under the
 * Tickets and Points measures the figure is a count, so the state gets a glyph and words too.
 */
import { describe, expect, it } from "vitest";
import { allocationText, cellFigure, overCapacityMark, ramp } from "../../src/lib/workload-cell";

const over = { ticketCount: 3, storyPoints: 8, timeOffHours: 0, capacityHours: 16, allocationPct: 150, isOverAllocated: true };
const fine = { ...over, allocationPct: 50, isOverAllocated: false };

describe("a workload cell", () => {
  it("marks over-capacity in text when the figure is a count", () => {
    expect(cellFigure(over, "tickets")).toBe("3");
    expect(overCapacityMark(over, "tickets")).toBe("!");
    expect(overCapacityMark(over, "points")).toBe("!");
    expect(allocationText(over)).toBe("over capacity, 150% booked");
  });

  it("adds nothing under hours, where the percentage already says it, or when within capacity", () => {
    expect(overCapacityMark(over, "hours")).toBeNull();
    expect(overCapacityMark(fine, "tickets")).toBeNull();
    expect(cellFigure(over, "hours")).toBe("150%");
  });

  it("keeps the colour ramp's steps", () => {
    expect(ramp(over)).toBe(4);
    expect(ramp(fine)).toBe(1);
    expect(ramp({ ...fine, allocationPct: null })).toBe(0);
  });
});
