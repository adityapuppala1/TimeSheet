/**
 * PLANNER's world: a construction site for a schedule. A big EPIC cube splits into task blocks of
 * different widths; a tower crane picks each block and sets it onto a tilted timeline board, where it
 * becomes a Gantt bar; a thin dependency line links each bar to the one before it; a "today" marker
 * sweeps the calendar; and every so often one bar (and everything after it) is nudged a day or two.
 *
 * Why this shape: the agent's real job is "epic -> child tasks with estimates -> dates -> blueprints",
 * so the diorama shows exactly those verbs in order. Everything the cycle touches is pooled (six
 * blocks, six bars, five links) and built once; update() only moves them. The cycle is one small state
 * machine (rest, split, pick, haul, set, hold, clear) with a function per phase, driven by the seeded
 * RNG so the same agent runs the same shift on every visit. Intensity sets the cadence: on duty it is
 * the today marker and the odd single task, working flat out it is a steady split-place-link-adjust.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";
import { disposer, type Sim } from "./shared";

const EPICS = ["Checkout redesign", "Onboarding flow", "Billing migration", "Mobile app v2", "Reporting overhaul"];
const TASKS = ["Data model", "API contract", "UI build", "Integration", "QA pass", "Docs", "Rollout", "Review", "Migration"];
const HUES = [0x38bdf8, 0xa78bfa, 0x34d399, 0xfbbf24, 0xf472b6, 0xfb923c];

// Board geometry (board-local units: x right, y up, z out of the face).
const W = 1.7;
const H = 1.1;
const DAYS = 10;
const GRID_L = -W / 2 + 0.09;
const DAY_W = (W - 0.18) / DAYS;
const ROW_TOP = H / 2 - 0.22;
const ROW_H = (H - 0.3) / 6;
const TILT = 0.55;
const BOARD_POS = new THREE.Vector3(0.97, 0.52, 0.78);

// Crane and queue layout (sim-group space).
const JIB_Y = 2.75;
const PLANE_Z = 0.78;
const HOME = new THREE.Vector3(-0.2, 2.3, PLANE_Z);
const EPIC_POS = new THREE.Vector3(-1.45, 1.55, PLANE_Z);
const MAX_TASKS = 6;

type Phase = "rest" | "split" | "pick" | "haul" | "set" | "hold" | "clear";

interface Task {
  name: string;
  hue: number;
  start: number;
  len: number;
}

interface Block {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  q: THREE.Vector3;
}

interface Bar {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  flash: THREE.Mesh;
  flashMat: THREE.MeshBasicMaterial;
  x: number;
  tx: number;
  pop: number;
  flashT: number;
  shown: boolean;
}

interface Link {
  mesh: THREE.Mesh;
  grow: number;
  shown: boolean;
}

const dayX = (day: number) => GRID_L + day * DAY_W;
const rowY = (row: number) => ROW_TOP - (row + 0.5) * ROW_H;
const ease = (k: number) => 1 - (1 - k) * (1 - k);

/** Board-local point to sim-group space (the board is tilted about X), without allocating. */
function boardToGroup(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(TILT);
  const s = Math.sin(TILT);
  return out.set(BOARD_POS.x + lx, BOARD_POS.y + ly * c + lz * s, BOARD_POS.z - ly * s + lz * c);
}

/** Paints the calendar: two week columns, day ticks, row guide lines and a header band. */
function makeCalendar(track: <T extends { dispose(): void }>(x: T) => T) {
  const cw = 512;
  const ch = Math.round((cw * H) / W);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext("2d");
  if (g) {
    const px = (lx: number) => ((lx + W / 2) / W) * cw;
    const py = (ly: number) => ((H / 2 - ly) / H) * ch;
    g.fillStyle = "#0f1b33";
    g.fillRect(0, 0, cw, ch);
    for (let w = 0; w < 2; w += 1) {
      g.fillStyle = w === 0 ? "rgba(56,189,248,0.10)" : "rgba(167,139,250,0.10)";
      g.fillRect(px(dayX(w * 5)), py(H / 2 - 0.04), (DAY_W * 5 * cw) / W, py(-H / 2 + 0.04) - py(H / 2 - 0.04));
      g.fillStyle = "rgba(226,232,240,0.8)";
      g.font = "bold 20px sans-serif";
      g.fillText(`WEEK ${w + 1}`, px(dayX(w * 5)) + 8, py(H / 2 - 0.09));
    }
    for (let d = 0; d <= DAYS; d += 1) {
      g.fillStyle = d % 5 === 0 ? "rgba(226,232,240,0.7)" : "rgba(148,163,184,0.4)";
      g.fillRect(px(dayX(d)) - 1, py(ROW_TOP + 0.03), 2, py(rowY(5) - ROW_H / 2) - py(ROW_TOP + 0.03));
    }
    g.fillStyle = "rgba(148,163,184,0.25)";
    for (let r = 0; r <= 6; r += 1) g.fillRect(px(GRID_L), py(ROW_TOP - r * ROW_H) - 1, (DAY_W * DAYS * cw) / W, 2);
  }
  const texture = track(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The epic's face: a plain "EPIC" label so the cube reads as the thing being broken down. */
function makeEpicLabel(track: <T extends { dispose(): void }>(x: T) => T) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  if (g) {
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.font = "bold 40px sans-serif";
    g.textAlign = "center";
    g.fillText("EPIC", 64, 78);
    g.fillRect(24, 92, 80, 5);
  }
  const texture = track(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function plannerSim(seed: number, accent: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();

  // ---- The board: a tilted calendar panel in a frame, with a base so it stands on the platform. ----
  const board = new THREE.Group();
  board.position.copy(BOARD_POS);
  board.rotation.x = -TILT;
  group.add(board);
  const face = new THREE.Mesh(track(new THREE.PlaneGeometry(W, H)), track(new THREE.MeshBasicMaterial({ map: makeCalendar(track) })));
  const frame = new THREE.Mesh(track(new THREE.BoxGeometry(W + 0.08, H + 0.08, 0.04)), track(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.6 })));
  frame.position.z = -0.025;
  board.add(frame, face);
  const footGeo = track(new THREE.BoxGeometry(0.05, 0.4, 0.05));
  const footMat = track(new THREE.MeshStandardMaterial({ color: 0x334155 }));
  for (const fx of [-0.65, 0.65]) {
    const foot = new THREE.Mesh(footGeo, footMat);
    foot.position.set(BOARD_POS.x + fx, 0.18, BOARD_POS.z - 0.36);
    foot.rotation.x = 0.35;
    group.add(foot);
  }

  // ---- Bars, links, flashes (pooled; children of the board so they sit on the grid). ----
  const barGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const flashGeo = track(new THREE.PlaneGeometry(1, 1));
  const bars: Bar[] = [];
  for (let i = 0; i < MAX_TASKS; i += 1) {
    const mat = track(new THREE.MeshStandardMaterial({ color: HUES[i % HUES.length], roughness: 0.45, emissive: HUES[i % HUES.length], emissiveIntensity: 0.25 }));
    const flashMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const mesh = new THREE.Mesh(barGeo, mat);
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.z = 0.7;
    flash.scale.set(1.15, 1.5, 1);
    mesh.add(flash);
    mesh.visible = false;
    board.add(mesh);
    bars.push({ mesh, mat, flash, flashMat, x: 0, tx: 0, pop: 1, flashT: 1, shown: false });
  }
  const linkMat = track(new THREE.MeshBasicMaterial({ color: 0xf8fafc }));
  const linkGeo = track(new THREE.PlaneGeometry(1, 0.016));
  const links: Link[] = [];
  for (let i = 0; i < MAX_TASKS - 1; i += 1) {
    const mesh = new THREE.Mesh(linkGeo, linkMat);
    mesh.position.z = 0.06;
    mesh.visible = false;
    board.add(mesh);
    links.push({ mesh, grow: 0, shown: false });
  }

  // The "today" marker: a bright line with a diamond head that sweeps the calendar.
  const todayMat = track(new THREE.MeshBasicMaterial({ color: 0xfb7185, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const today = new THREE.Group();
  today.add(new THREE.Mesh(track(new THREE.PlaneGeometry(0.025, H - 0.2)), todayMat));
  const todayHead = new THREE.Mesh(track(new THREE.PlaneGeometry(0.085, 0.085)), todayMat);
  todayHead.rotation.z = Math.PI / 4;
  todayHead.position.y = (H - 0.2) / 2;
  today.add(todayHead);
  today.position.z = 0.07;
  board.add(today);
  let todayDay = 0;

  // ---- The epic cube. ----
  const epicMat = track(new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, emissive: accent, emissiveIntensity: 0.3 }));
  const epic = new THREE.Mesh(track(new THREE.BoxGeometry(0.7, 0.7, 0.7)), epicMat);
  epic.position.copy(EPIC_POS);
  const label = new THREE.Mesh(track(new THREE.PlaneGeometry(0.62, 0.62)), track(new THREE.MeshBasicMaterial({ map: makeEpicLabel(track), transparent: true })));
  label.position.z = 0.356;
  epic.add(label);
  group.add(epic);

  // ---- Task blocks (pooled), laid out in two rows under the epic. ----
  const blockGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const blocks: Block[] = [];
  for (let i = 0; i < MAX_TASKS; i += 1) {
    const mat = track(new THREE.MeshStandardMaterial({ color: HUES[i % HUES.length], roughness: 0.45 }));
    const mesh = new THREE.Mesh(blockGeo, mat);
    mesh.visible = false;
    group.add(mesh);
    blocks.push({ mesh, mat, q: new THREE.Vector3(-1.4 + ((i % 3) - 1) * 0.36, 0.95 - Math.floor(i / 3) * 0.34, PLANE_Z) });
  }

  // ---- The tower crane: mast, jib, a trolley that follows the hook, and the cable. ----
  const craneMat = track(new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.5 }));
  const mast = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, JIB_Y, 0.1)), craneMat);
  mast.position.set(1.8, JIB_Y / 2, PLANE_Z);
  const jib = new THREE.Mesh(track(new THREE.BoxGeometry(3.4, 0.08, 0.08)), craneMat);
  jib.position.set(0.1, JIB_Y, PLANE_Z);
  const counter = new THREE.Mesh(track(new THREE.BoxGeometry(0.28, 0.22, 0.2)), track(new THREE.MeshStandardMaterial({ color: 0x64748b })));
  counter.position.set(1.75, JIB_Y - 0.14, PLANE_Z);
  group.add(mast, jib, counter);
  const trolley = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.09, 0.14)), track(new THREE.MeshStandardMaterial({ color: 0x1e293b })));
  group.add(trolley);
  const cableGeo = track(new THREE.BoxGeometry(0.014, 1, 0.014));
  cableGeo.translate(0, -0.5, 0);
  const cable = new THREE.Mesh(cableGeo, track(new THREE.MeshBasicMaterial({ color: 0x94a3b8 })));
  group.add(cable);
  const hookMesh = new THREE.Mesh(track(new THREE.ConeGeometry(0.06, 0.12, 12)), track(new THREE.MeshStandardMaterial({ color: 0xef4444 })));
  hookMesh.rotation.x = Math.PI;
  group.add(hookMesh);

  // ---- State. ----
  const hook = HOME.clone();
  const hookFrom = HOME.clone();
  const hookTo = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  let phase: Phase = "rest";
  let pt = 0;
  let wait = 1.2;
  let idx = 0;
  let adjusted = false;
  let epicName = EPICS[0];
  let tasks: Task[] = [];
  let caption = "Ready to plan";

  function enter(next: Phase) {
    phase = next;
    pt = 0;
    hookFrom.copy(hook);
  }

  /** A fresh work breakdown: each task starts when the previous one ends, with the odd gap. */
  function makePlan(n: number): Task[] {
    const first = Math.floor(rand() * TASKS.length);
    const out: Task[] = [];
    let start = 0;
    for (let i = 0; i < n; i += 1) {
      const room = DAYS - start - (n - 1 - i);
      const len = Math.max(1, Math.min(1 + Math.floor(rand() * 3), room));
      out.push({ name: TASKS[(first + i * 2) % TASKS.length], hue: HUES[(first + i) % HUES.length], start, len });
      start += len + (rand() < 0.4 ? 1 : 0);
      start = Math.min(start, DAYS - (n - 1 - i));
    }
    return out;
  }

  function beginPlan(intensity: number) {
    epicName = EPICS[Math.floor(rand() * EPICS.length)];
    const n = intensity > 0.6 ? 4 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 2);
    tasks = makePlan(n);
    idx = 0;
    adjusted = false;
    blocks.forEach((b, i) => {
      const task = tasks[i];
      b.mesh.visible = false;
      if (!task) return;
      b.mat.color.setHex(task.hue);
      b.mesh.scale.set(0.14 + task.len * 0.07, 0.22, 0.22);
    });
    bars.forEach((b, i) => {
      const task = tasks[i];
      if (task) {
        b.mat.color.setHex(task.hue);
        b.mat.emissive.setHex(task.hue);
      }
    });
    caption = `Breaking “${epicName}” into ${n} task${n === 1 ? "" : "s"}`;
    enter("split");
  }

  function stepSplit(dt: number, speed: number) {
    pt += dt * speed;
    const k = Math.min(1, pt / 1.0);
    tasks.forEach((_, i) => {
      const block = blocks[i];
      const local = Math.min(1, Math.max(0, k * 1.6 - i * 0.12));
      block.mesh.visible = local > 0;
      block.mesh.position.lerpVectors(EPIC_POS, block.q, ease(local));
      block.mesh.rotation.y = (1 - local) * 2;
    });
    if (k >= 1) enter("pick");
  }

  function stepPick(dt: number, speed: number) {
    pt += dt * speed;
    const k = Math.min(1, pt / 0.55);
    scratch.copy(blocks[idx].q);
    scratch.y += 0.3;
    hook.lerpVectors(hookFrom, scratch, ease(k));
    if (k < 1) return;
    caption = idx === 0 ? `Placing “${tasks[0].name}” on the timeline` : `Scheduling “${tasks[idx].name}” after “${tasks[idx - 1].name}”`;
    boardToGroup(dayX(tasks[idx].start + tasks[idx].len / 2), rowY(idx), 0.34, hookTo);
    enter("haul");
  }

  function carry() {
    blocks[idx].mesh.position.set(hook.x, hook.y - 0.28, hook.z);
    blocks[idx].mesh.rotation.y = 0;
  }

  function stepHaul(dt: number, speed: number) {
    pt += dt * speed;
    const k = Math.min(1, pt / 0.95);
    hook.lerpVectors(hookFrom, hookTo, ease(k));
    hook.y += Math.sin(k * Math.PI) * 0.45;
    carry();
    if (k >= 1) enter("set");
  }

  /** The block touches down: it becomes a Gantt bar and a dependency line starts to draw. */
  function place() {
    const task = tasks[idx];
    const bar = bars[idx];
    blocks[idx].mesh.visible = false;
    bar.shown = true;
    bar.x = task.start;
    bar.tx = task.start;
    bar.pop = 0;
    bar.mesh.visible = true;
    if (idx > 0) {
      links[idx - 1].shown = true;
      links[idx - 1].grow = 0;
      links[idx - 1].mesh.visible = true;
    }
    idx += 1;
    enter(idx < tasks.length ? "pick" : "hold");
    if (phase === "hold") caption = tasks.length > 1 ? `Linked ${tasks.length} tasks into a plan for “${epicName}”` : `Scheduled “${tasks[0].name}”`;
  }

  function stepSet(dt: number, speed: number) {
    pt += dt * speed;
    const k = Math.min(1, pt / 0.25);
    hook.copy(hookTo);
    hook.y -= Math.sin(k * Math.PI) * 0.06;
    carry();
    if (k >= 1) place();
  }

  /** Nudges task `j` and everything after it by `delta` days, if that keeps the chain on the grid. */
  function canShift(j: number, delta: number): boolean {
    const before = j > 0 ? tasks[j - 1].start + tasks[j - 1].len : 0;
    const last = tasks[tasks.length - 1];
    return tasks[j].start + delta >= before && last.start + last.len + delta <= DAYS;
  }

  function adjust() {
    adjusted = true;
    const n = tasks.length;
    if (n < 2) return;
    const first = 1 + Math.floor(rand() * (n - 1));
    const deltas = rand() < 0.5 ? [2, -1, 1, -2] : [-2, 1, -1, 2];
    for (let o = 0; o < n - 1; o += 1) {
      const j = 1 + ((first - 1 + o) % (n - 1));
      const delta = deltas.find((d) => canShift(j, d));
      if (delta === undefined) continue;
      for (let m = j; m < n; m += 1) {
        tasks[m].start += delta;
        bars[m].tx = tasks[m].start;
        bars[m].flashT = 0;
      }
      const days = Math.abs(delta);
      caption = `Shifting “${tasks[j].name}” ${delta > 0 ? "later" : "earlier"} by ${days} day${days === 1 ? "" : "s"}`;
      return;
    }
  }

  function stepHold(dt: number, speed: number) {
    pt += dt * speed;
    hook.lerp(HOME, Math.min(1, dt * 2.5));
    if (!adjusted && pt > 1.2) adjust();
    if (pt > 3.4) enter("clear");
  }

  function stepClear(dt: number, speed: number) {
    pt += dt * speed;
    const k = Math.min(1, pt / 0.7);
    hook.lerp(HOME, Math.min(1, dt * 2.5));
    bars.forEach((b) => (b.mesh.scale.y = b.shown ? Math.max(0.001, (1 - k) * ROW_H * 0.72) : b.mesh.scale.y));
    if (k < 1) return;
    hideBoard();
    wait = 0.6;
    enter("rest");
  }

  function hideBoard() {
    for (const b of bars) {
      b.shown = false;
      b.mesh.visible = false;
    }
    for (const l of links) {
      l.shown = false;
      l.mesh.visible = false;
    }
    for (const b of blocks) b.mesh.visible = false;
  }

  function stepRest(dt: number, intensity: number) {
    hook.lerp(HOME, Math.min(1, dt * 2.5));
    wait -= dt;
    if (wait > 0) return;
    wait = 4.5 - intensity * 3.6 + rand() * 0.6;
    beginPlan(intensity);
  }

  function stepPhase(dt: number, intensity: number) {
    const speed = 0.7 + intensity * 0.9;
    if (phase === "rest") stepRest(dt, intensity);
    else if (phase === "split") stepSplit(dt, speed);
    else if (phase === "pick") stepPick(dt, speed);
    else if (phase === "haul") stepHaul(dt, speed);
    else if (phase === "set") stepSet(dt, speed);
    else if (phase === "hold") stepHold(dt, speed);
    else stepClear(dt, speed);
  }

  /** Bars glide to their dates, pop when placed and flash when moved; the links follow the bars. */
  function stepBars(dt: number) {
    for (const b of bars) {
      if (!b.shown) continue;
      const task = tasks[bars.indexOf(b)];
      b.x += (b.tx - b.x) * Math.min(1, dt * 6);
      b.pop = Math.min(1, b.pop + dt * 4);
      b.flashT = Math.min(1, b.flashT + dt * 1.6);
      b.flashMat.opacity = (1 - b.flashT) * 0.75;
      const i = bars.indexOf(b);
      const pop = 1 + Math.sin(b.pop * Math.PI) * 0.3;
      if (phase !== "clear") b.mesh.scale.set(task.len * DAY_W, ROW_H * 0.72 * pop, 0.06);
      else b.mesh.scale.x = task.len * DAY_W;
      b.mesh.position.set(dayX(b.x + task.len / 2), rowY(i), 0.05);
    }
  }

  function stepLinks(dt: number) {
    links.forEach((l, i) => {
      if (!l.shown) return;
      l.grow = Math.min(1, l.grow + dt * 2.2);
      const a = bars[i].mesh.position;
      const b = bars[i + 1].mesh.position;
      const x1 = a.x + (tasks[i].len * DAY_W) / 2;
      const y1 = a.y;
      const x2 = b.x - (tasks[i + 1].len * DAY_W) / 2;
      const dx = x2 - x1;
      const dy = b.y - y1;
      const len = Math.max(0.001, Math.hypot(dx, dy));
      l.mesh.scale.x = len * l.grow;
      l.mesh.position.set(x1 + (dx * l.grow) / 2, y1 + (dy * l.grow) / 2, 0.06);
      l.mesh.rotation.z = Math.atan2(dy, dx);
    });
  }

  function stepHardware(t: number) {
    trolley.position.set(hook.x, JIB_Y - 0.08, PLANE_Z);
    cable.position.set(hook.x, JIB_Y - 0.1, PLANE_Z);
    cable.scale.y = Math.max(0.05, JIB_Y - 0.1 - hook.y);
    hookMesh.position.set(hook.x, hook.y, hook.z);
    epic.rotation.y = Math.sin(t * 0.5) * 0.25;
    epic.position.y = EPIC_POS.y + Math.sin(t * 1.2) * 0.04;
  }

  function stepEpic(dt: number) {
    const busy = phase === "split" || phase === "pick" || phase === "haul" || phase === "set";
    const target = busy ? 0.72 : 1;
    const s = epic.scale.x + (target - epic.scale.x) * Math.min(1, dt * 3);
    epic.scale.setScalar(s);
  }

  function powerDown() {
    hideBoard();
    today.visible = false;
    phase = "rest";
    wait = 0.8;
    hook.copy(HOME);
    caption = "Switched off";
  }

  function update(t: number, dt: number, intensity: number) {
    if (intensity <= 0.05) {
      powerDown();
      stepHardware(t);
      return;
    }
    today.visible = true;
    todayDay = (todayDay + dt * (0.15 + intensity * 0.25)) % DAYS;
    today.position.x = dayX(todayDay);
    stepPhase(dt, intensity);
    stepBars(dt);
    stepLinks(dt);
    stepEpic(dt);
    stepHardware(t);
    if (phase === "rest") caption = intensity > 0.6 ? "Waiting for the next epic" : "Keeping the schedule honest";
  }

  return { group, update, caption: () => caption, dispose: disposeAll };
}
