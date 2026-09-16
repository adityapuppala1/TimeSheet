/**
 * The breadcrumb is DERIVED from the sidebar's nav table, never typed. These pin the derivation —
 * and above all that it uses the sidebar's own active-route rule, so the crumb can never name a
 * different page than the sidebar is highlighting. Two sources of truth for "where am I" is the
 * drift this repo has fixed three times already.
 */
import { describe, expect, it } from "vitest";
import { crumbsFor, navItemFor } from "../../src/components/PageHeader";
import type { NavItem } from "../../src/components/Sidebar";

const ITEMS: NavItem[] = [
  { to: "/app", label: "Home", icon: null, end: true },
  { to: "/app/tickets", label: "Tickets", icon: null, section: "Work" },
  { to: "/app/settings", label: "Workspace settings", icon: null, section: "Configuration" }
];

describe("navItemFor uses the sidebar's matching rule", () => {
  it("resolves a detail page to its nearest nav ancestor, not to Home", () => {
    // `/app` is `end: true` in the real table for exactly this reason: without it every route
    // under /app would match Home, and the longest-match rule alone would still pick Home over a
    // page that is not in the table. Both halves matter.
    expect(navItemFor("/app/tickets/abc-123", ITEMS)?.label).toBe("Tickets");
    expect(navItemFor("/app", ITEMS)?.label).toBe("Home");
  });

  it("returns nothing for a path outside the table, so no wrong crumb is invented", () => {
    expect(navItemFor("/platform-admin/orgs", ITEMS)).toBeUndefined();
    expect(crumbsFor("/platform-admin/orgs", ITEMS)).toEqual([]);
  });
});

describe("crumbsFor", () => {
  it("is Section › Page, with the current page unlinked", () => {
    expect(crumbsFor("/app/tickets", ITEMS)).toEqual([{ label: "Work" }, { label: "Tickets", to: undefined }]);
  });

  it("links the page crumb when standing on a child of it", () => {
    // From a ticket detail, "Tickets" is a way back; from the list itself it is where you are.
    expect(crumbsFor("/app/tickets/abc-123", ITEMS)).toEqual([{ label: "Work" }, { label: "Tickets", to: "/app/tickets" }]);
  });

  it("gives the ungrouped lead item a single crumb, which the header then hides", () => {
    // One crumb is not a trail. PageHeader renders the nav only when there are two or more.
    expect(crumbsFor("/app", ITEMS)).toEqual([{ label: "Home", to: undefined }]);
  });

  it("reads the REAL table too — every sectioned route yields two crumbs", async () => {
    const { nav } = await import("../../src/components/Sidebar");
    for (const item of nav.filter((i) => i.section)) {
      const crumbs = crumbsFor(item.to);
      expect(crumbs.map((c) => c.label), item.to).toEqual([item.section, item.label]);
    }
  });
});
