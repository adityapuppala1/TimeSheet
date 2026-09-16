/**
 * WHAT: the one rule for which table columns are visible — the defaults, or a saved view's list.
 *
 * WHY A RULE AND NOT A STATE: a saved view stores `columns: string[] | null`. Null means "the
 * defaults" (and every view saved before columns existed is null, so they keep looking as they
 * did). A list means "exactly these" — except that a column that cannot be hidden is always on,
 * and an id the table no longer has (a custom field since deleted) is ignored rather than crashing
 * the view. Encoding those three facts once, tested, keeps the table, the Columns control and the
 * saved-view round trip in agreement.
 */

export interface ColumnSpec {
  id: string;
  /** Shown in the Columns control. */
  label: string;
  /** Off by default (custom-field columns start hidden so a table does not widen on its own). */
  defaultHidden?: boolean;
  /** S.NO and Title: the table is meaningless without them. */
  canHide?: boolean;
}

/** The visible column ids for a saved list (or the defaults for null). Order follows `all`. */
export function resolveVisibleColumns(all: readonly ColumnSpec[], saved: readonly string[] | null | undefined): string[] {
  const chosen = saved ? new Set(saved) : null;
  return all.filter((c) => c.canHide === false || (chosen ? chosen.has(c.id) : !c.defaultHidden)).map((c) => c.id);
}

/** True when `visible` is exactly the default set — the view can then be saved with `columns: null`. */
export function isDefaultColumns(all: readonly ColumnSpec[], visible: readonly string[]): boolean {
  const defaults = resolveVisibleColumns(all, null);
  return defaults.length === visible.length && defaults.every((id) => visible.includes(id));
}
