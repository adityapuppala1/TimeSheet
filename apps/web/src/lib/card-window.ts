/**
 * One page of a phone card list.
 *
 * WHY THIS EXISTS: the ticket list shows a table on desktop and self-contained cards on a phone,
 * and the two had different ideas about how much to show. The table pages at 20 rows; the card list
 * rendered every row the query returned. Measured on the seeded workspace at 390px: 200 cards,
 * 5,821 elements — 79% of the whole page — for a list whose desktop twin was showing 20 rows. The
 * phone, the weaker device, was doing ten times the work of the laptop, and its owner was scrolling
 * two hundred cards to reach the end of a "page".
 *
 * Cards are windowed rather than paged: prev/next buttons are a desktop idiom, and on a phone the
 * thumb is already travelling down the list. "Show more" extends the window in place.
 *
 * Generic over the item shape so it can be unit-tested without importing the ticket page; all it
 * needs is the `kind` discriminant that the grouped list already carries.
 */
export type CardKind = "header" | "row" | "footer";

export function windowCardItems<T extends { kind: CardKind }>(items: readonly T[], max: number): { shown: T[]; hidden: number } {
  let rows = 0;
  const shown: T[] = [];
  for (const item of items) {
    if (item.kind === "row") {
      if (rows >= max) break;
      rows += 1;
    }
    shown.push(item);
  }

  // A group header with nothing under it reads as an empty group, which is a lie — the rows are
  // there, they are just past the window. A trailing FOOTER is kept: it closes a run that was
  // shown in full, and on this list it is the "add to this group" row.
  while (shown.length > 0 && shown[shown.length - 1].kind === "header") shown.pop();

  const total = items.reduce((n, item) => n + (item.kind === "row" ? 1 : 0), 0);
  return { shown, hidden: total - rows };
}
