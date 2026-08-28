/**
 * The guard on the pitch deck's exported HTML and PowerPoint.
 *
 * `scripts/pitch-export/content.mjs` holds a second copy of the deck's narrative, because the page
 * keeps its content inside JSX mixed with lucide components and Tailwind classes, and a Node
 * exporter cannot import that without dragging the whole web build in. That duplication is a real
 * cost and the file says so at the top — this test is what stops it becoming a silent one.
 *
 * WHAT IT CATCHES: a slide added to, removed from, or renamed in `PitchDeck.tsx`'s own `SLIDES`
 * array without the exports learning about it. That is the failure that actually happens — someone
 * writes a new slide, ships it, and the deck they email a month later is missing it entirely.
 *
 * WHAT IT DOES NOT CATCH, stated plainly rather than left to be discovered: a reworded paragraph.
 * Nothing short of hoisting the seven content arrays into a shared module would, and that is the
 * right end state rather than what shipped today.
 *
 * The source is read as text on purpose. Importing the page pulls in React, the router and the
 * three.js backdrop for the sake of one array of string literals.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, never a string edit on the href: stripping "file:///" gives "C:/x/y" on Windows
// and "home/runner/x" on Linux — where the leading slash IS the root. That exact bug made the
// strictest tests in this repo silently absent from CI once already.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Pull the ids out of `const SLIDES = [...]` in the page, in the order they are declared. */
function slideIdsFromPage(): string[] {
  const source = read("../../src/pages/PitchDeck.tsx");
  const block = /const SLIDES = \[([\s\S]*?)\] as const;/.exec(source);
  expect(block, "PitchDeck.tsx no longer declares `const SLIDES = [...] as const`").not.toBeNull();
  return [...block![1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** And the ids the exporters will actually render. */
function slideIdsFromExport(): string[] {
  const source = read("../../../../scripts/pitch-export/content.mjs");
  const block = /export const SLIDES = \[([\s\S]*?)\n\];/.exec(source);
  expect(block, "content.mjs no longer declares `export const SLIDES = [...]`").not.toBeNull();
  return [...block![1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Slides that exist ONLY in the exports, never on the public page — each with the reason, because
 * an unexplained allowlist is just drift with permission:
 *  - "ask":  an equity ask has no business on a public marketing page; investors get the deck.
 *  - "team": the committed deck ships placeholder cards ("Add name") for the owner to fill in, and
 *            publishing placeholder people to the website would be worse than no team slide.
 */
const EXPORT_ONLY = ["ask", "team"];

describe("the exported deck covers the deck on the page", () => {
  it("has a section for every page slide, in the same order", () => {
    // Order matters as much as membership: a deck that argues the market before the problem is a
    // different pitch, and an exporter silently reordering it would be worse than omitting a slide.
    // Export-only slides are removed before comparing, so the page still cannot gain a slide the
    // exports lack — the drift this guard exists for — while the deck may carry investor-only ones.
    expect(slideIdsFromExport().filter((id) => !EXPORT_ONLY.includes(id))).toEqual(slideIdsFromPage());
  });

  it("actually carries the export-only slides it claims", () => {
    // Without this, deleting "ask" from the exports would still pass the filtered check above.
    const ids = slideIdsFromExport();
    for (const id of EXPORT_ONLY) expect(ids, `missing export-only slide: ${id}`).toContain(id);
  });

  it("keeps the export-only slides OFF the public page", () => {
    // The other direction: somebody pasting the ask slide into PitchDeck.tsx should hear about it
    // from a test naming the policy, not from a review comment after it shipped.
    const pageIds = slideIdsFromPage();
    for (const id of EXPORT_ONLY) expect(pageIds, `"${id}" belongs to the exports only`).not.toContain(id);
  });

  it("names every screenshot it embeds, and every one exists on disk", () => {
    // A missing PNG is an exception at build time for the PPTX and a broken image in the HTML. Both
    // are caught here instead, where the failure names the file.
    const source = read("../../../../scripts/pitch-export/content.mjs");
    const files = [...source.matchAll(/"([a-z0-9-]+\.png)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(10);
    for (const file of new Set(files)) {
      expect(() => read(`../../public/product/${file}`), `missing screenshot: ${file}`).not.toThrow();
    }
  });

  it("carries the market sources with the figures", () => {
    /*
     * The sizing slide's whole argument is that its numbers are checkable. A deck emailed without
     * the publishers attached is exactly the deck that slide was built not to be, so the export
     * has to keep them — this asserts the firms travel with the ranges.
     */
    const source = read("../../../../scripts/pitch-export/content.mjs");
    for (const firm of ["Grand View Research", "Fortune Business Insights", "Mordor Intelligence", "Research and Markets"]) {
      expect(source).toContain(firm);
    }
    // And that the assumptions are still labelled as assumptions rather than quietly presented.
    expect(source).toContain("assumptions");
    expect(source.toLowerCase()).toContain("the low end of every range");
  });
});
