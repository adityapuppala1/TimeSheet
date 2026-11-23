/**
 * The office's REAL activity and its spatial awareness, as pure functions.
 *
 * Activity: what the office shows at a moment must follow the run events — a hand-off only when the
 * server linked two runs, a meeting only when two agents' runs overlap on the same project, queue
 * depth counted from what was waiting then, helpers only idle agents and never the queue's owner.
 * Steering: people give way, wait at a doorway someone else is in, and pick free spots.
 */
import { describe, expect, it } from "vitest";
import { assignHelpers, bubbleLine, describeView, feedAt, isQueuedAt, isRunningAt, meetingAt, queuesAt, viewAt } from "../../src/components/agents-office/office-activity";
import { freeSlots, PERSONAL_SPACE, shouldWaitAtDoor, steer, type Mover } from "../../src/components/agents-office/office-steering";
import { buildNavGrid, DESKS, DOORWAYS, isWalkable, MEETING_TABLE } from "../../src/components/agents-office/office-model";
import type { OfficeActivity, OfficeRunEvent } from "../../src/services/api";

const T0 = Date.parse("2026-11-23T10:00:00Z");
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();
const ev = (o: Partial<OfficeRunEvent> & { runId: string; agentId: string }): OfficeRunEvent => ({
  capability: "triage",
  status: "COMPLETED",
  createdAt: iso(0),
  startedAt: iso(0),
  finishedAt: iso(10),
  entity: null,
  summary: null,
  ...o
});
const project = (id: string, title = `Project ${id}`) => ({
  type: "project" as const,
  id,
  title
});

describe("run timing", () => {
  it("is running between start and finish, and open-ended while still running", () => {
    const done = ev({ runId: "r", agentId: "a" });
    expect(isRunningAt(done, T0 + 5 * 60_000)).toBe(true);
    expect(isRunningAt(done, T0 + 11 * 60_000)).toBe(false);
    const live = ev({
      runId: "l",
      agentId: "a",
      status: "RUNNING",
      finishedAt: null
    });
    expect(isRunningAt(live, T0 + 999 * 60_000)).toBe(true);
  });

  it("a queued run is waiting, not working, until it starts", () => {
    const q = ev({
      runId: "q",
      agentId: "a",
      status: "QUEUED",
      startedAt: null,
      finishedAt: null
    });
    expect(isRunningAt(q, T0 + 60_000)).toBe(false);
    expect(isQueuedAt(q, T0 + 60_000)).toBe(true);
    expect(isQueuedAt(q, T0 - 60_000)).toBe(false);
    const started = ev({
      runId: "s",
      agentId: "a",
      createdAt: iso(0),
      startedAt: iso(5)
    });
    expect(isQueuedAt(started, T0 + 2 * 60_000)).toBe(true);
    expect(isQueuedAt(started, T0 + 6 * 60_000)).toBe(false);
  });
});

describe("meetings", () => {
  it("meets only when two agents overlap on the same project, quoting each run's own line", () => {
    const events = [
      ev({
        runId: "1",
        agentId: "b",
        entity: project("p"),
        summary: "Re-plan sprint 42 after the outage review"
      }),
      ev({
        runId: "2",
        agentId: "a",
        entity: project("p"),
        summary: null,
        startedAt: iso(5),
        finishedAt: iso(20)
      }),
      ev({ runId: "3", agentId: "c", entity: project("q") })
    ];
    expect(meetingAt(events, T0 + 2 * 60_000)).toBeNull();
    const m = meetingAt(events, T0 + 7 * 60_000);
    expect(m).toMatchObject({
      key: "meet-p",
      title: "Project p",
      agentIds: ["a", "b"]
    });
    expect(m?.lines.a).toBeNull();
    expect(m?.lines.b?.length).toBeLessThanOrEqual(34);
    expect(m?.lines.b?.endsWith("…")).toBe(true);
  });

  it("never meets over a run with no visible target", () => {
    expect(meetingAt([ev({ runId: "1", agentId: "a" }), ev({ runId: "2", agentId: "b" })], T0 + 60_000)).toBeNull();
  });
});

describe("queues and helpers", () => {
  it("counts what was waiting at that moment", () => {
    const events = [
      ev({
        runId: "1",
        agentId: "a",
        status: "QUEUED",
        startedAt: null,
        finishedAt: null
      }),
      ev({
        runId: "2",
        agentId: "a",
        status: "QUEUED",
        startedAt: null,
        finishedAt: null,
        createdAt: iso(30)
      }),
      ev({ runId: "3", agentId: "b", createdAt: iso(0), startedAt: iso(2) })
    ];
    expect(queuesAt(events, T0 + 60_000)).toEqual({ a: 1, b: 1 });
    expect(queuesAt(events, T0 + 40 * 60_000)).toEqual({ a: 2 });
  });

  it("sends idle helpers to the deepest queue first, never the owner, never twice", () => {
    expect(assignHelpers({ a: 2 }, ["x"])).toEqual([]);
    expect(assignHelpers({ a: 3, b: 6 }, ["a", "z", "y"])).toEqual([
      { helperId: "a", agentId: "b" },
      { helperId: "y", agentId: "b" },
      { helperId: "z", agentId: "a" }
    ]);
    expect(assignHelpers({ a: 9 }, ["a"])).toEqual([]);
  });
});

describe("viewAt", () => {
  const activity: OfficeActivity = {
    since: iso(-60),
    until: iso(60),
    events: [
      ev({
        runId: "1",
        agentId: "a",
        entity: project("p"),
        finishedAt: iso(5)
      }),
      ev({
        runId: "2",
        agentId: "b",
        entity: project("p"),
        createdAt: iso(6),
        startedAt: iso(6),
        finishedAt: iso(30)
      })
    ],
    queues: { c: 4 },
    handoffs: [
      {
        fromRunId: "1",
        toRunId: "2",
        fromAgentId: "a",
        toAgentId: "b",
        kind: "project",
        at: iso(6),
        title: "Project p"
      }
    ],
    truncated: false
  };

  it("shows a hand-off only inside its window after it happened", () => {
    const opts = { live: false, handoffWindowMs: 120_000, idleIds: [] };
    expect(viewAt(activity, T0 + 5.5 * 60_000, opts).handoffs).toEqual([]);
    expect(viewAt(activity, T0 + 7 * 60_000, opts).handoffs).toEqual([{ key: "1>2", fromAgentId: "a", toAgentId: "b", title: "Project p" }]);
    expect(viewAt(activity, T0 + 9 * 60_000, opts).handoffs).toEqual([]);
  });

  it("uses the server's queues live and recomputes them in replay; helpers are idle agents only", () => {
    const live = viewAt(activity, T0 + 7 * 60_000, {
      live: true,
      handoffWindowMs: 0,
      idleIds: ["a", "b"]
    });
    expect(live.queues).toEqual({ c: 4 });
    expect([...live.working]).toEqual(["b"]);
    // b is working, so only a is free to help.
    expect(live.helpers).toEqual([{ helperId: "a", agentId: "c" }]);
    expect(
      viewAt(activity, T0 + 7 * 60_000, {
        live: false,
        handoffWindowMs: 0,
        idleIds: []
      }).queues
    ).toEqual({});
    expect(viewAt(null, T0, { live: true, handoffWindowMs: 0, idleIds: [] }).handoffs).toEqual([]);
  });

  it("describes itself in words, labelling helpers as visual only", () => {
    const view = viewAt(activity, T0 + 7 * 60_000, {
      live: true,
      handoffWindowMs: 120_000,
      idleIds: ["a"]
    });
    const lines = describeView(view, (id) => id.toUpperCase());
    expect(lines).toContain("A handed Project p to B");
    expect(lines).toContain("C has 4 queued");
    expect(lines).toContain("A is helping C (visual only)");
  });

  it("the replay feed shows each run as it stood at that moment", () => {
    const at7 = feedAt(activity, T0 + 7 * 60_000, (id) => id);
    expect(at7.map((l) => `${l.agentName} ${l.text}`)).toEqual(["b is running triage on Project p", "a finished triage on Project p"]);
    expect(feedAt(activity, T0 - 60_000, (id) => id)).toEqual([]);
  });

  it("bubble lines are short and single-line", () => {
    expect(bubbleLine("  a\n b ")).toBe("a b");
    expect(bubbleLine("")).toBeNull();
  });
});

describe("steering", () => {
  const me: Mover = {
    id: "me",
    pos: { x: 0, z: 0 },
    dir: { x: 1, z: 0 },
    priority: 1
  };

  it("walks straight when nobody is near", () => {
    const s = steer(me, { x: 1, z: 0 }, [{ id: "far", pos: { x: 5, z: 5 }, dir: { x: 0, z: 0 }, priority: 0 }]);
    expect(s.dir.x).toBeCloseTo(1);
    expect(s.pace).toBe(1);
  });

  it("is pushed out of someone's personal space and slows, but never reverses", () => {
    const s = steer(me, { x: 1, z: 0 }, [{ id: "o", pos: { x: 0.3, z: 0.3 }, dir: { x: 0, z: 0 }, priority: 0 }]);
    expect(s.dir.z).toBeLessThan(0);
    expect(s.dir.x).toBeGreaterThanOrEqual(0);
    expect(s.pace).toBeLessThan(1);
  });

  it("on a head-on approach the lower priority steps right and the higher keeps its line", () => {
    const other: Mover = {
      id: "o",
      pos: { x: 1.5, z: 0 },
      dir: { x: -1, z: 0 },
      priority: 2
    };
    const low = steer(me, { x: 1, z: 0 }, [other]);
    expect(low.dir.z).toBeGreaterThan(0.1);
    const high = steer({ ...other }, { x: -1, z: 0 }, [me]);
    expect(Math.abs(high.dir.z)).toBeLessThan(1e-9);
  });

  it("waits at a doorway somebody else is moving through", () => {
    const door = DOORWAYS[0];
    const walker: Mover = {
      id: "w",
      pos: { x: door.x, z: door.z + 1.2 },
      dir: { x: 0, z: -1 },
      priority: 1
    };
    const inDoor: Mover = {
      id: "d",
      pos: { x: door.x, z: door.z + 0.1 },
      dir: { x: 0, z: 1 },
      priority: 0
    };
    expect(shouldWaitAtDoor(walker, [inDoor], DOORWAYS)).toEqual(door);
    expect(shouldWaitAtDoor(walker, [{ ...inDoor, dir: { x: 0, z: 0 } }], DOORWAYS)).toBeNull();
    expect(shouldWaitAtDoor({ ...walker, dir: { x: 0, z: 1 } }, [inDoor], DOORWAYS)).toBeNull();
  });

  it("free slots around a table are walkable and keep personal space from each other and the taken", () => {
    const grid = buildNavGrid();
    const taken = [{ x: MEETING_TABLE.x, z: MEETING_TABLE.z - 1.6 }];
    const slots = freeSlots({ x: MEETING_TABLE.x, z: MEETING_TABLE.z }, 5, taken, (p) => isWalkable(grid, p), 1.6);
    expect(slots).toHaveLength(5);
    for (const s of slots) {
      expect(isWalkable(grid, s)).toBe(true);
      for (const q of [...taken, ...slots.filter((x) => x !== s)]) expect(Math.hypot(s.x - q.x, s.z - q.z)).toBeGreaterThanOrEqual(PERSONAL_SPACE - 1e-9);
    }
    // A desk's own footprint is never offered.
    expect(isWalkable(grid, { x: DESKS[0].desk.x, z: DESKS[0].desk.z })).toBe(false);
  });
});
