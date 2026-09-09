/**
 * WHAT: the two pieces of the practice-update page that are logic rather than layout — how the
 * stored-draft cache is settled after a write, and whether a draft's recorded AI failure is still
 * true.
 *
 * WHY THEY LIVE HERE AND NOT IN THE PAGE: both are bugs a customer reported, and both are the kind
 * of bug that only reproduces under a race or a stale row. Pure functions can be tested; a
 * `useMutation` callback inside a 650-line page cannot be, not without a component harness this
 * suite deliberately does not have.
 */

/** The one query key the stored draft lives under. Exported so the page and the tests cannot
 *  disagree about it — a cache write to the wrong key silently does nothing. */
export const PRACTICE_DRAFT_QUERY_KEY = ["practice-update", "draft"] as const;

/** The slice of TanStack Query's client this module needs. Narrow on purpose: it is what makes
 *  these functions testable with a recorder instead of a real QueryClient. */
export interface DraftCacheClient {
  cancelQueries(filters: { queryKey: readonly unknown[] }): Promise<void>;
  setQueryData(queryKey: readonly unknown[], data: unknown): unknown;
  invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<void>;
}

/**
 * SETTLE THE STORED-DRAFT CACHE TO A STATE WE KNOW IS TRUE, in the only order that is safe.
 *
 * THE BUG THIS EXISTS TO FIX: discarding a draft brought the SAME draft back. The stored-draft
 * query runs with `staleTime: 0`, so a background refetch is very often already in flight — mount,
 * window refocus. One ISSUED BEFORE the DELETE RESOLVES AFTER it, still carrying the old draft;
 * `stored.data` changes reference, the page's restore effect runs, local `draft` is null by then,
 * and `current ?? restored` puts the discarded document straight back on screen. The server was
 * innocent throughout — the DELETE really deletes.
 *
 * Invalidating alone does not fix it: invalidation schedules a NEW fetch and says nothing about the
 * one already on the wire. So:
 *
 *   1. CANCEL first, so a response that is already in flight can no longer land and be written to
 *      the cache. This is the actual fix; everything after it is bookkeeping.
 *   2. SET the cache to what we know happened — `{ draft: null }` after a discard or a send, the
 *      new document after a generate. The page renders the truth immediately rather than whatever
 *      the last fetch happened to leave behind.
 *   3. INVALIDATE for reconciliation, so the server stays the authority on anything we could not
 *      know locally (a draft's `generatedByName`, a concurrent generate in another tab).
 */
export async function settleStoredDraftCache<TDraft>(client: DraftCacheClient, draft: TDraft | null): Promise<void> {
  await client.cancelQueries({ queryKey: PRACTICE_DRAFT_QUERY_KEY });
  client.setQueryData(PRACTICE_DRAFT_QUERY_KEY, { draft });
  await client.invalidateQueries({ queryKey: PRACTICE_DRAFT_QUERY_KEY });
}

/**
 * The API's own words when a capability's switch is off — `assertAIFeatureEnabled` in
 * ai.service.ts. Matched with a prefix test rather than an equality check so a trailing edit to
 * that sentence does not silently turn the fix off; if the wording ever changes beyond recognition
 * this stops matching and the page falls back to showing the stored message verbatim, which is
 * where it started.
 */
const CAPABILITY_DISABLED = /^this ai feature is disabled/i;

export interface DraftFailureNotice {
  message: string;
  /** True when the stored failure describes a workspace setting that has since been fixed. The page
   *  styles it as information rather than a warning — nothing is wrong right now. */
  stale: boolean;
}

/**
 * WHETHER A DRAFT'S RECORDED AI FAILURE IS STILL TRUE.
 *
 * `aiFailed` is PERSISTED on the draft row and replayed by `GET /draft`, so a draft generated while
 * the capability was switched off keeps saying "This AI feature is disabled for this workspace"
 * forever — including to the admin who has just switched it on, which makes a fix that worked look
 * like a fix that did not.
 *
 * `aiNarrativeEnabled` is the live answer to exactly that question, so when it is on, that
 * particular message is history rather than fact. It is REPHRASED, never hidden: the written
 * sections really are empty, and the reader still needs to know why and what to do about it.
 *
 * ONLY the feature-disabled message is treated this way. The master-switch message ("AI features
 * are disabled for this workspace") and every other failure — an unreachable model, an answer in
 * the wrong shape — describe something `aiNarrativeEnabled` says nothing about, so they are passed
 * through unchanged and stay warnings.
 */
export function describeDraftFailure(
  aiFailed: string | null | undefined,
  aiNarrativeEnabled: boolean | undefined
): DraftFailureNotice | null {
  if (!aiFailed) return null;
  if (aiNarrativeEnabled === true && CAPABILITY_DISABLED.test(aiFailed.trim())) {
    return {
      stale: true,
      message:
        "This draft was generated while AI drafting was switched off, which is why the written sections are empty. It is on now — regenerate to have them written."
    };
  }
  return { message: aiFailed, stale: false };
}
