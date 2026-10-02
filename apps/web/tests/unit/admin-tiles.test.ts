/**
 * The admin stat tiles (home page and Reports). Pinned: point-in-time tiles carry no one-way delta,
 * period tiles carry their visible comparison, and a figure that did not load is a dash — the
 * security risk score used to read `?? 0` and was toned "success".
 */
import { describe, expect, it } from "vitest";
import { dashboardAdminTiles, reportsAdminTiles, reportsTicketTiles, riskTone } from "../../src/lib/admin-tiles";
import type { AdminSummary } from "../../src/services/api";

const summary = {
  period: { from: "2026-08-24", to: "2026-08-27", ranged: true, comparisonFrom: "2026-08-17", comparisonTo: "2026-08-20", comparisonLabel: "vs the same days last week" },
  users: 12,
  usersJoined: 2,
  projects: 4,
  projectsCreated: 0,
  pendingApprovals: 3,
  openEscalations: 1,
  approvedHours: 40,
  approvedHoursPrev: 32,
  loggedHours: 50,
  loggedHoursPrev: 40,
  slaBreached: 2,
  slaBreachedPrev: 0,
  approvedThisWeek: 7.5,
  approvedLastWeek: 10
} as unknown as AdminSummary;

const context = { periodIn: "this week", comparisonLabel: "vs the same days last week" };
const byLabel = (tiles: ReturnType<typeof dashboardAdminTiles>, label: string) => tiles.find((t) => t.label === label)!;

describe("dashboard admin tiles", () => {
  it("labels point-in-time figures 'now' and gives them no delta", () => {
    const tiles = dashboardAdminTiles(summary, 4, context);
    for (const label of ["Users · now", "Projects · now", "Pending approvals · now", "Security risk score · now"]) {
      expect(byLabel(tiles, label).trend ?? null).toBeNull();
    }
    expect(byLabel(tiles, "Users · now").hint).toMatch(/^2 joined this week/);
  });

  it("compares the period's approved hours like-for-like, with the label printed", () => {
    const tile = byLabel(dashboardAdminTiles(summary, 4, context), "Approved hours");
    expect(tile.value).toBe("40.0h");
    expect(tile.trend).toMatchObject({ pct: 25, direction: "up" });
    expect(tile.trendLabel).toBe("vs the same days last week");
  });

  it("shows a dash, not a green zero, when the security score did not load", () => {
    const tile = byLabel(dashboardAdminTiles(summary, null, context), "Security risk score · now");
    expect(tile.value).toBe("—");
    expect(tile.tone).toBe("default");
    expect(riskTone(0)).toBe("success");
  });

  it("shows dashes everywhere while the summary is missing", () => {
    const tiles = dashboardAdminTiles(undefined, undefined, context);
    expect(tiles.map((t) => t.value)).toEqual(["—", "—", "—", "—", "—"]);
  });
});

describe("reports tiles", () => {
  it("reads approved hours this week as hours, against the same weekdays last week", () => {
    const tile = reportsAdminTiles(summary).find((t) => t.label === "Approved hours this week")!;
    expect(tile.value).toBe("7.5h");
    expect(tile.trend).toMatchObject({ pct: -25, direction: "down" });
  });

  it("says a breach from a zero baseline is new, not +100%", () => {
    const tile = reportsAdminTiles(summary).find((t) => t.label === "Approval SLA breaches today")!;
    expect(tile.trend?.isNew).toBe(true);
  });
});

describe("reports ticket tiles", () => {
  const ticketSummary = {
    openTickets: 9,
    openSlaBreaches: 2,
    resolvedThisWeek: 6,
    resolvedLastWeek: 4,
    resolution: { medianHours: null, sampleSize: 0, windowDays: 28, prevMedianHours: 12, prevSampleSize: 5 }
  } as unknown as Parameters<typeof reportsTicketTiles>[0];

  it("says resolution time cannot be measured rather than claiming 0h", () => {
    const tile = reportsTicketTiles(ticketSummary).find((t) => t.label.startsWith("Median resolution"))!;
    expect(tile.value).toBe("—");
    expect(tile.trend ?? null).toBeNull();
    expect(tile.hint).toMatch(/0 tickets resolved in the window/);
  });

  it("gives the SLA tile no one-way 'vs yesterday' delta", () => {
    const tile = reportsTicketTiles(ticketSummary).find((t) => t.label.startsWith("Ticket SLA"))!;
    expect(tile.trend ?? null).toBeNull();
    expect(tile.value).toBe("2");
  });
});
