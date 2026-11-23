/**
 * The Agents Office's rules, as pure functions.
 *
 * SPATIAL AWARENESS is the part a screenshot cannot prove: that every place an agent is ever sent is
 * actually reachable, that a route never passes through a wall or a desk, and that the only way in or
 * out of the building is the door. A floor-plan edit that seals a room would otherwise show up as an
 * agent walking on the spot forever.
 *
 * HONESTY is the other part: an agent's REAL state decides where it must be (`goalFor`), office life
 * is only ever offered to an idle agent with company to share it, and the feed's run lines come from
 * real runs, newest first.
 */
import { describe, expect, it } from "vitest";

import {
  buildNavGrid,
  castPeople,
  COFFEE_SPOT,
  DESKS,
  findPath,
  FLOOR,
  goalFor,
  headingTo,
  lineIsClear,
  MEETING_SEATS,
  obstacles,
  OUTSIDE,
  PEOPLE,
  pickIdleActivity,
  ROOMS,
  runFeed,
  turnBetween,
  ZONE_OF,
  activeFlows,
  declutter,
  initialsOf,
  PIPELINE,
  speechLine,
  TASK_TITLE,
  zoneSpot,
  type Vec2
} from "../../src/components/agents-office/office-model";
import type { Archetype } from "../../src/components/agents-studio/studio-model";

const grid = buildNavGrid();
const solid = obstacles();
const SPECIALISTS: Archetype[] = ["triage", "planner", "risk", "security", "reporter", "balancer"];

const inside = (p: Vec2, margin = 0.05) =>
  solid.some((r) => Math.abs(p.x - r.x) < r.w / 2 - margin && Math.abs(p.z - r.z) < r.d / 2 - margin);

/** Every point along a path, sampled finely. */
function samples(path: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1));
    for (let k = 0; k <= n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

describe("the floor plan", () => {
  it("gives every specialist a zone room that exists, with a place to stand and something to face", () => {
    for (const archetype of SPECIALISTS) {
      const spot = zoneSpot(ZONE_OF[archetype]);
      expect(spot, archetype).not.toBeNull();
      expect(ROOMS.some((r) => r.id === ZONE_OF[archetype])).toBe(true);
      expect(inside(spot!.stand), `${archetype} would stand inside furniture`).toBe(false);
    }
    expect(zoneSpot(ZONE_OF.assistant)).toBeNull(); // the assistant works at its desk
  });

  it("has a desk for eight agents and no two desks or seats in the same place", () => {
    expect(DESKS).toHaveLength(8);
    const seats = [...DESKS, ...MEETING_SEATS].map((s) => `${s.seat.x},${s.seat.z}`);
    expect(new Set(seats).size).toBe(seats.length);
  });
});

describe("navigation", () => {
  const destinations: Array<[string, Vec2]> = [
    ...DESKS.map((d, i): [string, Vec2] => [`desk ${i}`, d.access]),
    ...MEETING_SEATS.map((s, i): [string, Vec2] => [`meeting seat ${i}`, s.access]),
    ...SPECIALISTS.map((a): [string, Vec2] => [`${a} zone`, zoneSpot(ZONE_OF[a])!.stand]),
    ["coffee", COFFEE_SPOT.stand]
  ];

  it.each(destinations)("reaches %s from the door", (_name, target) => {
    const path = findPath(grid, OUTSIDE, target);
    expect(path).not.toBeNull();
    expect(path!.at(-1)).toEqual(target);
  });

  it("never routes through a wall, a desk or a room's equipment", () => {
    for (const [name, target] of destinations) {
      const path = findPath(grid, DESKS[0].access, target)!;
      // The final hop lands exactly on the target, which may sit beside furniture; everything before it must be clear.
      const body = samples(path.slice(0, -1));
      expect(body.some((p) => inside(p)), `route to ${name} crosses something solid`).toBe(false);
    }
  });

  it("only lets anyone in or out through the door", () => {
    // Seal the doorway and the outside becomes unreachable: there is no other gap in the shell.
    const sealed = buildNavGrid([...solid, { x: 0, z: FLOOR.d / 2, w: 2.2, d: 0.4, h: 1 }]);
    expect(findPath(sealed, DESKS[0].access, OUTSIDE)?.at(-2)?.z ?? 0).toBeLessThan(FLOOR.d / 2);
    expect(lineIsClear(grid, { x: 0, z: FLOOR.d / 2 - 1 }, OUTSIDE)).toBe(true);
    expect(lineIsClear(grid, { x: 5, z: FLOOR.d / 2 - 1 }, { x: 5, z: FLOOR.d / 2 + 1 })).toBe(false);
  });

  it("takes a sensibly short route, not a tour of the building", () => {
    const from = DESKS[0].access;
    const to = DESKS[3].access;
    const path = findPath(grid, from, to)!;
    const length = path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.z - path[i].z), 0);
    expect(length).toBeLessThan(Math.hypot(to.x - from.x, to.z - from.z) * 1.5);
  });

  it("turns the short way round", () => {
    expect(turnBetween(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(Math.abs(turnBetween(3, -3))).toBeLessThan(Math.PI);
    expect(headingTo({ x: 0, z: 0 }, { x: 0, z: 1 })).toBeCloseTo(0);
    expect(headingTo({ x: 0, z: 0 }, { x: 1, z: 0 })).toBeCloseTo(Math.PI / 2);
  });
});

describe("what an agent must be doing follows its real state", () => {
  it("maps each mood to one goal", () => {
    expect(goalFor("off")).toBe("away");
    expect(goalFor("working")).toBe("zone");
    expect(goalFor("attention")).toBe("alert");
    expect(goalFor("celebrating")).toBe("celebrate");
    expect(goalFor("idle")).toBe("desk");
  });

  it("offers company-dependent office life only when there is company", () => {
    const always = (v: number) => () => v;
    for (let roll = 0; roll < 1; roll += 0.05) {
      expect(["coffee", "stay"]).toContain(pickIdleActivity(always(roll), 1)); // alone: no chat, no stand-up
      expect(pickIdleActivity(always(roll), 2)).not.toBe("standup"); // a stand-up needs three
    }
    expect(pickIdleActivity(always(0.05), 3)).toBe("standup");
    expect(pickIdleActivity(always(0.3), 2)).toBe("chat");
  });
});

describe("casting", () => {
  it("gives every agent a different person, even two of the same kind", () => {
    const cast = castPeople(["triage", "triage", "planner", "risk", "security", "reporter", "balancer", "assistant"]);
    expect(new Set(cast).size).toBe(8);
    for (const person of cast) expect(PEOPLE).toContain(person);
  });

  it("is stable: the same roster always gets the same people", () => {
    const roster: Archetype[] = ["planner", "triage", "assistant"];
    expect(castPeople(roster)).toEqual(castPeople(roster));
  });
});

describe("the run feed", () => {
  const run = (id: string, status: string, createdAt: string, finishedAt: string | null = null) => ({ id, capability: "plan_breakdown", status, createdAt, finishedAt });

  it("lists real runs newest first, in plain words", () => {
    const feed = runFeed([
      { id: "a", name: "Planner", runs: { recent: [run("1", "COMPLETED", "2026-11-12T10:00:00Z", "2026-11-12T10:05:00Z")] } },
      { id: "b", name: "Triage", runs: { recent: [run("2", "RUNNING", "2026-11-12T11:00:00Z")] } }
    ]);
    expect(feed.map((l) => l.agentName)).toEqual(["Triage", "Planner"]);
    expect(feed[0].text).toBe("is running plan breakdown");
    expect(feed[1].text).toBe("finished plan breakdown");
    expect(feed.every((l) => l.kind === "run")).toBe(true);
  });

  it("is empty when nothing has run — it never invents activity", () => {
    expect(runFeed([{ id: "a", name: "Planner", runs: { recent: [] } }])).toEqual([]);
  });
});

describe("what the office shows", () => {
  const set = (...xs: Archetype[]) => new Set<Archetype>(xs);

  it("names every specialist's task for its card", () => {
    for (const archetype of Object.keys(ZONE_OF) as Archetype[]) expect(TASK_TITLE[archetype].length).toBeGreaterThan(3);
  });

  it("only moves packets out of a room whose agent is really working", () => {
    const all = set("triage", "planner", "risk", "security", "reporter", "balancer");
    expect(activeFlows(set(), all)).toEqual([]);
    expect(activeFlows(set("triage"), all)).toEqual([{ from: "triage", to: "planner", both: false }]);
    expect(activeFlows(set("triage", "planner"), all).find((f) => f.from === "triage")?.both).toBe(true);
  });

  it("never draws a hand-off to an agent that is not in the office", () => {
    expect(activeFlows(set("triage"), set("triage"))).toEqual([]);
    for (const [from, to] of PIPELINE) expect(from).not.toBe(to);
  });

  it("speaks in short, stable lines that change turn by turn", () => {
    expect(speechLine("open", 3, 0)).toBe(speechLine("open", 3, 0));
    expect(speechLine("standup", 1, 0)).not.toBe(speechLine("standup", 1, 1));
    for (let t = 0; t < 10; t += 1) expect(speechLine("reply", -5, t).length).toBeLessThanOrEqual(16);
  });
});

describe("avatar initials", () => {
  it("takes up to two initials and never returns an empty face", () => {
    expect(initialsOf("Risk watch")).toBe("RW");
    expect(initialsOf("Triage")).toBe("T");
    expect(initialsOf("  load  balancer team ")).toBe("LB");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("label declutter", () => {
  it("leaves labels that do not touch where they are", () => {
    expect(declutter([{ x: 0, y: 100 }, { x: 500, y: 100 }], 150, 40)).toEqual([0, 0]);
  });

  it("stacks overlapping tags so none cover another, nearest the viewer staying put", () => {
    const boxes = [
      { x: 0, y: 100 },
      { x: 20, y: 110 },
      { x: 10, y: 105 }
    ];
    const lifts = declutter(boxes, 150, 40);
    expect(lifts[1]).toBe(0); // lowest on screen = nearest the camera
    const bottoms = boxes.map((b, i) => b.y - lifts[i]).sort((a, b) => a - b);
    for (let i = 1; i < bottoms.length; i += 1) expect(bottoms[i] - bottoms[i - 1]).toBeGreaterThanOrEqual(40);
  });
});

describe("label declutter with bubbles", () => {
  it("clears a neighbour's speech bubble, not just its tag", () => {
    // The near label carries a bubble (stack 90 px tall); the far one sits 50 px above its anchor.
    const lifts = declutter([{ x: 0, y: 200, h: 90 }, { x: 10, y: 150 }], 150, 40);
    expect(lifts[0]).toBe(0);
    expect(150 - lifts[1]).toBeLessThanOrEqual(200 - 90);
  });
});
