/**
 * V12 8.5 — the Requirements Studio list as a small Docs Hub: "Each page displays Docs in a
 * table. You can filter, sort, and filter by Doc tags" (help.clickup.com, Docs Hub). Pure so the
 * page stays a renderer and the rules can be tested without a browser.
 */

export type StudioShow = "all" | "mine" | "archived";
export type StudioSort = "newest" | "updated" | "title";

export interface StudioFilters {
  q: string;
  show: StudioShow;
  docType: "ALL" | "PRD" | "BRD" | "BOTH";
  sort: StudioSort;
}

export const DEFAULT_STUDIO_FILTERS: StudioFilters = { q: "", show: "all", docType: "ALL", sort: "newest" };

/** The slice of a document row the filter reads — kept minimal so any row shape fits. */
export interface StudioRowLike {
  id: string;
  title: string;
  docType: "PRD" | "BRD" | "BOTH";
  status: "DRAFTING" | "READY" | "ARCHIVED";
  createdById?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * "All" and "Created by me" hide archived rows exactly as the list always did; "Archived" shows
 * only them. The search is a case-insensitive substring on the title. Sorting is stable within
 * equal keys (the input order, newest first from the API).
 */
export function filterStudioRows<T extends StudioRowLike>(rows: T[], f: StudioFilters, meId: string | null | undefined): T[] {
  const q = f.q.trim().toLowerCase();
  const kept = rows.filter((r) => {
    if (f.show === "archived" ? r.status !== "ARCHIVED" : r.status === "ARCHIVED") return false;
    if (f.show === "mine" && (!meId || r.createdById !== meId)) return false;
    if (f.docType !== "ALL" && r.docType !== f.docType) return false;
    if (q && !r.title.toLowerCase().includes(q)) return false;
    return true;
  });
  const by: Record<StudioSort, (a: T, b: T) => number> = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
  };
  return [...kept].sort(by[f.sort]);
}

export const STUDIO_FILTERS_KEY = "timesphere.studio-filters";

/** Remembered per browser; anything malformed falls back to the defaults (never throws). */
export function loadStudioFilters(storage: Pick<Storage, "getItem"> | null): StudioFilters {
  try {
    const raw = storage?.getItem(STUDIO_FILTERS_KEY);
    if (!raw) return DEFAULT_STUDIO_FILTERS;
    const parsed = JSON.parse(raw) as Partial<StudioFilters>;
    const show: StudioShow = parsed.show === "mine" || parsed.show === "archived" ? parsed.show : "all";
    const docType = parsed.docType === "PRD" || parsed.docType === "BRD" || parsed.docType === "BOTH" ? parsed.docType : "ALL";
    const sort: StudioSort = parsed.sort === "updated" || parsed.sort === "title" ? parsed.sort : "newest";
    // The search box is deliberately not remembered — a stale query is the classic "where did my documents go".
    return { q: "", show, docType, sort };
  } catch {
    return DEFAULT_STUDIO_FILTERS;
  }
}

export function saveStudioFilters(storage: Pick<Storage, "setItem"> | null, f: StudioFilters): void {
  try {
    storage?.setItem(STUDIO_FILTERS_KEY, JSON.stringify({ show: f.show, docType: f.docType, sort: f.sort }));
  } catch {
    /* private mode or full storage — the choice simply is not remembered */
  }
}
