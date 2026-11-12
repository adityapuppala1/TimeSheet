/**
 * WHAT: one agent's workstation — a round platform with a glowing rim, a nameplate, the character
 * standing on it, and the simulation of the work it does. The engine owns a row of these.
 *
 * THE RIM IS THE STATUS, AT A DISTANCE: it takes the mood colour, so across a room of eight stations
 * you can read which are on, which are working and which need a look before you read a single name.
 * It is the same colour the character's antenna and visor wear.
 *
 * `pulse()` is the "power on" ring that expands from the platform; `burst()` is the confetti when a run
 * has just finished. Both are one-shots owned here so the engine only has to say WHEN.
 */
import * as THREE from "three";
import { AGENT_PALETTE, hashSeed, MOOD_INTENSITY, mulberry32, type Mood, type StationSlot } from "../studio-model";
import { buildCharacter, MOOD_COLOR, type Character } from "./character";
import { buildSim, type Sim } from "./sims/index";
import type { StudioAgent, StudioTheme } from "./types";

const PLATFORM_RADIUS = 2.1;
const CONFETTI = 36;

export interface Station {
  id: string;
  group: THREE.Group;
  /** Invisible, but raycastable: what a click or hover lands on. */
  hit: THREE.Mesh;
  mood: Mood;
  slot: StationSlot;
  update(t: number, dt: number, lookX: number, lookY: number): void;
  setAgent(agent: StudioAgent): void;
  setTheme(theme: StudioTheme): void;
  setSelected(selected: boolean): void;
  caption(): string;
  /** True while anything on this station is still animating — the engine rests when none are. */
  busy(): boolean;
  dispose(): void;
}

function nameplate(name: string, accent: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.roundRect(0, 0, 512, 128, 28);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(0, 0, 22, 128, [28, 0, 0, 28]);
    ctx.fill();
    ctx.fillStyle = "#f8fafc";
    ctx.font = '700 52px system-ui, "Segoe UI", sans-serif';
    ctx.textBaseline = "middle";
    ctx.fillText(name.length > 16 ? `${name.slice(0, 15)}…` : name, 52, 66);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function buildStation(agent: StudioAgent, slot: StationSlot, theme: StudioTheme): Station {
  const tint = AGENT_PALETTE[agent.tint % AGENT_PALETTE.length];
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  group.position.set(slot.x, 0, slot.z);
  group.rotation.y = slot.rotY;

  // Platform.
  const topMat = track(new THREE.MeshStandardMaterial({ color: theme === "dark" ? 0x1e293b : 0xe2e8f0, roughness: 0.7 }));
  const platform = new THREE.Mesh(track(new THREE.CylinderGeometry(PLATFORM_RADIUS, PLATFORM_RADIUS + 0.12, 0.16, 64)), topMat);
  platform.position.y = 0.08;
  group.add(platform);

  const rimMat = track(new THREE.MeshBasicMaterial({ color: MOOD_COLOR[agent.mood], transparent: true, opacity: 0.9 }));
  const rim = new THREE.Mesh(track(new THREE.TorusGeometry(PLATFORM_RADIUS + 0.03, 0.035, 8, 96)), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.17;
  group.add(rim);

  const glowMat = track(new THREE.MeshBasicMaterial({ color: tint.hex, transparent: true, opacity: 0.1, depthWrite: false }));
  const glow = new THREE.Mesh(track(new THREE.CircleGeometry(PLATFORM_RADIUS - 0.2, 64)), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.165;
  group.add(glow);

  // A selection halo: a second, wider ring that only shows for the selected station.
  const haloMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
  const halo = new THREE.Mesh(track(new THREE.RingGeometry(PLATFORM_RADIUS + 0.2, PLATFORM_RADIUS + 0.32, 96)), haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;
  group.add(halo);

  // Nameplate, laid on the platform lip facing the camera.
  const plateTex = track(nameplate(agent.name, tint.css));
  const plate = new THREE.Mesh(track(new THREE.PlaneGeometry(1.7, 0.425)), track(new THREE.MeshBasicMaterial({ map: plateTex, transparent: true })));
  plate.position.set(0, 0.36, PLATFORM_RADIUS + 0.05);
  plate.rotation.x = -0.35;
  group.add(plate);

  // The agent and its world.
  const character: Character = buildCharacter(agent.archetype, tint.hex, agent.emoji);
  character.root.position.set(-0.35, 0.16, -0.1);
  group.add(character.root);
  const sim: Sim = buildSim(agent.archetype, agent.id, tint.hex);
  sim.group.position.y = 0.16;
  group.add(sim.group);

  // One-shot: the ring that expands when an agent powers on.
  const pulseMat = track(new THREE.MeshBasicMaterial({ color: tint.hex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const pulseRing = new THREE.Mesh(track(new THREE.RingGeometry(0.9, 1.0, 64)), pulseMat);
  pulseRing.rotation.x = -Math.PI / 2;
  pulseRing.position.y = 0.2;
  group.add(pulseRing);
  let pulseT = 1;

  // One-shot: confetti.
  const confettiGeo = track(new THREE.BufferGeometry());
  const positions = new Float32Array(CONFETTI * 3);
  const colours = new Float32Array(CONFETTI * 3);
  const velocities = Array.from({ length: CONFETTI }, () => new THREE.Vector3());
  confettiGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  confettiGeo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  const confettiMat = track(new THREE.PointsMaterial({ size: 0.12, vertexColors: true, transparent: true, opacity: 1, depthWrite: false }));
  const confetti = new THREE.Points(confettiGeo, confettiMat);
  confetti.visible = false;
  confetti.frustumCulled = false;
  group.add(confetti);
  let confettiT = 99;

  // The pick proxy.
  const hit = new THREE.Mesh(track(new THREE.CylinderGeometry(PLATFORM_RADIUS, PLATFORM_RADIUS, 3.6, 16)), track(new THREE.MeshBasicMaterial({ visible: false })));
  hit.position.y = 1.8;
  group.add(hit);

  let current = agent;
  let selected = false;
  let haloGoal = 0;
  const rimColor = new THREE.Color(MOOD_COLOR[agent.mood]);
  const goal = new THREE.Color();
  let lastMood: Mood = agent.mood;
  let clock = 0;

  // Seeded per agent and per burst, so a celebration is varied but never random in the unsafe sense.
  let bursts = 0;
  function burst() {
    bursts += 1;
    const rand = mulberry32(hashSeed(agent.id) + bursts);
    const palette = [0xf472b6, 0x38bdf8, 0xfacc15, 0x34d399, 0xa78bfa];
    for (let i = 0; i < CONFETTI; i += 1) {
      positions.set([0, 1.6, 0], i * 3);
      velocities[i].set((rand() - 0.5) * 2.6, 2.2 + rand() * 2.2, (rand() - 0.5) * 2.6);
      const c = new THREE.Color(palette[i % palette.length]);
      colours.set([c.r, c.g, c.b], i * 3);
    }
    (confettiGeo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    confetti.visible = true;
    confettiT = 0;
  }

  function setAgent(next: StudioAgent) {
    if (next.mood !== lastMood) {
      if (lastMood === "off") {
        character.boot();
        pulseT = 0;
      }
      if (next.mood === "celebrating") burst();
      lastMood = next.mood;
    }
    current = next;
  }

  function update(t: number, dt: number, lookX: number, lookY: number) {
    clock = t;
    character.update(current.mood, t, dt, lookX, lookY);
    sim.update(t, dt, MOOD_INTENSITY[current.mood]);

    // Rim and glow follow the mood.
    goal.setHex(MOOD_COLOR[current.mood]);
    rimColor.lerp(goal, 1 - Math.exp(-dt * 6));
    rimMat.color.copy(rimColor);
    rimMat.opacity = current.mood === "off" ? 0.4 : 0.75 + Math.sin(t * 2.2) * 0.15;
    glowMat.opacity = current.mood === "off" ? 0.03 : 0.1 + MOOD_INTENSITY[current.mood] * 0.12;

    haloGoal = selected ? 0.55 + Math.sin(t * 3) * 0.12 : 0;
    haloMat.opacity += (haloGoal - haloMat.opacity) * (1 - Math.exp(-dt * 10));

    if (pulseT < 1) {
      pulseT += dt * 1.1;
      const k = Math.min(1, pulseT);
      pulseRing.scale.setScalar(1 + k * 1.3);
      pulseMat.opacity = (1 - k) * 0.85;
    } else {
      pulseMat.opacity = 0;
    }

    if (confettiT < 2.6) {
      confettiT += dt;
      for (let i = 0; i < CONFETTI; i += 1) {
        const v = velocities[i];
        v.y -= 6.5 * dt;
        positions[i * 3] += v.x * dt;
        positions[i * 3 + 1] += v.y * dt;
        positions[i * 3 + 2] += v.z * dt;
      }
      (confettiGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      confettiMat.opacity = Math.max(0, 1 - confettiT / 2.6);
    } else if (confetti.visible) {
      confetti.visible = false;
    }
  }

  return {
    id: agent.id,
    group,
    hit,
    get mood() {
      return current.mood;
    },
    slot,
    update,
    setAgent,
    setTheme: (next) => topMat.color.setHex(next === "dark" ? 0x1e293b : 0xe2e8f0),
    setSelected: (value) => {
      selected = value;
    },
    caption: () => sim.caption(),
    busy: () => current.mood !== "off" || pulseT < 1 || confettiT < 2.6 || Math.abs(haloMat.opacity - haloGoal) > 0.01 || clock < 0.6,
    dispose: () => {
      character.dispose();
      sim.dispose();
      for (const item of disposables) item.dispose();
    }
  };
}
