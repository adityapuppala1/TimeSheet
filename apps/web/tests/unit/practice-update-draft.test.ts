/**
 * TWO BUGS A CUSTOMER FOUND, both on the practice-update page, both invisible to a screenshot.
 *
 *   1. DISCARD BROUGHT THE DRAFT BACK. The stored-draft query runs with `staleTime: 0`, so a
 *      refetch issued before the DELETE resolves after it, still carrying the deleted document.
 *      The page's restore effect then re-seeds an editor it has just cleared. The tests below prove
 *      the cancel happens FIRST and that the cache is written to a state we know is true, not just
 *      marked stale — an ordering, which is precisely what a screenshot cannot show.
 *
 *   2. A FAILURE BANNER THAT OUTLIVED ITS CAUSE. `aiFailed` is stored on the draft row, so a draft
 *      generated while the capability was off keeps saying so after somebody fixes the setting —
 *      making a fix that worked look like one that did not.
 *
 * Testing the pure functions rather than the page is deliberate: this suite is utility-level and
 * has no component harness, so the logic worth testing was moved somewhere it can be reached.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PRACTICE_DRAFT_QUERY_KEY,
  describeDraftFailure,
  settleStoredDraftCache,
  type DraftCacheClient
} from "../../src/utils/practice-update-draft";

/** A recorder standing in for the QueryClient: it remembers WHAT was called and IN WHICH ORDER,
 *  which is the whole subject of the first half of this file. */
function recorder() {
  const order: string[] = [];
  const setData: Array<{ key: readonly unknown[]; data: unknown }> = [];
  const client: DraftCacheClient = {
    cancelQueries: vi.fn(async () => {
      order.push("cancel");
    }),
    setQueryData: vi.fn((key: readonly unknown[], data: unknown) => {
      order.push("set");
      setData.push({ key, data });
      return data;
    }),
    invalidateQueries: vi.fn(async () => {
      order.push("invalidate");
    })
  };
  return { client, order, setData };
}

describe("settleStoredDraftCache", () => {
  it("cancels in-flight fetches BEFORE anything else", async () => {
    const { client, order } = recorder();
    await settleStoredDraftCache(client, null);
    // Cancel first is the fix. Invalidation only schedules a new fetch; it says nothing about the
    // one already on the wire, which is the response that resurrected the discarded draft.
    expect(order).toEqual(["cancel", "set", "invalidate"]);
  });

  it("writes the state we know is true, on the key the page reads", async () => {
    const { client, setData } = recorder();
    await settleStoredDraftCache(client, null);
    expect(setData).toEqual([{ key: PRACTICE_DRAFT_QUERY_KEY, data: { draft: null } }]);
  });

  it("seeds the cache with a freshly generated draft rather than clearing it", async () => {
    const { client, setData } = recorder();
    const fresh = { id: "new", narrative: null };
    await settleStoredDraftCache(client, fresh);
    // A generate straight after a discard must not be reconciled back to a stale document either:
    // the cancel covers that, and the set makes the new one authoritative immediately.
    expect(setData[0].data).toEqual({ draft: fresh });
  });

  it("still reconciles with the server afterwards", async () => {
    const { client } = recorder();
    await settleStoredDraftCache(client, null);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: PRACTICE_DRAFT_QUERY_KEY });
  });

  /**
   * THE BUG, REPRODUCED END TO END. A fake cache plays the race: a fetch is issued, the draft is
   * discarded, and only then does the fetch come back with the old document. With the cancel in
   * place the late response is dropped and the cache stays empty; without it, it lands.
   */
  it("a response already in flight cannot restore the discarded draft", async () => {
    const stale = { id: "old-draft" };
    let cache: { draft: unknown } | undefined = { draft: stale };
    let cancelled = false;

    const client: DraftCacheClient = {
      cancelQueries: async () => {
        cancelled = true;
      },
      setQueryData: (_key, data) => {
        cache = data as { draft: unknown };
        return data;
      },
      invalidateQueries: async () => undefined
    };

    // The refetch that was already on the wire when Discard was clicked.
    const inFlight = Promise.resolve({ draft: stale });

    await settleStoredDraftCache(client, null);

    const landed = await inFlight;
    if (!cancelled) cache = landed; // what the old code allowed to happen

    expect(cancelled).toBe(true);
    expect(cache).toEqual({ draft: null });
  });
});

describe("describeDraftFailure", () => {
  const DISABLED = "This AI feature is disabled for this workspace.";

  it("says nothing when the prose was written", () => {
    expect(describeDraftFailure(null, true)).toBeNull();
    expect(describeDraftFailure("", true)).toBeNull();
  });

  it("presents a genuine failure as current", () => {
    const shapeError = "The model answered, but not in the format this update needs.";
    expect(describeDraftFailure(shapeError, true)).toEqual({ message: shapeError, stale: false });
  });

  it("still shows the disabled message while the capability really is off", () => {
    expect(describeDraftFailure(DISABLED, false)).toEqual({ message: DISABLED, stale: false });
    // Undefined settings = we do not know yet. Not knowing is not the same as knowing it is on,
    // so the stored message stands rather than being explained away on a guess.
    expect(describeDraftFailure(DISABLED, undefined)).toEqual({ message: DISABLED, stale: false });
  });

  it("rewrites the disabled message once drafting is back on", () => {
    const notice = describeDraftFailure(DISABLED, true);
    expect(notice?.stale).toBe(true);
    expect(notice?.message).not.toBe(DISABLED);
    // Rephrased, never hidden: the sections really are empty and the reader needs the way out.
    expect(notice?.message).toMatch(/regenerate/i);
  });

  it("leaves the MASTER switch's message alone", () => {
    // aiNarrativeEnabled answers "is this capability on", not "is AI on at all" — so it cannot
    // declare this one stale, and a workspace with AI switched off entirely must keep the warning.
    const masterOff = "AI features are disabled for this workspace.";
    expect(describeDraftFailure(masterOff, true)).toEqual({ message: masterOff, stale: false });
  });
});
