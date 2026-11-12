/**
 * REPORTER is dressed as a newsroom hand: a flat press cap with a PRESS card in the band, a spiral-bound
 * notepad in one hand, a fat pencil in the other that scribbles when it works, and a PRESS tag on a
 * lanyard. Four cheap silhouettes (flat cap, pad, pencil, tag) so it reads at ~100px tall and nobody
 * mistakes it for the hard-hatted or gauge-carrying agents.
 *
 * The props hang on the ARM pivots, but each hand group is counter-rotated by the arm's current swing
 * so a raised arm lifts the pad / pencil without tumbling it (the pad stays a readable page, not a
 * spinning card). Geometry and materials are shared across the small repeated parts.
 */
import * as THREE from "three";
import type { Mood } from "../../studio-model";
import type { Accessory, AccessoryContext, ArmTargets } from "./types";

/** Default (switched-off) arm swing the shared rig settles to, used until a mood pose is requested. */
const REST_ARM = 0.12;
const PAD_TILT = -0.38;
const PENCIL_TILT = -0.5;
const HAND_Y = -0.55;
const RULE_COUNT = 7;
const RING_COUNT = 6;

/** How hard the pencil scribbles, per mood. */
const SCRIBBLE: Readonly<Record<Mood, number>> = { off: 0, idle: 0.25, working: 1, attention: 0.1, celebrating: 0 };

interface Pose {
  armLx: number;
  armRx: number;
  armLz: number;
  armRz: number;
}

const REST_POSE: Pose = { armLx: REST_ARM, armRx: REST_ARM, armLz: 0.08, armRz: -0.08 };

/** The arm pose for a mood; a lookup of small builders keeps the branching out of one function. */
const POSES: Readonly<Record<Exclude<Mood, "off">, (s: number) => Pose>> = {
  idle: (s) => ({ armLx: -1.05, armRx: -0.95 + Math.sin(s * 2.4) * 0.05, armLz: 0.12, armRz: -0.3 }),
  working: (s) => ({ armLx: -1.1, armRx: -0.95 + Math.sin(s * 11) * 0.07, armLz: 0.12, armRz: -0.32 + Math.cos(s * 7.5) * 0.09 }),
  // Pad held high like a front page.
  attention: (s) => ({ armLx: -2.2 + Math.sin(s * 4) * 0.05, armRx: -0.8, armLz: 0.2, armRz: -0.25 }),
  // Pad waved overhead.
  celebrating: (s) => ({ armLx: -2.7, armRx: -0.9, armLz: 0.5 + Math.sin(s * 8) * 0.3, armRz: -0.3 })
};

function pressTexture(track: AccessoryContext["track"]): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 80;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#f8fafc";
  g.fillRect(0, 0, 128, 80);
  g.fillStyle = "#dc2626";
  g.fillRect(0, 0, 128, 26);
  g.fillStyle = "#0f172a";
  g.font = "bold 34px sans-serif";
  g.textAlign = "center";
  g.fillText("PRESS", 64, 66);
  const tex = track(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildCap(ctx: AccessoryContext, cardMat: THREE.Material): void {
  const { track, neck } = ctx;
  const capMat = track(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85 }));
  const bandMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 }));
  const cap = new THREE.Group();
  cap.position.set(0, 0.74, -0.02);
  cap.rotation.z = -0.06;
  const crown = new THREE.Mesh(track(new THREE.SphereGeometry(0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), capMat);
  crown.scale.set(1.08, 0.62, 0.95);
  const band = new THREE.Mesh(track(new THREE.CylinderGeometry(0.54, 0.55, 0.1, 28)), bandMat);
  band.scale.z = 0.95;
  band.position.y = 0.03;
  const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(0.4, 0.4, 0.035, 20, 1, false, -Math.PI / 2, Math.PI)), bandMat);
  brim.scale.set(1.15, 1, 0.9);
  brim.position.set(0, 0.0, 0.3);
  brim.rotation.x = 0.16;
  const button = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 10, 8)), bandMat);
  button.position.y = 0.32;
  const card = new THREE.Mesh(track(new THREE.PlaneGeometry(0.24, 0.15)), cardMat);
  card.position.set(0.4, 0.08, 0.36);
  card.rotation.set(-0.15, 0.62, 0.12);
  cap.add(crown, band, brim, button, card);
  neck.add(cap);
}

function buildPad(ctx: AccessoryContext): THREE.Group {
  const { track } = ctx;
  const pad = new THREE.Group();
  const cover = new THREE.Mesh(track(new THREE.BoxGeometry(0.38, 0.5, 0.03)), track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 })));
  const pages = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.45, 0.03)), track(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.9 })));
  pages.position.z = 0.025;
  pad.add(cover, pages);
  const ruleGeo = track(new THREE.BoxGeometry(0.26, 0.012, 0.004));
  const ruleMat = track(new THREE.MeshBasicMaterial({ color: 0x64748b }));
  for (let i = 0; i < RULE_COUNT; i += 1) {
    const rule = new THREE.Mesh(ruleGeo, ruleMat);
    rule.position.set(0.02, 0.15 - i * 0.055, 0.043);
    pad.add(rule);
  }
  const margin = new THREE.Mesh(track(new THREE.BoxGeometry(0.008, 0.44, 0.004)), track(new THREE.MeshBasicMaterial({ color: 0xef4444 })));
  margin.position.set(-0.1, 0, 0.043);
  const ringGeo = track(new THREE.SphereGeometry(0.026, 8, 6));
  const ringMat = track(new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.7, roughness: 0.3 }));
  for (let i = 0; i < RING_COUNT; i += 1) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(-0.14 + i * 0.056, 0.245, 0.03);
    pad.add(ring);
  }
  pad.add(margin);
  return pad;
}

function buildPencil(ctx: AccessoryContext): THREE.Group {
  const { track } = ctx;
  const pencil = new THREE.Group();
  const body = new THREE.Mesh(track(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6)), track(new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.55 })));
  const wood = new THREE.Mesh(track(new THREE.ConeGeometry(0.04, 0.12, 6)), track(new THREE.MeshStandardMaterial({ color: 0xe9c79a, roughness: 0.8 })));
  wood.rotation.x = Math.PI;
  wood.position.y = -0.36;
  const lead = new THREE.Mesh(track(new THREE.ConeGeometry(0.014, 0.04, 6)), track(new THREE.MeshBasicMaterial({ color: 0x0f172a })));
  lead.rotation.x = Math.PI;
  lead.position.y = -0.43;
  const eraser = new THREE.Mesh(track(new THREE.CylinderGeometry(0.042, 0.042, 0.08, 8)), track(new THREE.MeshStandardMaterial({ color: 0xf472b6, roughness: 0.7 })));
  eraser.position.y = 0.34;
  pencil.add(body, wood, lead, eraser);
  pencil.position.set(0, 0.06, 0.02);
  return pencil;
}

function buildTag(ctx: AccessoryContext, cardMat: THREE.Material): void {
  const { track, rig } = ctx;
  const strapMat = track(new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }));
  const strapGeo = track(new THREE.BoxGeometry(0.035, 0.56, 0.01));
  for (const side of [-1, 1]) {
    const strap = new THREE.Mesh(strapGeo, strapMat);
    strap.position.set(side * 0.1, 1.09, 0.325);
    strap.rotation.z = side * 0.38;
    rig.add(strap);
  }
  const tag = new THREE.Mesh(track(new THREE.PlaneGeometry(0.26, 0.16)), cardMat);
  tag.position.set(0, 0.8, 0.335);
  rig.add(tag);
}

export function reporterAccessory(ctx: AccessoryContext): Accessory {
  const { armL, armR, track } = ctx;
  const tex = pressTexture(track);
  const cardMat = track(new THREE.MeshBasicMaterial(tex ? { map: tex, side: THREE.DoubleSide } : { color: 0xf8fafc, side: THREE.DoubleSide }));
  buildCap(ctx, cardMat);
  buildTag(ctx, cardMat);

  const padHand = new THREE.Group();
  padHand.position.set(0, HAND_Y, 0);
  const pad = buildPad(ctx);
  pad.position.set(0, 0.17, 0.05);
  padHand.add(pad);
  armL.add(padHand);

  const penHand = new THREE.Group();
  penHand.position.set(0, HAND_Y, 0);
  const pencil = buildPencil(ctx);
  penHand.add(pencil);
  armR.add(penHand);

  // The swing each arm is being asked for (eased here) so the hand groups can cancel it out.
  let wantL = REST_ARM;
  let wantR = REST_ARM;
  let angleL = REST_ARM;
  let angleR = REST_ARM;

  return {
    replacesBadge: true,
    update(mood, s) {
      angleL += (wantL - angleL) * 0.15;
      angleR += (wantR - angleR) * 0.15;
      padHand.rotation.x = -angleL + PAD_TILT;
      penHand.rotation.x = -angleR + PENCIL_TILT;
      const scribble = SCRIBBLE[mood];
      penHand.rotation.z = 0.5 + Math.sin(s * 23) * 0.07 * scribble;
      pencil.position.x = Math.sin(s * 31) * 0.012 * scribble;
    },
    arms(mood, s): ArmTargets | null {
      const pose = mood === "off" ? REST_POSE : POSES[mood](s);
      wantL = pose.armLx;
      wantR = pose.armRx;
      return mood === "off" ? null : pose;
    }
  };
}
