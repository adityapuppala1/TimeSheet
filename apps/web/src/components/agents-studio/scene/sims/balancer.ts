/**
 * LOAD BALANCER's world: a capacity see-saw. A two-pan platform scale starts with one pan piled high with
 * coloured booking blocks (hours = height) and the other nearly empty, so the beam is tipped hard over.
 * Blocks are lifted off the heavy pan one at a time, arc over the beam and land on the light pan while the
 * beam springs toward level (with a little overshoot). Three capacity bars beside it show each person's
 * load: a bar turns red past the 100% ring and green when comfortably under. Once everyone is under 100%
 * a fresh booking pops onto a pan and the cycle repeats.
 *
 * Why it looks like this: the agent uses no AI, only arithmetic over real approved hours, so the picture
 * is the arithmetic itself, weights on a scale, rather than a thinking animation. The beam angle and the
 * bar heights are DERIVED from the same block hours (nothing is animated independently), so the bars,
 * beam and blocks can never disagree. Everything is seeded and deterministic per agent.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";
import { disposer, type Sim } from "./shared";

const PEOPLE = ["Asha", "Ben", "Chen"] as const;
const PROJECT_COLORS = [0xf87171, 0xfb923c, 0xfacc15, 0x34d399, 0x38bdf8, 0xa78bfa] as const;
const GREEN = 0x4ade80;
const RED = 0xef4444;

const CAPACITY_HOURS = 32;
const POOL = 14;
const TOTAL_CAP = 44;
const SCALE_X = 1.0;
const SCALE_Z = 0.5;
const BEAM_Y = 1.3;
const BEAM_HALF = 0.62;
const DROP = 0.62;
const MAX_TILT = 0.3;
const BAR_X = 0.75;
const BAR_STEP = 0.45;
const BAR_Z = -0.85;
const BAR_H = 0.95;
const SIDES = [-1, 1] as const;

interface Block {
  mesh: THREE.Mesh;
  hours: number;
  height: number;
  phase: "free" | "rest" | "pop" | "fly" | "retire";
  t: number;
  dest: number;
  from: THREE.Vector3;
  offset: THREE.Vector3;
}

interface Bar {
  fill: THREE.Mesh;
  fillMat: THREE.MeshStandardMaterial;
  shown: number;
}

const tmpA = new THREE.Vector3();
const tmpColor = new THREE.Color();
const GREEN_C = new THREE.Color(GREEN);
const RED_C = new THREE.Color(RED);

function smooth(a: number, b: number, x: number) {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

export function balancerSim(seed: number, _accent: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();
  const metal = track(new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.35, metalness: 0.5 }));
  const dark = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 }));

  // --- The scale: base, pillar, tilting beam, two hanging pans. ---
  const base = new THREE.Mesh(track(new THREE.CylinderGeometry(0.4, 0.46, 0.1, 24)), dark);
  base.position.set(SCALE_X, 0.05, SCALE_Z);
  const pillar = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.09, BEAM_Y, 12)), metal);
  pillar.position.set(SCALE_X, BEAM_Y / 2, SCALE_Z);
  const beam = new THREE.Group();
  beam.position.set(SCALE_X, BEAM_Y, SCALE_Z);
  beam.add(new THREE.Mesh(track(new THREE.BoxGeometry(BEAM_HALF * 2 + 0.1, 0.07, 0.09)), metal));
  beam.add(new THREE.Mesh(track(new THREE.SphereGeometry(0.11, 16, 12)), track(new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.4 }))));
  group.add(base, pillar, beam);

  const wireGeo = track(new THREE.BoxGeometry(0.014, 1, 0.014));
  wireGeo.translate(0, -0.5, 0);
  const panGeo = track(new THREE.CylinderGeometry(0.34, 0.3, 0.05, 28));
  const panMat = track(new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.4, metalness: 0.4 }));
  const wires = SIDES.map(() => new THREE.Mesh(wireGeo, metal));
  const pans = SIDES.map(() => new THREE.Mesh(panGeo, panMat));
  wires.forEach((w) => (w.scale.y = DROP));
  group.add(...wires, ...pans);

  // --- Booking blocks, pooled; one shared unit box, scaled per block. ---
  const blockGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const blockMats = PROJECT_COLORS.map((c) => track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 })));
  const blocks: Block[] = [];
  for (let i = 0; i < POOL; i += 1) {
    const mesh = new THREE.Mesh(blockGeo, blockMats[0]);
    mesh.visible = false;
    group.add(mesh);
    blocks.push({ mesh, hours: 0, height: 0, phase: "free", t: 0, dest: 0, from: new THREE.Vector3(), offset: new THREE.Vector3() });
  }
  const onPan: Block[][] = [[], []];

  // --- Capacity bars. ---
  const bars: Bar[] = [];
  const barBase = new THREE.Mesh(track(new THREE.BoxGeometry(1.4, 0.08, 0.5)), dark);
  barBase.position.set(BAR_X + BAR_STEP, 0.04, BAR_Z);
  group.add(barBase);
  const trackGeo = track(new THREE.CylinderGeometry(0.15, 0.15, BAR_H, 20));
  const trackMat = track(new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.5, transparent: true, opacity: 0.6 }));
  const fillGeo = track(new THREE.CylinderGeometry(0.115, 0.115, 1, 20));
  fillGeo.translate(0, 0.5, 0);
  const ringGeo = track(new THREE.TorusGeometry(0.17, 0.013, 8, 32));
  const ringMat = track(new THREE.MeshBasicMaterial({ color: 0xf8fafc }));
  PEOPLE.forEach((_name, i) => {
    const x = BAR_X + i * BAR_STEP;
    const holder = new THREE.Group();
    holder.position.set(x, 0.08, BAR_Z);
    const tube = new THREE.Mesh(trackGeo, trackMat);
    tube.position.y = BAR_H / 2;
    const fillMat = track(new THREE.MeshStandardMaterial({ color: GREEN, roughness: 0.4, emissive: GREEN, emissiveIntensity: 0.25 }));
    const fill = new THREE.Mesh(fillGeo, fillMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = BAR_H / 1.5;
    holder.add(tube, fill, ring);
    group.add(holder);
    bars.push({ fill, fillMat, shown: 70 });
  });

  // --- State. ---
  let angle = 0;
  let angleVel = 0;
  let waitT = 0.6;
  let driftT = 0;
  let caption = "Checking who has room this week";
  let movingText = "";

  const hoursOf = (pan: number) => onPan[pan].reduce((sum, b) => sum + b.hours, 0);
  const pct = (pan: number) => (hoursOf(pan) * 100) / CAPACITY_HOURS;
  const flying = () => blocks.find((b) => b.phase === "fly");

  /** Where a pan's surface is, given the beam's current angle. */
  function panPoint(pan: number, out: THREE.Vector3) {
    const side = SIDES[pan];
    return out.set(SCALE_X + side * BEAM_HALF * Math.cos(angle), BEAM_Y + side * BEAM_HALF * Math.sin(angle) - DROP + 0.03, SCALE_Z);
  }

  /** Where a block sits on its pan: a 2x2 grid, stacked in layers. */
  function slotOffset(index: number, height: number, out: THREE.Vector3) {
    const col = index % 2;
    const row = Math.floor(index / 2) % 2;
    const layer = Math.floor(index / 4);
    return out.set((col - 0.5) * 0.26, layer * 0.22 + height / 2, (row - 0.5) * 0.26);
  }

  function place(block: Block) {
    block.mesh.position.copy(block.offset);
  }

  function addBlock(pan: number, hours: number) {
    const b = blocks.find((x) => x.phase === "free");
    if (!b) return;
    b.hours = hours;
    b.height = 0.08 + hours * 0.02;
    b.mesh.material = blockMats[Math.floor(rand() * blockMats.length)];
    b.mesh.scale.set(0.22, b.height, 0.22);
    b.phase = "pop";
    b.t = 0;
    slotOffset(onPan[pan].length, b.height, b.offset);
    onPan[pan].push(b);
    b.mesh.visible = true;
  }

  // The shift opens lopsided: the left pan piled high, the right nearly empty.
  for (const h of [8, 6, 5, 8, 4, 6, 5]) addBlock(0, h);
  addBlock(1, 3);
  blocks.forEach((b) => (b.phase = "rest"));
  angle = MAX_TILT;

  const targetAngle = () => Math.max(-1, Math.min(1, (hoursOf(0) - hoursOf(1)) / 28)) * MAX_TILT;

  /** The best block to move: the one that most nearly halves the gap. Null when moving can't help. */
  function pickBlock(heavy: number): Block | null {
    const gap = hoursOf(heavy) - hoursOf(1 - heavy);
    let best: Block | null = null;
    for (const b of onPan[heavy]) {
      if (b.hours >= gap) continue;
      if (!best || Math.abs(b.hours - gap / 2) < Math.abs(best.hours - gap / 2)) best = b;
    }
    return best;
  }

  function startMove(heavy: number, block: Block) {
    const from = pct(heavy);
    const to = pct(1 - heavy);
    onPan[heavy].splice(onPan[heavy].indexOf(block), 1);
    panPoint(heavy, tmpA);
    block.from.copy(tmpA).add(block.offset);
    block.phase = "fly";
    block.t = 0;
    block.dest = 1 - heavy;
    movingText = `Moving an ${block.hours}h booking from ${PEOPLE[heavy]} (${Math.round(from)}%) to ${PEOPLE[1 - heavy]} (${Math.round(to)}%)`;
  }

  /** Overbooked pan found: lift a block off it. Returns false when everyone is fine. */
  function tryRebalance(): boolean {
    const heavy = pct(0) >= pct(1) ? 0 : 1;
    if (pct(heavy) <= 100) return false;
    const block = pickBlock(heavy);
    if (!block) return false;
    startMove(heavy, block);
    return true;
  }

  /** Keeps the shift going: a finished booking leaves and a fresh one pops onto a pan. */
  function introduceImbalance() {
    if (hoursOf(0) + hoursOf(1) > TOTAL_CAP) {
      const pan = rand() < 0.5 ? 0 : 1;
      const gone = onPan[pan].splice(Math.floor(rand() * onPan[pan].length), 1)[0];
      if (gone) {
        gone.phase = "retire";
        gone.t = 0;
      }
    }
    addBlock(hoursOf(0) >= hoursOf(1) ? 0 : 1, 6 + Math.floor(rand() * 3));
  }

  function stepScheduler(dt: number, speed: number) {
    if (flying()) return;
    waitT -= dt * speed;
    if (waitT > 0) return;
    if (tryRebalance()) {
      waitT = 0.25;
    } else {
      introduceImbalance();
      waitT = 2.4;
    }
  }

  function stepFly(b: Block, dt: number, speed: number) {
    b.t += dt * (0.55 + speed * 0.5);
    const k = Math.min(1, b.t);
    const eased = k * k * (3 - 2 * k);
    panPoint(b.dest, tmpA);
    slotOffset(onPan[b.dest].length, b.height, b.offset);
    tmpA.add(b.offset);
    b.mesh.position.lerpVectors(b.from, tmpA, eased);
    b.mesh.position.y += Math.sin(k * Math.PI) * 1.0;
    b.mesh.rotation.y = k * Math.PI;
    if (k < 1) return;
    b.mesh.rotation.y = 0;
    b.phase = "rest";
    onPan[b.dest].push(b);
  }

  function stepRest(b: Block, dt: number, pan: number, index: number) {
    slotOffset(index, b.height, tmpA);
    b.offset.lerp(tmpA, 1 - Math.exp(-dt * 10));
    panPoint(pan, tmpA);
    b.mesh.position.copy(tmpA).add(b.offset);
  }

  function stepPop(b: Block, dt: number, pan: number, index: number) {
    b.t += dt * 3;
    const k = Math.min(1, b.t);
    b.mesh.scale.set(0.22 * k, b.height * k, 0.22 * k);
    stepRest(b, dt, pan, index);
    if (k >= 1) b.phase = "rest";
  }

  function stepRetire(b: Block, dt: number) {
    b.t += dt * 2.5;
    const k = Math.min(1, b.t);
    b.mesh.scale.set(0.22 * (1 - k), b.height * (1 - k), 0.22 * (1 - k));
    b.mesh.position.y += dt * 0.6;
    if (k >= 1) {
      b.phase = "free";
      b.mesh.visible = false;
    }
  }

  function stepBlocks(dt: number, speed: number) {
    for (let pan = 0; pan < 2; pan += 1) {
      onPan[pan].forEach((b, i) => (b.phase === "pop" ? stepPop(b, dt, pan, i) : stepRest(b, dt, pan, i)));
    }
    for (const b of blocks) {
      if (b.phase === "fly") stepFly(b, dt, speed);
      else if (b.phase === "retire") stepRetire(b, dt);
    }
  }

  /** A spring toward the level the block hours dictate: under-damped, so it overshoots a little. */
  function stepBeam(dt: number, t: number, intensity: number) {
    const sway = Math.sin(t * 0.8) * 0.025 * (1 - intensity);
    angleVel += ((targetAngle() + sway - angle) * 34 - angleVel * 4.2) * dt;
    angle += angleVel * dt;
    beam.rotation.z = angle;
    SIDES.forEach((side, i) => {
      const x = SCALE_X + side * BEAM_HALF * Math.cos(angle);
      const y = BEAM_Y + side * BEAM_HALF * Math.sin(angle);
      wires[i].position.set(x, y, SCALE_Z);
      pans[i].position.set(x, y - DROP, SCALE_Z);
    });
  }

  /** Each bar eases toward its person's load; colour goes green to red around the 100% ring. */
  function stepBars(dt: number, t: number) {
    const targets = [pct(0), pct(1), 66 + Math.sin(t * 0.35 + seed) * 7];
    bars.forEach((bar, i) => {
      bar.shown += (targets[i] - bar.shown) * (1 - Math.exp(-dt * 5));
      bar.fill.scale.y = Math.max(0.001, (Math.min(150, bar.shown) / 150) * BAR_H);
      tmpColor.copy(GREEN_C).lerp(RED_C, smooth(88, 104, bar.shown));
      bar.fillMat.color.copy(tmpColor);
      bar.fillMat.emissive.copy(tmpColor);
    });
  }

  function describe() {
    if (flying()) return movingText;
    if (pct(0) <= 100 && pct(1) <= 100) return "Everyone is under 100% — scale is level";
    return "Checking who has room this week";
  }

  function update(t: number, dt: number, intensity: number) {
    if (intensity <= 0.05) {
      caption = "Switched off";
      return;
    }
    const step = Math.min(dt, 0.05);
    driftT += step;
    const speed = 0.4 + intensity * 1.4;
    stepScheduler(step, speed);
    stepBlocks(step, speed);
    stepBeam(step, t, intensity);
    stepBars(step, driftT);
    caption = describe();
  }

  stepBeam(0, 0, 0);
  stepBars(0, 0);
  bars.forEach((b, i) => (b.shown = [pct(0), pct(1), 66][i]));
  blocks.forEach((b) => b.phase !== "free" && place(b));

  return { group, update, caption: () => caption, dispose: disposeAll };
}
