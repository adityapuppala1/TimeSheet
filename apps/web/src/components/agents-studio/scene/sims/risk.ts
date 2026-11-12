/**
 * RISK WATCH's world: a risk observatory. A radar scope sweeps and pings blips (mostly calm, a few red),
 * a half-circle gauge needle eases to a new score every few seconds, a line chart ribbon rolls with the
 * gauge, and when the needle crosses into the red a shield token rises off the scope and docks on a
 * "drafted" tray — the agent drafting a mitigation for a human to accept.
 *
 * Why it looks like this: the real agent only NARRATES a score it cannot change ("the score itself is
 * arithmetic"), so the needle is the star and everything else reacts to it. The scope lies tilted toward
 * the camera in front, the gauge and chart stand on an upright panel at the back right, so nothing hides
 * behind the character. All numbers are a seeded illustration (mulberry32), never real project data.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";
import { disposer, type Sim } from "./shared";

type Track = <T extends { dispose(): void }>(item: T) => T;

const PROJECTS = ["Atlas", "Beacon", "Meridian", "Nimbus", "Orion"];
const CAUSES_UP = ["3 overdue tasks", "2 blocked dependencies", "a slipped milestone", "burn running ahead of plan", "a key reviewer on leave"];
const CAUSES_DOWN = ["the backlog was re-scoped", "2 blockers cleared", "the milestone landed", "burn back on plan"];

const AMBER_AT = 0.45;
const RED_AT = 0.72;
const SCOPE_R = 0.7;
const TRAIL = 10;
const TRAIL_STEP = 0.075;
const CHART_N = 28;
const CHART_W = 1.2;
const CHART_H = 0.5;
const CHART_Y = -0.85;
const SCOPE_POS = new THREE.Vector3(0.7, 0.55, 1.2);
const TRAY_POS = new THREE.Vector3(1.62, 0.12, 0.5);
const COLOR_CALM = 0x5eead4;
const COLOR_RED = 0xf87171;

function basic(track: Track, color: number, opacity = 1, additive = false) {
  return track(
    new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1 || additive,
      opacity,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide
    })
  );
}

interface Blip {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
}

/** The scope: dark disc, range rings, a rotating sweep with a fading trail, and a pool of blips. */
function buildScope(track: Track, accent: number) {
  const group = new THREE.Group();
  group.position.copy(SCOPE_POS);
  group.rotation.x = -0.9;
  group.scale.setScalar(0.85);

  const face = new THREE.Mesh(track(new THREE.CircleGeometry(SCOPE_R, 48)), track(new THREE.MeshBasicMaterial({ color: 0x07131d })));
  const rimMesh = new THREE.Mesh(track(new THREE.TorusGeometry(SCOPE_R + 0.03, 0.04, 8, 48)), track(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 })));
  group.add(face, rimMesh);

  const lineMat = basic(track, 0x2dd4bf, 0.45);
  for (const r of [0.23, 0.46, 0.69]) {
    const ring = new THREE.Mesh(track(new THREE.RingGeometry(r - 0.007, r + 0.007, 64)), lineMat);
    ring.position.z = 0.01;
    group.add(ring);
  }
  const crossGeo = track(new THREE.PlaneGeometry(SCOPE_R * 2, 0.012));
  for (const rot of [0, Math.PI / 2]) {
    const cross = new THREE.Mesh(crossGeo, lineMat);
    cross.rotation.z = rot;
    cross.position.z = 0.01;
    group.add(cross);
  }

  const pivot = new THREE.Group();
  pivot.position.z = 0.02;
  const sliverGeo = track(new THREE.CircleGeometry(SCOPE_R, 4, 0, TRAIL_STEP));
  for (let k = 0; k < TRAIL; k += 1) {
    const fade = 1 - k / TRAIL;
    const sliver = new THREE.Mesh(sliverGeo, basic(track, accent, 0.5 * fade * fade, true));
    sliver.rotation.z = -(k + 1) * TRAIL_STEP;
    pivot.add(sliver);
  }
  const line = new THREE.Mesh(track(new THREE.PlaneGeometry(SCOPE_R, 0.02)), basic(track, 0xe0fffa, 0.95, true));
  line.position.set(SCOPE_R / 2, 0, 0.005);
  pivot.add(line);
  group.add(pivot);

  const blipGeo = track(new THREE.CircleGeometry(0.045, 12));
  const blips: Blip[] = [];
  for (let i = 0; i < 16; i += 1) {
    const mat = basic(track, COLOR_CALM, 1, true);
    const mesh = new THREE.Mesh(blipGeo, mat);
    mesh.position.z = 0.04;
    mesh.visible = false;
    group.add(mesh);
    blips.push({ mesh, mat, age: 1, life: 1 });
  }

  const pedestal = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.34, 0.5, 20)), track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 })));
  pedestal.position.set(SCOPE_POS.x, 0.22, SCOPE_POS.z);
  pedestal.scale.setScalar(0.85);
  return { group, pivot, blips, pedestal };
}

/** The upright panel: a half-circle gauge (green→amber→red, ticks, needle) over a rolling line chart. */
function buildPanel(track: Track, accent: number) {
  const panel = new THREE.Group();
  panel.position.set(1.05, 1.15, -0.75);
  panel.rotation.y = -0.4;

  const frameMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.55 }));
  const back = new THREE.Mesh(track(new THREE.BoxGeometry(1.5, 1.9, 0.06)), frameMat);
  const inset = new THREE.Mesh(track(new THREE.PlaneGeometry(1.4, 1.8)), track(new THREE.MeshBasicMaterial({ color: 0x0b1220 })));
  inset.position.z = 0.035;
  const foot = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.2, 0.25)), frameMat);
  foot.position.y = -1.05;
  panel.add(back, inset, foot);

  const gauge = new THREE.Group();
  gauge.position.set(0, 0.3, 0.05);
  const zones: Array<[number, number, number]> = [
    [0x4ade80, 0, AMBER_AT],
    [0xfbbf24, AMBER_AT, RED_AT],
    [0xf87171, RED_AT, 1]
  ];
  for (const [color, from, to] of zones) {
    const start = Math.PI * (1 - to);
    gauge.add(new THREE.Mesh(track(new THREE.RingGeometry(0.42, 0.56, 24, 1, start, Math.PI * (to - from))), basic(track, color)));
  }
  const tickGeo = track(new THREE.BoxGeometry(0.02, 0.07, 0.01));
  const tickMat = basic(track, 0x94a3b8);
  for (let i = 0; i <= 10; i += 1) {
    const a = Math.PI * (1 - i / 10);
    const tick = new THREE.Mesh(tickGeo, tickMat);
    tick.position.set(Math.cos(a) * 0.37, Math.sin(a) * 0.37, 0.005);
    tick.rotation.z = a - Math.PI / 2;
    gauge.add(tick);
  }
  const needle = new THREE.Group();
  needle.position.z = 0.02;
  const blade = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.035, 0.015)), basic(track, 0xf8fafc));
  blade.position.x = 0.25;
  const hub = new THREE.Mesh(track(new THREE.CircleGeometry(0.06, 16)), basic(track, 0xf8fafc));
  needle.add(blade, hub);
  gauge.add(needle);
  panel.add(gauge);

  return { panel, needle, chart: buildChart(track, panel, accent) };
}

/** The chart ribbon: a triangle strip whose vertices are rewritten in place — no per-frame allocation. */
function buildChart(track: Track, panel: THREE.Group, accent: number) {
  const bg = new THREE.Mesh(track(new THREE.PlaneGeometry(CHART_W + 0.1, CHART_H + 0.14)), basic(track, 0x111c30));
  bg.position.set(0, CHART_Y + CHART_H / 2, 0.045);
  panel.add(bg);
  const threshold = new THREE.Mesh(track(new THREE.PlaneGeometry(CHART_W, 0.012)), basic(track, COLOR_RED, 0.55));
  threshold.position.set(0, CHART_Y + RED_AT * CHART_H, 0.05);
  panel.add(threshold);

  const positions = new Float32Array(CHART_N * 2 * 3);
  const geo = track(new THREE.BufferGeometry());
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const index: number[] = [];
  for (let i = 0; i < CHART_N - 1; i += 1) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geo.setIndex(index);
  const strip = new THREE.Mesh(geo, basic(track, accent));
  strip.position.z = 0.055;
  strip.frustumCulled = false;
  panel.add(strip);
  const dot = new THREE.Mesh(track(new THREE.CircleGeometry(0.05, 12)), basic(track, 0xffffff));
  dot.position.z = 0.06;
  panel.add(dot);

  const history = new Float32Array(CHART_N);
  function write() {
    for (let i = 0; i < CHART_N; i += 1) {
      const x = -CHART_W / 2 + (CHART_W * i) / (CHART_N - 1);
      const y = CHART_Y + history[i] * CHART_H;
      positions.set([x, y + 0.016, 0, x, y - 0.016, 0], i * 6);
    }
    geo.attributes.position.needsUpdate = true;
    dot.position.set(CHART_W / 2, CHART_Y + history[CHART_N - 1] * CHART_H, 0.06);
  }
  return { history, write };
}

interface Token {
  mesh: THREE.Mesh;
  phase: "free" | "fly" | "docked";
  t: number;
  slot: number;
}

/** The "drafted" tray and the pool of shield tokens that dock on it. */
function buildTray(track: Track) {
  const group = new THREE.Group();
  group.position.copy(TRAY_POS);
  group.add(new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 0.06, 0.36)), track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.55 }))));
  const edge = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 0.02, 0.03)), basic(track, 0x4ade80));
  edge.position.set(0, 0.035, 0.17);
  group.add(edge);

  const shape = new THREE.Shape();
  shape.moveTo(-0.12, 0.12);
  shape.lineTo(0.12, 0.12);
  shape.lineTo(0.12, -0.02);
  shape.quadraticCurveTo(0.12, -0.12, 0, -0.17);
  shape.quadraticCurveTo(-0.12, -0.12, -0.12, -0.02);
  shape.closePath();
  const geo = track(new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false }));
  const mat = track(new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.35, emissive: 0x166534, emissiveIntensity: 0.6 }));
  const tokens: Token[] = [];
  for (let i = 0; i < 4; i += 1) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    tokens.push({ mesh, phase: "free", t: 0, slot: i });
  }
  return { group, tokens };
}

const dockPos = (slot: number, out: THREE.Vector3) => out.set(TRAY_POS.x - 0.24 + slot * 0.16, TRAY_POS.y + 0.2, TRAY_POS.z);

export function riskSim(seed: number, accent: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();

  const scope = buildScope(track, accent);
  const { panel, needle, chart } = buildPanel(track, accent);
  const tray = buildTray(track);
  group.add(scope.group, scope.pedestal, panel, tray.group);
  for (const token of tray.tokens) group.add(token.mesh);

  for (let i = 0; i < CHART_N; i += 1) chart.history[i] = 0.25 + rand() * 0.15;
  chart.write();

  let sweep = rand() * Math.PI * 2;
  let value = 0.3;
  let target = 0.3;
  let holdIn = 1.5;
  let blipIn = 0.3;
  let chartIn = 0;
  let nextSlot = 0;
  let off = false;
  let live = "Watching the score — all calm";
  const dockFrom = new THREE.Vector3();
  const dockTo = new THREE.Vector3();

  function score(v: number) {
    return Math.round(v * 100);
  }

  function pick<T>(items: T[]) {
    return items[Math.floor(rand() * items.length)];
  }

  /** Chooses the next score and the sentence that explains the move. */
  function retarget(intensity: number) {
    const previous = target;
    const spike = rand() < intensity * intensity * 0.8;
    target = spike ? RED_AT + 0.05 + rand() * (0.96 - RED_AT) : 0.15 + rand() * 0.4;
    holdIn = 6 - intensity * 4.4 + rand() * 1.4;
    live = explain(previous, target);
  }

  function explain(previous: number, next: number) {
    const project = pick(PROJECTS);
    const points = Math.abs(score(next) - score(previous));
    if (next >= RED_AT) return "Needle in the red — drafting a mitigation";
    if (previous >= RED_AT) return next >= AMBER_AT ? "Back to amber after the re-plan" : `Back in the green — ${pick(CAUSES_DOWN)} on ${project}`;
    if (next >= previous) return `Risk score up ${points} points — ${pick(CAUSES_UP)} on ${project}`;
    return `Risk score down ${points} points — ${pick(CAUSES_DOWN)} on ${project}`;
  }

  function spawnBlip(intensity: number) {
    const blip = scope.blips.find((b) => b.age >= b.life);
    if (!blip) return;
    const angle = sweep - rand() * 0.12;
    const radius = 0.14 + rand() * 0.5;
    blip.mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.04);
    blip.mat.color.setHex(rand() < 0.16 + intensity * 0.1 ? COLOR_RED : COLOR_CALM);
    blip.age = 0;
    blip.life = 1.4 + rand() * 0.9;
    blip.mesh.visible = true;
  }

  function stepScope(dt: number, intensity: number) {
    sweep = (sweep + dt * (0.9 + intensity * 3.2)) % (Math.PI * 2);
    scope.pivot.rotation.z = sweep;
    blipIn -= dt;
    if (blipIn <= 0) {
      spawnBlip(intensity);
      blipIn = 1.2 - intensity * 0.95 + rand() * 0.3;
    }
    for (const blip of scope.blips) {
      if (blip.age >= blip.life) continue;
      blip.age += dt;
      const k = Math.min(1, blip.age / blip.life);
      blip.mat.opacity = 1 - k;
      blip.mesh.scale.setScalar(1 + (1 - k) * 0.6);
      if (k >= 1) blip.mesh.visible = false;
    }
  }

  function launchToken() {
    const token = tray.tokens[nextSlot];
    token.slot = nextSlot;
    nextSlot = (nextSlot + 1) % tray.tokens.length;
    token.phase = "fly";
    token.t = 0;
    token.mesh.visible = true;
  }

  function stepGauge(dt: number, intensity: number) {
    holdIn -= dt;
    if (holdIn <= 0) retarget(intensity);
    const before = value;
    value += (target - value) * Math.min(1, dt * (1.6 + intensity * 3));
    if (before < RED_AT && value >= RED_AT) launchToken();
  }

  function stepChart(dt: number, intensity: number) {
    chartIn -= dt;
    if (chartIn <= 0) {
      chart.history.copyWithin(0, 1);
      chartIn = 0.5 - intensity * 0.3;
    }
    chart.history[CHART_N - 1] = value;
    chart.write();
  }

  function flyToken(token: Token, dt: number) {
    token.t += dt;
    const k = Math.min(1, token.t / 1.5);
    const rise = Math.min(1, k / 0.4);
    const run = Math.max(0, (k - 0.4) / 0.6);
    dockPos(token.slot, dockTo);
    dockFrom.set(SCOPE_POS.x, SCOPE_POS.y + 1.0, SCOPE_POS.z);
    token.mesh.position.lerpVectors(dockFrom, dockTo, run * run * (3 - 2 * run));
    token.mesh.position.y += rise * 0.15 + Math.sin(run * Math.PI) * 0.3;
    token.mesh.scale.setScalar(0.45 + rise * 0.3);
    token.mesh.rotation.y = (1 - k) * 6;
    if (k < 1) return;
    token.phase = "docked";
    live = `Mitigation drafted for ${pick(PROJECTS)} — waiting for a human to accept it`;
  }

  function stepTokens(dt: number, on: boolean) {
    for (const token of tray.tokens) {
      if (token.phase === "fly" && on) flyToken(token, dt);
      else if (token.phase === "fly") {
        token.phase = "free";
        token.mesh.visible = false;
      }
    }
  }

  function update(_t: number, dt: number, intensity: number) {
    const on = intensity > 0.05;
    off = !on;
    scope.pivot.visible = on;
    if (on) {
      stepScope(dt, intensity);
      stepGauge(dt, intensity);
      stepChart(dt, intensity);
    } else {
      for (const blip of scope.blips) blip.mesh.visible = false;
    }
    stepTokens(dt, on);
    needle.rotation.z = Math.PI * (1 - value);
  }

  return { group, update, caption: () => (off ? "Switched off" : live), dispose: disposeAll };
}
