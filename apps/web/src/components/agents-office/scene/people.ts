/**
 * WHAT: one agent as a person in the office — a rigged low-poly human (CC0, see
 * public/agents/people/README.txt) with real skeletal animation: breathing idle, a walk cycle whose
 * stride matches WALK_SPEED so feet do not slide, sitting, waving, pointing and cheering, blended with
 * cross-fades so a person rises from a chair rather than snapping upright. Talking opens the mouth
 * (the model's `boca` morph target) in a speech-like rhythm.
 *
 * WHY EVERY AGENT IS A DIFFERENT PERSON, WITH A NAME TAG: the eight models are distinct people, cast one
 * per agent (office-model.ts `castPeople`), and each wears a floating tag in the agent's own tint with
 * its mood colour — so identity and state read from across the room without relying on a face.
 *
 * Models are fetched once per file and CLONED per agent (SkeletonUtils), so two agents never share a
 * skeleton. Loaded only through the office engine's dynamic import.
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AGENT_PALETTE, moodCss, type Mood } from "../../agents-studio/studio-model";

export type Clip = "idle" | "walk" | "sit" | "wave" | "point" | "cheer";

/** The pack's clip names (Portuguese) for each thing a person does here. */
const CLIP_NAME: Readonly<Record<Clip, string>> = {
  idle: "parado",
  walk: "andar",
  sit: "sentar",
  wave: "acenar",
  point: "apontar",
  cheer: "comemorar"
};

const cache = new Map<string, Promise<GLTF>>();

function loadModel(file: string): Promise<GLTF> {
  let pending = cache.get(file);
  if (!pending) {
    pending = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}agents/people/${file}.glb`);
    cache.set(file, pending);
  }
  return pending;
}

export interface Person {
  root: THREE.Group;
  /** Invisible, raycastable body — what a click or hover lands on. */
  hit: THREE.Mesh;
  play(clip: Clip, fade?: number): void;
  setTalking(talking: boolean): void;
  /** A one-glyph thought above the head ("☕", "!", "…"), or null for none. */
  setBubble(glyph: string | null): void;
  setMood(mood: Mood): void;
  setSelected(selected: boolean): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** The name tag: a dark pill with the agent's tint on the left edge and its mood as a dot. */
function drawTag(canvas: HTMLCanvasElement, name: string, tint: string, mood: Mood) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(15,23,42,0.92)";
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 30);
  ctx.fillStyle = tint;
  roundRect(ctx, 0, 0, 20, canvas.height, 10);
  ctx.fillStyle = moodCss(mood);
  ctx.beginPath();
  ctx.arc(canvas.width - 36, canvas.height / 2, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f8fafc";
  ctx.font = '600 34px system-ui, "Segoe UI", sans-serif';
  ctx.textBaseline = "middle";
  ctx.fillText(name.length > 15 ? `${name.slice(0, 14)}…` : name, 36, canvas.height / 2 + 2);
}

function drawBubble(canvas: HTMLCanvasElement, glyph: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  roundRect(ctx, 8, 8, 112, 92, 28);
  ctx.beginPath();
  ctx.moveTo(40, 96);
  ctx.lineTo(34, 124);
  ctx.lineTo(66, 98);
  ctx.fill();
  ctx.fillStyle = "#0f172a";
  ctx.font = '600 54px "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, 64, 56);
}

export async function createPerson(file: string, name: string, tintIndex: number, mood: Mood): Promise<Person> {
  const gltf = await loadModel(file);
  const tint = AGENT_PALETTE[tintIndex % AGENT_PALETTE.length];
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const root = new THREE.Group();
  const body = cloneSkinned(gltf.scene);
  root.add(body);
  let face: THREE.SkinnedMesh | undefined;
  body.traverse((node) => {
    if (node instanceof THREE.SkinnedMesh) {
      node.castShadow = true;
      // A skinned mesh's bounds are its rest pose; a seated or waving person would otherwise be culled.
      node.frustumCulled = false;
      face = node;
    }
  });
  const mouth = face?.morphTargetDictionary?.boca;

  // Animation: one action per clip, cross-faded.
  const mixer = new THREE.AnimationMixer(body);
  const actions = new Map<Clip, THREE.AnimationAction>();
  for (const clip of Object.keys(CLIP_NAME) as Clip[]) {
    const source = THREE.AnimationClip.findByName(gltf.animations, CLIP_NAME[clip]);
    if (source) actions.set(clip, mixer.clipAction(source));
  }
  let current: Clip | null = null;

  // A ring on the floor in the agent's tint; brighter when selected.
  const ringMat = track(new THREE.MeshBasicMaterial({ color: tint.hex, transparent: true, opacity: 0.55, depthWrite: false }));
  const ring = new THREE.Mesh(track(new THREE.RingGeometry(0.3, 0.38, 32)), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  root.add(ring);

  // Name tag.
  const tagCanvas = document.createElement("canvas");
  tagCanvas.width = 384;
  tagCanvas.height = 72;
  drawTag(tagCanvas, name, tint.css, mood);
  const tagTex = track(new THREE.CanvasTexture(tagCanvas));
  tagTex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthTest: false })));
  tag.scale.set(1.15, 0.215, 1);
  tag.position.y = 2.12;
  tag.renderOrder = 10;
  root.add(tag);

  // Thought bubble.
  const bubbleCanvas = document.createElement("canvas");
  bubbleCanvas.width = 128;
  bubbleCanvas.height = 128;
  const bubbleTex = track(new THREE.CanvasTexture(bubbleCanvas));
  bubbleTex.colorSpace = THREE.SRGBColorSpace;
  const bubble = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: bubbleTex, transparent: true, depthTest: false })));
  bubble.scale.set(0.5, 0.5, 1);
  bubble.position.set(0.35, 2.55, 0);
  bubble.renderOrder = 11;
  bubble.visible = false;
  root.add(bubble);
  let glyphShown: string | null = null;

  const hit = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.34, 1.2, 4, 8)), track(new THREE.MeshBasicMaterial({ visible: false })));
  hit.position.y = 0.95;
  root.add(hit);

  let talking = false;
  let selected = false;
  let seated = false;

  return {
    root,
    hit,
    play(clip, fade = 0.3) {
      if (clip === current) return;
      const next = actions.get(clip);
      if (!next) return;
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      if (current) actions.get(current)?.fadeOut(fade);
      current = clip;
      seated = clip === "sit";
    },
    setTalking(value) {
      talking = value;
    },
    setBubble(glyph) {
      if (glyph === glyphShown) return;
      glyphShown = glyph;
      bubble.visible = glyph !== null;
      if (glyph !== null) {
        drawBubble(bubbleCanvas, glyph);
        bubbleTex.needsUpdate = true;
      }
    },
    setMood(next) {
      drawTag(tagCanvas, name, tint.css, next);
      tagTex.needsUpdate = true;
    },
    setSelected(value) {
      selected = value;
    },
    update(dt, t) {
      mixer.update(dt);
      if (face && mouth !== undefined && face.morphTargetInfluences) {
        // Speech rhythm: two overlapping beats, so the mouth is not a metronome.
        const open = talking ? Math.max(0, Math.sin(t * 13) * 0.5 + Math.sin(t * 7.3) * 0.4 + 0.25) : 0;
        face.morphTargetInfluences[mouth] += (Math.min(1, open) - face.morphTargetInfluences[mouth]) * Math.min(1, dt * 18);
      }
      // The tag and bubble sit lower over someone who is sitting down.
      const lift = seated ? -0.42 : 0;
      tag.position.y += (2.12 + lift - tag.position.y) * Math.min(1, dt * 8);
      bubble.position.y = tag.position.y + 0.43 + Math.sin(t * 2.4) * 0.03;
      ringMat.opacity = selected ? 0.75 + Math.sin(t * 4) * 0.2 : 0.4;
      ring.scale.setScalar(selected ? 1.5 : 1);
    },
    dispose() {
      mixer.stopAllAction();
      for (const item of disposables) item.dispose();
    }
  };
}
