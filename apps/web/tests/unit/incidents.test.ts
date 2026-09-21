import { describe, expect, it } from "vitest";
import { groupIncidentsByMonth, incidentMixLabel } from "../../src/lib/incidents";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

describe("groupIncidentsByMonth", () => {
  it("groups by month then day, newest first, whatever order the rows arrive in", () => {
    const rows = [
      { id: "a", status: "DEGRADED" as const, startedAt: at(2026, 8, 24) },
      { id: "b", status: "DOWN" as const, startedAt: at(2026, 8, 31) },
      { id: "c", status: "DEGRADED" as const, startedAt: at(2026, 9, 2) },
      { id: "d", status: "DEGRADED" as const, startedAt: at(2026, 8, 31, 9) }
    ];
    const months = groupIncidentsByMonth(rows);
    expect(months.map((m) => m.key)).toEqual(["2026-09", "2026-08"]);
    const aug = months[1];
    expect(aug.count).toBe(3);
    expect(aug.days.map((d) => d.key)).toEqual(["2026-08-31", "2026-08-24"]);
    // Inside a day, still newest first.
    expect(aug.days[0].incidents.map((i) => i.id)).toEqual(["b", "d"]);
  });

  it("carries the WORST status and a per-status mix on the month, so a folded month still tells the truth", () => {
    const months = groupIncidentsByMonth([
      { id: "a", status: "DEGRADED" as const, startedAt: at(2026, 8, 1) },
      { id: "b", status: "DOWN" as const, startedAt: at(2026, 8, 2) },
      { id: "c", status: "DEGRADED" as const, startedAt: at(2026, 8, 3) }
    ]);
    expect(months[0].worst).toBe("DOWN");
    expect(months[0].byStatus).toEqual({ OPERATIONAL: 0, DEGRADED: 2, DOWN: 1 });
    expect(incidentMixLabel(months[0].byStatus)).toBe("1 down · 2 degraded");
  });

  it("never says '0 down' for a month that only degraded", () => {
    expect(incidentMixLabel({ OPERATIONAL: 0, DEGRADED: 4, DOWN: 0 })).toBe("4 degraded");
  });

  it("drops a row whose timestamp cannot be read rather than crashing the page", () => {
    const months = groupIncidentsByMonth([{ id: "bad", status: "DOWN" as const, startedAt: "not a date" }]);
    expect(months).toEqual([]);
  });
});
