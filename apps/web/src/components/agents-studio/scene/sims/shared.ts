/**
 * Pieces every agent's simulated world is built from. A `Sim` is a three.js group plus an
 * `update(t, dt, intensity)` that animates it and a caption saying what it is illustrating.
 *
 * `intensity` (0 still, 1 flat out) is derived from the agent's REAL mood; everything that moves is a
 * seeded illustration of the agent's job, and the HUD tags every caption "Simulated". Seeded so the
 * same agent runs the same shift on every visit.
 *
 * Each archetype lives in its own file (triage.ts, planner.ts, ...) and is registered in index.ts.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";

export interface Sim {
  group: THREE.Group;
  /** `intensity` is 0 (still) to 1 (flat out), derived from the agent's real mood. */
  update(t: number, dt: number, intensity: number): void;
  /** What the simulation is illustrating right now, in a sentence. */
  caption(): string;
  dispose(): void;
}

/** A floating screen of scrolling "data" rows — drawn once into a tall texture and scrolled, so it
 *  costs one uniform per frame instead of a canvas redraw. */
export function makeScreen(accent: string, seed: number, track: <T extends { dispose(): void }>(x: T) => T) {
  const rand = mulberry32(seed);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, 256, 512);
    for (let y = 8; y < 512; y += 22) {
      ctx.fillStyle = "rgba(148,163,184,0.18)";
      ctx.fillRect(10, y, 14, 9);
      ctx.fillStyle = rand() > 0.82 ? accent : "rgba(226,232,240,0.55)";
      ctx.fillRect(32, y, 40 + rand() * 150, 9);
    }
  }
  const texture = track(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 0.5);
  const material = track(new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.92 }));
  const frameMat = track(new THREE.MeshBasicMaterial({ color: 0x1e293b }));
  const group = new THREE.Group();
  const frame = new THREE.Mesh(track(new THREE.PlaneGeometry(0.98, 0.62)), frameMat);
  frame.position.z = -0.005;
  const face = new THREE.Mesh(track(new THREE.PlaneGeometry(0.9, 0.54)), material);
  group.add(frame, face);
  return { group, scroll: (amount: number) => (texture.offset.y = (texture.offset.y + amount) % 1) };
}

export function disposer() {
  const items: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    items.push(item);
    return item;
  };
  return { track, disposeAll: () => items.forEach((i) => i.dispose()) };
}

