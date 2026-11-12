/**
 * WHAT: one agent as a small hovering robot — procedural geometry only, so there is no model file to
 * license, download or keep in step with the roster, and its colour is the agent's own tint.
 *
 * THE RIG is deliberately plain: a body, a head that turns and nods, two shoulders that swing, a
 * glowing visor with two eyes that open and close, an antenna whose tip is the status light, and a
 * thruster flame under it. Every expression is a handful of numbers (`Pose`) eased toward a target,
 * so mood changes ARE the animation — there are no clips to blend, and a character that was powered
 * down simply rises, lights its visor and looks around.
 *
 * WHY IT HOVERS: no walk cycle to get wrong, and a floating body with a soft contact shadow reads as
 * charming and "machine" at once. It also makes `off` legible without a prop — it settles to the
 * platform with its head down.
 *
 * ACCESSORIES are what tell the six jobs apart at a glance (the triage bot holds an inbox tray). An
 * archetype without one yet wears its emoji as a floating badge, so every agent is distinguishable
 * from the first frame and the others can be filled in without touching this rig.
 *
 * LOADED ONLY VIA A DYNAMIC IMPORT (components/agents-studio/AgentStudio.tsx → scene/engine.ts), so
 * three.js never reaches a default page load.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MOOD_HEX, type Archetype, type Mood } from "../studio-model";

/** One palette for every surface that shows a mood — see studio-model.ts. */
export const MOOD_COLOR = MOOD_HEX;

export interface Character {
  root: THREE.Group;
  /** Eased every frame. `lookX`/`lookY` are where the viewer's pointer is, -1..1 across the canvas. */
  update(mood: Mood, t: number, dt: number, lookX: number, lookY: number): void;
  /** Powers up: the visor flickers on. Called when an agent goes from off to anything else. */
  boot(): void;
  dispose(): void;
}

/** A small texture holding one glyph — an emoji badge, a "!" or a "z". Drawn once, never updated. */
function glyphTexture(text: string, color: string, size = 128): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.round(size * 0.7)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif`;
    ctx.fillText(text, size / 2, size / 2 + size * 0.04);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The numbers a mood is made of. The first group is eased toward its target each frame; the rest
 *  (bob and jump) are read straight off the clock. */
interface Targets {
  sink: number;
  eyeOpen: number;
  pitch: number;
  yaw: number;
  roll: number;
  armLx: number;
  armRx: number;
  armLz: number;
  armRz: number;
  flame: number;
  bobAmp: number;
  bobSpeed: number;
  jump: number;
}
type Pose = Omit<Targets, "bobAmp" | "bobSpeed" | "jump">;
const EASED: ReadonlyArray<keyof Pose> = ["sink", "eyeOpen", "pitch", "yaw", "roll", "armLx", "armRx", "armLz", "armRz", "flame"];

/** How fast the status light pulses, per mood (radians of the clock) — a table, not a ternary chain. */
const PULSE_SPEED: Readonly<Record<Mood, number>> = { off: 0, idle: 3.2, working: 11, attention: 3.2, celebrating: 3.2 };
const TIP_SPEED: Readonly<Record<Mood, number>> = { off: 0, idle: 4, working: 4, attention: 12, celebrating: 4 };
/** How much the held tray sloshes, per mood. */
const TRAY_SORT: Readonly<Record<Mood, number>> = { off: 0, idle: 0.15, working: 1, attention: 0.3, celebrating: 0 };

/** What a mood asks the body to do: a pure function of the mood, the clock and where the viewer is looking. */
function targetsFor(mood: Mood, s: number, lookX: number, lookY: number, holdsTray: boolean): Targets {
  const t: Targets = {
    sink: 0,
    eyeOpen: 1,
    pitch: 0,
    yaw: lookX * 0.55,
    roll: 0,
    armLx: Math.sin(s * 1.3) * 0.08,
    armRx: Math.sin(s * 1.3 + 1) * 0.08,
    armLz: 0.18,
    armRz: -0.18,
    flame: 1,
    bobAmp: 0.05,
    bobSpeed: 1.6,
    jump: 0
  };
  switch (mood) {
    case "off":
      Object.assign(t, { sink: -0.4, eyeOpen: 0.06, pitch: 0.55, yaw: 0, armLx: 0.12, armRx: 0.12, armLz: 0.08, armRz: -0.08, flame: 0, bobAmp: 0 });
      break;
    case "working":
      Object.assign(t, {
        eyeOpen: 0.62,
        pitch: 0.16 + Math.sin(s * 5) * 0.05 - lookY * 0.1,
        yaw: lookX * 0.2 + Math.sin(s * 1.7) * 0.18,
        armLx: -0.9 + Math.sin(s * 7) * 0.5,
        armRx: -0.9 + Math.cos(s * 7) * 0.5,
        flame: 1.6,
        bobAmp: 0.035,
        bobSpeed: 2.8
      });
      break;
    case "attention":
      Object.assign(t, { yaw: Math.sin(s * 6) * 0.3, roll: Math.sin(s * 6) * 0.06, armRx: -2.3 + Math.sin(s * 9) * 0.35, armRz: -0.5, eyeOpen: 0.95, flame: 1.1, bobSpeed: 2.2 });
      break;
    case "celebrating":
      Object.assign(t, { jump: Math.abs(Math.sin(s * 6.5)) * 0.34, armLx: -2.7, armRx: -2.7, armLz: 0.55, armRz: -0.55, eyeOpen: 0.55, flame: 1.9, pitch: -0.12 });
      break;
    default:
      t.pitch = -lookY * 0.18;
  }
  if (holdsTray && (mood === "idle" || mood === "working" || mood === "attention")) {
    // The tray is held in both hands, forward and level; only a tremor of work shows in the arms.
    const tremor = mood === "working" ? Math.sin(s * 9) * 0.04 : 0;
    Object.assign(t, { armLx: -1.25 + tremor, armRx: -1.25 - tremor, armLz: 0.06, armRz: -0.06 });
  }
  return t;
}

export function buildCharacter(archetype: Archetype, tint: number, emoji: string): Character {
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const body = new THREE.Color(tint);
  const head = body.clone().lerp(new THREE.Color(0xffffff), 0.28);
  const trim = body.clone().multiplyScalar(0.62);

  const matBody = track(new THREE.MeshStandardMaterial({ color: body, roughness: 0.5, metalness: 0.05 }));
  const matHead = track(new THREE.MeshStandardMaterial({ color: head, roughness: 0.45, metalness: 0.05 }));
  const matTrim = track(new THREE.MeshStandardMaterial({ color: trim, roughness: 0.6, metalness: 0.05 }));
  const matVisor = track(new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.25, metalness: 0.4 }));
  const matEye = track(new THREE.MeshBasicMaterial({ color: MOOD_COLOR.idle }));
  const matLight = track(new THREE.MeshBasicMaterial({ color: MOOD_COLOR.idle }));
  const matFlame = track(
    new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  const matShadow = track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));

  const root = new THREE.Group();

  // Soft contact shadow on the platform.
  const shadow = new THREE.Mesh(track(new THREE.CircleGeometry(0.62, 32)), matShadow);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  root.add(shadow);

  // Everything that hovers lives in `rig`.
  const rig = new THREE.Group();
  root.add(rig);

  const torso = new THREE.Mesh(track(new RoundedBoxGeometry(0.86, 0.8, 0.62, 5, 0.22)), matBody);
  torso.position.y = 0.98;
  rig.add(torso);

  const belly = new THREE.Mesh(track(new RoundedBoxGeometry(0.34, 0.2, 0.05, 3, 0.05)), matLight);
  belly.position.set(0, 0.96, 0.31);
  rig.add(belly);

  const thruster = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.12, 0.16, 16)), matTrim);
  thruster.position.y = 0.52;
  rig.add(thruster);
  const flame = new THREE.Mesh(track(new THREE.ConeGeometry(0.13, 0.5, 16)), matFlame);
  flame.rotation.x = Math.PI;
  flame.position.y = 0.2;
  rig.add(flame);

  // Head, pivoting at the neck.
  const neck = new THREE.Group();
  neck.position.y = 1.42;
  rig.add(neck);
  const skull = new THREE.Mesh(track(new RoundedBoxGeometry(1.02, 0.8, 0.8, 5, 0.3)), matHead);
  skull.position.y = 0.4;
  neck.add(skull);
  const visor = new THREE.Mesh(track(new RoundedBoxGeometry(0.8, 0.46, 0.12, 3, 0.12)), matVisor);
  visor.position.set(0, 0.42, 0.36);
  neck.add(visor);

  const eyes = new THREE.Group();
  eyes.position.set(0, 0.44, 0.44);
  neck.add(eyes);
  const eyeGeo = track(new RoundedBoxGeometry(0.15, 0.2, 0.04, 3, 0.05));
  const eyeL = new THREE.Mesh(eyeGeo, matEye);
  eyeL.position.x = -0.2;
  const eyeR = new THREE.Mesh(eyeGeo, matEye);
  eyeR.position.x = 0.2;
  eyes.add(eyeL, eyeR);

  const earGeo = track(new THREE.CylinderGeometry(0.13, 0.13, 0.12, 20));
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, matTrim);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(side * 0.55, 0.4, 0);
    neck.add(ear);
  }

  const mast = new THREE.Mesh(track(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8)), matTrim);
  mast.position.y = 0.95;
  neck.add(mast);
  const tip = new THREE.Mesh(track(new THREE.SphereGeometry(0.085, 16, 12)), matLight);
  tip.position.y = 1.12;
  neck.add(tip);

  // Arms, pivoting at the shoulders. They hang along -Y; a NEGATIVE rotation about X swings the hand forward.
  const armGeo = track(new THREE.CapsuleGeometry(0.09, 0.38, 6, 12));
  const handGeo = track(new THREE.SphereGeometry(0.125, 16, 12));
  const makeArm = (side: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.58, 1.2, 0);
    const limb = new THREE.Mesh(armGeo, matBody);
    limb.position.y = -0.27;
    const hand = new THREE.Mesh(handGeo, matTrim);
    hand.position.y = -0.55;
    pivot.add(limb, hand);
    rig.add(pivot);
    return pivot;
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // ---- accessories ------------------------------------------------------------------------------
  let holdsTray = false;
  let tray: THREE.Group | undefined;
  let badge: THREE.Sprite | undefined;
  if (archetype === "triage") {
    holdsTray = true;
    tray = new THREE.Group();
    tray.position.set(0, 0.97, 0.56);
    const trayMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5 }));
    const base = new THREE.Mesh(track(new RoundedBoxGeometry(1.1, 0.06, 0.55, 3, 0.03)), trayMat);
    tray.add(base);
    const paperMat = track(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.8 }));
    const paperGeo = track(new THREE.BoxGeometry(0.32, 0.012, 0.24));
    for (let i = 0; i < 4; i += 1) {
      const paper = new THREE.Mesh(paperGeo, paperMat);
      paper.position.set(-0.22 + i * 0.015, 0.04 + i * 0.012, 0.02 - i * 0.01);
      paper.rotation.y = (i - 1.5) * 0.12;
      tray.add(paper);
    }
    rig.add(tray);
  } else {
    const spriteMat = track(new THREE.SpriteMaterial({ map: track(glyphTexture(emoji, "#ffffff")), transparent: true, depthWrite: false }));
    badge = new THREE.Sprite(spriteMat);
    badge.scale.set(0.5, 0.5, 0.5);
    badge.position.set(0, 2.95, 0);
    rig.add(badge);
  }

  // Status glyphs: a "!" when it needs a look, a "z" when it is powered down.
  const bangMat = track(new THREE.SpriteMaterial({ map: track(glyphTexture("!", "#f59e0b")), transparent: true, depthWrite: false }));
  const bang = new THREE.Sprite(bangMat);
  bang.scale.setScalar(0.55);
  bang.position.set(0.85, 2.5, 0.2);
  bang.visible = false;
  rig.add(bang);
  const zzzMat = track(new THREE.SpriteMaterial({ map: track(glyphTexture("z", "#94a3b8")), transparent: true, depthWrite: false }));
  const zzz = new THREE.Sprite(zzzMat);
  zzz.scale.setScalar(0.42);
  zzz.visible = false;
  rig.add(zzz);

  // ---- animation --------------------------------------------------------------------------------
  const pose: Pose = { sink: 0, eyeOpen: 1, pitch: 0, yaw: 0, roll: 0, armLx: 0, armRx: 0, armLz: 0, armRz: 0, flame: 1 };
  const statusColor = new THREE.Color(MOOD_COLOR.idle);
  const goalColor = new THREE.Color();
  let blinkIn = 2.5;
  let blinking = 0;
  let bootTimer = 0;
  const phase = ((tint % 997) / 997) * Math.PI * 2;

  const ease = (current: number, to: number, k: number) => current + (to - current) * k;

  /** 1 normally, a sliver while blinking. Never blinks while powered down. */
  function blinkFactor(mood: Mood, dt: number, s: number): number {
    if (mood !== "off") {
      blinkIn -= dt;
      if (blinkIn <= 0) {
        blinking = 0.13;
        blinkIn = 2.4 + ((Math.sin(s * 12.9898) + 1) / 2) * 3.2;
      }
    }
    if (blinking <= 0) return 1;
    blinking -= dt;
    return 0.08;
  }

  /** The visor flickers on before it settles. */
  function bootFactor(t: number, dt: number): number {
    if (bootTimer <= 0) return 1;
    bootTimer -= dt;
    return Math.floor(t * 28) % 3 === 0 ? 0.1 : 1;
  }

  function paintStatus(mood: Mood, s: number, k: number) {
    goalColor.setHex(MOOD_COLOR[mood]);
    statusColor.lerp(goalColor, k);
    matEye.color.copy(statusColor);
    const dim = mood === "off";
    matLight.color.copy(statusColor).multiplyScalar(dim ? 0.25 : 0.78 + Math.sin(s * PULSE_SPEED[mood]) * 0.22);
    tip.scale.setScalar(dim ? 0.7 : 1 + Math.sin(s * TIP_SPEED[mood]) * 0.18);
    matFlame.color.copy(statusColor);
  }

  /** The props and glyphs that depend on the mood: the tray, the badge, the "!" and the "z". */
  function dressProps(mood: Mood, lift: number, s: number, t: number) {
    if (tray) {
      const sort = TRAY_SORT[mood];
      tray.rotation.z = Math.sin(s * 3.1) * 0.13 * sort;
      tray.rotation.x = Math.sin(s * 2.3 + 1) * 0.05 * sort;
      tray.visible = mood !== "off" && mood !== "celebrating";
    }
    if (badge) {
      badge.position.y = 2.95 + lift * 0.5 + Math.sin(s * 1.4) * 0.05;
      (badge.material as THREE.SpriteMaterial).opacity = mood === "off" ? 0.45 : 1;
    }
    bang.visible = mood === "attention";
    if (bang.visible) bang.scale.setScalar(0.5 + Math.abs(Math.sin(s * 6)) * 0.12);
    zzz.visible = mood === "off";
    if (zzz.visible) {
      const cycle = (t * 0.5) % 1;
      zzz.position.set(0.6 + cycle * 0.35, 2.3 + cycle * 0.6, 0.2);
      zzzMat.opacity = Math.sin(cycle * Math.PI);
    }
  }

  function update(mood: Mood, t: number, dt: number, lookX: number, lookY: number) {
    const k = 1 - Math.exp(-dt * 7);
    const s = t + phase;
    const goal = targetsFor(mood, s, lookX, lookY, holdsTray);
    for (const key of EASED) pose[key] = ease(pose[key], goal[key], k);

    const lift = pose.sink + Math.sin(s * goal.bobSpeed) * goal.bobAmp + goal.jump;
    rig.position.y = lift;
    neck.rotation.set(pose.pitch, pose.yaw, pose.roll);
    armL.rotation.set(pose.armLx, 0, pose.armLz);
    armR.rotation.set(pose.armRx, 0, pose.armRz);
    eyes.scale.set(1, Math.max(0.05, pose.eyeOpen * blinkFactor(mood, dt, s) * bootFactor(t, dt)), 1);

    paintStatus(mood, s, k);
    flame.scale.set(1, Math.max(0.001, pose.flame * (1 + Math.sin(t * 34 + phase) * 0.12)), 1);
    flame.visible = pose.flame > 0.05;

    // The shadow shrinks and fades as the body rises.
    const rise = Math.max(0, lift + 0.4);
    shadow.scale.setScalar(1 - Math.min(0.35, rise * 0.25));
    matShadow.opacity = 0.26 - Math.min(0.12, rise * 0.1);

    dressProps(mood, lift, s, t);
  }

  return {
    root,
    update,
    boot: () => {
      bootTimer = 0.8;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}
