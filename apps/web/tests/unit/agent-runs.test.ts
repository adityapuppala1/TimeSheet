import { describe, expect, it } from "vitest";
import { groupRunsByDay, RUN_PERIODS, RUN_STATUS_LABELS } from "../../src/lib/agent-runs";

/** Local-time construction: the grouping is about the day the READER would name. */
function at(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

const NOW = new Date(2026, 8, 17, 15, 0); // 17 Sep 2026, local

describe("groupRunsByDay", () => {
  it("keeps the API's newest-first order inside each day and across days", () => {
    const runs = [
      { id: "a", createdAt: at(2026, 9, 17, 14) },
      { id: "b", createdAt: at(2026, 9, 17, 9) },
      { id: "c", createdAt: at(2026, 9, 16, 18) },
      { id: "d", createdAt: at(2026, 9, 2, 10) }
    ];
    const groups = groupRunsByDay(runs, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", groups[2].label]);
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a", "b"]);
    expect(groups[1].runs.map((r) => r.id)).toEqual(["c"]);
    expect(groups[2].runs.map((r) => r.id)).toEqual(["d"]);
    expect(groups[2].label).not.toMatch(/Today|Yesterday/);
  });

  it("groups by the viewer's local day, not by UTC", () => {
    // 00:30 local is the previous day in UTC for a positive offset — the heading must still say the
    // date the person reading it would name.
    const justAfterMidnight = new Date(2026, 8, 17, 0, 30);
    const groups = groupRunsByDay([{ id: "a", createdAt: justAfterMidnight.toISOString() }], NOW);
    expect(groups[0].label).toBe("Today");
  });

  it("never drops a row with an unreadable timestamp", () => {
    const groups = groupRunsByDay([{ id: "bad", createdAt: "not a date" }], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Unknown date");
    expect(groups[0].runs.map((r) => r.id)).toEqual(["bad"]);
  });

  it("returns nothing for nothing", () => {
    expect(groupRunsByDay([], NOW)).toEqual([]);
  });
});

describe("the card's filter options", () => {
  it("offers Any time plus four windows, all within the API's 90-day bound", () => {
    expect(RUN_PERIODS.map((p) => p.value)).toEqual(["0", "1", "7", "30", "90"]);
    for (const p of RUN_PERIODS) expect(Number(p.value)).toBeLessThanOrEqual(90);
  });

  it("labels every status the runner can write, and no invented one", () => {
    expect(Object.keys(RUN_STATUS_LABELS).sort()).toEqual(
      ["ABORTED", "BLOCKED", "COMPLETED", "FAILED", "PARTIAL", "QUEUED", "RUNNING"].sort()
    );
    // The words matter: two of these are bounds working, not failures.
    expect(RUN_STATUS_LABELS.PARTIAL).toBe("Stopped at a limit");
    expect(RUN_STATUS_LABELS.BLOCKED).toBe("Held for review");
  });
});
