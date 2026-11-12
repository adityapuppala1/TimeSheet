/**
 * What an agent CARRIES or WEARS — the part of a character that says what its job is at a glance. The
 * shared rig (body, head, visor, arms, antenna, thruster) is the same hover-bot for everyone, so the
 * accessory is what stops two agents looking alike: a hard hat and blueprint roll, radar ears and a
 * gauge, a guard cap and shield, a press cap and notepad, a balance scale.
 *
 * One file per archetype (triage.ts, planner.ts, ...), registered in index.ts. An archetype with no
 * accessory returns null and wears its emoji as a floating badge instead.
 *
 * Everything an accessory creates must go through `ctx.track(...)` so the character disposes it.
 */
import type * as THREE from "three";
import type { Mood } from "../../studio-model";

export interface AccessoryContext {
  /** The hovering body group. Add props here and they bob with the character. */
  rig: THREE.Group;
  /** The head pivot (origin at the neck): attach hats, ear gear and antenna add-ons here so they turn with the head. */
  neck: THREE.Group;
  /** Shoulder pivots. Arms hang along -Y; a NEGATIVE rotation about X swings the hand forward. Hand is ~0.55 below the pivot. */
  armL: THREE.Group;
  armR: THREE.Group;
  /** The agent's colours: body (its tint), head (lighter) and trim (darker). */
  body: THREE.Color;
  head: THREE.Color;
  trim: THREE.Color;
  tint: number;
  track: <T extends { dispose(): void }>(item: T) => T;
}

export interface ArmTargets {
  armLx?: number;
  armRx?: number;
  armLz?: number;
  armRz?: number;
}

export interface Accessory {
  /**
   * Per-frame. `s` is the clock plus this character's phase (use it for motion), `t` is the bare clock,
   * `lift` is how far the body is currently hovering above its resting height.
   */
  update(mood: Mood, s: number, t: number, lift: number): void;
  /** Optionally hold the arms in a pose (e.g. gripping a tray) instead of the mood's default. Return null to let the mood decide. */
  arms?(mood: Mood, s: number): ArmTargets | null;
  /** True when the prop already identifies the character, so the floating emoji badge is not worn. */
  replacesBadge?: boolean;
}

export type AccessoryBuilder = (ctx: AccessoryContext) => Accessory | null;
