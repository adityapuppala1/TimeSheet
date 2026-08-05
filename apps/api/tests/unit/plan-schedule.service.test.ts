/**
 * Pins the scheduling engine.
 *
 * WHY THIS IS THE MOST TEST-WORTHY FILE IN THE PLANNING LAYER: every interesting bug in a
 * scheduler is arithmetic — an off-by-one on a working day (every Gantt bar a day too long), a
 * lag applied to the wrong endpoint, a dependency cycle that hangs the request, a parent progress
 * that averages instead of weighting. None of those throw; they render plausibly and are wrong.
 * The service is deliberately a pure core so all of it can be checked here without a database.
 */
import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  assertNoParentCycle,
  dayKey,
  findCycle,
  legacyCategory,
  rollUpProgress,
  solveSchedule,
  subtractWorkingDays,
  toDay,
  workingDaysBetween,
  type PlanDependency,
  type PlanItem
} from "../../src/services/plan-schedule.service.js";

/** 2026-03-02 is a Monday. Every date in this file is anchored off that so the weekday of any
 *  expectation is checkable by eye. */
const MON = toDay("2026-03-02");
const FRI = toDay("2026-03-06");
const SAT = toDay("2026-03-07");

const item = (over: Partial<PlanItem> & { id: string }): PlanItem => ({
  key: over.id.toUpperCase(),
  title: over.id,
  parentId: null,
  startDate: null,
  endDate: null,
  isMilestone: false,
  progressPct: null,
  estimatedHours: null,
  status: "OPEN",
  statusCategory: "TODO",
  baselineStartDate: null,
  baselineEndDate: null,
  ...over
});

const dep = (id: string, fromId: string, toId: string, type: any, lagDays = 0): PlanDependency => ({
  id,
  fromId,
  toId,
  type,
  lagDays
});

describe("working-day arithmetic", () => {
  it("treats a span as inclusive: a 1-day task starts and ends the same day", () => {
    // THE off-by-one that makes every bar on a Gantt chart one day too long.
    expect(dayKey(addWorkingDays(MON, 1))).toBe("2026-03-02");
    expect(dayKey(addWorkingDays(MON, 5))).toBe("2026-03-06"); // Mon..Fri is 5 working days
  });

  it("skips the weekend", () => {
    expect(dayKey(addWorkingDays(MON, 6))).toBe("2026-03-09"); // next Monday, not Saturday
    // A span starting on a Saturday is pulled forward to Monday — a task that "starts Saturday"
    // is a scheduling artefact, not a plan.
    expect(dayKey(addWorkingDays(SAT, 1))).toBe("2026-03-09");
  });

  it("honours a non-Mon-Fri working week", () => {
    // A six-day week is common in this product's likely market; hard-coding Mon-Fri would be
    // wrong for a large share of it.
    const sixDay = [1, 2, 3, 4, 5, 6];
    expect(dayKey(addWorkingDays(MON, 6, sixDay))).toBe("2026-03-07"); // Saturday now works
    expect(workingDaysBetween(MON, toDay("2026-03-08"), sixDay)).toBe(6);
  });

  it("counts working days inclusively, and zero for a reversed range", () => {
    expect(workingDaysBetween(MON, FRI)).toBe(5);
    expect(workingDaysBetween(MON, MON)).toBe(1);
    expect(workingDaysBetween(FRI, MON)).toBe(0);
  });

  it("walks backwards symmetrically and never lands on a non-working day", () => {
    expect(dayKey(subtractWorkingDays(toDay("2026-03-09"), 1))).toBe("2026-03-06"); // Mon -1 = Fri
    expect(dayKey(subtractWorkingDays(SAT, 0))).toBe("2026-03-06"); // clamps off the weekend
  });
});

describe("dependency resolution", () => {
  it("finish-to-start puts the successor on the next working day", () => {
    const items = [
      item({ id: "a", startDate: MON, endDate: FRI }),
      item({ id: "b", estimatedHours: 8 })
    ];
    const { items: solved } = solveSchedule(items, [dep("d1", "a", "b", "FINISH_TO_START")]);
    const b = solved.find((i) => i.id === "b")!;
    expect(dayKey(b.resolvedStart)).toBe("2026-03-09"); // Monday, not Saturday
    expect(b.isInferred).toBe(true);
  });

  it("treats BLOCKS as finish-to-start, so V5 dependencies keep meaning what they meant", () => {
    // Orgs have real data recorded under BLOCKS — the only dependency vocabulary the ticket
    // sheet has ever offered. Reinterpreting it would silently change their plans.
    const items = [item({ id: "a", startDate: MON, endDate: FRI }), item({ id: "b" })];
    const viaBlocks = solveSchedule(items, [dep("d", "a", "b", "BLOCKS")]).items.find((i) => i.id === "b")!;
    const viaFs = solveSchedule(items, [dep("d", "a", "b", "FINISH_TO_START")]).items.find((i) => i.id === "b")!;
    expect(dayKey(viaBlocks.resolvedStart)).toBe(dayKey(viaFs.resolvedStart));
  });

  it("applies lag in working days, not calendar days", () => {
    const items = [item({ id: "a", startDate: MON, endDate: MON }), item({ id: "b" })];
    // Finishes Monday, +2 working days lag => starts Thursday (Tue, Wed are the lag).
    const b = solveSchedule(items, [dep("d", "a", "b", "FINISH_TO_START", 2)]).items.find((i) => i.id === "b")!;
    expect(dayKey(b.resolvedStart)).toBe("2026-03-05");
  });

  it("start-to-start ties the two starts together", () => {
    const items = [item({ id: "a", startDate: toDay("2026-03-04"), endDate: FRI }), item({ id: "b" })];
    const b = solveSchedule(items, [dep("d", "a", "b", "START_TO_START")]).items.find((i) => i.id === "b")!;
    expect(dayKey(b.resolvedStart)).toBe("2026-03-04");
  });

  it("finish-to-finish backs the successor's start off its own duration", () => {
    const items = [
      item({ id: "a", startDate: MON, endDate: FRI }),
      // 3-day task that must not finish before A finishes (Fri) => starts Wednesday.
      item({ id: "b", estimatedHours: 24 })
    ];
    const b = solveSchedule(items, [dep("d", "a", "b", "FINISH_TO_FINISH")]).items.find((i) => i.id === "b")!;
    expect(dayKey(b.resolvedStart)).toBe("2026-03-04");
    expect(dayKey(b.resolvedEnd)).toBe("2026-03-06");
  });

  it("REPORTS a contradiction instead of silently moving a date a human typed", () => {
    // The whole posture of this engine: it tells you the plan is inconsistent, it does not
    // quietly disagree with what you entered.
    const items = [
      item({ id: "a", startDate: MON, endDate: FRI }),
      item({ id: "b", startDate: toDay("2026-03-03"), endDate: toDay("2026-03-04") })
    ];
    const solved = solveSchedule(items, [dep("d1", "a", "b", "FINISH_TO_START")]);
    const b = solved.items.find((i) => i.id === "b")!;
    expect(dayKey(b.resolvedStart)).toBe("2026-03-03"); // the typed date survives
    expect(solved.violations).toHaveLength(1);
    expect(solved.violations[0].message).toMatch(/before .* allows/);
  });

  it("gives a milestone zero duration and keeps it on the timeline", () => {
    const m = solveSchedule([item({ id: "m", isMilestone: true, startDate: FRI })], []).items[0];
    expect(m.durationDays).toBe(0);
    expect(dayKey(m.resolvedStart)).toBe(dayKey(m.resolvedEnd));
  });
});

describe("cycles", () => {
  it("finds a dependency cycle and names the ring", () => {
    const items = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    const cycle = findCycle(items, [
      dep("1", "a", "b", "FINISH_TO_START"),
      dep("2", "b", "c", "FINISH_TO_START"),
      dep("3", "c", "a", "FINISH_TO_START")
    ]);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle!)).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not mistake a diamond for a cycle", () => {
    // a -> b, a -> c, b -> d, c -> d. Two paths to the same node is normal, not a loop.
    const items = ["a", "b", "c", "d"].map((id) => item({ id }));
    expect(
      findCycle(items, [
        dep("1", "a", "b", "FINISH_TO_START"),
        dep("2", "a", "c", "FINISH_TO_START"),
        dep("3", "b", "d", "FINISH_TO_START"),
        dep("4", "c", "d", "FINISH_TO_START")
      ])
    ).toBeNull();
  });

  it("survives a long chain without blowing the stack", () => {
    // Iterative DFS, not recursive — "the timeline 500s on our biggest project" is a bad way to
    // discover a recursion limit.
    const items = Array.from({ length: 5000 }, (_, i) => item({ id: `n${i}` }));
    const deps = Array.from({ length: 4999 }, (_, i) => dep(`d${i}`, `n${i}`, `n${i + 1}`, "FINISH_TO_START"));
    expect(findCycle(items, deps)).toBeNull();
  });

  it("refuses a parent assignment that would make an item its own ancestor", () => {
    const parentOf = new Map<string, string | null>([
      ["epic", null],
      ["story", "epic"],
      ["task", "story"]
    ]);
    expect(() => assertNoParentCycle("epic", "task", parentOf)).toThrow(/own ancestor/i);
    expect(() => assertNoParentCycle("epic", "epic", parentOf)).toThrow(/own parent/i);
    // A legal re-parent must still be allowed.
    expect(() => assertNoParentCycle("task", "epic", parentOf)).not.toThrow();
  });
});

describe("critical path and float", () => {
  it("marks the longest chain critical and gives the slack branch float", () => {
    // a(5d) -> b(5d) -> d, and a -> c(1d) -> d. The a-b-d chain is critical; c has slack.
    const items = [
      item({ id: "a", startDate: MON, endDate: FRI }),
      item({ id: "b", startDate: toDay("2026-03-09"), endDate: toDay("2026-03-13") }),
      item({ id: "c", startDate: toDay("2026-03-09"), endDate: toDay("2026-03-09") }),
      item({ id: "d", startDate: toDay("2026-03-16"), endDate: toDay("2026-03-16") })
    ];
    const solved = solveSchedule(items, [
      dep("1", "a", "b", "FINISH_TO_START"),
      dep("2", "a", "c", "FINISH_TO_START"),
      dep("3", "b", "d", "FINISH_TO_START"),
      dep("4", "c", "d", "FINISH_TO_START")
    ]);
    const by = new Map(solved.items.map((i) => [i.id, i]));
    expect(by.get("b")!.totalFloatDays).toBe(0);
    expect(by.get("b")!.isCritical).toBe(true);
    expect(by.get("c")!.totalFloatDays).toBeGreaterThan(0);
    expect(by.get("c")!.isCritical).toBe(false);
    expect(solved.criticalPath).toContain("b");
    expect(solved.criticalPath).not.toContain("c");
  });

  it("reports the plan's overall span", () => {
    const solved = solveSchedule(
      [item({ id: "a", startDate: MON, endDate: FRI }), item({ id: "b", startDate: toDay("2026-03-09"), endDate: toDay("2026-03-11") })],
      []
    );
    expect(dayKey(solved.start!)).toBe("2026-03-02");
    expect(dayKey(solved.end!)).toBe("2026-03-11");
  });
});

describe("baseline slip", () => {
  it("counts slip in working days, and reports null with no baseline", () => {
    const [slipped, none] = solveSchedule(
      [
        item({ id: "a", startDate: MON, endDate: toDay("2026-03-11"), baselineStartDate: MON, baselineEndDate: FRI }),
        item({ id: "b", startDate: MON, endDate: FRI })
      ],
      []
    ).items;
    // Fri 6th -> Wed 11th is 3 working days later (Mon, Tue, Wed), not 5 calendar days.
    expect(slipped.slipDays).toBe(3);
    expect(none.slipDays).toBeNull();
  });

  it("reports a negative slip when work finishes ahead of baseline", () => {
    const ahead = solveSchedule(
      [item({ id: "a", startDate: MON, endDate: toDay("2026-03-04"), baselineStartDate: MON, baselineEndDate: FRI })],
      []
    ).items[0];
    expect(ahead.slipDays).toBeLessThan(0);
  });
});

describe("progress roll-up", () => {
  const childrenOf = (items: PlanItem[]) => {
    const map = new Map<string, PlanItem[]>();
    for (const i of items) {
      if (!i.parentId) continue;
      if (!map.has(i.parentId)) map.set(i.parentId, []);
      map.get(i.parentId)!.push(i);
    }
    return map;
  };

  it("weights a parent by effort, not by child count", () => {
    // THE bug this prevents: a 40-hour epic with one finished 1-hour subtask is 2.5% done. A
    // plain mean says 50%, and that is how status reports end up cheerfully wrong.
    const items = [
      item({ id: "epic" }),
      item({ id: "big", parentId: "epic", estimatedHours: 39, statusCategory: "TODO" }),
      item({ id: "small", parentId: "epic", estimatedHours: 1, statusCategory: "DONE", status: "RESOLVED" })
    ];
    const progress = rollUpProgress(items, childrenOf(items));
    expect(progress.get("epic")).toBe(3); // 100 * 1/40 rounded
    expect(progress.get("epic")).not.toBe(50);
  });

  it("lets an explicit number on a parent override the roll-up", () => {
    const items = [
      item({ id: "epic", progressPct: 30 }),
      item({ id: "child", parentId: "epic", statusCategory: "DONE" })
    ];
    expect(rollUpProgress(items, childrenOf(items)).get("epic")).toBe(30);
  });

  it("derives leaf progress from logged-vs-estimated hours when in flight", () => {
    // The number this app has and a pure PM tool does not.
    const items = [item({ id: "t", statusCategory: "ACTIVE", estimatedHours: 10, loggedHours: 4 })];
    expect(rollUpProgress(items, childrenOf(items)).get("t")).toBe(40);
  });

  it("caps derived progress below 100 so only a real status can mean finished", () => {
    // Overrunning the estimate must never read as "done" — that is a status decision, not an
    // arithmetic one.
    const items = [item({ id: "t", statusCategory: "ACTIVE", estimatedHours: 10, loggedHours: 40 })];
    expect(rollUpProgress(items, childrenOf(items)).get("t")).toBe(95);
  });

  it("treats DONE and CANCELLED as complete for roll-up purposes", () => {
    const items = [item({ id: "a", statusCategory: "DONE" }), item({ id: "b", statusCategory: "CANCELLED" })];
    const progress = rollUpProgress(items, childrenOf(items));
    expect(progress.get("a")).toBe(100);
    expect(progress.get("b")).toBe(100);
  });

  it("rolls a three-level tree up through the middle layer", () => {
    const items = [
      item({ id: "epic" }),
      item({ id: "story", parentId: "epic" }),
      item({ id: "t1", parentId: "story", estimatedHours: 5, statusCategory: "DONE" }),
      item({ id: "t2", parentId: "story", estimatedHours: 5, statusCategory: "TODO" })
    ];
    const progress = rollUpProgress(items, childrenOf(items));
    expect(progress.get("story")).toBe(50);
    expect(progress.get("epic")).toBe(50);
  });
});

describe("legacyCategory", () => {
  it("maps every built-in status, matching DEFAULT_STATUS_CATEGORY in @timesheet/shared", () => {
    // The fallback for workspaces that never enabled custom workflows. If it drifts from the
    // shared map, a ticket's timeline colour and its board column disagree.
    expect(legacyCategory("OPEN")).toBe("TODO");
    expect(legacyCategory("REOPENED")).toBe("TODO");
    expect(legacyCategory("IN_PROGRESS")).toBe("ACTIVE");
    expect(legacyCategory("IN_REVIEW")).toBe("REVIEW");
    expect(legacyCategory("RESOLVED")).toBe("DONE");
    expect(legacyCategory("CLOSED")).toBe("DONE");
  });
});
