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

/**
 * TAGS AS A FALLBACK.
 *
 * The CD pipeline builds and publishes on a `v*.*.*` tag. Creating the GitHub *Release* object on
 * top of it is a separate, manual step — and until somebody did it, every running installation was
 * told it was up to date while a newer version had in fact shipped. That is the worst direction for
 * an update check to fail in: silent, and reassuring.
 *
 * This was not hypothetical. At the time it was written the repo had four version tags and zero
 * releases, so every installation in existence was being told it was current.
 */
describe("update detection does not depend on somebody writing release notes", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /**
   * A FRESH module per test. `update-check.service.ts` caches its answer for an hour in a
   * module-level variable — deliberately, so a thousand browsers produce one GitHub request — and
   * that cache is shared by everything importing it. Without this, the second test in this block
   * reads the first one's answer and asserts nothing.
   */
  async function freshStatus() {
    vi.resetModules();
    const mod = await import("../../src/services/update-check.service.js");
    return mod.getUpdateStatus();
  }

  /** Answers /releases and /tags differently, like GitHub does. */
  function githubWith({ releases, tags }: { releases: unknown[]; tags: unknown[] }) {
    return vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/tags") ? tags : releases)
      })
    ) as never;
  }

  it("reads tags when no Releases have been published", async () => {
    global.fetch = githubWith({ releases: [], tags: [{ name: "v9.9.9" }, { name: "v1.0.0" }] });

    const status = await freshStatus();

    expect(status.latestVersion).toBe("9.9.9");
    expect(status.updateAvailable).toBe(true);
  });

  it("ignores tags that are not plain versions", async () => {
    global.fetch = githubWith({ releases: [], tags: [{ name: "nightly" }, { name: "v9.9.9-rc1" }, { name: "v9.9.9" }] });

    const status = await freshStatus();
    const versions = status.releases.map((r) => r.version);
    expect(versions).toContain("9.9.9");
    // The rest of the list is this build's own changelog history; what must NOT appear is a
    // nightly or a prerelease masquerading as a version somebody could update to.
    expect(versions).not.toContain("nightly");
    expect(versions.some((version) => version.includes("rc"))).toBe(false);
  });

  it("prefers real Releases when they exist, because those carry notes", async () => {
    global.fetch = githubWith({
      releases: [{ tag_name: "v9.9.9", name: "Nine", body: "the notes", published_at: "2026-01-01", html_url: "u" }],
      tags: [{ name: "v8.8.8" }]
    });

    const status = await freshStatus();
    expect(status.latestVersion).toBe("9.9.9");
    expect(status.releases.find((r) => r.version === "9.9.9")?.notes).toBe("the notes");
  });

  it("reports the HIGHEST version GitHub knows, not whichever row came back first", async () => {
    // /tags makes no promise about ordering, and `latestVersion` is what the update banner and
    // update.sh hang off. An implementation that trusted row order would answer "8.8.8" here.
    global.fetch = githubWith({ releases: [], tags: [{ name: "v8.8.8" }, { name: "v9.9.9" }, { name: "v9.1.0" }] });

    const status = await freshStatus();
    expect(status.latestVersion).toBe("9.9.9");
  });

  it("leaves notes empty rather than inventing them for a tag", async () => {
    // A tag carries no notes. The bundled-CHANGELOG fallback fills them where it can; making
    // something up here would put words in a release's mouth. 9.9.9 exists in no changelog, so
    // it must stay empty — which is also what makes the merge test below non-vacuous.
    global.fetch = githubWith({ releases: [], tags: [{ name: "v9.9.9" }] });

    const status = await freshStatus();
    expect(status.releases.find((r) => r.version === "9.9.9")?.notes ?? "").toBe("");
  });

  it("fills a tag's notes and name from this build's own changelog", async () => {
    // The regression this pins: the moment the tags fallback made the GitHub list non-empty, an
    // early return blocked the changelog fallback entirely, and the What's-new page showed
    // "No notes were written for this release" for every version — notes that were sitting in
    // the build's own CHANGELOG.md the whole time. The merge is per version, not all-or-nothing.
    global.fetch = githubWith({ releases: [], tags: [{ name: "v2.3.0" }] });

    const status = await freshStatus();
    const release = status.releases.find((r) => r.version === "2.3.0");
    expect(release?.notes ?? "").not.toBe("");
    // The changelog heading's human name replaces the bare tag string.
    expect(release?.name).not.toBe("v2.3.0");
  });

  it("never overwrites a real Release's own words with the changelog's", async () => {
    global.fetch = githubWith({
      releases: [{ tag_name: "v2.3.0", name: "GitHub title", body: "github body", published_at: "2026-08-08", html_url: "u" }],
      tags: []
    });

    const status = await freshStatus();
    const release = status.releases.find((r) => r.version === "2.3.0");
    expect(release?.notes).toBe("github body");
    expect(release?.name).toBe("GitHub title");
  });
});

/**
 * THE HISTORY IS THE CHANGELOG'S, NOT GITHUB'S.
 *
 * The bug these pin, exactly as reported: /app/whats-new's Release history stopped at 2.3.0 while
 * the installation was running 2.4.0 — and said "Up to date" underneath, because 2.3.0 was also
 * the newest version GitHub had been told about. The repo had four tags (1.0.0, 1.1.0, 2.0.0,
 * 2.3.0) and seven released versions, and the page was built by mapping over GITHUB's list, so
 * every release whose tag had not been pushed was invisible — notes and all, while those notes sat
 * in the very build being served.
 *
 * A release exists when CHANGELOG.md and VERSION say it does. Tagging is a later, separate step,
 * and the page must not wait for it.
 */
describe("release history is derived from the bundled changelog", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  async function freshStatus() {
    vi.resetModules();
    const mod = await import("../../src/services/update-check.service.js");
    return mod.getUpdateStatus();
  }

  /** The versions the real CHANGELOG.md declares — the list the page owes its readers. */
  async function bundledVersions(): Promise<string[]> {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const mod = await import("../../src/services/changelog-releases.service.js");
    const markdown = readFileSync(resolve(__dirname, "../../../../CHANGELOG.md"), "utf8");
    return mod.parseChangelogReleases(markdown, "owner/repo").map((release) => release.version);
  }

  it("shows every changelog release even when GitHub has tagged only some of them", async () => {
    // Precisely the observed state: a partial tag list, missing 2.1.0, 2.2.0 and everything after.
    global.fetch = githubTags(["v1.0.0", "v1.1.0", "v2.0.0", "v2.3.0"]);

    const status = await freshStatus();
    const shown = status.releases.map((r) => r.version);

    for (const version of await bundledVersions()) {
      expect(shown, `${version} is in CHANGELOG.md but missing from Release history`).toContain(version);
    }
    // Untagged releases are not second-class: they arrive with their notes attached.
    expect(status.releases.find((r) => r.version === "2.2.0")?.notes ?? "").not.toBe("");
  });

  it("puts the version this build is RUNNING in the history, so the page can badge it", async () => {
    global.fetch = githubTags(["v2.3.0"]);

    const status = await freshStatus();
    expect(status.releases.map((r) => r.version)).toContain(status.currentVersion);
  });

  it("orders by semver, not by which source supplied the row", async () => {
    global.fetch = githubTags(["v1.1.0", "v2.3.0", "v1.0.0"]);

    const status = await freshStatus();
    const versions = status.releases.map((r) => r.version);
    const descending = [...versions].sort((a, b) => compareSemver(b, a));
    expect(versions).toEqual(descending);
  });

  it("says the list is 'mixed' when the bundle knows versions GitHub does not", async () => {
    // The UI uses this to explain a version that has no GitHub link yet, instead of leaving it
    // looking like a rendering bug.
    global.fetch = githubTags(["v2.3.0"]);
    await expect(freshStatus()).resolves.toMatchObject({ releasesSource: "mixed" });
  });

  it("says 'changelog' when GitHub contributed nothing at all", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("air-gapped")) as never;
    const status = await freshStatus();
    expect(status.releasesSource).toBe("changelog");
    expect(status.releases.length).toBeGreaterThan(0);
    // And it still refuses to guess about the future: no history can prove you are up to date.
    expect(status.latestVersion).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  it("still surfaces a version NEWER than this build — the one thing the bundle cannot know", async () => {
    global.fetch = githubTags(["v99.0.0"]);

    const status = await freshStatus();
    expect(status.latestVersion).toBe("99.0.0");
    expect(status.updateAvailable).toBe(true);
    expect(status.releases[0].version).toBe("99.0.0");
  });

  function githubTags(names: string[]) {
    return vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/tags") ? names.map((name) => ({ name })) : [])
      })
    ) as never;
  }
});
