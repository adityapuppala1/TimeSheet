/**
 * WHAT: the pure half of the Agents "Office" — the floor plan, where everything stands, how an agent
 * gets from A to B, and what an agent should be doing given its real mood. No three.js, no physics, no
 * DOM, so the rules are unit-tested and the 3D layer only has to draw and move what this decides.
 *
 * THE OFFICE (metres; x right, z toward the viewer; origin at the centre of a 24 × 16 floor):
 *   back row of rooms   — meeting room · planning · risk · security ops
 *   open floor          — eight desks in two rows, one per agent
 *   sides               — kitchen and triage mailroom on the left, capacity and press on the right
 *   front wall          — the door agents arrive and leave through
 * Each specialist has a ZONE: the room whose equipment acts out its job (the simulated worlds from
 * components/agents-studio/scene/sims). When a real run starts, the agent stands up and walks there.
 *
 * WHAT IS REAL: the goal. `goalFor` maps the roster-derived mood to where the agent must be —
 * out of the office when switched off, at its zone while a run is queued or running, flagging for
 * help at its desk after a failed run. WHAT IS OFFICE LIFE: between runs an on-duty agent sits at its
 * desk and now and then gets a coffee, chats to a colleague or joins a stand-up. Those are chosen by
 * `pickIdleActivity` from a seeded generator and the UI labels them as idle, never as work.
 *
 * WHO CALLS THIS: components/agents-office/scene/* and AgentOffice.tsx.
 */
import type { Archetype, Mood } from "../agents-studio/studio-model";

export interface Vec2 {
  x: number;
  z: number;
}

/** An axis-aligned box on the floor: centre, size, and how tall it is (for walls and furniture). */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export const FLOOR = { w: 24, d: 16 } as const;
export const MAX_AGENTS = 8;
/** Matches the walk clip's stride (1.37 m per 1 s cycle), so feet do not slide. */
export const WALK_SPEED = 1.37;
export const AGENT_RADIUS = 0.28;

const WALL_T = 0.14;
export const WALL_LOW = 1.05;
export const WALL_HIGH = 2.7;
const BACK_Z = -3;

/* ------------------------------------------------------------------ rooms */

export type RoomId = "meeting" | "planning" | "risk" | "security" | "kitchen" | "triage" | "capacity" | "press" | "floor";

export interface Room {
  id: RoomId;
  label: string;
  /** Floor rectangle (h unused). */
  area: Rect;
}

export const ROOMS: readonly Room[] = [
  { id: "meeting", label: "Meeting room", area: { x: -8.5, z: -5.5, w: 7, d: 5, h: 0 } },
  { id: "planning", label: "Planning", area: { x: -2.25, z: -5.5, w: 5.5, d: 5, h: 0 } },
  { id: "risk", label: "Risk desk", area: { x: 3.5, z: -5.5, w: 6, d: 5, h: 0 } },
  { id: "security", label: "Security ops", area: { x: 9.25, z: -5.5, w: 5.5, d: 5, h: 0 } },
  { id: "kitchen", label: "Kitchen", area: { x: -9.75, z: -0.25, w: 4.5, d: 5.5, h: 0 } },
  { id: "triage", label: "Mailroom", area: { x: -9.5, z: 5.25, w: 5, d: 5.5, h: 0 } },
  { id: "capacity", label: "Capacity", area: { x: 9.5, z: -0.25, w: 5, d: 5.5, h: 0 } },
  { id: "press", label: "Press desk", area: { x: 9.5, z: 5.25, w: 5, d: 5.5, h: 0 } }
];

/** The room whose equipment acts out each specialist's job. The assistant has none: it works at its desk. */
export const ZONE_OF: Readonly<Record<Archetype, RoomId>> = {
  triage: "triage",
  planner: "planning",
  risk: "risk",
  security: "security",
  reporter: "press",
  balancer: "capacity",
  assistant: "floor"
};

export const roomById = (id: RoomId): Room | undefined => ROOMS.find((r) => r.id === id);

/** Where a zone's equipment stands (its middle), inside its room. */
export function equipmentCentre(room: Room): Vec2 {
  return { x: room.area.x + 0.4, z: room.area.z - 0.3 };
}

/** Where an agent stands to work its zone's equipment, and the point it faces (the equipment's middle). */
export function zoneSpot(id: RoomId): { stand: Vec2; face: Vec2 } | null {
  const room = roomById(id);
  if (!room) return null;
  const centre = equipmentCentre(room);
  return { stand: { x: centre.x - 1.85, z: centre.z + 1.75 }, face: centre };
}

/* ------------------------------------------------------------------ walls */

const wall = (x: number, z: number, w: number, d: number, h: number): Rect => ({ x, z, w, d, h });

/** A wall along x from x0 to x1 at depth z, with door gaps cut out. */
function wallX(z: number, x0: number, x1: number, h: number, doors: ReadonlyArray<[number, number]> = []): Rect[] {
  const out: Rect[] = [];
  let from = x0;
  for (const [a, b] of [...doors].sort((p, q) => p[0] - q[0])) {
    if (a > from) out.push(wall((from + a) / 2, z, a - from, WALL_T, h));
    from = b;
  }
  if (x1 > from) out.push(wall((from + x1) / 2, z, x1 - from, WALL_T, h));
  return out;
}

const wallZ = (x: number, z0: number, z1: number, h: number): Rect => wall(x, (z0 + z1) / 2, WALL_T, z1 - z0, h);

export const DOOR: Vec2 = { x: 0, z: FLOOR.d / 2 };
/** Just outside the door: where a switched-off agent goes, and where one arrives from. */
export const OUTSIDE: Vec2 = { x: 0, z: FLOOR.d / 2 + 1.6 };

export const WALLS: readonly Rect[] = [
  // Outer shell: tall at the back and sides, low at the front so the camera sees in.
  ...wallX(-FLOOR.d / 2, -FLOOR.w / 2, FLOOR.w / 2, WALL_HIGH),
  wallZ(-FLOOR.w / 2, -FLOOR.d / 2, FLOOR.d / 2, WALL_HIGH),
  wallZ(FLOOR.w / 2, -FLOOR.d / 2, FLOOR.d / 2, WALL_HIGH),
  ...wallX(FLOOR.d / 2, -FLOOR.w / 2, FLOOR.w / 2, 0.5, [[-0.9, 0.9]]),
  // The back rooms' front wall, with a doorway into each.
  ...wallX(BACK_Z, -FLOOR.w / 2, FLOOR.w / 2, WALL_LOW, [
    [-9.4, -7.6],
    [-4.6, -2.9],
    [1.0, 2.7],
    [6.9, 8.6]
  ]),
  // Partitions between the back rooms.
  wallZ(-5, -FLOOR.d / 2, BACK_Z, WALL_LOW),
  wallZ(0.5, -FLOOR.d / 2, BACK_Z, WALL_LOW),
  wallZ(6.5, -FLOOR.d / 2, BACK_Z, WALL_LOW),
  // Side nooks: a short divider between kitchen and mailroom, and between capacity and press.
  ...wallX(2.5, -FLOOR.w / 2, -8.6, WALL_LOW),
  ...wallX(2.5, 8.6, FLOOR.w / 2, WALL_LOW)
];

/* ------------------------------------------------------------------ furniture */

export interface Seat {
  /** Where the agent sits, and the heading (radians about Y, 0 = facing +z) it sits at. */
  seat: Vec2;
  heading: number;
  /** Where it stands up to / sits down from — a free spot beside the chair. */
  access: Vec2;
}

export interface Desk extends Seat {
  /** Desk top footprint. */
  desk: Rect;
}

const DESK_XS = [-4.5, -1.5, 1.5, 4.5];
const DESK_ZS = [0.2, 4.3];

/** Eight desks in two rows. The agent sits behind its desk facing the viewer, laptop in front of it. */
export const DESKS: readonly Desk[] = DESK_ZS.flatMap((z) =>
  DESK_XS.map((x) => ({
    desk: { x, z: z + 0.3, w: 1.5, d: 0.7, h: 0.74 },
    seat: { x, z: z - 0.42 },
    heading: 0,
    access: { x: x + 0.95, z: z - 0.5 }
  }))
);

export const MEETING_TABLE: Rect = { x: -8.5, z: -5.6, w: 3.4, d: 1.3, h: 0.74 };

/** Six seats around the meeting table: three each side, facing it. */
export const MEETING_SEATS: readonly Seat[] = [-1.1, 0, 1.1].flatMap((dx) => [
  { seat: { x: MEETING_TABLE.x + dx, z: MEETING_TABLE.z - 1.0 }, heading: 0, access: { x: MEETING_TABLE.x + dx, z: MEETING_TABLE.z - 1.6 } },
  { seat: { x: MEETING_TABLE.x + dx, z: MEETING_TABLE.z + 1.0 }, heading: Math.PI, access: { x: MEETING_TABLE.x + dx, z: MEETING_TABLE.z + 1.6 } }
]);

export const COFFEE_COUNTER: Rect = { x: -11.3, z: -0.6, w: 0.8, d: 2.4, h: 0.95 };
export const COFFEE_SPOT: { stand: Vec2; face: Vec2 } = { stand: { x: -10.3, z: -0.6 }, face: { x: -11.3, z: -0.6 } };
export const BIN: Vec2 = { x: 6.6, z: 2.2 };

/** Plants and other things you walk around. */
export const DECOR: readonly Rect[] = [
  { x: -6.9, z: 7.2, w: 0.6, d: 0.6, h: 1.2 },
  { x: 6.9, z: 7.2, w: 0.6, d: 0.6, h: 1.2 },
  { x: -6.6, z: -2.4, w: 0.6, d: 0.6, h: 1.2 },
  { x: -11.3, z: 1.6, w: 0.7, d: 0.7, h: 1.4 }
];

const ZONE_ROOMS: readonly RoomId[] = ["planning", "risk", "security", "triage", "capacity", "press"];
export const zoneRooms = (): Room[] => ROOMS.filter((r) => ZONE_ROOMS.includes(r.id));

/** The floor area a zone's equipment occupies, so nobody walks through a crane. */
function equipmentFootprint(room: Room): Rect {
  const centre = equipmentCentre(room);
  return { x: centre.x + 0.2, z: centre.z, w: 3.0, d: 2.8, h: 2 };
}

/** Everything solid: what the nav grid routes around and what physics collides with. */
export function obstacles(): Rect[] {
  return [...WALLS, ...DESKS.map((d) => d.desk), MEETING_TABLE, COFFEE_COUNTER, ...DECOR, ...zoneRooms().map(equipmentFootprint)];
}

/* ------------------------------------------------------------------ navigation */

export const CELL = 0.4;
const COLS = Math.ceil((FLOOR.w + 2) / CELL);
const ROWS = Math.ceil((FLOOR.d + 6) / CELL);
const ORIGIN = { x: -(FLOOR.w + 2) / 2, z: -(FLOOR.d + 6) / 2 + 1 };

export interface NavGrid {
  cols: number;
  rows: number;
  /** 1 = blocked. */
  blocked: Uint8Array;
}

const cellOf = (p: Vec2): [number, number] => [Math.floor((p.x - ORIGIN.x) / CELL), Math.floor((p.z - ORIGIN.z) / CELL)];
const centreOf = (c: number, r: number): Vec2 => ({ x: ORIGIN.x + (c + 0.5) * CELL, z: ORIGIN.z + (r + 0.5) * CELL });
const inGrid = (c: number, r: number) => c >= 0 && r >= 0 && c < COLS && r < ROWS;

function hits(p: Vec2, rect: Rect, margin: number): boolean {
  return Math.abs(p.x - rect.x) < rect.w / 2 + margin && Math.abs(p.z - rect.z) < rect.d / 2 + margin;
}

/** Whether a point is inside the building or on the doorstep path outside it. */
function onWalkableGround(p: Vec2): boolean {
  const inside = Math.abs(p.x) < FLOOR.w / 2 && Math.abs(p.z) < FLOOR.d / 2;
  const doorstep = Math.abs(p.x) < 1.2 && p.z >= FLOOR.d / 2 && p.z < FLOOR.d / 2 + 2.4;
  return inside || doorstep;
}

/** The grid agents path over: a cell is blocked when an agent's body could not stand at its centre. */
export function buildNavGrid(solid: readonly Rect[] = obstacles()): NavGrid {
  const blocked = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const p = centreOf(c, r);
      const free = onWalkableGround(p) && !solid.some((rect) => hits(p, rect, AGENT_RADIUS));
      blocked[r * COLS + c] = free ? 0 : 1;
    }
  }
  return { cols: COLS, rows: ROWS, blocked };
}

const isFree = (grid: NavGrid, c: number, r: number) => inGrid(c, r) && grid.blocked[r * COLS + c] === 0;

/** The free cell nearest a point — seats and stand spots sit right beside furniture, often in a blocked cell. */
function nearestFree(grid: NavGrid, p: Vec2): [number, number] | null {
  const [c0, r0] = cellOf(p);
  let best: [number, number] | null = null;
  let bestDist = Infinity;
  for (let r = r0 - 6; r <= r0 + 6; r += 1) {
    for (let c = c0 - 6; c <= c0 + 6; c += 1) {
      if (!isFree(grid, c, r)) continue;
      const centre = centreOf(c, r);
      const dist = (centre.x - p.x) ** 2 + (centre.z - p.z) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = [c, r];
      }
    }
  }
  return best;
}

const NEIGHBOURS: ReadonlyArray<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2]
];

/** A diagonal step is only allowed when both cells it squeezes between are free — no cutting corners. */
function canStep(grid: NavGrid, c: number, r: number, dc: number, dr: number): boolean {
  if (!isFree(grid, c + dc, r + dr)) return false;
  return dc === 0 || dr === 0 || (isFree(grid, c + dc, r) && isFree(grid, c, r + dr));
}

/** True when the straight line between two points crosses only free cells. */
export function lineIsClear(grid: NavGrid, a: Vec2, b: Vec2): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL / 2));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const [c, r] = cellOf({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    if (!isFree(grid, c, r)) return false;
  }
  return true;
}

/** Drop waypoints that a straight line can skip, so agents walk in lines rather than staircases. */
function smooth(grid: NavGrid, points: Vec2[]): Vec2[] {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;
  for (let i = 2; i < points.length; i += 1) {
    if (!lineIsClear(grid, points[anchor], points[i])) {
      out.push(points[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function reconstruct(cameFrom: Int32Array, end: number): Vec2[] {
  const cells: number[] = [];
  for (let at = end; at !== -1; at = cameFrom[at]) cells.push(at);
  return cells.reverse().map((i) => centreOf(i % COLS, Math.floor(i / COLS)));
}

/** Index in `open` of the cell with the lowest f = g + h. */
function cheapest(open: number[], g: Float32Array, h: (i: number) => number): number {
  let bestAt = 0;
  for (let i = 1; i < open.length; i += 1) {
    if (g[open[i]] + h(open[i]) < g[open[bestAt]] + h(open[bestAt])) bestAt = i;
  }
  return bestAt;
}

/**
 * A* over the nav grid. Returns the waypoints from `from` to `to` (ending exactly at `to`), or null
 * when there is no route. The grid is ~3,600 cells, so a plain open list is plenty.
 */
export function findPath(grid: NavGrid, from: Vec2, to: Vec2): Vec2[] | null {
  const start = nearestFree(grid, from);
  const goal = nearestFree(grid, to);
  if (!start || !goal) return null;
  const startI = start[1] * COLS + start[0];
  const goalI = goal[1] * COLS + goal[0];
  const g = new Float32Array(COLS * ROWS).fill(Infinity);
  const cameFrom = new Int32Array(COLS * ROWS).fill(-1);
  const closed = new Uint8Array(COLS * ROWS);
  const open: number[] = [startI];
  g[startI] = 0;
  const h = (i: number) => Math.hypot((i % COLS) - goal[0], Math.floor(i / COLS) - goal[1]);

  while (open.length > 0) {
    const current = open.splice(cheapest(open, g, h), 1)[0];
    if (current === goalI) return [...smooth(grid, reconstruct(cameFrom, current)), to];
    closed[current] = 1;
    const c = current % COLS;
    const r = Math.floor(current / COLS);
    for (const [dc, dr, cost] of NEIGHBOURS) {
      const next = (r + dr) * COLS + (c + dc);
      if (!canStep(grid, c, r, dc, dr) || closed[next]) continue;
      const tentative = g[current] + cost;
      if (tentative >= g[next]) continue;
      if (g[next] === Infinity) open.push(next);
      g[next] = tentative;
      cameFrom[next] = current;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ behaviour */

/** Where an agent's REAL state says it must be. */
export type Goal = "away" | "zone" | "alert" | "celebrate" | "desk";

const GOAL_OF: Readonly<Record<Mood, Goal>> = {
  off: "away",
  working: "zone",
  attention: "alert",
  celebrating: "celebrate",
  idle: "desk"
};

export const goalFor = (mood: Mood): Goal => GOAL_OF[mood];

/** What an on-duty agent with nothing running might do next. All of it is office life, never work. */
export type IdleActivity = "stay" | "coffee" | "chat" | "standup";

/** Seconds an idle agent stays put before considering a break — long enough that the desk is home. */
export function idlePause(rand: () => number): number {
  return 14 + rand() * 22;
}

/**
 * The next piece of office life for an idle agent. `idleCount` is how many agents are idle right now
 * (including this one): a chat needs two, a stand-up three, and a stand-up is rare.
 */
export function pickIdleActivity(rand: () => number, idleCount: number): IdleActivity {
  const roll = rand();
  if (idleCount >= 3 && roll < 0.14) return "standup";
  if (idleCount >= 2 && roll < 0.5) return "chat";
  if (roll < 0.82) return "coffee";
  return "stay";
}

/** Heading (radians about Y, 0 = facing +z) that looks from `from` toward `to`. */
export function headingTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** The shortest signed turn from one heading to another, in (-π, π]. */
export function turnBetween(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/* ------------------------------------------------------------------ people */

/** The model file each specialist wears. */
const PERSON_OF: Readonly<Record<Archetype, string>> = {
  triage: "lu",
  planner: "rafa",
  risk: "cardim",
  security: "dito",
  reporter: "marta",
  balancer: "rosa",
  assistant: "zelia"
};
export const PEOPLE: readonly string[] = ["lu", "rafa", "cardim", "dito", "marta", "rosa", "zelia", "tiao"];

/** One distinct person per agent: the specialist's own model first, then whoever is not taken yet. */
export function castPeople(archetypes: readonly Archetype[]): string[] {
  const taken = new Set<string>();
  return archetypes.map((archetype) => {
    const preferred = PERSON_OF[archetype];
    const person = taken.has(preferred) ? (PEOPLE.find((p) => !taken.has(p)) ?? preferred) : preferred;
    taken.add(person);
    return person;
  });
}

/* ------------------------------------------------------------------ the feed */

export interface RunLike {
  id: string;
  capability: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface FeedLine {
  key: string;
  agentId: string;
  agentName: string;
  text: string;
  at: number;
  /** "run" lines are REAL agent runs; "life" lines are office ambience. */
  kind: "run" | "life";
}

const RUN_VERB: Readonly<Record<string, string>> = {
  QUEUED: "queued",
  RUNNING: "is running",
  COMPLETED: "finished",
  PARTIAL: "partly finished",
  BLOCKED: "was blocked on",
  FAILED: "failed",
  ABORTED: "aborted"
};

/** The real runs across the roster as feed lines, newest first. */
export function runFeed(agents: ReadonlyArray<{ id: string; name: string; runs: { recent: readonly RunLike[] } }>, limit = 8): FeedLine[] {
  const lines: FeedLine[] = [];
  for (const agent of agents) {
    for (const run of agent.runs.recent) {
      const verb = RUN_VERB[run.status] ?? run.status.toLowerCase();
      lines.push({
        key: `run-${run.id}`,
        agentId: agent.id,
        agentName: agent.name,
        text: `${verb} ${run.capability.replaceAll("_", " ")}`,
        at: Date.parse(run.finishedAt ?? run.createdAt),
        kind: "run"
      });
    }
  }
  return lines.sort((a, b) => b.at - a.at).slice(0, limit);
}
