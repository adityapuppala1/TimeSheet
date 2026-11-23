/**
 * WHAT: the office the agents work in, drawn from the floor plan in office-model.ts — the same
 * rectangles the nav grid and the physics world use, so what you see is exactly what blocks a walker.
 * Floor with tinted, labelled rooms; cut-away walls (tall at the back, low at the front so the camera
 * sees in); eight desks each with a laptop and chair; the meeting table with its wall screen; the
 * kitchen counter and coffee machine; plants; the paper bin.
 *
 * A LAPTOP SCREEN IS A STATE LIGHT: it glows only while its owner is sitting at it, so an empty,
 * dark desk reads as "this agent is away or busy elsewhere" at a glance.
 *
 * Geometries and materials are shared across identical pieces and all tracked for disposal.
 */
import * as THREE from "three";
import {
  BIN,
  COFFEE_COUNTER,
  DECOR,
  DESKS,
  FLOOR,
  MEETING_SEATS,
  MEETING_TABLE,
  ROOMS,
  WALL_HIGH,
  WALLS,
  type Rect
} from "../office-model";
import type { StudioTheme } from "../../agents-studio/scene/types";

export interface Building {
  group: THREE.Group;
  /** Light or dim desk `index`'s laptop. */
  setLaptop(index: number, on: boolean): void;
  setTheme(theme: StudioTheme): void;
  dispose(): void;
}

const ROOM_TINT: Readonly<Record<string, string>> = {
  meeting: "#a5b4fc",
  planning: "#7dd3fc",
  risk: "#c4b5fd",
  security: "#94a3b8",
  kitchen: "#fdba74",
  triage: "#bef264",
  capacity: "#fcd34d",
  press: "#f9a8d4"
};

/** One room on the floor texture: a soft tint and its name. */
function paintRoom(ctx: CanvasRenderingContext2D, room: (typeof ROOMS)[number], scale: number, dark: boolean) {
  const { x, z, w, d } = room.area;
  const px = (x - w / 2 + FLOOR.w / 2) * scale;
  const pz = (z - d / 2 + FLOOR.d / 2) * scale;
  ctx.globalAlpha = dark ? 0.16 : 0.3;
  ctx.fillStyle = ROOM_TINT[room.id] ?? "#cbd5e1";
  ctx.fillRect(px + 6, pz + 6, w * scale - 12, d * scale - 12);
  ctx.globalAlpha = 1;
  ctx.fillStyle = dark ? "rgba(226,232,240,0.7)" : "rgba(30,41,59,0.6)";
  ctx.font = '700 22px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(room.label.toUpperCase(), px + 18, pz + d * scale - 20);
}

/** The floor as one texture: base colour, a soft tint per room, and each room's name painted on it. */
function floorTexture(theme: StudioTheme): THREE.CanvasTexture {
  const scale = 48;
  const canvas = document.createElement("canvas");
  canvas.width = FLOOR.w * scale;
  canvas.height = FLOOR.d * scale;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const dark = theme === "dark";
    ctx.fillStyle = dark ? "#1e293b" : "#e8edf3";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Carpet tiles.
    ctx.strokeStyle = dark ? "rgba(148,163,184,0.08)" : "rgba(100,116,139,0.10)";
    for (let x = 0; x <= FLOOR.w; x += 1) ctx.strokeRect(x * scale, 0, 0.5, canvas.height);
    for (let z = 0; z <= FLOOR.d; z += 1) ctx.strokeRect(0, z * scale, canvas.width, 0.5);
    for (const room of ROOMS) paintRoom(ctx, room, scale, dark);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function buildOffice(theme: StudioTheme): Building {
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };
  const group = new THREE.Group();
  const unit = track(new THREE.BoxGeometry(1, 1, 1));
  const std = (color: number, roughness = 0.7) => track(new THREE.MeshStandardMaterial({ color, roughness }));

  /** A box sized and placed by a floor rectangle, sitting on the ground (or lifted to `y0`). */
  const box = (r: Rect, material: THREE.Material, y0 = 0, cast = true): THREE.Mesh => {
    const mesh = new THREE.Mesh(unit, material);
    mesh.scale.set(r.w, r.h, r.d);
    mesh.position.set(r.x, y0 + r.h / 2, r.z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // ---- floor -------------------------------------------------------------------------------------
  let floorTex = track(floorTexture(theme));
  const floorMat = track(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }));
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(FLOOR.w, FLOOR.d)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);
  // The doorstep outside.
  const stepMat = std(0x94a3b8, 0.9);
  box({ x: 0, z: FLOOR.d / 2 + 1.2, w: 2.4, d: 2.4, h: 0.02 }, stepMat, 0, false);

  // ---- walls -------------------------------------------------------------------------------------
  const wallMat = std(0xf1f5f9, 0.85);
  const glassMat = track(new THREE.MeshStandardMaterial({ color: 0xbae6fd, roughness: 0.2, transparent: true, opacity: 0.32 }));
  const capMat = std(0x64748b, 0.6);
  for (const w of WALLS) {
    const tall = w.h >= WALL_HIGH;
    box(w, tall ? wallMat : glassMat, 0, tall);
    if (!tall && w.h > 0.6) box({ ...w, h: 0.05, w: w.w + 0.02, d: w.d + 0.02 }, capMat, w.h, false);
  }

  // ---- desks, laptops, chairs -------------------------------------------------------------------
  const deskMat = std(0xe2c9a3, 0.6);
  const legMat = std(0x475569, 0.5);
  const chairMat = std(0x334155, 0.7);
  const laptopMat = std(0x1e293b, 0.4);
  const screenOff = 0x0f172a;
  const screens: THREE.MeshStandardMaterial[] = [];
  const chair = (x: number, z: number, heading: number) => {
    const c = new THREE.Group();
    const seat = new THREE.Mesh(unit, chairMat);
    seat.scale.set(0.46, 0.07, 0.46);
    seat.position.y = 0.43;
    const back = new THREE.Mesh(unit, chairMat);
    back.scale.set(0.46, 0.5, 0.06);
    back.position.set(0, 0.72, -0.22);
    const post = new THREE.Mesh(unit, legMat);
    post.scale.set(0.07, 0.4, 0.07);
    post.position.y = 0.2;
    c.add(seat, back, post);
    c.traverse((m) => {
      m.castShadow = true;
    });
    c.position.set(x, 0, z);
    c.rotation.y = heading;
    group.add(c);
  };
  for (const d of DESKS) {
    box({ ...d.desk, h: 0.05 }, deskMat, d.desk.h - 0.05);
    for (const sx of [-1, 1]) box({ x: d.desk.x + sx * (d.desk.w / 2 - 0.08), z: d.desk.z, w: 0.06, d: d.desk.d - 0.1, h: d.desk.h - 0.05 }, legMat);
    // Laptop: base on the desk, screen hinged up and facing the person in the chair.
    box({ x: d.desk.x, z: d.desk.z - 0.08, w: 0.42, d: 0.28, h: 0.02 }, laptopMat, d.desk.h, false);
    const screenMat = track(new THREE.MeshStandardMaterial({ color: screenOff, emissive: 0x38bdf8, emissiveIntensity: 0, roughness: 0.3 }));
    screens.push(screenMat);
    const lid = new THREE.Mesh(unit, laptopMat);
    lid.scale.set(0.42, 0.28, 0.02);
    lid.position.set(d.desk.x, d.desk.h + 0.15, d.desk.z + 0.07);
    lid.rotation.x = 0.22;
    const glow = new THREE.Mesh(unit, screenMat);
    glow.scale.set(0.38, 0.24, 0.005);
    glow.position.set(d.desk.x, d.desk.h + 0.15, d.desk.z + 0.055);
    glow.rotation.x = 0.22;
    group.add(lid, glow);
    chair(d.seat.x, d.seat.z, d.heading);
  }

  // ---- meeting room -----------------------------------------------------------------------------
  box({ ...MEETING_TABLE, h: 0.06 }, std(0xf8fafc, 0.4), MEETING_TABLE.h - 0.06);
  box({ x: MEETING_TABLE.x, z: MEETING_TABLE.z, w: 0.5, d: 0.5, h: MEETING_TABLE.h - 0.06 }, legMat);
  for (const s of MEETING_SEATS) chair(s.seat.x, s.seat.z, s.heading);
  const wallScreen = track(new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: 0x6366f1, emissiveIntensity: 0.35 }));
  box({ x: MEETING_TABLE.x, z: -FLOOR.d / 2 + 0.12, w: 2.6, d: 0.06, h: 1.3 }, wallScreen, 1.0, false);

  // ---- kitchen ----------------------------------------------------------------------------------
  box(COFFEE_COUNTER, std(0xfafafa, 0.5));
  box({ x: COFFEE_COUNTER.x, z: COFFEE_COUNTER.z, w: 0.4, d: 0.45, h: 0.5 }, std(0x1f2937, 0.4), COFFEE_COUNTER.h);
  box({ x: COFFEE_COUNTER.x + 0.12, z: COFFEE_COUNTER.z, w: 0.08, d: 0.2, h: 0.08 }, std(0xef4444, 0.4), COFFEE_COUNTER.h + 0.3, false);

  // ---- plants and the bin -----------------------------------------------------------------------
  const potMat = std(0x9a6b4f, 0.8);
  const leafMat = std(0x22c55e, 0.8);
  const leafGeo = track(new THREE.IcosahedronGeometry(0.42, 0));
  for (const p of DECOR) {
    box({ x: p.x, z: p.z, w: 0.36, d: 0.36, h: 0.4 }, potMat);
    const leaves = new THREE.Mesh(leafGeo, leafMat);
    leaves.position.set(p.x, 0.85, p.z);
    leaves.scale.set(1, 1.3, 1);
    leaves.castShadow = true;
    group.add(leaves);
  }
  const binMat = std(0x64748b, 0.6);
  for (const [dx, dz, w, d] of [
    [0.2, 0, 0.03, 0.43],
    [-0.2, 0, 0.03, 0.43],
    [0, 0.2, 0.43, 0.03],
    [0, -0.2, 0.43, 0.03]
  ] as const) {
    box({ x: BIN.x + dx, z: BIN.z + dz, w, d, h: 0.44 }, binMat);
  }

  return {
    group,
    setLaptop(index, on) {
      const screen = screens[index];
      if (!screen) return;
      screen.emissiveIntensity = on ? 0.9 : 0;
      screen.color.setHex(on ? 0x0ea5e9 : screenOff);
    },
    setTheme(next) {
      floorTex.dispose();
      floorTex = track(floorTexture(next));
      floorMat.map = floorTex;
      floorMat.needsUpdate = true;
      wallMat.color.setHex(next === "dark" ? 0x334155 : 0xf1f5f9);
    },
    dispose() {
      for (const item of disposables) item.dispose();
    }
  };
}
