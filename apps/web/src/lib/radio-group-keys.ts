/**
 * WHAT: which option an arrow key selects in a radio group — the keyboard half of the WAI-ARIA APG
 * radio group pattern. Arrows move and wrap; Home and End jump to the ends; anything else is not
 * ours (returns null), so Tab still leaves the group and Space still activates.
 *
 * WHY A HELPER: the login page's Password/Directory switcher (security audit #19) was `role="tab"`
 * buttons with no tab panels and no arrow keys — announced as tabs, operated like buttons. It is a
 * choice of one, which is a radio group; this is the part of that pattern that is pure logic.
 */
export function radioIndexForKey(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
