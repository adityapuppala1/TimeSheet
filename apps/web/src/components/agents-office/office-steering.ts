/**
 * WHAT: the office's spatial awareness — pure, unit-tested rules for how people share the floor.
 *   - `steer`: local avoidance. A walker keeps to its route but is pushed sideways by anyone inside its
 *     personal space, and on a head-on approach the one with the lower priority steps aside to its
 *     right (a deterministic tie-break, so two people never mirror each other forever).
 *   - `shouldWaitAtDoor`: someone already in a doorway goes first; a walker about to enter it waits.
 *   - `freeSlots`: spots around a point (a table, a zone) that are walkable and not already taken, so
 *     a fourth arrival stands beside the other three rather than inside one of them.
 *
 * The A* route (office-model.ts) still decides WHERE to go; Rapier still resolves the actual step.
 * This only decides how to give way. No three.js, no DOM.
 *
 * WHO CALLS THIS: scene/office-engine.ts, every walking frame.
 */
import { AGENT_RADIUS, type Vec2 } from "./office-model";

/** Comfortable distance between two people's centres (m). */
export const PERSONAL_SPACE = AGENT_RADIUS * 2 + 0.45;
/** Radius around a doorway's centre that counts as "in the doorway" (m). */
export const DOOR_RADIUS = 0.75;
/** How far out a walker starts checking a doorway ahead (m). */
const DOOR_LOOKAHEAD = 1.6;

export interface Mover {
  id: string;
  pos: Vec2;
  /** Unit heading of travel, or {0,0} when standing still. */
  dir: Vec2;
  /** Higher priority keeps its line; lower gives way. */
  priority: number;
}

export interface Steer {
  /** Unit direction to step in. */
  dir: Vec2;
  /** 0..1 multiplier on walking speed (slows when crowded). */
  pace: number;
}

const len = (v: Vec2) => Math.hypot(v.x, v.z);
const norm = (v: Vec2): Vec2 => {
  const l = len(v);
  return l < 1e-9 ? { x: 0, z: 0 } : { x: v.x / l, z: v.z / l };
};
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
/** The right-hand perpendicular of a heading (x right, z toward the viewer). */
const rightOf = (d: Vec2): Vec2 => ({ x: -d.z, z: d.x });

/** Separation push from one neighbour, or null when it is outside personal space. */
function pushFrom(self: Mover, other: Mover, space: number): Vec2 | null {
  const away = { x: self.pos.x - other.pos.x, z: self.pos.z - other.pos.z };
  const d = len(away);
  if (d >= space) return null;
  const strength = (space - d) / space;
  if (d < 1e-6) return { x: strength, z: 0 };
  return { x: (away.x / d) * strength, z: (away.z / d) * strength };
}

/** True when two walkers are closing on each other roughly head-on and the other is ahead. */
function headOn(self: Mover, other: Mover, range: number): boolean {
  const to = { x: other.pos.x - self.pos.x, z: other.pos.z - self.pos.z };
  const d = len(to);
  if (d > range || d < 1e-6) return false;
  const ahead = dot(self.dir, to) / d > 0.7;
  const facing = dot(self.dir, other.dir) < -0.5;
  return ahead && facing;
}

/**
 * Where to step this frame. `want` is the unit direction toward the next waypoint. Neighbours inside
 * personal space push the walker away; on a head-on approach the lower-priority walker sidesteps right.
 */
export function steer(self: Mover, want: Vec2, others: readonly Mover[], space = PERSONAL_SPACE): Steer {
  let side = { x: 0, z: 0 };
  let crowd = 0;
  for (const other of others) {
    if (other.id === self.id) continue;
    const push = pushFrom(self, other, space);
    if (push) {
      side = { x: side.x + push.x, z: side.z + push.z };
      crowd = Math.max(crowd, len(push));
    }
    if (self.priority < other.priority && headOn(self, other, space * 2.2)) {
      const r = rightOf(want);
      side = { x: side.x + r.x * 0.8, z: side.z + r.z * 0.8 };
    }
  }
  const blended = norm({ x: want.x + side.x * 1.4, z: want.z + side.z * 1.4 });
  // Never step backwards along the route: a push only bends the line, it does not reverse it.
  const forward =
    dot(blended, want) < 0
      ? norm({
          x: blended.x - want.x * dot(blended, want),
          z: blended.z - want.z * dot(blended, want)
        })
      : blended;
  const dir = len(forward) < 1e-6 ? want : forward;
  return { dir, pace: 1 - Math.min(0.6, crowd * 0.8) };
}

/**
 * Wait at a doorway when somebody else is in it. The one already inside goes first; between two who
 * are both outside it, the higher priority goes first. Returns the doorway to wait for, or null.
 */
export function shouldWaitAtDoor(self: Mover, others: readonly Mover[], doors: readonly Vec2[]): Vec2 | null {
  for (const door of doors) {
    const to = { x: door.x - self.pos.x, z: door.z - self.pos.z };
    const d = len(to);
    // Only a doorway ahead and close, that this walker is not already inside.
    if (d <= DOOR_RADIUS || d > DOOR_LOOKAHEAD || dot(self.dir, to) / d < 0.5) continue;
    const blocker = others.find((o) => {
      if (o.id === self.id || (o.dir.x === 0 && o.dir.z === 0)) return false;
      return Math.hypot(o.pos.x - door.x, o.pos.z - door.z) <= DOOR_RADIUS;
    });
    if (blocker) return door;
  }
  return null;
}

/**
 * Up to `n` spots on rings around `centre` (first ring at `radius`) that pass `walkable` and keep
 * personal space from every `taken` spot and from each other. Order is stable: nearest the `prefer`
 * point first, so arrivals fill the side nearest them.
 */
export function freeSlots(centre: Vec2, n: number, taken: readonly Vec2[], walkable: (p: Vec2) => boolean, radius = 0.9, prefer: Vec2 = centre): Vec2[] {
  const candidates: Vec2[] = [];
  for (let ring = 0; ring < 3; ring += 1) {
    const r = radius + ring * PERSONAL_SPACE;
    const count = 8 + ring * 4;
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2;
      candidates.push({
        x: centre.x + Math.cos(a) * r,
        z: centre.z + Math.sin(a) * r
      });
    }
  }
  const dist = (p: Vec2) => Math.hypot(p.x - prefer.x, p.z - prefer.z);
  candidates.sort((p, q) => dist(p) - dist(q));
  const chosen: Vec2[] = [];
  const clear = (p: Vec2) => [...taken, ...chosen].every((q) => Math.hypot(p.x - q.x, p.z - q.z) >= PERSONAL_SPACE);
  for (const p of candidates) {
    if (chosen.length >= n) break;
    if (walkable(p) && clear(p)) chosen.push(p);
  }
  return chosen;
}
