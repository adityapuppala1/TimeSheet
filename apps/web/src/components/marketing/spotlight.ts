/**
 * The pointer-following highlight shared by the landing page's capability grid and the pitch deck's
 * surfaces grid. Paired with `.spotlight-card` in index.css, which paints the two variables set here.
 *
 * WHY IT LIVES IN ONE FILE: the two pages had the same handler copied into both, and the CSS reads
 * variable names that only work if every writer agrees on them. A second copy that drifts one name
 * fails silently — the highlight simply stops moving, which is exactly the kind of bug nobody files.
 *
 * ATTACH IT TO THE GRID, NOT TO EACH CARD. One listener that finds the card under the pointer costs
 * one subscription for a whole section rather than one per card, and it keeps working when the grid
 * re-keys its children (the landing page's filter chips do exactly that).
 */
import type { PointerEvent as ReactPointerEvent } from "react";

export function handleSpotlight(event: ReactPointerEvent<HTMLDivElement>) {
  const card = (event.target as HTMLElement).closest<HTMLElement>(".spotlight-card");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  // Setting a CSS variable rather than React state on purpose: this fires on every pointermove, and
  // routing that through a re-render would rebuild the entire grid dozens of times a second for a
  // decoration nobody would thank us for.
  card.style.setProperty("--spot-x", `${((event.clientX - rect.left) / rect.width) * 100}%`);
  card.style.setProperty("--spot-y", `${((event.clientY - rect.top) / rect.height) * 100}%`);
}
