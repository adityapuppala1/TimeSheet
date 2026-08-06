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

describe("parseChangelogReleases", () => {
  it("parses the repo's actual CHANGELOG.md into the full release history", () => {
    const markdown = readFileSync(resolve(__dirname, "../../../../CHANGELOG.md"), "utf8");
    const releases = parseChangelogReleases(markdown, REPO);

    const versions = releases.map((r) => r.version);
    expect(versions).toEqual(["2.0.0", "1.1.0", "1.0.0"]);

    const v2 = releases[0];
    expect(v2.name).toBe("the planning layer");
    expect(v2.publishedAt).toBe("2026-08-06T12:00:00.000Z");
    expect(v2.notes).toContain("planning");

    // Date-only headings ("## 1.1.0 — 2026-08-03") get the version as their display name.
    expect(releases[1].name).toBe("v1.1.0");
    expect(releases[1].publishedAt).toBe("2026-08-03T12:00:00.000Z");
    expect(releases[2].publishedAt).toBe("2026-07-29T12:00:00.000Z");

    // Bodies must not bleed across sections: 1.0.0's notes cannot mention the planning layer.
    expect(releases[2].notes).not.toContain("planning layer");
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
