/**
 * WHAT: the office furniture that REAL activity moves —
 *   - queue stacks: one physical crate (a Rapier dynamic body) per run waiting in an agent's queue,
 *     dropped onto a pile in its room, with a sign giving the real count (the pile tops out at
 *     STACK_MAX; the sign never does);
 *   - the meeting room's wall screen, which shows the shared item while agents meet over it.
 *
 * Crates come from a fixed pool created once (POOL bodies); unused ones are parked out of the world,
 * so a changing queue never allocates. The engine owns the meshes (it mirrors every prop) — this only
 * decides which pooled crate stands where.
 *
 * WHO CALLS THIS: scene/office-engine.ts `setActivity`.
 */
import * as THREE from "three";
import { mulberry32 } from "../../agents-studio/studio-model";
import { FLOOR, MEETING_TABLE, type Vec2 } from "../office-model";
import { LABEL_UNIT } from "./labels";
import type { Physics } from "./physics";

const POOL = 24;
const STACK_MAX = 6;
const CRATE = 0.3;
const FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';

export interface QueueStack {
  key: string;
  at: Vec2;
  depth: number;
}

export interface ActivityProps {
  setQueues(stacks: readonly QueueStack[]): void;
  setMeeting(meeting: { title: string; names: string[] } | null): void;
  /** Keep the signs a constant on-screen size. */
  update(): void;
  dispose(): void;
}

interface Sign {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  sprite: THREE.Sprite;
  text: string;
}

const SIGN_W = 96;
const SIGN_H = 24;

function makeSign(): Sign {
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_W * 2;
  canvas.height = SIGN_H * 2;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: false,
    toneMapped: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 18;
  return { canvas, texture, material, sprite, text: "" };
}

function drawSign(sign: Sign, text: string) {
  if (sign.text === text) return;
  sign.text = text;
  const ctx = sign.canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, SIGN_W, SIGN_H);
  ctx.fillStyle = "rgba(15,23,42,0.86)";
  ctx.beginPath();
  ctx.roundRect(2, 2, SIGN_W - 4, SIGN_H - 4, 9);
  ctx.fill();
  ctx.fillStyle = "#fde68a";
  ctx.font = `600 11px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, SIGN_W / 2, SIGN_H / 2 + 0.5);
  sign.texture.needsUpdate = true;
}

function drawScreen(canvas: HTMLCanvasElement, meeting: { title: string; names: string[] } | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (!meeting) {
    ctx.fillStyle = "#334155";
    ctx.font = `500 28px ${FONT}`;
    ctx.fillText("No meeting", 28, h / 2 - 14);
    return;
  }
  ctx.fillStyle = "#a5b4fc";
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText("WORKING TOGETHER ON", 28, 24);
  ctx.fillStyle = "#f8fafc";
  ctx.font = `700 40px ${FONT}`;
  let title = meeting.title;
  while (title.length > 1 && ctx.measureText(title).width > w - 56) title = title.slice(0, -2);
  ctx.fillText(title === meeting.title ? title : `${title}…`, 28, 64);
  ctx.fillStyle = "#94a3b8";
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText(meeting.names.join(" · "), 28, 128);
}

export function createActivityProps(scene: THREE.Scene, physics: Physics, addProp: (x: number, y: number, z: number) => number): ActivityProps {
  const pool: number[] = [];
  for (let i = 0; i < POOL; i += 1) {
    const index = addProp(0, -20, 0);
    physics.parkProp(index);
    pool.push(index);
  }
  const free = [...pool];
  /** Which pooled crates each stack holds, bottom first. */
  const stacks = new Map<string, number[]>();
  const signs = new Map<string, Sign>();
  const jitter = mulberry32(0x51ac);

  function resize(key: string, at: Vec2, shown: number) {
    const held = stacks.get(key) ?? [];
    while (held.length > shown) {
      const index = held.pop();
      if (index === undefined) break;
      physics.parkProp(index);
      free.push(index);
    }
    while (held.length < shown && free.length > 0) {
      const index = free.pop() as number;
      const level = held.length;
      // Dropped from just above the pile: it settles on the one below under real gravity.
      physics.dropProp(index, at.x + (jitter() - 0.5) * 0.06, CRATE / 2 + level * (CRATE + 0.02) + 0.05, at.z + (jitter() - 0.5) * 0.06);
      held.push(index);
    }
    stacks.set(key, held);
  }

  function signFor(key: string): Sign {
    let sign = signs.get(key);
    if (!sign) {
      sign = makeSign();
      signs.set(key, sign);
      scene.add(sign.sprite);
    }
    return sign;
  }

  // The meeting room's wall screen (building.ts draws the dark frame at this spot).
  const screenCanvas = document.createElement("canvas");
  screenCanvas.width = 640;
  screenCanvas.height = 300;
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({
    map: screenTex,
    toneMapped: false
  });
  const screenGeo = new THREE.PlaneGeometry(2.4, 1.12);
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.position.set(MEETING_TABLE.x, 1.65, -FLOOR.d / 2 + 0.165);
  scene.add(screen);
  drawScreen(screenCanvas, null);
  let shownMeeting = "";

  return {
    setQueues(next) {
      const keys = new Set(next.map((s) => s.key));
      for (const key of [...stacks.keys()]) {
        if (keys.has(key)) continue;
        resize(key, { x: 0, z: 0 }, 0);
        stacks.delete(key);
      }
      for (const [key, sign] of signs) sign.sprite.visible = keys.has(key);
      for (const s of next) {
        const shown = Math.min(STACK_MAX, Math.max(0, s.depth));
        resize(s.key, s.at, shown);
        const sign = signFor(s.key);
        sign.sprite.visible = s.depth > 0;
        drawSign(sign, `${s.depth} queued`);
        sign.sprite.position.set(s.at.x, shown * (CRATE + 0.02) + 0.35, s.at.z);
      }
    },
    setMeeting(meeting) {
      const key = meeting ? `${meeting.title}|${meeting.names.join(",")}` : "";
      if (key === shownMeeting) return;
      shownMeeting = key;
      drawScreen(screenCanvas, meeting);
      screenTex.needsUpdate = true;
    },
    update() {
      for (const sign of signs.values()) sign.sprite.scale.set(SIGN_W * LABEL_UNIT.value, SIGN_H * LABEL_UNIT.value, 1);
    },
    dispose() {
      for (const sign of signs.values()) {
        scene.remove(sign.sprite);
        sign.texture.dispose();
        sign.material.dispose();
      }
      scene.remove(screen);
      screenGeo.dispose();
      screenMat.dispose();
      screenTex.dispose();
    }
  };
}
