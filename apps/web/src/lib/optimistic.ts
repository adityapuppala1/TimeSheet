import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * V12 10.1 — the four lines every optimistic mutation needs, written once.
 *
 * WHY A HELPER RATHER THAN FOUR COPIES: an optimistic update is only safe when all four halves are
 * present — cancel in-flight refetches (or one lands mid-edit and overwrites the guess), snapshot,
 * patch, and roll back to the exact snapshot on failure. Hand-written per call site, the one that
 * gets dropped is the rollback, and a dropped rollback is worse than no optimism at all: the screen
 * then disagrees with the database until something else happens to refetch.
 *
 * `onSettled` always invalidates, success or failure, so the server stays the authority and the
 * guess is only ever a bridge across the round trip.
 */

export interface OptimisticPatch<TData> {
  key: QueryKey;
  /** Return the next cache value, or `undefined` to leave this entry alone. */
  update: (current: TData) => TData | undefined;
}

export interface OptimisticContext {
  /** Every entry touched, with the value it held before. Restored verbatim on error. */
  previous: Array<[QueryKey, unknown]>;
}

/**
 * Apply one or more patches across the cache, returning what is needed to undo them.
 *
 * Matching is by `queryClient.getQueriesData`, so a key like `["tickets"]` patches every variant
 * (`["tickets", filters]`) — which is what a board and a list showing the same ticket need.
 */
export async function applyOptimistic<TData>(
  queryClient: QueryClient,
  patches: Array<OptimisticPatch<TData>>
): Promise<OptimisticContext> {
  const previous: Array<[QueryKey, unknown]> = [];

  for (const patch of patches) {
    // Cancel first: a refetch already in flight would land after the patch and silently undo it.
    await queryClient.cancelQueries({ queryKey: patch.key });
    for (const [key, data] of queryClient.getQueriesData<TData>({ queryKey: patch.key })) {
      if (data === undefined) continue;
      const next = patch.update(data);
      if (next === undefined) continue;
      previous.push([key, data]);
      queryClient.setQueryData(key, next);
    }
  }
  return { previous };
}

/** Put every touched entry back exactly as it was. */
export function rollbackOptimistic(queryClient: QueryClient, context: OptimisticContext | undefined): void {
  if (!context) return;
  for (const [key, data] of context.previous) queryClient.setQueryData(key, data);
}

/** The server is the authority; the guess was only a bridge. Call on success AND on failure. */
export function settleOptimistic(queryClient: QueryClient, keys: QueryKey[]): void {
  for (const key of keys) {
    // Deliberately not awaited — settling is a background refresh, and `onSettled` must not block a
    // mutation on it. A failed refetch is React Query's to retry, not this helper's to report.
    queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined);
  }
}

/** Replace one item in a list by id, leaving the rest — and the array's identity — alone. */
export function replaceById<T extends { id: string }>(rows: T[], id: string, patch: Partial<T>): T[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.id !== id) return row;
    changed = true;
    return { ...row, ...patch };
  });
  // Returning the same array when nothing matched keeps React from re-rendering for no reason, and
  // tells `applyOptimistic` there was nothing here to undo.
  return changed ? next : rows;
}
