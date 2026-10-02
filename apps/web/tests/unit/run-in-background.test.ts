/**
 * `runInBackground` is how this app says "this promise is deliberately not awaited" for a METHOD
 * call — a cache refresh, a `.then` chain — where the `void` operator would trip the local
 * `sonarjs/void-use` rule (it cannot see types here, so it only exempts plain function calls).
 * Pinned: it changes nothing about when work happens, and a rejection is caught and reported
 * rather than surfacing as an unhandled rejection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInBackground } from "../../src/lib/run-in-background";

afterEach(() => vi.restoreAllMocks());

describe("runInBackground", () => {
  it("returns at once without waiting, and lets the work finish on its own", async () => {
    let done = false;
    const work = new Promise<void>((resolve) => setTimeout(() => ((done = true), resolve()), 5));
    expect(runInBackground(work)).toBeUndefined();
    expect(done).toBe(false);
    await work;
    expect(done).toBe(true);
  });

  it("catches a rejection and reports it, rather than leaving an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = Promise.reject(new Error("refetch failed"));
    runInBackground(failing);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith("[background]", expect.objectContaining({ message: "refetch failed" }));
  });
});
