/**
 * The bundled-changelog release parser. The most important case is the REAL CHANGELOG.md at the
 * repo root: a synthetic fixture can drift from the file's actual heading dialects, and this
 * parser exists precisely to read that one file forever.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChangelogReleases } from "../../src/services/changelog-releases.service.js";

const REPO = "owner/repo";

const REPO_ROOT = resolve(__dirname, "../../../..");
const realChangelog = () => readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");

describe("parseChangelogReleases", () => {
  it("parses the repo's actual CHANGELOG.md into the full release history", () => {
    const releases = parseChangelogReleases(realChangelog(), REPO);
    const byVersion = (version: string) => {
      const found = releases.find((release) => release.version === version);
      expect(found, `${version} missing from the parsed history`).toBeDefined();
      return found!;
    };

    // Looked up by version rather than by index, and asserting the historical tail is PRESENT in
    // order rather than that the list equals it. Cutting a release used to break six assertions
    // that had nothing to do with the new release — which is a test that punishes the one action
    // it exists to protect.
    const versions = releases.map((release) => release.version);
    const history = ["2.3.0", "2.2.0", "2.1.0", "2.0.0", "1.1.0", "1.0.0"];
    expect(versions.slice(versions.indexOf("2.3.0"))).toEqual(history);

    // Two releases share a date — the parser must order by position in the file, not by date.
    const v22 = byVersion("2.2.0");
    expect(v22.name).toBe("what the code assumed, and what it actually did");
    expect(v22.publishedAt).toBe("2026-08-07T12:00:00.000Z");

    // The em-dash-separated name survives a title that itself contains a comma.
    const v21 = byVersion("2.1.0");
    expect(v21.name).toBe("who gets the email, and why it was slow");
    expect(v21.publishedAt).toBe("2026-08-07T12:00:00.000Z");
    // Bodies must not bleed across sections that share a heading date.
    expect(v21.notes).not.toContain("what the code assumed");

    const v2 = byVersion("2.0.0");
    expect(v2.name).toBe("the planning layer");
    expect(v2.publishedAt).toBe("2026-08-06T12:00:00.000Z");
    expect(v2.notes).toContain("planning");

    // Date-only headings ("## 1.1.0 — 2026-08-03") get the version as their display name.
    expect(byVersion("1.1.0").name).toBe("v1.1.0");
    expect(byVersion("1.1.0").publishedAt).toBe("2026-08-03T12:00:00.000Z");
    expect(byVersion("1.0.0").publishedAt).toBe("2026-07-29T12:00:00.000Z");

    // Bodies must not bleed across sections: 1.0.0's notes cannot mention the planning layer.
    expect(byVersion("1.0.0").notes).not.toContain("planning layer");
  });

  it("has a newest release matching the VERSION file, so What's-new shows the running build", () => {
    // THE FAILURE THIS CATCHES, which happened: eighteen sections of finished work sat under
    // `## Unreleased` for nine days. The parser ignores that heading on purpose — an installation
    // must never render notes for a version that does not exist — so the in-app What's-new page
    // kept showing 2.3.0 and nobody could tell whether the page was broken or the release was
    // never cut. Nothing tied the two files together, so nothing said so.
    const releases = parseChangelogReleases(realChangelog(), REPO);
    const version = readFileSync(resolve(REPO_ROOT, "VERSION"), "utf8").trim();

    expect(releases.length, "CHANGELOG.md has no versioned releases at all").toBeGreaterThan(0);
    expect(
      releases[0].version,
      `VERSION says ${version} but the newest CHANGELOG.md heading is ${releases[0].version}. ` +
        `Either cut the release (rename "## Unreleased" to "## ${version} — <name> — <date>") ` +
        `or bump VERSION to match.`
    ).toBe(version);
  });

  it("keeps an Unreleased section for work that has not shipped", () => {
    // The other half: the section has to still exist after a release is cut, or the next change
    // lands under the released heading and silently rewrites history an installation already saw.
    expect(realChangelog()).toMatch(/^## Unreleased$/m);
  });

  it("handles version — name — date, version — date, and bare version headings", () => {
    const md = [
      "# Changelog",
      "",
      "## 3.1.0 — the big one — 2027-01-05",
      "notes A",
      "## 3.0.1 — 2026-12-01",
      "notes B",
      "## 3.0.0",
      "notes C"
    ].join("\n");
    const out = parseChangelogReleases(md, REPO);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ version: "3.1.0", name: "the big one", publishedAt: "2027-01-05T12:00:00.000Z", notes: "notes A" });
    expect(out[1]).toMatchObject({ version: "3.0.1", name: "v3.0.1", notes: "notes B" });
    expect(out[2]).toMatchObject({ version: "3.0.0", name: "v3.0.0", publishedAt: null, notes: "notes C" });
  });

  it("ignores preamble and ### subsection headings inside a release body", () => {
    const md = ["intro text", "## 1.0.0 — 2026-01-01", "### ✨ Features", "- one"].join("\n");
    const out = parseChangelogReleases(md, REPO);
    expect(out).toHaveLength(1);
    expect(out[0].notes).toContain("### ✨ Features");
  });
});
