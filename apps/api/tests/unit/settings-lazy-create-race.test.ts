/**
 * Six settings rows are created lazily, by an `upsert` on the read path — and every one of them
 * raced.
 *
 * THE BUG, IN ONE SENTENCE: `upsert` is not atomic against a concurrent `upsert` of the same
 * missing row. Both callers find nothing, both try to INSERT, and the loser gets
 * `P2002 — Unique constraint failed on the constraint: PRIMARY`. Prisma does not retry it.
 *
 * WHEN IT BITES: only on a workspace whose row does not exist yet, and only when two reads overlap.
 * That is not rare — it is exactly a brand-new tenant, whose very first page load fires several
 * requests at once, and any `Promise.all` that reads the same settings twice. It was found by
 * running the practice update over a freshly provisioned org, where two concurrent
 * `isChangeManagementOn()` calls raced and the report logged a Prisma error before falling back.
 *
 * WHY THE WHOLE CLASS IS FIXED RATHER THAN THE ONE THAT WAS SEEN: the six getters are the same four
 * lines copied six times, and `getGlobalAISettings` is the one with the most at stake — it is what
 * every AI preflight calls, so the version of this bug that reaches a customer is "AI is broken on
 * my first day" rather than "one digest logged a warning".
 *
 * THE FIX IS NOT A LOCK. Losing the race is harmless: the row the winner created is the row this
 * caller wanted. Catching P2002 and re-reading is both correct and cheaper than serialising every
 * settings read for the lifetime of the workspace to protect one moment at the start of it.
 */
import { describe, expect, it, vi } from "vitest";

import { lazyCreateSettings } from "../../src/utils/lazy-create-settings.js";

/** A Prisma unique-constraint violation, as the client actually throws it. */
function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed on the constraint: `PRIMARY`"), { code: "P2002" });
}

describe("losing the lazy-create race is not an error", () => {
  it("re-reads the row the other caller created, instead of throwing", async () => {
    const winnersRow = { id: "global", enabled: true };
    const upsert = vi.fn().mockRejectedValueOnce(uniqueViolation());
    const reread = vi.fn().mockResolvedValue(winnersRow);

    await expect(lazyCreateSettings(upsert, reread)).resolves.toBe(winnersRow);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("costs nothing on the overwhelmingly common path", async () => {
    // Every read after the first one in a workspace's life. The re-read must not fire.
    const row = { id: "global" };
    const reread = vi.fn();

    await expect(lazyCreateSettings(vi.fn().mockResolvedValue(row), reread)).resolves.toBe(row);
    expect(reread).not.toHaveBeenCalled();
  });
});

describe("what it must NOT swallow", () => {
  it("rethrows anything that is not a unique-constraint violation, WITHOUT re-reading", async () => {
    // A dropped connection, a missing table, a permission error. Retrying those hides a real fault
    // behind a second query that will fail the same way.
    //
    // THE `reread` ASSERTION IS THE TEST, not the rejection. An earlier version checked only that
    // the error came back out — and a helper that swallowed EVERY error still passed it, because
    // the re-read found nothing and the original was rethrown from the wrong branch. The
    // observable difference between "did not retry" and "retried and gave up" is whether the
    // second query was issued at all.
    const boom = Object.assign(new Error("connection lost"), { code: "P1001" });
    const reread = vi.fn();

    await expect(lazyCreateSettings(vi.fn().mockRejectedValue(boom), reread)).rejects.toThrow("connection lost");
    expect(reread).not.toHaveBeenCalled();
  });

  it("rethrows the ORIGINAL error when the re-read finds nothing, and re-reads exactly once", async () => {
    // Two properties in one fixture, because they fail together:
    //
    //   - A P2002 with no row behind it is NOT this race. It is a different unique index being
    //     violated, and reporting it as a missing row sends somebody hunting the wrong bug.
    //   - The re-read happens once. `reread` is primed to return null first and a row afterwards,
    //     so a helper that loops until it finds something would resolve with that row instead of
    //     rejecting — which is what makes the loop visible here rather than as a test timeout.
    const violation = uniqueViolation();
    const reread = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "global" });
    const upsert = vi.fn().mockRejectedValue(violation);

    await expect(lazyCreateSettings(upsert, reread)).rejects.toBe(violation);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("lets a failure from the re-read itself surface", async () => {
    // The row vanished, the connection dropped, the index is broken. Whatever it is, it is not
    // something a third query would fix.
    const reread = vi.fn().mockRejectedValue(new Error("re-read failed"));

    await expect(lazyCreateSettings(vi.fn().mockRejectedValue(uniqueViolation()), reread)).rejects.toThrow(
      "re-read failed"
    );
    expect(reread).toHaveBeenCalledTimes(1);
  });
});

/**
 * The anti-drift check. A seventh settings getter written the old way would reintroduce the bug
 * silently — it only shows up on a new workspace, under concurrency, which no test anybody writes
 * for their own feature would cover.
 */
describe("every lazily-created settings row goes through the helper", () => {
  it("has no bare upsert left on a settings read path", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "ai.service.ts",
      "change.service.ts",
      "email-intake.service.ts",
      "face.service.ts",
      "mcp.service.ts",
      "notify.service.ts"
    ];

    for (const file of files) {
      const source = await readFile(new URL(`../../src/services/${file}`, import.meta.url), "utf-8");
      const getters = source.match(/export async function get[A-Za-z]*Settings[\s\S]*?\n}/g) ?? [];
      expect(getters.length, `${file} has no settings getter — has it been renamed?`).toBeGreaterThan(0);

      for (const getter of getters) {
        if (!getter.includes(".upsert(")) continue;
        expect(getter, `${file}: a settings getter upserts without lazyCreateSettings — see this file's header`).toContain(
          "lazyCreateSettings"
        );
      }
    }
  });
});
