/**
 * WHAT: the office's floating labels — a person's name tag (name + what it is doing right now), a
 * speech bubble with a few words, and the holographic task card over an agent working its zone.
 *
 * WHY SCREEN-SIZED SPRITES: from the overview camera a person is ~40 px tall, and a label sized in
 * metres shrank with them into an unreadable smudge. These sprites ignore distance
 * (`sizeAttenuation: false`) and are sized in CSS pixels through `LABEL_UNIT`, which the engine
 * updates on resize — so a tag reads the same at the overview as close up. They are drawn at 2× into
 * canvas textures and redrawn ONLY when their text changes, never per frame.
 *
 * Honesty: the task card always carries a "SIMULATED" chip — its caption and progress illustrate the
 * job; only the fact that the agent is working is real.
 */
import * as THREE from "three";
import { moodCss, type Mood } from "../../agents-studio/studio-model";
import { initialsOf } from "../office-model";

/** Sprite scale per CSS pixel: 2·tan(fov/2) / viewport height (× a compact factor on phones). Set by
 *  the engine on every resize. */
export const LABEL_UNIT = { value: 0.0012 };


const DPR = 2;
const FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';

interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  /** Logical (CSS px) size. */
  w: number;
  h: number;
}

function makeSprite(w: number, h: number, anchorY: number, order: number): Canvas2D {
  const canvas = document.createElement("canvas");
  canvas.width = w * DPR;
  canvas.height = h * DPR;
  const ctx = canvas.getContext("2d");
  ctx?.scale(DPR, DPR);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // UI, not a lit surface: no tone mapping, so the colours are the colours that were drawn.
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, anchorY);
  sprite.renderOrder = order;
  return { canvas, ctx, texture, sprite, material, w, h };
}

function sizeSprite(c: Canvas2D, grow = 1) {
  c.sprite.scale.set(c.w * LABEL_UNIT.value * grow, c.h * LABEL_UNIT.value * grow, 1);
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Cut `text` with an ellipsis so it fits `max` px in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/* ------------------------------------------------------------------ name tag */

export interface Tag {
  sprite: THREE.Sprite;
  set(status: string, mood: Mood, emphasis: boolean): void;
  /** Per frame: keep the pixel size (and grow a little when emphasised). */
  update(): void;
  dispose(): void;
}

export const TAG_W = 156;
export const TAG_H = 40;

export function createTag(name: string, tintCss: string): Tag {
  const c = makeSprite(TAG_W, TAG_H, 0, 20);
  let shown = "";
  let grow = 1;
  let target = 1;
  return {
    sprite: c.sprite,
    set(status, mood, emphasis) {
      target = emphasis ? 1.12 : 1;
      const key = `${status}|${mood}|${emphasis}`;
      if (key === shown || !c.ctx) return;
      shown = key;
      const ctx = c.ctx;
      ctx.clearRect(0, 0, TAG_W, TAG_H);
      ctx.fillStyle = emphasis ? "rgba(15,23,42,0.96)" : "rgba(15,23,42,0.84)";
      pill(ctx, 1, 1, TAG_W - 2, TAG_H - 2, 12);
      ctx.fill();
      ctx.strokeStyle = emphasis ? tintCss : "rgba(148,163,184,0.35)";
      ctx.lineWidth = emphasis ? 2 : 1;
      ctx.stroke();
      // Avatar disc: initials in the agent's tint, ringed in its mood colour.
      ctx.fillStyle = tintCss;
      ctx.beginPath();
      ctx.arc(22, TAG_H / 2, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = moodCss(mood);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#0f172a";
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initialsOf(name), 22, TAG_H / 2 + 0.5);
      ctx.textAlign = "left";
      ctx.fillStyle = "#f8fafc";
      ctx.font = `600 13px ${FONT}`;
      ctx.fillText(fit(ctx, name, TAG_W - 52), 43, 15);
      ctx.fillStyle = moodCss(mood);
      ctx.font = `500 11px ${FONT}`;
      ctx.fillText(fit(ctx, status, TAG_W - 52), 43, 31);
      c.texture.needsUpdate = true;
    },
    update() {
      grow += (target - grow) * 0.25;
      sizeSprite(c, grow);
    },
    dispose() {
      c.texture.dispose();
      c.material.dispose();
    }
  };
}

/* ------------------------------------------------------------------ speech bubble */

export interface Bubble {
  sprite: THREE.Sprite;
  /** A few words (or a single glyph), or null to hide it. */
  set(text: string | null): void;
  update(t: number): void;
  dispose(): void;
}

/** Wide enough for a short real line from a run (office-activity.ts caps them at 34 characters). */
export const BUBBLE_W = 196;
export const BUBBLE_H = 40;

export function createBubble(): Bubble {
  const c = makeSprite(BUBBLE_W, BUBBLE_H, 0, 21);
  c.sprite.visible = false;
  let shown: string | null = null;
  let pop = 0;
  return {
    sprite: c.sprite,
    set(text) {
      if (text === shown) return;
      shown = text;
      c.sprite.visible = text !== null;
      pop = 0;
      if (text === null || !c.ctx) return;
      const ctx = c.ctx;
      ctx.clearRect(0, 0, BUBBLE_W, BUBBLE_H);
      ctx.font = `600 12px ${FONT}, "Segoe UI Emoji"`;
      const words = fit(ctx, text, BUBBLE_W - 24);
      const w = Math.max(30, ctx.measureText(words).width + 20);
      const x = (BUBBLE_W - w) / 2;
      ctx.fillStyle = "rgba(255,255,255,0.97)";
      ctx.shadowColor = "rgba(15,23,42,0.25)";
      ctx.shadowBlur = 4;
      pill(ctx, x, 3, w, 26, 13);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(BUBBLE_W / 2 - 5, 28);
      ctx.lineTo(BUBBLE_W / 2, 37);
      ctx.lineTo(BUBBLE_W / 2 + 6, 28);
      ctx.fill();
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(words, BUBBLE_W / 2, 16.5);
      c.texture.needsUpdate = true;
    },
    update() {
      // Pops in with a small overshoot, then holds.
      pop = Math.min(1, pop + 0.12);
      const s = pop < 1 ? 0.6 + Math.sin(pop * Math.PI * 0.75) * 0.5 : 1;
      sizeSprite(c, s);
    },
    dispose() {
      c.texture.dispose();
      c.material.dispose();
    }
  };
}

/* ------------------------------------------------------------------ task card */

export interface TaskCard {
  sprite: THREE.Sprite;
  /** Show the card with this title and caption, or hide it (null). */
  set(card: { icon: string; title: string; caption: string; accent: string } | null): void;
  /** Per frame: the in/out animation and the illustrative progress bar. */
  update(t: number, dt: number): boolean;
  dispose(): void;
}

export const CARD_W = 230;
export const CARD_H = 64;

function drawCard(ctx: CanvasRenderingContext2D, card: { icon: string; title: string; caption: string; accent: string }, progress: number) {
  ctx.clearRect(0, 0, CARD_W, CARD_H);
  const glass = ctx.createLinearGradient(0, 0, 0, CARD_H);
  glass.addColorStop(0, "rgba(14,30,52,0.92)");
  glass.addColorStop(1, "rgba(8,18,34,0.92)");
  ctx.fillStyle = glass;
  pill(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 10);
  ctx.fill();
  ctx.strokeStyle = card.accent;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `14px "Segoe UI Emoji", "Apple Color Emoji", ${FONT}`;
  ctx.fillText(card.icon, 10, 17);
  ctx.fillStyle = "#e0f2fe";
  ctx.font = `700 12px ${FONT}`;
  ctx.fillText(fit(ctx, card.title, CARD_W - 104), 31, 17);
  // The honesty chip.
  ctx.font = `700 8px ${FONT}`;
  ctx.fillStyle = "rgba(148,163,184,0.25)";
  pill(ctx, CARD_W - 66, 9, 56, 15, 4);
  ctx.fill();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText("SIMULATED", CARD_W - 61, 17);
  ctx.fillStyle = "rgba(203,213,225,0.85)";
  ctx.font = `500 10.5px ${FONT}`;
  ctx.fillText(fit(ctx, card.caption, CARD_W - 20), 10, 36);
  ctx.fillStyle = "rgba(148,163,184,0.25)";
  pill(ctx, 10, 49, CARD_W - 20, 5, 2.5);
  ctx.fill();
  const bar = ctx.createLinearGradient(10, 0, CARD_W - 10, 0);
  bar.addColorStop(0, card.accent);
  bar.addColorStop(1, "#a5f3fc");
  ctx.fillStyle = bar;
  pill(ctx, 10, 49, Math.max(5, (CARD_W - 20) * progress), 5, 2.5);
  ctx.fill();
}

export function createTaskCard(seed: number): TaskCard {
  const c = makeSprite(CARD_W, CARD_H, 0, 22);
  c.sprite.visible = false;
  let card: { icon: string; title: string; caption: string; accent: string } | null = null;
  let lastCard = "";
  let shown = 0;
  let drawnStep = -1;
  const period = 7 + (seed % 5);
  return {
    sprite: c.sprite,
    set(next) {
      // On hide the last drawing stays on the texture while the card fades out.
      card = next;
    },
    update(t, dt) {
      const want = card ? 1 : 0;
      shown += (want - shown) * Math.min(1, dt * 8);
      if (shown < 0.02 && !card) {
        c.sprite.visible = false;
        return false;
      }
      c.sprite.visible = true;
      c.material.opacity = Math.min(1, shown * 1.2);
      sizeSprite(c, 0.7 + shown * 0.3);
      if (!card || !c.ctx) return true;
      // Progress loops — the card illustrates steady work; it is not a real percentage.
      const progress = ((t + seed) % period) / period;
      const step = Math.floor(progress * 40);
      const key = `${card.title}|${card.caption}|${card.accent}`;
      if (step !== drawnStep || key !== lastCard) {
        drawnStep = step;
        lastCard = key;
        drawCard(c.ctx, card, step / 40);
        c.texture.needsUpdate = true;
      }
      return true;
    },
    dispose() {
      c.texture.dispose();
      c.material.dispose();
    }
  };
}
