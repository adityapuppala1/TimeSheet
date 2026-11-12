/**
 * PLANNER wears a safety-yellow hard hat (with a headlamp that glints) and carries a rolled blueprint
 * in its right hand while the left arm points at the board. A hard hat is the one silhouette that says
 * "site foreman" even at ~100px tall, and it says it from the head, which is where the eye lands first,
 * so it identifies the agent on its own and replaces the floating emoji badge.
 *
 * The hat hangs off the neck pivot so it turns and nods with the head; the roll hangs off the rig so it
 * bobs with the body. Geometry is shared between parts (one dome, one cylinder) and scaled, so the whole
 * accessory is a handful of meshes.
 */
import * as THREE from "three";
import type { Mood } from "../../studio-model";
import type { Accessory, AccessoryContext, ArmTargets } from "./types";

const HAT = 0xfbbf24;
const HAT_DARK = 0xf59e0b;
const PAPER = 0xe0f2fe;

/** How lively the pointing arm is, per mood. */
const POINT: Readonly<Record<Mood, number>> = { off: 0, idle: 0.35, working: 1, attention: 0.6, celebrating: 0 };

function buildHat(ctx: AccessoryContext) {
  const { neck, track } = ctx;
  const hat = new THREE.Group();
  hat.position.y = 0.66;
  const shell = track(new THREE.MeshStandardMaterial({ color: HAT, roughness: 0.35, metalness: 0.05 }));
  const rim = track(new THREE.MeshStandardMaterial({ color: HAT_DARK, roughness: 0.5 }));

  const dome = new THREE.Mesh(track(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2)), shell);
  dome.scale.set(0.58, 0.42, 0.5);
  const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(1, 1, 1, 32)), rim);
  brim.scale.set(0.66, 0.04, 0.62);
  brim.position.set(0, 0.01, 0.07);
  // The raised ridge that runs front to back over the crown.
  const ridge = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.05, 0.84)), rim);
  ridge.position.set(0, 0.4, 0);
  ridge.scale.set(1, 1, 0.9);
  hat.add(dome, brim, ridge);

  const lampMat = track(new THREE.MeshBasicMaterial({ color: 0xfef9c3 }));
  const lamp = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.1, 0.1, 16)), rim);
  lamp.rotation.x = Math.PI / 2;
  lamp.position.set(0, 0.2, 0.5);
  const lens = new THREE.Mesh(track(new THREE.CircleGeometry(0.065, 16)), lampMat);
  lens.position.set(0, 0.2, 0.56);
  hat.add(lamp, lens);
  neck.add(hat);
  return { hat, lampMat };
}

function buildRoll(ctx: AccessoryContext) {
  const { rig, track } = ctx;
  const roll = new THREE.Group();
  roll.position.set(0.55, 0.95, 0.6);
  roll.rotation.set(0.15, 0.2, 0.95);
  const paperMat = track(new THREE.MeshStandardMaterial({ color: PAPER, roughness: 0.85 }));
  const capMat = track(new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.5 }));
  const lineMat = track(new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
  const tube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 20)), paperMat);
  const capGeo = track(new THREE.CylinderGeometry(0.108, 0.108, 0.07, 20));
  const capA = new THREE.Mesh(capGeo, capMat);
  capA.position.y = 0.46;
  const capB = new THREE.Mesh(capGeo, capMat);
  capB.position.y = -0.46;
  // A blueprint rule line and a grid tick, so it reads as a drawing rather than a plain tube.
  const ruleGeo = track(new THREE.CylinderGeometry(0.103, 0.103, 0.014, 20, 1, true));
  const ruleA = new THREE.Mesh(ruleGeo, lineMat);
  ruleA.position.y = 0.2;
  const ruleB = new THREE.Mesh(ruleGeo, lineMat);
  ruleB.position.y = -0.12;
  roll.add(tube, capA, capB, ruleA, ruleB);
  rig.add(roll);
  return roll;
}

export function plannerAccessory(ctx: AccessoryContext): Accessory {
  const { hat, lampMat } = buildHat(ctx);
  const roll = buildRoll(ctx);
  const lampOn = new THREE.Color(0xfef9c3);
  const lampOff = new THREE.Color(0x64748b);

  return {
    replacesBadge: true,
    update(mood, s) {
      // Off: the lamp goes dark and the roll rests; celebrating: the hat tips and the roll is raised.
      lampMat.color.copy(mood === "off" ? lampOff : lampOn).multiplyScalar(mood === "off" ? 1 : 0.85 + Math.sin(s * 3) * 0.15);
      hat.rotation.x = mood === "celebrating" ? -0.28 + Math.sin(s * 6) * 0.05 : 0;
      hat.position.z = mood === "celebrating" ? 0.04 : 0;
      const sway = mood === "off" ? 0 : Math.sin(s * 1.6) * 0.04;
      roll.rotation.z = (mood === "celebrating" ? 0.35 : 0.95) + sway;
      roll.position.y = mood === "celebrating" ? 1.45 : 0.98;
    },
    arms(mood, s): ArmTargets | null {
      if (mood === "off") return null;
      const point = POINT[mood];
      if (mood === "celebrating") return { armRx: -2.4, armLx: -1.2, armLz: 0.3, armRz: -0.1 };
      // Right arm holds the roll out in front; left arm swings out to the board on the right.
      return { armRx: -1.15 + Math.sin(s * 1.6) * 0.04, armRz: -0.12, armLx: -1.35 + Math.sin(s * 2.4) * 0.12 * point, armLz: -0.5 - point * 0.15 };
    }
  };
}
