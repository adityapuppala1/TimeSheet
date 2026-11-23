/**
 * WHAT: the office the agents work in, drawn from the floor plan in office-model.ts — the same
 * rectangles the nav grid and the physics world use, so what you see is exactly what blocks a walker.
 *
 * ART DIRECTION: a light-oak plank floor for the open plan and a soft carpet tile in each room's tint
 * (room names printed on the carpet), with pools of warm "ceiling light" baked into the floor texture
 * over the desks — the depth cue a flat colour lacked, at zero runtime cost. Outer walls are painted
 * plaster with a skirting board, a top trim and a row of windows; glass partitions inside have slim
 * frames. All of it is procedural canvas or plain geometry: no downloaded textures.
 *
 * CUT-AWAY WALLS: a tall wall between the camera and the room hides the room, so an outer wall drops to
 * a low stub whenever the camera is on its outside (`update(camera)`), the way architectural
 * visualisations and life-sims do it. The back wall never drops — the camera cannot get behind it.
 *
 * A LAPTOP SCREEN IS A STATE LIGHT: lit only while its owner sits at it. The screen faces the person,
 * so the camera sees its back — the lid's logo lights up and a soft spill of screen light falls on the
 * desk and the sitter, which is what reads from the overview.
 *
 * DRAW CALLS: everything that never changes is merged per material once built (`mergeStatic`), so the
 * ~200 boxes of furniture cost a couple of dozen draw calls. Things that change (laptops, cut-away
 * walls) stay separate. Every geometry, material and texture is tracked and disposed.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../../agents-studio/studio-model";
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
  /** Per frame: cut away the outer walls between the camera and the room. True while one is moving. */
  update(camera: THREE.Camera, dt: number): boolean;
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

const PALETTE = {
  light: { wood: [222, 196, 160], seam: "rgba(120,86,50,0.22)", wall: 0xf4f1ec, trim: 0x8b7355, skirting: 0xd6cfc4, carpetAlpha: 0.42, label: "rgba(30,41,59,0.55)", pool: "rgba(255,244,214,0.30)" },
  dark: { wood: [92, 70, 52], seam: "rgba(0,0,0,0.35)", wall: 0x2b3444, trim: 0x55606f, skirting: 0x1f2631, carpetAlpha: 0.28, label: "rgba(226,232,240,0.55)", pool: "rgba(255,214,150,0.12)" }
} as const;

const PX = 64;

/** Light-oak planks: staggered joints and a little tone variation per board, seeded so it never changes. */
function paintPlanks(ctx: CanvasRenderingContext2D, theme: StudioTheme) {
  const p = PALETTE[theme];
  const rand = mulberry32(7);
  const plank = 0.2 * PX;
  for (let y = 0; y < FLOOR.d * PX; y += plank) {
    let x = -rand() * 1.6 * PX;
    while (x < FLOOR.w * PX) {
      const len = (1.2 + rand() * 1.2) * PX;
      const v = (rand() - 0.5) * 18;
      ctx.fillStyle = `rgb(${p.wood[0] + v},${p.wood[1] + v * 0.9},${p.wood[2] + v * 0.7})`;
      ctx.fillRect(x, y, len, plank);
      ctx.fillStyle = p.seam;
      ctx.fillRect(x, y, 1.2, plank);
      x += len;
    }
    ctx.fillStyle = p.seam;
    ctx.fillRect(0, y, FLOOR.w * PX, 1);
  }
}

/** A room's carpet: its tint over a fine tile grid, a darker edge, and its name. */
function paintRoom(ctx: CanvasRenderingContext2D, room: (typeof ROOMS)[number], theme: StudioTheme) {
  const p = PALETTE[theme];
  const { x, z, w, d } = room.area;
  const px = (x - w / 2 + FLOOR.w / 2) * PX;
  const pz = (z - d / 2 + FLOOR.d / 2) * PX;
  const inset = 8;
  ctx.fillStyle = theme === "dark" ? "#1c2433" : "#eef0f3";
  ctx.fillRect(px + inset, pz + inset, w * PX - inset * 2, d * PX - inset * 2);
  ctx.globalAlpha = p.carpetAlpha;
  ctx.fillStyle = ROOM_TINT[room.id] ?? "#cbd5e1";
  ctx.fillRect(px + inset, pz + inset, w * PX - inset * 2, d * PX - inset * 2);
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = "#000";
  for (let gx = px + inset; gx < px + w * PX - inset; gx += PX * 0.5) ctx.fillRect(gx, pz + inset, 1, d * PX - inset * 2);
  for (let gz = pz + inset; gz < pz + d * PX - inset; gz += PX * 0.5) ctx.fillRect(px + inset, gz, w * PX - inset * 2, 1);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ROOM_TINT[room.id] ?? "#cbd5e1";
  ctx.lineWidth = 3;
  ctx.strokeRect(px + inset, pz + inset, w * PX - inset * 2, d * PX - inset * 2);
  ctx.fillStyle = p.label;
  ctx.font = '700 26px system-ui, "Segoe UI", sans-serif';
  ctx.letterSpacing = "3px";
  ctx.fillText(room.label.toUpperCase(), px + 24, pz + d * PX - 26);
  ctx.letterSpacing = "0px";
}

/** Warm pools of ceiling light over the desk rows and the rooms — baked, so they cost nothing per frame. */
function paintLightPools(ctx: CanvasRenderingContext2D, theme: StudioTheme) {
  const spots = [...DESKS.map((d) => ({ x: d.desk.x, z: d.desk.z - 0.2, r: 2.2 })), ...ROOMS.map((r) => ({ x: r.area.x, z: r.area.z, r: 2.6 }))];
  for (const s of spots) {
    const cx = (s.x + FLOOR.w / 2) * PX;
    const cz = (s.z + FLOOR.d / 2) * PX;
    const g = ctx.createRadialGradient(cx, cz, 0, cx, cz, s.r * PX);
    g.addColorStop(0, PALETTE[theme].pool);
    g.addColorStop(1, "rgba(255,244,214,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - s.r * PX, cz - s.r * PX, s.r * PX * 2, s.r * PX * 2);
  }
}

function floorTexture(theme: StudioTheme): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = FLOOR.w * PX;
  canvas.height = FLOOR.d * PX;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    paintPlanks(ctx, theme);
    for (const room of ROOMS) paintRoom(ctx, room, theme);
    ctx.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";
    paintLightPools(ctx, theme);
    ctx.globalCompositeOperation = "source-over";
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Merge every static mesh under `group` into one mesh per (material, shadow) pair. */
function mergeStatic(group: THREE.Group, track: <T extends { dispose(): void }>(x: T) => T) {
  group.updateMatrixWorld(true);
  const buckets = new Map<string, { material: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>();
  const merged: THREE.Mesh[] = [];
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || node.userData.live || node.parent?.userData.live) return;
    const material = node.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) return;
    const source = node.geometry as THREE.BufferGeometry;
    const geo: THREE.BufferGeometry = source.index ? source.toNonIndexed() : source.clone();
    geo.deleteAttribute("uv1");
    geo.applyMatrix4(node.matrixWorld);
    const key = `${material.uuid}|${node.castShadow}`;
    const bucket = buckets.get(key) ?? { material, cast: node.castShadow, geos: [] as THREE.BufferGeometry[] };
    bucket.geos.push(geo);
    buckets.set(key, bucket);
    merged.push(node);
  });
  for (const node of merged) node.removeFromParent();
  for (const { material, cast, geos } of buckets.values()) {
    const geo = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!geo) continue;
    const mesh = new THREE.Mesh(track(geo), material);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

interface CutWall {
  group: THREE.Group;
  /** Outward normal on the floor plane, and the wall plane's offset along it. */
  nx: number;
  nz: number;
  at: number;
  height: number;
  windows: THREE.Object3D[];
}

export function buildOffice(theme: StudioTheme): Building {
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };
  const group = new THREE.Group();
  const unit = track(new THREE.BoxGeometry(1, 1, 1));
  const std = (color: number, roughness = 0.7, metalness = 0) => track(new THREE.MeshStandardMaterial({ color, roughness, metalness }));

  /** A box sized and placed by a floor rectangle, sitting on the ground (or lifted to `y0`). */
  const box = (r: Rect, material: THREE.Material, y0 = 0, cast = true, parent: THREE.Object3D = group): THREE.Mesh => {
    const mesh = new THREE.Mesh(unit, material);
    mesh.scale.set(r.w, r.h, r.d);
    mesh.position.set(r.x, y0 + r.h / 2, r.z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // ---- floor -------------------------------------------------------------------------------------
  let floorTex = track(floorTexture(theme));
  const floorMat = track(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.62 }));
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(FLOOR.w, FLOOR.d)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.userData.live = true;
  group.add(floor);
  // A slab under the building so its edge has thickness, and a doormat at the entrance.
  const slabMat = std(0x9ca3af, 0.9);
  box({ x: 0, z: 0, w: FLOOR.w + 0.4, d: FLOOR.d + 0.4, h: 0.25 }, slabMat, -0.26, false);
  box({ x: 0, z: FLOOR.d / 2 + 0.6, w: 1.7, d: 0.8, h: 0.02 }, std(0x57534e, 0.95), 0, false);

  // ---- walls -------------------------------------------------------------------------------------
  const p = PALETTE[theme];
  const wallMat = std(p.wall, 0.9);
  const trimMat = std(p.trim, 0.5);
  const skirtMat = std(p.skirting, 0.7);
  const glassMat = track(new THREE.MeshPhysicalMaterial({ color: 0xdbeafe, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false }));
  const frameMat = std(0x475569, 0.4, 0.6);
  const windowMat = track(new THREE.MeshStandardMaterial({ color: 0xbfdbfe, emissive: 0xdbeafe, emissiveIntensity: 0.55, roughness: 0.1 }));
  const cuts: CutWall[] = [];

  const outerWall = (w: Rect, nx: number, nz: number) => {
    const g = new THREE.Group();
    g.userData.live = true;
    box(w, wallMat, 0, true, g);
    box({ ...w, w: w.w + 0.06, d: w.d + 0.06, h: 0.08 }, trimMat, w.h, false, g);
    const windows: THREE.Object3D[] = [];
    // Windows along the inside face, spaced along the wall's long axis.
    const along = nx === 0 ? w.w : w.d;
    const count = Math.floor(along / 3);
    for (let i = 0; i < count; i += 1) {
      const t = -along / 2 + (i + 0.5) * (along / count);
      const inset = -0.08;
      const pane: Rect = nx === 0 ? { x: w.x + t, z: w.z - nz * inset, w: 1.6, d: 0.02, h: 1.1 } : { x: w.x - nx * inset, z: w.z + t, w: 0.02, d: 1.6, h: 1.1 };
      windows.push(box(pane, windowMat, 1.15, false, g));
      const sill: Rect = nx === 0 ? { ...pane, w: 1.75, d: 0.12, h: 0.05 } : { ...pane, d: 1.75, w: 0.12, h: 0.05 };
      windows.push(box(sill, trimMat, 1.1, false, g));
      const mullion: Rect = nx === 0 ? { ...pane, w: 0.04, d: 0.04 } : { ...pane, d: 0.04, w: 0.04 };
      windows.push(box(mullion, frameMat, 1.15, false, g));
    }
    group.add(g);
    cuts.push({ group: g, nx, nz, at: nx * w.x + nz * w.z, height: 1, windows });
  };

  for (const w of WALLS) {
    const tall = w.h >= WALL_HIGH;
    if (tall && w.w > w.d) outerWall(w, 0, -1);
    else if (tall) outerWall(w, Math.sign(w.x), 0);
    else if (w.z > FLOOR.d / 2 - 0.2) {
      // The front ledge: a low painted wall with a timber cap — the edge of the cut-away building.
      box(w, wallMat);
      box({ ...w, w: w.w + 0.04, d: w.d + 0.1, h: 0.05 }, trimMat, w.h, false);
    } else {
      box(w, glassMat, 0, false).userData.live = true;
      box({ ...w, h: 0.05, w: w.w + 0.02, d: w.d + 0.02 }, frameMat, w.h, false);
      box({ ...w, h: 0.06, w: w.w + 0.02, d: w.d + 0.02 }, frameMat, 0, false);
    }
  }
  // Skirting along the inside of the back wall (the side walls carry theirs in the cut-away group).
  box({ x: 0, z: -FLOOR.d / 2 + 0.09, w: FLOOR.w - 0.2, d: 0.04, h: 0.1 }, skirtMat, 0, false);

  // ---- desks, laptops, chairs -------------------------------------------------------------------
  const deskMat = std(0xd9b98c, 0.45);
  const edgeMat = std(0xf8fafc, 0.5);
  const legMat = std(0x334155, 0.35, 0.5);
  const chairMat = std(0x1f2937, 0.6);
  const chairAccent = std(0x3b4f6b, 0.7);
  const laptopMat = std(0x9ca3af, 0.3, 0.6);
  const screenOff = 0x0f172a;
  const screens: THREE.MeshStandardMaterial[] = [];
  const logos: THREE.MeshBasicMaterial[] = [];
  const spills: THREE.Mesh[] = [];
  const spillMats: THREE.MeshBasicMaterial[] = [];
  const spillTex = track(glowTexture());
  const mugMat = std(0xf8fafc, 0.4);
  const bookMat = std(0x0ea5e9, 0.7);

  const chair = (x: number, z: number, heading: number) => {
    const c = new THREE.Group();
    const parts: Array<[THREE.Material, number, number, number, number, number, number]> = [
      [chairAccent, 0.48, 0.08, 0.46, 0, 0.45, 0],
      [chairMat, 0.46, 0.52, 0.06, 0, 0.76, -0.22],
      [legMat, 0.06, 0.38, 0.06, 0, 0.22, 0],
      [legMat, 0.5, 0.03, 0.06, 0, 0.03, 0],
      [legMat, 0.06, 0.03, 0.5, 0, 0.03, 0]
    ];
    for (const [mat, sx, sy, sz, px, py, pz] of parts) {
      const m = new THREE.Mesh(unit, mat);
      m.scale.set(sx, sy, sz);
      m.position.set(px, py, pz);
      m.castShadow = true;
      m.receiveShadow = true;
      c.add(m);
    }
    c.position.set(x, 0, z);
    c.rotation.y = heading;
    group.add(c);
  };

  for (const d of DESKS) {
    box({ ...d.desk, h: 0.045 }, deskMat, d.desk.h - 0.045);
    box({ ...d.desk, d: 0.02, z: d.desk.z + d.desk.d / 2 - 0.01, h: 0.045 }, edgeMat, d.desk.h - 0.045, false);
    for (const sx of [-1, 1]) box({ x: d.desk.x + sx * (d.desk.w / 2 - 0.08), z: d.desk.z, w: 0.05, d: d.desk.d - 0.12, h: d.desk.h - 0.045 }, legMat);
    // A modesty panel between the legs, and a mug and a notebook so no two desks look identical.
    box({ x: d.desk.x, z: d.desk.z + 0.15, w: d.desk.w - 0.2, d: 0.02, h: 0.35 }, legMat, 0.32, false);
    box({ x: d.desk.x - 0.5, z: d.desk.z - 0.05, w: 0.08, d: 0.08, h: 0.1 }, mugMat, d.desk.h, false);
    box({ x: d.desk.x + 0.48, z: d.desk.z, w: 0.22, d: 0.3, h: 0.02 }, bookMat, d.desk.h, false);
    // Laptop: base, and the lid hinged up toward the sitter (so the camera sees its back).
    box({ x: d.desk.x, z: d.desk.z - 0.1, w: 0.42, d: 0.28, h: 0.02 }, laptopMat, d.desk.h, false);
    const live = new THREE.Group();
    live.userData.live = true;
    live.position.set(d.desk.x, d.desk.h + 0.15, d.desk.z + 0.05);
    live.rotation.x = 0.22;
    const lid = new THREE.Mesh(unit, laptopMat);
    lid.scale.set(0.42, 0.28, 0.02);
    lid.castShadow = true;
    const screenMat = track(new THREE.MeshStandardMaterial({ color: screenOff, emissive: 0x7dd3fc, emissiveIntensity: 0, roughness: 0.3 }));
    screens.push(screenMat);
    const screen = new THREE.Mesh(unit, screenMat);
    screen.scale.set(0.38, 0.24, 0.004);
    screen.position.z = -0.012;
    // The back of the lid, the side the camera sees: a small logo that lights with the screen.
    const logoMat = track(new THREE.MeshBasicMaterial({ color: 0x64748b, toneMapped: false }));
    logos.push(logoMat);
    const logo = new THREE.Mesh(unit, logoMat);
    logo.scale.set(0.06, 0.06, 0.004);
    logo.position.z = 0.012;
    live.add(lid, screen, logo);
    group.add(live);
    // Screen light spilling onto the desk and the person: an additive soft disc, shown only when lit.
    const spillMat = track(new THREE.MeshBasicMaterial({ map: spillTex, color: 0x7dd3fc, transparent: true, depthWrite: false, toneMapped: false }));
    spillMats.push(spillMat);
    const spill = new THREE.Mesh(track(new THREE.PlaneGeometry(1.2, 0.66)), spillMat);
    spill.rotation.x = -Math.PI / 2;
    spill.position.set(d.desk.x, d.desk.h + 0.006, d.desk.z - 0.01);
    spill.visible = false;
    spill.userData.live = true;
    spills.push(spill);
    group.add(spill);
    chair(d.seat.x, d.seat.z, d.heading);
  }

  // ---- meeting room -----------------------------------------------------------------------------
  box({ ...MEETING_TABLE, h: 0.06 }, std(0xf1f5f9, 0.3), MEETING_TABLE.h - 0.06);
  box({ x: MEETING_TABLE.x, z: MEETING_TABLE.z, w: 0.5, d: 0.5, h: MEETING_TABLE.h - 0.06 }, legMat);
  for (const s of MEETING_SEATS) chair(s.seat.x, s.seat.z, s.heading);
  const wallScreen = track(new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: 0x6366f1, emissiveIntensity: 0.45 }));
  box({ x: MEETING_TABLE.x, z: -FLOOR.d / 2 + 0.12, w: 2.6, d: 0.06, h: 1.3 }, wallScreen, 1.0, false);

  // ---- kitchen ----------------------------------------------------------------------------------
  box(COFFEE_COUNTER, std(0xfafafa, 0.35));
  box({ ...COFFEE_COUNTER, h: 0.04, w: COFFEE_COUNTER.w + 0.06 }, std(0x57534e, 0.4), COFFEE_COUNTER.h, false);
  box({ x: COFFEE_COUNTER.x, z: COFFEE_COUNTER.z, w: 0.4, d: 0.45, h: 0.5 }, std(0x1f2937, 0.3, 0.4), COFFEE_COUNTER.h + 0.04);
  box({ x: COFFEE_COUNTER.x + 0.12, z: COFFEE_COUNTER.z, w: 0.08, d: 0.2, h: 0.08 }, std(0xef4444, 0.4), COFFEE_COUNTER.h + 0.34, false);

  // ---- plants and the bin -----------------------------------------------------------------------
  const potMat = std(0xe7e5e4, 0.6);
  const leafMat = std(0x3f9b5a, 0.75);
  const leafDark = std(0x2f7a46, 0.8);
  const leafGeo = track(new THREE.IcosahedronGeometry(0.3, 1));
  for (const d of DECOR) {
    box({ x: d.x, z: d.z, w: 0.38, d: 0.38, h: 0.42 }, potMat);
    for (const [dx, dy, dz, s, mat] of [
      [0, 0.75, 0, 1.1, leafMat],
      [0.14, 1.0, 0.05, 0.8, leafDark],
      [-0.12, 0.95, -0.06, 0.75, leafMat]
    ] as const) {
      const leaves = new THREE.Mesh(leafGeo, mat);
      leaves.position.set(d.x + dx, dy, d.z + dz);
      leaves.scale.setScalar(s);
      leaves.castShadow = true;
      group.add(leaves);
    }
  }
  const binMat = std(0x64748b, 0.5, 0.4);
  for (const [dx, dz, w, d] of [
    [0.2, 0, 0.03, 0.43],
    [-0.2, 0, 0.03, 0.43],
    [0, 0.2, 0.43, 0.03],
    [0, -0.2, 0.43, 0.03]
  ] as const) {
    box({ x: BIN.x + dx, z: BIN.z + dz, w, d, h: 0.44 }, binMat);
  }

  mergeStatic(group, track);

  /** Light adds on a dark floor; on a pale desk an added glow vanishes, so it tints instead. */
  const styleSpills = (next: StudioTheme) => {
    for (const m of spillMats) {
      m.blending = next === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending;
      m.color.setHex(next === "dark" ? 0x7dd3fc : 0x38bdf8);
      m.opacity = next === "dark" ? 0.6 : 0.38;
      m.needsUpdate = true;
    }
  };
  styleSpills(theme);

  const camLocal = new THREE.Vector3();
  return {
    group,
    setLaptop(index, on) {
      const screen = screens[index];
      if (!screen) return;
      screen.emissiveIntensity = on ? 1.1 : 0;
      screen.color.setHex(on ? 0x0ea5e9 : screenOff);
      logos[index].color.setHex(on ? 0xe0f2fe : 0x64748b);
      spills[index].visible = on;
    },
    setTheme(next) {
      floorTex.dispose();
      floorTex = track(floorTexture(next));
      floorMat.map = floorTex;
      floorMat.needsUpdate = true;
      wallMat.color.setHex(PALETTE[next].wall);
      trimMat.color.setHex(PALETTE[next].trim);
      skirtMat.color.setHex(PALETTE[next].skirting);
      windowMat.emissiveIntensity = next === "dark" ? 0.25 : 0.55;
      styleSpills(next);
    },
    update(camera, dt) {
      camLocal.copy(camera.position);
      let moving = false;
      for (const c of cuts) {
        const outside = c.nx * camLocal.x + c.nz * camLocal.z > c.at + 0.5;
        const want = outside ? 0.14 : 1;
        if (Math.abs(want - c.height) < 0.002) continue;
        c.height += (want - c.height) * Math.min(1, dt * 6);
        c.group.scale.y = c.height;
        for (const w of c.windows) w.visible = c.height > 0.85;
        moving = true;
      }
      return moving;
    },
    dispose() {
      for (const item of disposables) item.dispose();
    }
  };
}

/** A soft white disc (alpha falls off to the edge), tinted per use by the material colour. */
function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.5, "rgba(255,255,255,0.3)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}
