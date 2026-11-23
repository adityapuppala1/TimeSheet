/**
 * WHAT: one agent as a person in the office — a rigged low-poly human (CC0, see
 * public/agents/people/README.txt) with real skeletal animation: breathing idle, a walk cycle whose
 * stride matches WALK_SPEED so feet do not slide, sitting, waving, pointing and cheering, blended with
 * cross-fades so a person rises from a chair rather than snapping upright. Talking opens the mouth
 * (the model's `boca` morph target) in a speech-like rhythm.
 *
 * READABILITY (labels.ts): a screen-sized name tag says who it is AND what it is doing right now; a
 * speech bubble carries a few words; a task card floats over an agent working its zone. Under the feet
 * a soft contact shadow grounds the body and a halo in the MOOD colour says its state from across the
 * room. Hover or selection lifts the body's emissive in the agent's own tint — a cheap highlight that
 * costs no extra render pass.
 *
 * LIFE: every person starts its loops at a different point and runs them at a slightly different
 * speed (seeded), so a room of sitters never breathes in lockstep; the head turns toward whatever the
 * engine says it is looking at (a chat partner, the camera on hover) by rotating the `Cabeca` bone
 * after the animation pose, clamped to a natural range.
 *
 * Models are fetched once per file and CLONED per agent (SkeletonUtils), so two agents never share a
 * skeleton. Materials are cloned too, so one person's highlight never lights another.
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AGENT_PALETTE, hashSeed, MOOD_HEX, mulberry32, type Mood } from "../../agents-studio/studio-model";
import { BUBBLE_H, BUBBLE_W, CARD_H, CARD_W, createBubble, createTag, createTaskCard, TAG_H, TAG_W, type TaskCard } from "./labels";

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
/** Loops that many people play at once — the ones worth de-synchronising. */
const STAGGERED: ReadonlySet<Clip> = new Set(["idle", "sit", "point"]);
/** How far the head may turn from the body, each way (radians). */
const HEAD_LIMIT = 1.0;

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
  /** The task card, exposed so the engine can fill it while the agent works its zone. */
  card: TaskCard;
  play(clip: Clip, fade?: number): void;
  /** Walk-cycle speed as a fraction of full stride, so accelerating feet do not slide. */
  setPace(ratio: number): void;
  setTalking(talking: boolean): void;
  /** A few words or a glyph above the head, or null for none. */
  setBubble(text: string | null): void;
  /** The tag's second line — what it is doing, in two or three words. */
  setStatus(text: string): void;
  setMood(mood: Mood): void;
  /** 0 none, 1 hovered, 2 selected. */
  setEmphasis(level: 0 | 1 | 2): void;
  /** Where the labels hang (world space), for screen-space decluttering. */
  labelAnchor(out: THREE.Vector3): THREE.Vector3;
  /** The label stack's height in px: the tag, plus the bubble or card showing above it. */
  stackHeight(): number;
  /** Raise the label stack by `px` CSS pixels so it clears a neighbour's, and slide it `dx` px sideways
   *  to stay inside the viewport. */
  setLift(px: number, dx?: number): void;
  /** A world point for the head to turn toward, or null to look ahead. */
  lookAt(point: THREE.Vector3 | null): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

/** A soft round shadow texture, shared by everyone — the contact shadow a shadow map is too blurry for. */
let blobTexture: THREE.CanvasTexture | null = null;
let blobUsers = 0;
function acquireBlob(): THREE.CanvasTexture {
  blobUsers += 1;
  if (blobTexture) return blobTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(0.55, "rgba(0,0,0,0.22)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  blobTexture = new THREE.CanvasTexture(canvas);
  return blobTexture;
}
function releaseBlob() {
  blobUsers -= 1;
  if (blobUsers > 0 || !blobTexture) return;
  blobTexture.dispose();
  blobTexture = null;
}

const tmpQ = new THREE.Quaternion();
const tmpParent = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpYaw = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export async function createPerson(file: string, name: string, tintIndex: number, mood: Mood): Promise<Person> {
  const gltf = await loadModel(file);
  const tint = AGENT_PALETTE[tintIndex % AGENT_PALETTE.length];
  const rand = mulberry32(hashSeed(name + file));
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const root = new THREE.Group();
  const body = cloneSkinned(gltf.scene);
  root.add(body);
  let face: THREE.SkinnedMesh | undefined;
  const skins: THREE.MeshStandardMaterial[] = [];
  body.traverse((node) => {
    if (!(node instanceof THREE.SkinnedMesh)) return;
    node.castShadow = true;
    // A skinned mesh's bounds are its rest pose; a seated or waving person would otherwise be culled.
    node.frustumCulled = false;
    face = node;
    const own = (m: THREE.Material) => {
      const copy = track(m.clone());
      if (copy instanceof THREE.MeshStandardMaterial) skins.push(copy);
      return copy;
    };
    node.material = Array.isArray(node.material) ? node.material.map(own) : own(node.material);
  });
  const mouth = face?.morphTargetDictionary?.boca;
  const head = body.getObjectByName("Cabeca") ?? null;

  // Animation: one action per clip, cross-faded; looping clips de-synchronised per person.
  const mixer = new THREE.AnimationMixer(body);
  const actions = new Map<Clip, THREE.AnimationAction>();
  const tempo = 0.9 + rand() * 0.2;
  for (const clip of Object.keys(CLIP_NAME) as Clip[]) {
    const source = THREE.AnimationClip.findByName(gltf.animations, CLIP_NAME[clip]);
    if (source) actions.set(clip, mixer.clipAction(source));
  }
  let current: Clip | null = null;

  // Contact shadow and mood halo, flat on the floor.
  const blob = new THREE.Mesh(
    track(new THREE.PlaneGeometry(1.1, 1.1)),
    track(new THREE.MeshBasicMaterial({ map: acquireBlob(), transparent: true, depthWrite: false, toneMapped: false }))
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  blob.renderOrder = 1;
  const haloMat = track(new THREE.MeshBasicMaterial({ color: MOOD_HEX[mood], transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
  const halo = new THREE.Mesh(track(new THREE.RingGeometry(0.34, 0.42, 40)), haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;
  halo.renderOrder = 2;
  root.add(blob, halo);

  const tag = createTag(name, tint.css);
  const bubble = createBubble();
  const card = createTaskCard(Math.floor(rand() * 1000));
  // Stacked in screen space above the same anchor: tag, then bubble / card above it (offsets in px).
  let slideX = 0;
  const stackAt = (lift: number) => {
    tag.sprite.center.x = 0.5 - slideX / TAG_W;
    card.sprite.center.x = 0.5 - slideX / CARD_W;
    bubble.sprite.center.x = 0.5 - slideX / BUBBLE_W;
    tag.sprite.center.y = -lift / TAG_H;
    bubble.sprite.center.y = -(lift + TAG_H + 8) / BUBBLE_H;
    card.sprite.center.y = -(lift + TAG_H + 8) / CARD_H;
  };
  let lift = 0;
  let liftWanted = 0;
  stackAt(0);
  const anchor = new THREE.Group();
  anchor.position.y = 2.05;
  anchor.add(tag.sprite, bubble.sprite, card.sprite);
  root.add(anchor);

  const hit = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.34, 1.2, 4, 8)), track(new THREE.MeshBasicMaterial({ visible: false })));
  hit.position.y = 0.95;
  root.add(hit);

  let talking = false;
  let emphasis: 0 | 1 | 2 = 0;
  let seated = false;
  let status = "";
  let moodNow = mood;
  let look: THREE.Vector3 | null = null;
  let headYaw = 0;
  let glow = 0;

  const redrawTag = () => tag.set(status, moodNow, emphasis > 0);

  /** Turn the head toward `look` on top of the animated pose, smoothly and within a natural range. */
  function turnHead(dt: number) {
    if (!head?.parent) return;
    let want = 0;
    if (look) {
      root.getWorldPosition(tmpV);
      const toward = Math.atan2(look.x - tmpV.x, look.z - tmpV.z);
      let d = (toward - root.rotation.y) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      want = Math.max(-HEAD_LIMIT, Math.min(HEAD_LIMIT, d));
    }
    headYaw += (want - headYaw) * Math.min(1, dt * 5);
    if (Math.abs(headYaw) < 0.002) return;
    // Rotate about WORLD up, whatever the bone's own axes are: world = yaw · world, back to local.
    head.parent.updateWorldMatrix(true, false);
    head.parent.getWorldQuaternion(tmpParent);
    head.getWorldQuaternion(tmpQ);
    tmpQ.premultiply(tmpYaw.setFromAxisAngle(UP, headYaw));
    head.quaternion.copy(tmpParent.invert().multiply(tmpQ));
  }

  redrawTag();

  return {
    root,
    hit,
    card,
    play(clip, fade = 0.3) {
      if (clip === current) return;
      const next = actions.get(clip);
      if (!next) return;
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      next.timeScale = STAGGERED.has(clip) ? tempo : 1;
      if (STAGGERED.has(clip)) next.time = rand() * next.getClip().duration;
      if (current) actions.get(current)?.fadeOut(fade);
      current = clip;
      seated = clip === "sit";
    },
    setPace(ratio) {
      const walk = actions.get("walk");
      if (walk) walk.timeScale = Math.max(0.25, ratio);
    },
    setTalking(value) {
      talking = value;
    },
    setBubble(text) {
      bubble.set(text);
    },
    setStatus(text) {
      status = text;
      redrawTag();
    },
    setMood(next) {
      moodNow = next;
      haloMat.color.setHex(MOOD_HEX[next]);
      redrawTag();
    },
    setEmphasis(level) {
      emphasis = level;
      redrawTag();
    },
    labelAnchor(out) {
      return anchor.getWorldPosition(out);
    },
    stackHeight() {
      const above = Math.max(bubble.sprite.visible ? BUBBLE_H : 0, card.sprite.visible ? CARD_H : 0);
      return TAG_H + (above ? above + 8 : 0);
    },
    setLift(px, dx = 0) {
      liftWanted = px;
      if (Math.abs(dx - slideX) > 0.5) {
        slideX = dx;
        stackAt(lift);
      }
    },
    lookAt(point) {
      look = point;
    },
    update(dt, t) {
      mixer.update(dt);
      turnHead(dt);
      if (face && mouth !== undefined && face.morphTargetInfluences) {
        // Speech rhythm: two overlapping beats, so the mouth is not a metronome.
        const open = talking ? Math.max(0, Math.sin(t * 13) * 0.5 + Math.sin(t * 7.3) * 0.4 + 0.25) : 0;
        face.morphTargetInfluences[mouth] += (Math.min(1, open) - face.morphTargetInfluences[mouth]) * Math.min(1, dt * 18);
      }
      // The labels ride lower over someone sitting down.
      const anchorY = seated ? 1.62 : 2.05;
      anchor.position.y += (anchorY - anchor.position.y) * Math.min(1, dt * 8);
      if (Math.abs(liftWanted - lift) > 0.5) {
        lift += (liftWanted - lift) * Math.min(1, dt * 10);
        stackAt(lift);
      }
      tag.update();
      bubble.update(t);
      card.update(t, dt);
      // Halo: breathes while working or asking for help, brightest when selected.
      const live = moodNow === "working" || moodNow === "attention";
      const pulse = live ? 0.5 + 0.5 * Math.sin(t * 3.2) : 0;
      haloMat.opacity = (emphasis === 2 ? 0.9 : 0.5) + pulse * 0.3;
      halo.scale.setScalar((emphasis === 2 ? 1.35 : 1) + pulse * 0.12);
      // Highlight: the body's emissive in the agent's tint.
      const wantGlow = [0, 0.18, 0.3][emphasis];
      if (Math.abs(wantGlow - glow) > 0.002) {
        glow += (wantGlow - glow) * Math.min(1, dt * 10);
        for (const m of skins) {
          m.emissive.setHex(tint.hex);
          m.emissiveIntensity = glow;
        }
      }
    },
    dispose() {
      mixer.stopAllAction();
      tag.dispose();
      bubble.dispose();
      card.dispose();
      releaseBlob();
      for (const item of disposables) item.dispose();
    }
  };
}
