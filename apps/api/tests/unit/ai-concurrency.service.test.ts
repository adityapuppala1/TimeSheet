/**
 * The per-provider concurrency gate. The invariant that matters most is the LAST test in the first
 * block: a permit that isn't released on the throw path would wedge a provider for the lifetime of
 * the process, which is a far worse outcome than the unbounded concurrency this replaces.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __aiSlotsInFlight,
  __resetAiConcurrencyForTests,
  acquireAiSlot
} from "../../src/services/ai-concurrency.service.js";

afterEach(() => __resetAiConcurrencyForTests());

describe("acquireAiSlot", () => {
  it("admits up to maxConcurrent immediately", async () => {
    const a = await acquireAiSlot("p1", 2, 50);
    const b = await acquireAiSlot("p1", 2, 50);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(__aiSlotsInFlight("p1")).toBe(2);
  });

  it("makes the caller past the ceiling wait, then admits it when a slot frees", async () => {
    const a = await acquireAiSlot("p1", 1, 1000);
    expect(a.ok).toBe(true);

    const pending = acquireAiSlot("p1", 1, 1000);
    // Nothing resolved yet — the ceiling is 1 and it's taken.
    expect(__aiSlotsInFlight("p1")).toBe(1);

    if (a.ok) a.release();
    const b = await pending;
    expect(b.ok).toBe(true);
    // Still 1: the slot was handed straight over rather than released-then-reacquired.
    expect(__aiSlotsInFlight("p1")).toBe(1);
  });

  it("times out rather than waiting forever when no slot frees", async () => {
    const a = await acquireAiSlot("p1", 1, 30);
    expect(a.ok).toBe(true);

    const b = await acquireAiSlot("p1", 1, 30);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("timeout");
  });

  it("does NOT hand a freed slot to a caller that already timed out", async () => {
    // The bug this guards: resolving an abandoned waiter leaks a permit — inFlight goes up for a
    // caller that has already moved on to the next provider and will never release it.
    const a = await acquireAiSlot("p1", 1, 1000);
    const timedOut = await acquireAiSlot("p1", 1, 20);
    expect(timedOut.ok).toBe(false);

    if (a.ok) a.release();
    // The abandoned waiter was removed on timeout, so releasing drops the count to zero.
    expect(__aiSlotsInFlight("p1")).toBe(0);
  });

  it("releases idempotently, so a finally-block double-release is harmless", async () => {
    const a = await acquireAiSlot("p1", 2, 50);
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(__aiSlotsInFlight("p1")).toBe(0);
  });

  it("keeps separate providers on separate ceilings", async () => {
    const a = await acquireAiSlot("p1", 1, 50);
    const b = await acquireAiSlot("p2", 1, 50);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // p2's ceiling is its own — p1 being full is irrelevant
  });

  it("treats a nonsensical ceiling as 1 rather than deadlocking every caller", async () => {
    const a = await acquireAiSlot("p1", 0, 30);
    expect(a.ok).toBe(true);

    const b = await acquireAiSlot("p1", 0, 30);
    expect(b.ok).toBe(false);
  });

  it("serves waiters first-in-first-out, so a burst can't starve its earliest caller", async () => {
    const held = await acquireAiSlot("p1", 1, 1000);
    const order: string[] = [];

    const first = acquireAiSlot("p1", 1, 1000).then((r) => {
      order.push("first");
      if (r.ok) r.release();
    });
    const second = acquireAiSlot("p1", 1, 1000).then((r) => {
      order.push("second");
      if (r.ok) r.release();
    });

    if (held.ok) held.release();
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
  });
});
