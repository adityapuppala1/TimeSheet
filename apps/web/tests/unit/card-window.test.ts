/**
 * The phone card window must count ROWS, not items — a grouped list carries headers and footers
 * between them, and counting those would show a different number of tickets depending on how the
 * list happened to be grouped. It must also never leave a group heading with nothing under it.
 */
import { describe, expect, it } from "vitest";
import { windowCardItems, type CardKind } from "../../src/lib/card-window";

const item = (kind: CardKind, id: string) => ({ kind, id });
const flat = (n: number) => Array.from({ length: n }, (_, i) => item("row", `r${i}`));

describe("windowCardItems", () => {
  it("shows everything, and hides nothing, when the window is larger than the list", () => {
    const { shown, hidden } = windowCardItems(flat(3), 20);
    expect(shown).toHaveLength(3);
    expect(hidden).toBe(0);
  });

  it("cuts at the row limit and reports what is left", () => {
    const { shown, hidden } = windowCardItems(flat(200), 20);
    expect(shown).toHaveLength(20);
    expect(hidden).toBe(180);
  });

  it("counts rows only — headers and footers do not eat the budget", () => {
    const grouped = [
      item("header", "g1"),
      ...flat(2),
      item("footer", "g1"),
      item("header", "g2"),
      ...flat(2),
      item("footer", "g2")
    ];
    const { shown, hidden } = windowCardItems(grouped, 3);
    expect(shown.filter((i) => i.kind === "row")).toHaveLength(3);
    expect(hidden).toBe(1);
    // Both headings are still there; the second group is simply cut short.
    expect(shown.filter((i) => i.kind === "header")).toHaveLength(2);
  });

  it("drops a heading left with no rows under it", () => {
    const grouped = [item("header", "g1"), ...flat(2), item("footer", "g1"), item("header", "g2"), ...flat(2)];
    const { shown, hidden } = windowCardItems(grouped, 2);
    expect(shown.map((i) => i.kind)).toEqual(["header", "row", "row", "footer"]);
    expect(hidden).toBe(2);
  });

  it("keeps a trailing footer, which closes a group that WAS shown in full", () => {
    const grouped = [item("header", "g1"), ...flat(2), item("footer", "g1")];
    expect(windowCardItems(grouped, 2).shown.at(-1)?.kind).toBe("footer");
  });

  it("handles an empty list without inventing anything", () => {
    expect(windowCardItems([], 20)).toEqual({ shown: [], hidden: 0 });
  });
});
