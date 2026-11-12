/**
 * TRIAGE carries an inbox tray in both hands: a dark tray with a few papers that slides and tilts as it
 * sorts. It is the prop that says "this one files what arrives".
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Mood } from "../../studio-model";
import type { Accessory, AccessoryContext, ArmTargets } from "./types";

/** How much the held tray sloshes, per mood. */
const TRAY_SORT: Readonly<Record<Mood, number>> = { off: 0, idle: 0.15, working: 1, attention: 0.3, celebrating: 0 };

export function triageAccessory(ctx: AccessoryContext): Accessory {
  const { rig, track } = ctx;
  const tray = new THREE.Group();
  tray.position.set(0, 0.97, 0.56);
  const trayMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5 }));
  tray.add(new THREE.Mesh(track(new RoundedBoxGeometry(1.1, 0.06, 0.55, 3, 0.03)), trayMat));
  const paperMat = track(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.8 }));
  const paperGeo = track(new THREE.BoxGeometry(0.32, 0.012, 0.24));
  for (let i = 0; i < 4; i += 1) {
    const paper = new THREE.Mesh(paperGeo, paperMat);
    paper.position.set(-0.22 + i * 0.015, 0.04 + i * 0.012, 0.02 - i * 0.01);
    paper.rotation.y = (i - 1.5) * 0.12;
    tray.add(paper);
  }
  rig.add(tray);

  return {
    replacesBadge: true,
    update(mood, s) {
      const sort = TRAY_SORT[mood];
      tray.rotation.z = Math.sin(s * 3.1) * 0.13 * sort;
      tray.rotation.x = Math.sin(s * 2.3 + 1) * 0.05 * sort;
      tray.visible = mood !== "off" && mood !== "celebrating";
    },
    // Held in both hands, forward and level; only a tremor of work shows in the arms.
    arms(mood, s): ArmTargets | null {
      if (mood !== "idle" && mood !== "working" && mood !== "attention") return null;
      const tremor = mood === "working" ? Math.sin(s * 9) * 0.04 : 0;
      return { armLx: -1.25 + tremor, armRx: -1.25 - tremor, armLz: 0.06, armRz: -0.06 };
    }
  };
}
