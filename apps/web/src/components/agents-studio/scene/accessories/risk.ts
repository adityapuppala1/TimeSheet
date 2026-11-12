/**
 * RISK WATCH is the lookout: big amber goggle rings over the visor, a radar dish for each ear and a
 * magnifying glass in the right hand. It is the silhouette that says "this one watches a number and looks
 * closely at why it moved", and it stays readable when the character is only ~100px tall because every
 * piece is a thick ring or a wide dish rather than fine detail.
 *
 * The goggles and dishes hang off the head pivot so they turn with the head; the lens hangs off the
 * shoulder pivot so it sweeps with the arm. Dishes scan independently when on duty, snap toward the
 * viewer when the agent needs a look, and droop when it is switched off. Everything is built once from
 * shared geometry and tracked, so the character disposes it all.
 */
import * as THREE from "three";
import type { Mood } from "../../studio-model";
import type { Accessory, AccessoryContext, ArmTargets } from "./types";

const RIM = 0xf59e0b;
const GLASS = 0x67e8f9;

/** How fast the dishes scan, per mood. */
const SCAN_SPEED: Readonly<Record<Mood, number>> = { off: 0, idle: 0.7, working: 2.2, attention: 0, celebrating: 1.2 };
/** How far the dishes droop (radians), per mood. */
const DROOP: Readonly<Record<Mood, number>> = { off: 1.1, idle: 0, working: 0, attention: 0, celebrating: 0 };
/** How hard the lens shakes, per mood. */
const SHAKE: Readonly<Record<Mood, number>> = { off: 0, idle: 0, working: 0.04, attention: 0.2, celebrating: 0 };

interface Dish {
  pivot: THREE.Group;
  side: number;
  yaw: number;
  droop: number;
}

function buildGoggles(ctx: AccessoryContext, rim: THREE.Material, glass: THREE.Material) {
  const ringGeo = ctx.track(new THREE.TorusGeometry(0.17, 0.04, 10, 28));
  const glassGeo = ctx.track(new THREE.CircleGeometry(0.15, 24));
  for (const side of [-1, 1]) {
    const ring = new THREE.Mesh(ringGeo, rim);
    ring.position.set(side * 0.21, 0.42, 0.45);
    const disc = new THREE.Mesh(glassGeo, glass);
    disc.position.set(side * 0.21, 0.42, 0.455);
    ctx.neck.add(ring, disc);
  }
  const bridge = new THREE.Mesh(ctx.track(new THREE.BoxGeometry(0.1, 0.045, 0.045)), rim);
  bridge.position.set(0, 0.42, 0.45);
  ctx.neck.add(bridge);
}

function buildDishes(ctx: AccessoryContext, rim: THREE.Material, dishMat: THREE.Material): Dish[] {
  const dishGeo = ctx.track(new THREE.SphereGeometry(0.36, 20, 8, 0, Math.PI * 2, 0, 1.05));
  const spikeGeo = ctx.track(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6));
  const edgeGeo = ctx.track(new THREE.TorusGeometry(0.31, 0.022, 6, 28));
  const tipGeo = ctx.track(new THREE.SphereGeometry(0.03, 8, 6));
  return [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.7, 0.42, 0);
    // The cap's pole faces the head, so the open face looks outward.
    const dish = new THREE.Mesh(dishGeo, dishMat);
    dish.rotation.z = side * (Math.PI / 2);
    const spike = new THREE.Mesh(spikeGeo, rim);
    spike.rotation.z = Math.PI / 2;
    spike.position.set(side * 0.17, 0, 0);
    const tip = new THREE.Mesh(tipGeo, rim);
    tip.position.set(side * 0.3, 0, 0);
    const edge = new THREE.Mesh(edgeGeo, rim);
    edge.position.y = 0.178;
    edge.rotation.x = Math.PI / 2;
    dish.add(edge);
    pivot.add(dish, spike, tip);
    ctx.neck.add(pivot);
    return { pivot, side, yaw: 0, droop: 0 };
  });
}

function buildLens(ctx: AccessoryContext, rim: THREE.Material, glass: THREE.Material, handleMat: THREE.Material) {
  const lens = new THREE.Group();
  lens.position.set(0, -0.55, 0.04);
  const handle = new THREE.Mesh(ctx.track(new THREE.CylinderGeometry(0.035, 0.035, 0.34, 8)), handleMat);
  handle.position.y = -0.15;
  const head = new THREE.Group();
  head.position.y = -0.32;
  head.rotation.x = 1.0;
  const ring = new THREE.Mesh(ctx.track(new THREE.TorusGeometry(0.22, 0.045, 10, 28)), rim);
  ring.position.y = -0.22;
  const disc = new THREE.Mesh(ctx.track(new THREE.CircleGeometry(0.2, 24)), glass);
  disc.position.y = -0.22;
  head.add(ring, disc);
  lens.add(handle, head);
  ctx.armR.add(lens);
  return lens;
}

/** Dishes ease toward the pose their mood asks for: scanning, facing the viewer, or drooping. */
function stepDish(dish: Dish, mood: Mood, s: number) {
  const scan = Math.sin(s * SCAN_SPEED[mood] + dish.side * 1.7) * 0.55;
  const snap = mood === "attention" ? -dish.side * 1.1 : scan;
  dish.yaw += (snap - dish.yaw) * 0.15;
  dish.droop += (DROOP[mood] - dish.droop) * 0.1;
  dish.pivot.rotation.y = dish.yaw;
  dish.pivot.rotation.z = -dish.side * dish.droop;
}

export function riskAccessory(ctx: AccessoryContext): Accessory {
  const { track } = ctx;
  const rim = track(new THREE.MeshStandardMaterial({ color: RIM, roughness: 0.4, metalness: 0.3 }));
  const glass = track(new THREE.MeshBasicMaterial({ color: GLASS, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  const dishMat = track(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.45, metalness: 0.25, side: THREE.DoubleSide }));
  const handleMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 }));

  buildGoggles(ctx, rim, glass);
  const dishes = buildDishes(ctx, rim, dishMat);
  const lens = buildLens(ctx, rim, glass, handleMat);

  return {
    replacesBadge: true,
    update(mood, s) {
      for (const dish of dishes) stepDish(dish, mood, s);
      lens.rotation.z = Math.sin(s * 14) * SHAKE[mood];
    },
    // Right hand holds the lens forward and sweeping; raised high to celebrate; left rests.
    arms(mood, s): ArmTargets | null {
      if (mood === "off") return null;
      if (mood === "celebrating") return { armRx: -2.6, armRz: -0.2 };
      const sweep = mood === "working" ? Math.sin(s * 2.4) * 0.35 : Math.sin(s * 0.8) * 0.08;
      return { armRx: -1.15, armRz: -0.2 + sweep, armLx: 0.05, armLz: 0.1 };
    }
  };
}
