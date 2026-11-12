/**
 * SECURITY DESK wears a peaked guard cap (flat top, short brim, badge plate), straps a heraldic shield to
 * its left arm and holds a scanner wand in its right hand. Three props, three silhouettes: a flat-topped
 * hat, a big shield on the flank and a glowing stick — so it reads as "the guard" even at ~100px tall.
 *
 * The shield sits in a holder that COUNTER-ROTATES against the arm, so it stays upright and facing the
 * camera however the arm is posed; the wand tip pulses while it works. Everything is tracked for disposal.
 */
import * as THREE from "three";
import type { Mood } from "../../studio-model";
import type { Accessory, AccessoryContext, ArmTargets } from "./types";

const SHIELD_LIFT: Readonly<Record<Mood, number>> = { off: -0.12, idle: 0, working: 0.04, attention: 0.34, celebrating: -0.05 };
const WAND_GLOW: Readonly<Record<Mood, number>> = { off: 0, idle: 0.35, working: 1, attention: 0.6, celebrating: 1.3 };

const TIP_COLOUR: Readonly<Record<Mood, number>> = { off: 0x1e293b, idle: 0x4ade80, working: 0x4ade80, attention: 0xf87171, celebrating: 0x4ade80 };

function heraldicShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-0.3, 0.38);
  s.lineTo(0.3, 0.38);
  s.lineTo(0.3, 0.02);
  s.quadraticCurveTo(0.28, -0.3, 0, -0.5);
  s.quadraticCurveTo(-0.28, -0.3, -0.3, 0.02);
  s.closePath();
  return s;
}

function buildCap(ctx: AccessoryContext) {
  const { neck, track } = ctx;
  const capMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 }));
  const bandMat = track(new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4, metalness: 0.4 }));
  const crown = new THREE.Mesh(track(new THREE.CylinderGeometry(0.52, 0.56, 0.24, 24)), capMat);
  crown.position.set(0, 0.86, 0);
  const top = new THREE.Mesh(track(new THREE.CylinderGeometry(0.6, 0.52, 0.07, 24)), capMat);
  top.position.set(0, 1.0, 0.02);
  const band = new THREE.Mesh(track(new THREE.CylinderGeometry(0.565, 0.565, 0.05, 24)), bandMat);
  band.position.set(0, 0.76, 0);
  const brim = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 0.04, 0.3)), capMat);
  brim.position.set(0, 0.76, 0.6);
  brim.rotation.x = 0.12;
  const plate = new THREE.Mesh(track(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 6)), bandMat);
  plate.rotation.x = Math.PI / 2;
  plate.position.set(0, 0.9, 0.56);
  neck.add(crown, top, band, brim, plate);
}

function buildShield(ctx: AccessoryContext) {
  const { armL, track } = ctx;
  const holder = new THREE.Group();
  holder.position.set(0.1, -0.5, 0.22);
  const baseMat = track(new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.45, metalness: 0.3, emissive: 0x1d4ed8, emissiveIntensity: 0.15 }));
  const rimMat = track(new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.3, metalness: 0.6 }));
  const emblemMat = track(new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
  const geo = track(new THREE.ExtrudeGeometry(heraldicShape(), { depth: 0.07, bevelEnabled: false }));
  const plate = new THREE.Mesh(geo, baseMat);
  const rim = new THREE.Mesh(geo, rimMat);
  rim.scale.set(1.1, 1.08, 0.7);
  rim.position.set(0, 0.0, -0.02);
  // The emblem: a chevron built from two bars.
  const barGeo = track(new THREE.BoxGeometry(0.34, 0.09, 0.03));
  const left = new THREE.Mesh(barGeo, emblemMat);
  left.position.set(-0.1, 0.06, 0.09);
  left.rotation.z = 0.6;
  const right = new THREE.Mesh(barGeo, emblemMat);
  right.position.set(0.1, 0.06, 0.09);
  right.rotation.z = -0.6;
  const holderBack = new THREE.Group();
  holderBack.add(rim, plate, left, right);
  holderBack.scale.setScalar(1.05);
  holder.add(holderBack);
  armL.add(holder);
  return { holder, baseMat };
}

function buildWand(ctx: AccessoryContext) {
  const { armR, track } = ctx;
  const wand = new THREE.Group();
  wand.position.set(0, -0.55, 0);
  const handleMat = track(new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.5 }));
  const handle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.055, 0.6, 10)), handleMat);
  handle.position.y = -0.2;
  const head = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.2, 0.08)), handleMat);
  head.position.y = -0.55;
  const tipMat = track(new THREE.MeshBasicMaterial({ color: 0x4ade80 }));
  const tip = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 14, 10)), tipMat);
  tip.position.y = -0.72;
  const haloMat = track(new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  const halo = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 14, 10)), haloMat);
  halo.position.y = -0.72;
  wand.add(handle, head, tip, halo);
  armR.add(wand);
  return { tip, tipMat, halo, haloMat };
}

export function securityAccessory(ctx: AccessoryContext): Accessory {
  buildCap(ctx);
  const shield = buildShield(ctx);
  const wand = buildWand(ctx);
  const { armL } = ctx;

  return {
    replacesBadge: true,
    update(mood, s) {
      // Keep the shield upright whatever the arm does, and raise it to cover when the agent needs attention.
      shield.holder.rotation.x = -armL.rotation.x;
      shield.holder.position.y = -0.5 + SHIELD_LIFT[mood];
      const flash = mood === "attention" ? 0.5 + 0.5 * Math.sin(s * 10) : 0;
      shield.baseMat.emissiveIntensity = mood === "off" ? 0 : 0.15 + flash * 0.9;
      shield.baseMat.color.setHex(mood === "off" ? 0x334155 : 0x1d4ed8);
      const glow = WAND_GLOW[mood] * (0.75 + 0.25 * Math.sin(s * 8));
      wand.tipMat.color.setHex(TIP_COLOUR[mood]);
      wand.haloMat.color.copy(wand.tipMat.color);
      wand.haloMat.opacity = mood === "off" ? 0 : 0.18 + glow * 0.25;
      wand.halo.scale.setScalar(0.8 + glow * 0.5);
    },
    arms(mood, s): ArmTargets | null {
      if (mood === "off") return null;
      if (mood === "celebrating") return { armLx: -1.0, armRx: -2.7 + Math.sin(s * 9) * 0.2, armLz: 0.1, armRz: -0.35 };
      const sweep = mood === "working" ? Math.sin(s * 2.4) * 0.3 : Math.sin(s * 1.2) * 0.08;
      const left = mood === "attention" ? -1.9 : -1.0;
      return { armLx: left, armRx: -1.15 + sweep, armLz: 0.12, armRz: -0.12 };
    }
  };
}
