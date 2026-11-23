/**
 * WHAT: the office's rigid-body world (Rapier, WebAssembly) — the part that makes the room physical.
 *   - Walls and furniture are FIXED colliders built from the same rectangles the nav grid routes around.
 *   - Each person is a KINEMATIC capsule moved through a character controller: a step is requested and
 *     the controller returns how far the body can really go, sliding along desks and around colleagues.
 *     It also pushes whatever loose it walks into, with real impulses.
 *   - Loose things — stress balls, boxes, crumpled paper — are DYNAMIC bodies with gravity, friction and
 *     bounce. A finished run tosses a paper ball at the bin on a real ballistic arc; a click flicks a prop.
 *
 * WHY PATHFINDING IS NOT DONE HERE: A* over the nav grid (office-model.ts) plans the route; this only
 * resolves each step against what is actually in the way, including things that moved since.
 *
 * `ghost` on a move ignores other people (never the building): two agents meeting head-on in a doorway
 * would otherwise deadlock, so the engine lets a stuck walker slip past for a moment.
 *
 * Loaded only through the office engine's dynamic import; ~1.5 MB of wasm that no other page pays for.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { AGENT_RADIUS, BIN, FLOOR, type Rect, type Vec2 } from "../office-model";

const GROUP_WORLD = 0x0001;
const GROUP_PEOPLE = 0x0002;
/** Membership in the high 16 bits, what it collides with in the low 16. */
const groups = (member: number, filter: number) => (member << 16) | filter;
const PEOPLE_GROUPS = groups(GROUP_PEOPLE, GROUP_WORLD | GROUP_PEOPLE);
const GHOST_FILTER = groups(GROUP_PEOPLE, GROUP_WORLD);
const WORLD_GROUPS = groups(GROUP_WORLD, GROUP_WORLD | GROUP_PEOPLE);

const BODY_HALF = 0.55;
const BODY_Y = BODY_HALF + AGENT_RADIUS + 0.02;

/** "crate" is a queued run: a real stacked body per waiting run in a room (scene/activity-props.ts). */
export type PropKind = "ball" | "box" | "paper" | "crate";

export interface PropState {
  kind: PropKind;
  /** Written every step: position then quaternion, for the mesh to copy. */
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /** False while a pooled body is parked out of the simulation. */
  enabled: boolean;
}

export interface Physics {
  addPerson(id: string, at: Vec2): void;
  removePerson(id: string): void;
  /** Request a step; returns where the body actually ended up. */
  movePerson(id: string, dx: number, dz: number, ghost: boolean): Vec2;
  placePerson(id: string, at: Vec2): void;
  addProp(kind: PropKind, x: number, y: number, z: number): number;
  props(): readonly PropState[];
  /** Take a pooled prop out of the world, or drop it back in at a point (at rest). */
  parkProp(index: number): void;
  dropProp(index: number, x: number, y: number, z: number): void;
  /** Flick a prop: an impulse along (dx, dz) with some lift. */
  flick(index: number, dx: number, dz: number): void;
  /** Throw a paper ball from a hand toward the bin on a ballistic arc. */
  tossPaper(index: number, from: { x: number; y: number; z: number }): void;
  step(dt: number): void;
  dispose(): void;
}

const PROP_SHAPE: Readonly<Record<PropKind, { radius: number; density: number; bounce: number }>> = {
  ball: { radius: 0.11, density: 0.6, bounce: 0.72 },
  box: { radius: 0.17, density: 0.35, bounce: 0.15 },
  paper: { radius: 0.06, density: 0.12, bounce: 0.3 },
  crate: { radius: 0.15, density: 0.5, bounce: 0.05 }
};

export async function createPhysics(solid: readonly Rect[]): Promise<Physics> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  // The ground, wider than the floor so a prop knocked out of the door still lands on something.
  world.createCollider(RAPIER.ColliderDesc.cuboid(FLOOR.w, 0.1, FLOOR.d).setTranslation(0, -0.1, 0).setCollisionGroups(WORLD_GROUPS).setFriction(0.9));
  for (const r of solid) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(r.w / 2, Math.max(r.h, 0.3) / 2, r.d / 2)
        .setTranslation(r.x, Math.max(r.h, 0.3) / 2, r.z)
        .setCollisionGroups(WORLD_GROUPS)
    );
  }
  // The bin: four thin walls, open at the top, so paper really lands inside it.
  for (const [dx, dz, hw, hd] of [
    [0.2, 0, 0.015, 0.2],
    [-0.2, 0, 0.015, 0.2],
    [0, 0.2, 0.2, 0.015],
    [0, -0.2, 0.2, 0.015]
  ] as const) {
    world.createCollider(RAPIER.ColliderDesc.cuboid(hw, 0.22, hd).setTranslation(BIN.x + dx, 0.22, BIN.z + dz).setCollisionGroups(WORLD_GROUPS));
  }

  const controller = world.createCharacterController(0.02);
  controller.setApplyImpulsesToDynamicBodies(true);
  controller.setSlideEnabled(true);

  const people = new Map<string, { body: RAPIER.RigidBody; collider: RAPIER.Collider }>();
  const propBodies: RAPIER.RigidBody[] = [];
  const propStates: PropState[] = [];

  return {
    addPerson(id, at) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, BODY_Y, at.z));
      const collider = world.createCollider(RAPIER.ColliderDesc.capsule(BODY_HALF, AGENT_RADIUS).setCollisionGroups(PEOPLE_GROUPS), body);
      people.set(id, { body, collider });
    },
    removePerson(id) {
      const person = people.get(id);
      if (!person) return;
      world.removeRigidBody(person.body);
      people.delete(id);
    },
    movePerson(id, dx, dz, ghost) {
      const person = people.get(id);
      if (!person) return { x: 0, z: 0 };
      controller.computeColliderMovement(person.collider, { x: dx, y: 0, z: dz }, undefined, ghost ? GHOST_FILTER : undefined);
      const moved = controller.computedMovement();
      const at = person.body.translation();
      const next = { x: at.x + moved.x, y: BODY_Y, z: at.z + moved.z };
      person.body.setNextKinematicTranslation(next);
      return { x: next.x, z: next.z };
    },
    placePerson(id, at) {
      const person = people.get(id);
      if (!person) return;
      person.body.setTranslation({ x: at.x, y: BODY_Y, z: at.z }, true);
      person.body.setNextKinematicTranslation({ x: at.x, y: BODY_Y, z: at.z });
    },
    addProp(kind, x, y, z) {
      const shape = PROP_SHAPE[kind];
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(0.25).setAngularDamping(0.6).setCcdEnabled(kind === "paper"));
      const desc = kind === "box" || kind === "crate" ? RAPIER.ColliderDesc.cuboid(shape.radius, shape.radius, shape.radius) : RAPIER.ColliderDesc.ball(shape.radius);
      world.createCollider(desc.setDensity(shape.density).setRestitution(shape.bounce).setFriction(0.7), body);
      propBodies.push(body);
      propStates.push({ kind, position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, enabled: true });
      return propBodies.length - 1;
    },
    props: () => propStates,
    parkProp(index) {
      const body = propBodies[index];
      if (!body) return;
      body.setEnabled(false);
      propStates[index].enabled = false;
    },
    dropProp(index, x, y, z) {
      const body = propBodies[index];
      if (!body) return;
      body.setTranslation({ x, y, z }, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.setEnabled(true);
      propStates[index].enabled = true;
    },
    flick(index, dx, dz) {
      const body = propBodies[index];
      if (!body) return;
      const m = body.mass();
      body.applyImpulse({ x: dx * m * 3.2, y: m * 3.4, z: dz * m * 3.2 }, true);
      body.applyTorqueImpulse({ x: dz * m * 0.05, y: 0, z: -dx * m * 0.05 }, true);
    },
    tossPaper(index, from) {
      const body = propBodies[index];
      if (!body) return;
      // Projectile motion: pick a flight time, solve the launch velocity that lands in the bin's mouth.
      const T = 0.95;
      const vx = (BIN.x - from.x) / T;
      const vz = (BIN.z - from.z) / T;
      const vy = (0.5 - from.y) / T + 0.5 * 9.81 * T;
      body.setTranslation(from, true);
      body.setLinvel({ x: vx, y: vy, z: vz }, true);
      body.setAngvel({ x: 6, y: 3, z: 4 }, true);
    },
    step(dt) {
      world.timestep = Math.min(dt, 1 / 20);
      world.step();
      for (let i = 0; i < propBodies.length; i += 1) {
        if (!propStates[i].enabled) continue;
        const t = propBodies[i].translation();
        const r = propBodies[i].rotation();
        // Anything that escapes the world comes back onto the open floor.
        if (t.y < -3) propBodies[i].setTranslation({ x: 0, y: 1.2, z: 6 }, true);
        const state = propStates[i];
        state.position.x = t.x;
        state.position.y = t.y;
        state.position.z = t.z;
        state.rotation.x = r.x;
        state.rotation.y = r.y;
        state.rotation.z = r.z;
        state.rotation.w = r.w;
      }
    },
    dispose() {
      world.free();
    }
  };
}
