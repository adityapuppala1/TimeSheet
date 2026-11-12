/**
 * LOAD BALANCER wears a small balance scale on its head like a juggler's hat and holds a weight block in
 * each fist. The beam tips back and forth as it works; the weights are lifted alternately. It reads at a
 * glance (a horizontal bar with two pans above the skull) and says "this one evens things out".
 */
import * as THREE from "three";
import type { Mood } from "../../studio-model";
import type { Accessory, AccessoryContext, ArmTargets } from "./types";

/** Beam swing amplitude (radians) per mood. Off droops to one side and stays there. */
const SWING: Readonly<Record<Mood, number>> = { off: 0, idle: 0.1, working: 0.32, attention: 0.5, celebrating: 0 };
/** Resting tilt of the beam per mood. */
const REST_TILT: Readonly<Record<Mood, number>> = { off: 0.4, idle: 0, working: 0, attention: 0, celebrating: 0 };
const BEAM_HALF = 0.62;
const PAN_DROP = 0.3;

function buildBeam(ctx: AccessoryContext) {
  const { track } = ctx;
  const metal = track(new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.35, metalness: 0.5 }));
  const accent = track(new THREE.MeshStandardMaterial({ color: ctx.tint, roughness: 0.5 }));
  const root = new THREE.Group();
  root.position.set(0, 0.8, 0);
  const post = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 10)), metal);
  post.position.y = 0.15;
  root.add(post);
  const pivot = new THREE.Group();
  pivot.position.y = 0.34;
  root.add(pivot);
  pivot.add(new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.035, BEAM_HALF * 2, 8)), metal).rotateZ(Math.PI / 2));
  const hub = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 12, 10)), accent);
  pivot.add(hub);
  const panGeo = track(new THREE.CylinderGeometry(0.22, 0.17, 0.05, 20));
  const wireGeo = track(new THREE.CylinderGeometry(0.008, 0.008, PAN_DROP, 4));
  const hangs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const hang = new THREE.Group();
    hang.position.x = side * BEAM_HALF;
    const wire = new THREE.Mesh(wireGeo, metal);
    wire.position.y = -PAN_DROP / 2;
    const pan = new THREE.Mesh(panGeo, accent);
    pan.position.y = -PAN_DROP;
    hang.add(wire, pan);
    pivot.add(hang);
    hangs.push(hang);
  }
  return { root, pivot, hangs };
}

function buildWeights(ctx: AccessoryContext): THREE.Mesh[] {
  const { track } = ctx;
  const geo = track(new THREE.BoxGeometry(0.26, 0.2, 0.2));
  const colors = [0xf59e0b, 0x38bdf8];
  return [ctx.armL, ctx.armR].map((arm, i) => {
    const mat = track(new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.4, metalness: 0.2 }));
    const block = new THREE.Mesh(geo, mat);
    block.position.set(0, -0.72, 0.02);
    arm.add(block);
    return block;
  });
}

/** Arm pose per mood; alternating lift while working. */
function armPose(mood: Mood, s: number): ArmTargets | null {
  if (mood === "off") return { armLx: 0.1, armRx: 0.1, armLz: 0.1, armRz: -0.1 };
  if (mood === "celebrating") return { armLx: -2.6, armRx: -2.6, armLz: 0.5, armRz: -0.5 };
  const amp = mood === "working" ? 0.55 : 0.12;
  const wave = Math.sin(s * 2.6) * amp;
  return { armLx: -0.7 + wave, armRx: -0.7 - wave, armLz: 0.35, armRz: -0.35 };
}

export function balancerAccessory(ctx: AccessoryContext): Accessory {
  const { root, pivot, hangs } = buildBeam(ctx);
  ctx.neck.add(root);
  const weights = buildWeights(ctx);

  return {
    replacesBadge: true,
    update(mood, s) {
      const wobble = mood === "attention" ? Math.sin(s * 11) * 0.12 : 0;
      const tilt = REST_TILT[mood] + Math.sin(s * 2.6) * SWING[mood] + wobble;
      pivot.rotation.z = tilt;
      // Pans stay level however the beam tips.
      for (const hang of hangs) hang.rotation.z = -tilt;
      for (const w of weights) w.rotation.z = mood === "working" ? Math.sin(s * 5) * 0.1 : 0;
    },
    arms: (mood, s) => armPose(mood, s)
  };
}
