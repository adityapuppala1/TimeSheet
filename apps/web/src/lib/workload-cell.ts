/**
 * WHAT: what one cell of the Workload board says — its figure under each measure, its colour step,
 * and the words for its allocation state.
 *
 * WHY THE WORDS: the colour ramp always encodes hours against capacity, whatever the board is
 * measuring. Switched to Tickets or Points, a cell printed a ticket count while "over capacity" was
 * carried by its colour alone — a state a colour-blind planner, or anyone with the board printed in
 * greyscale, could not see (WCAG 1.4.1). The cell now carries the state in text as well.
 */
import type { WorkloadCellRow } from "../services/api";

export type WorkloadMeasure = "hours" | "tickets" | "points";

/**
 * Which step of the capacity ramp a cell sits on.
 *
 * The bands are deliberately uneven. 1-59% is "has room" and does not need four shades to say so;
 * the interesting range is 60-100%, where a planner decides whether one more task fits. Even
 * quintiles would spend most of the palette on distinctions nobody acts on.
 */
export function ramp(cell: Pick<WorkloadCellRow, "isOverAllocated" | "allocationPct">): 0 | 1 | 2 | 3 | 4 {
  if (cell.isOverAllocated) return 4;
  const pct = cell.allocationPct;
  if (pct === null || pct === 0) return 0;
  if (pct < 60) return 1;
  if (pct < 90) return 2;
  return 3;
}

type CellFacts = Pick<WorkloadCellRow, "ticketCount" | "storyPoints" | "timeOffHours" | "capacityHours" | "allocationPct" | "isOverAllocated">;

/** The figure a cell shows under each measure. "off" and "—" keep their meaning under hours. */
export function cellFigure(cell: CellFacts, measure: WorkloadMeasure): string {
  if (measure === "tickets") return cell.ticketCount === 0 ? "—" : String(cell.ticketCount);
  if (measure === "points") return cell.storyPoints === 0 ? "—" : String(cell.storyPoints);
  if (cell.timeOffHours > 0 && cell.capacityHours === 0) return "off";
  return cell.allocationPct === null ? "—" : `${cell.allocationPct}%`;
}

/**
 * A visible mark for "over capacity" when the figure itself does not say so — under Tickets and
 * Points the number is a count, so the over-allocation the colour shows needs a glyph too. Under
 * Hours the percentage already says it.
 */
export function overCapacityMark(cell: CellFacts, measure: WorkloadMeasure): string | null {
  return measure !== "hours" && cell.isOverAllocated ? "!" : null;
}

/** The cell's allocation state in words, for its accessible name. */
export function allocationText(cell: CellFacts): string {
  if (cell.isOverAllocated) return cell.allocationPct === null ? "over capacity: booked while unavailable" : `over capacity, ${cell.allocationPct}% booked`;
  if (cell.timeOffHours > 0 && cell.capacityHours === 0) return "on leave";
  return cell.allocationPct === null ? "no capacity" : `${cell.allocationPct}% booked`;
}
