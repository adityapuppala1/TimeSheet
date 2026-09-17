import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO_FILTERS, filterStudioRows, loadStudioFilters, saveStudioFilters, STUDIO_FILTERS_KEY } from "../../src/lib/studio-filters";

const rows = [
  { id: "a", title: "Onboarding PRD", docType: "PRD" as const, status: "READY" as const, createdById: "me", createdAt: "2026-09-01", updatedAt: "2026-09-10" },
  { id: "b", title: "Billing BRD", docType: "BRD" as const, status: "DRAFTING" as const, createdById: "other", createdAt: "2026-09-05", updatedAt: "2026-09-06" },
  { id: "c", title: "Archive drill", docType: "PRD" as const, status: "ARCHIVED" as const, createdById: "me", createdAt: "2026-09-03", updatedAt: "2026-09-04" },
  { id: "d", title: "alpha notes", docType: "BOTH" as const, status: "READY" as const, createdById: null, createdAt: "2026-09-02", updatedAt: "2026-09-12" }
];

describe("filterStudioRows", () => {
  it("hides archived rows by default and sorts newest first", () => {
    expect(filterStudioRows(rows, DEFAULT_STUDIO_FILTERS, "me").map((r) => r.id)).toEqual(["b", "d", "a"]);
  });
  it("Created by me narrows to the signed-in person, and to nobody when signed out", () => {
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, show: "mine" }, "me").map((r) => r.id)).toEqual(["a"]);
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, show: "mine" }, null)).toEqual([]);
  });
  it("Archived shows only what the other pages hide", () => {
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, show: "archived" }, "me").map((r) => r.id)).toEqual(["c"]);
  });
  it("type, search and the two other sorts", () => {
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, docType: "PRD" }, "me").map((r) => r.id)).toEqual(["a"]);
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, q: "  NOTES " }, "me").map((r) => r.id)).toEqual(["d"]);
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, sort: "updated" }, "me").map((r) => r.id)).toEqual(["d", "a", "b"]);
    expect(filterStudioRows(rows, { ...DEFAULT_STUDIO_FILTERS, sort: "title" }, "me").map((r) => r.id)).toEqual(["d", "b", "a"]);
  });
});

describe("remembered filters", () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
  }
  it("round-trips show/type/sort but never the search box", () => {
    const s = memory();
    saveStudioFilters(s, { q: "stale", show: "mine", docType: "BRD", sort: "title" });
    expect(JSON.parse(s.map.get(STUDIO_FILTERS_KEY)!)).toEqual({ show: "mine", docType: "BRD", sort: "title" });
    expect(loadStudioFilters(s)).toEqual({ q: "", show: "mine", docType: "BRD", sort: "title" });
  });
  it("falls back to the defaults on garbage or a throwing storage", () => {
    expect(loadStudioFilters({ getItem: () => "{not json" })).toEqual(DEFAULT_STUDIO_FILTERS);
    expect(loadStudioFilters({ getItem: () => JSON.stringify({ show: "nope", sort: 3 }) })).toEqual(DEFAULT_STUDIO_FILTERS);
    expect(
      loadStudioFilters({
        getItem: () => {
          throw new Error("blocked");
        }
      })
    ).toEqual(DEFAULT_STUDIO_FILTERS);
    expect(loadStudioFilters(null)).toEqual(DEFAULT_STUDIO_FILTERS);
  });
});
