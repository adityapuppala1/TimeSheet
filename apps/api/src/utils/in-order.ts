/**
 * WHAT: run `fn` over `items` ONE AT A TIME, in order — the explicit form of "these must not run in
 * parallel".
 *
 * WHY A HELPER INSTEAD OF A `for … await` WRITTEN INLINE: every sequential loop in the user routes is
 * sequential on purpose, and an inline `await` in a loop reads (and is flagged, SonarQube S9382) as an
 * accident somebody should "fix" with `Promise.all`. Here that fix would be a bug:
 *   - bulk actions check "would this leave the workspace with no super admin?" before EACH person, and
 *     that check must see the people already deactivated earlier in the same batch;
 *   - the CSV import's second pass links managers against the reporting lines it has just written, so
 *     a loop inside the file is refused at its closing line;
 *   - every row reports its own outcome, so one failure never hides the others.
 * One documented place for the rule, instead of sixteen unexplained awaits.
 */
export async function forEachInOrder<T>(items: readonly T[], fn: (item: T, index: number) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    await fn(items[index], index); // NOSONAR — sequential by design, see above
  }
}
