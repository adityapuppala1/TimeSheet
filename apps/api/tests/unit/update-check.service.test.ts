/**
 * Tests for the update checker.
 *
 * Two properties carry the feature. `compareSemver` decides whether the "update available" banner
 * appears at all — a comparison bug either nags every installation forever or never tells anyone
 * about a security release. And `getUpdateStatus` must NEVER throw: it runs on a public endpoint
 * read by the What's-new page, and GitHub being down must degrade to "no information", not become
 * an error in front of someone doing their job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { compareSemver, getUpdateStatus } = await import("../../src/services/update-check.service.js");

describe("compareSemver", () => {
  it("orders plain semvers correctly", () => {
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.1.0", "1.1.0")).toBe(0);
    expect(compareSemver("1.1.0", "1.10.0")).toBeLessThan(0);
  });

  it("tolerates a leading v, because git tags carry one", () => {
    expect(compareSemver("v1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("v2.0.0", "v1.9.0")).toBeGreaterThan(0);
  });

  it("compares numerically, not lexically", () => {
    // The classic failure: "1.9.0" > "1.10.0" as strings. If this regresses, every installation
    // on 1.9.x is told 1.10.0 is not an upgrade.
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("getUpdateStatus", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
  });

  it("never throws when GitHub is unreachable — it degrades to 'no information'", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;

    const status = await getUpdateStatus();

    // The contract: a failed check is silence, not an error. currentVersion still reports.
    expect(status.currentVersion).toBeTruthy();
    expect(status.updateAvailable).toBe(false);
    expect(Array.isArray(status.releases)).toBe(true);
  });

  it("never throws on a rate-limited (403) response either", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as never;
    await expect(getUpdateStatus()).resolves.toMatchObject({ updateAvailable: false });
  });
});
