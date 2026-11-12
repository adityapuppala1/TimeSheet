/**
 * REPORTER's world: a tiny newsroom. A paper roll feeds a press; printed sheets slide out and STACK into
 * a thickening "weekly digest"; behind it a pinboard shows animated bar charts and a trend line (the
 * recap data). When the pile reaches eight sections it folds into a paper plane that flies up and out
 * (the mail being sent) while the pile resets.
 *
 * Deliberately NOT a belt-with-bins: the look is press + stack + pinboard + flying mail, so it never
 * reads like the triage conveyor. Everything is pooled (nine sheets, one plane, five bars) and every
 * number is drawn from `mulberry32(seed)`, so the same agent prints the same digest each visit.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";
import { disposer, type Sim } from "./shared";

const SECTIONS = 8;
const EXIT_X = 0.95;
const EXIT_Y = 0.52;
const SHEET_W = 0.42;
const SHEET_T = 0.04;
const STACK_X = 1.55;
const STACK_Z = 0.75;
const STACK_BASE = 0.1;
const SHEET_PITCH = 0.047;
const BAR_COUNT = 5;
const TREND_POINTS = 7;
const PLANE_FROM_Y = 0.55;
const PLANE_TO = { x: 2.4, y: 3.3, z: -1.8 };
const PLANE_SECONDS = 2.4;

interface Sheet {
  mesh: THREE.Mesh;
  headMat: THREE.MeshBasicMaterial;
}

interface Bar {
  mesh: THREE.Mesh;
  value: number;
  target: number;
}

type MovePhase = "none" | "emerge" | "travel";

export function reporterSim(seed: number, accent: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();
  const headColors = [accent, 0x38bdf8, 0xf472b6, 0xfacc15, 0x4ade80, 0xfb923c, 0xa78bfa, 0x22d3ee];

  const darkMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 }));
  const paperMat = track(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.8 }));
  const metalMat = track(new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.5, roughness: 0.4 }));
  const markMat = track(new THREE.MeshBasicMaterial({ color: 0xf8fafc }));

  /** A cylinder lying along Z with a light tab on its rim, so spinning is visible. */
  function makeDrum(radius: number, length: number, mat: THREE.Material) {
    const geo = track(new THREE.CylinderGeometry(radius, radius, length, 18));
    geo.rotateX(Math.PI / 2);
    const drum = new THREE.Mesh(geo, mat);
    const tab = new THREE.Mesh(track(new THREE.BoxGeometry(radius * 0.5, radius * 0.25, length * 1.02)), markMat);
    tab.position.x = radius * 0.8;
    drum.add(tab);
    return drum;
  }

  // The press: a base block, a paper roll at the back-left and a pair of rollers at the exit.
  const base = new THREE.Mesh(track(new THREE.BoxGeometry(1.0, 0.4, 0.55)), darkMat);
  base.position.set(0.55, 0.2, STACK_Z);
  group.add(base);
  const hood = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.2, 0.55)), metalMat);
  hood.position.set(0.8, 0.5, STACK_Z);
  group.add(hood);
  const roll = makeDrum(0.2, 0.46, paperMat);
  roll.position.set(0.25, 0.6, STACK_Z);
  group.add(roll);
  const ribbon = new THREE.Mesh(track(new THREE.BoxGeometry(0.55, 0.012, 0.4)), paperMat);
  ribbon.position.set(0.6, EXIT_Y - 0.02, STACK_Z);
  group.add(ribbon);
  const rollers = [makeDrum(0.065, 0.5, metalMat), makeDrum(0.065, 0.5, metalMat)];
  rollers[0].position.set(EXIT_X, EXIT_Y - 0.08, STACK_Z);
  rollers[1].position.set(EXIT_X, EXIT_Y + 0.07, STACK_Z);
  group.add(rollers[0], rollers[1]);

  // The pallet the digest stacks on.
  const pallet = new THREE.Mesh(track(new THREE.BoxGeometry(0.54, 0.06, 0.4)), darkMat);
  pallet.position.set(STACK_X + 0.1, 0.03, STACK_Z);
  group.add(pallet);

  // Sheets: eight stacked slots plus one in transit. Each has a coloured header bar and chart glyph.
  const sheetGeo = track(new THREE.BoxGeometry(SHEET_W, SHEET_T, 0.3));
  const headGeo = track(new THREE.BoxGeometry(0.34, 0.006, 0.07));
  const glyphGeo = track(new THREE.BoxGeometry(0.03, 0.006, 0.07));
  const glyphMat = track(new THREE.MeshBasicMaterial({ color: 0x475569 }));
  function makeSheet(): Sheet {
    const headMat = track(new THREE.MeshBasicMaterial({ color: accent }));
    const mesh = new THREE.Mesh(sheetGeo, paperMat);
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(0, SHEET_T / 2 + 0.001, -0.09);
    mesh.add(head);
    for (let i = 0; i < 3; i += 1) {
      const glyph = new THREE.Mesh(glyphGeo, glyphMat);
      glyph.scale.z = 0.5 + i * 0.4;
      glyph.position.set(-0.08 + i * 0.07, SHEET_T / 2 + 0.001, 0.08);
      mesh.add(glyph);
    }
    mesh.visible = false;
    group.add(mesh);
    return { mesh, headMat };
  }
  const stacked: Sheet[] = [];
  for (let i = 0; i < SECTIONS; i += 1) {
    const sheet = makeSheet();
    sheet.mesh.position.set(STACK_X, STACK_BASE + i * SHEET_PITCH, STACK_Z);
    sheet.mesh.rotation.y = (rand() - 0.5) * 0.12;
    sheet.headMat.color.setHex(headColors[i]);
    stacked.push(sheet);
  }
  const moving = makeSheet();

  // The paper plane (the sent mail) and the "sent" flash where the digest lifts off.
  const planeGeo = track(new THREE.ConeGeometry(0.12, 0.42, 3));
  planeGeo.rotateZ(-Math.PI / 2);
  const planeMat = track(new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: accent, emissiveIntensity: 0.35, roughness: 0.6 }));
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.scale.set(1, 0.35, 1);
  plane.visible = false;
  group.add(plane);
  const flashMat = track(new THREE.MeshBasicMaterial({ color: 0x86efac, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const flash = new THREE.Mesh(track(new THREE.RingGeometry(0.22, 0.3, 32)), flashMat);
  flash.rotation.x = -Math.PI / 2;
  flash.position.set(STACK_X, 0.12, STACK_Z);
  group.add(flash);

  // The pinboard: a backing panel on two posts, with bar charts and a trend line.
  const board = new THREE.Group();
  board.position.set(1.15, 1.5, -1.15);
  board.rotation.y = -0.18;
  group.add(board);
  board.add(new THREE.Mesh(track(new THREE.BoxGeometry(1.4, 1.0, 0.06)), darkMat));
  const header = new THREE.Mesh(track(new THREE.BoxGeometry(1.26, 0.1, 0.02)), track(new THREE.MeshBasicMaterial({ color: accent })));
  header.position.set(0, 0.38, 0.04);
  board.add(header);
  const postGeo = track(new THREE.BoxGeometry(0.05, 1.0, 0.05));
  for (const x of [-0.5, 0.5]) {
    const post = new THREE.Mesh(postGeo, metalMat);
    post.position.set(x, -1.0, -0.04);
    board.add(post);
  }
  const barGeo = track(new THREE.BoxGeometry(0.12, 1, 0.05));
  const bars: Bar[] = [];
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const mesh = new THREE.Mesh(barGeo, track(new THREE.MeshBasicMaterial({ color: headColors[(i + 1) % headColors.length] })));
    mesh.position.x = -0.05 + i * 0.15;
    board.add(mesh);
    bars.push({ mesh, value: 0.2 + rand() * 0.6, target: 0.2 + rand() * 0.6 });
  }
  const trendValues = Array.from({ length: TREND_POINTS }, () => rand());
  const trendTargets = trendValues.slice();
  const trendPos = new Float32Array(TREND_POINTS * 3);
  const trendGeo = track(new THREE.BufferGeometry());
  trendGeo.setAttribute("position", new THREE.BufferAttribute(trendPos, 3));
  const trend = new THREE.Line(trendGeo, track(new THREE.LineBasicMaterial({ color: 0xfacc15 })));
  trend.position.set(0.0, 0.14, 0.05);
  board.add(trend);
  const axis = new THREE.Mesh(track(new THREE.BoxGeometry(0.64, 0.01, 0.01)), track(new THREE.MeshBasicMaterial({ color: 0x475569 })));
  axis.position.set(0.3, 0.12, 0.05);
  board.add(axis);

  // Run state.
  let spawnIn = 0.6;
  let phase: MovePhase = "none";
  let phaseT = 0;
  let stackCount = 0;
  let planeT = -1;
  let flashT = 1;
  let recipients = 12;
  let barChangeIn = 1;
  let sinceBarChange = 99;
  let caption = "Charting what keeps breaking this month";

  function writeTrend() {
    for (let i = 0; i < TREND_POINTS; i += 1) {
      trendPos[i * 3] = (i / (TREND_POINTS - 1)) * 0.6;
      trendPos[i * 3 + 1] = trendValues[i] * 0.18;
      trendPos[i * 3 + 2] = 0;
    }
    trendGeo.attributes.position.needsUpdate = true;
  }

  function spawnSheet() {
    phase = "emerge";
    phaseT = 0;
    moving.headMat.color.setHex(headColors[stackCount % SECTIONS]);
    moving.mesh.visible = true;
    moving.mesh.scale.set(0.05, 1, 1);
    moving.mesh.position.set(EXIT_X, EXIT_Y, STACK_Z);
    moving.mesh.rotation.y = 0;
  }

  function launchPlane() {
    for (const sheet of stacked) sheet.mesh.visible = false;
    stackCount = 0;
    planeT = 0;
    flashT = 0;
    recipients = 6 + Math.floor(rand() * 19);
    plane.visible = true;
    plane.position.set(STACK_X, PLANE_FROM_Y, STACK_Z);
  }

  function landSheet() {
    moving.mesh.visible = false;
    phase = "none";
    stacked[stackCount].headMat.color.copy(moving.headMat.color);
    stacked[stackCount].mesh.visible = true;
    stackCount += 1;
    if (stackCount >= SECTIONS) launchPlane();
  }

  function emerge(speed: number) {
    const k = Math.min(1, phaseT * speed / 0.9);
    moving.mesh.scale.x = Math.max(0.05, k);
    moving.mesh.position.x = EXIT_X + (SHEET_W / 2) * k;
    if (k < 1) return;
    phase = "travel";
    phaseT = 0;
  }

  function travel(speed: number) {
    const k = Math.min(1, phaseT * speed / 0.8);
    const topY = STACK_BASE + stackCount * SHEET_PITCH;
    moving.mesh.position.x = EXIT_X + SHEET_W / 2 + (STACK_X - EXIT_X - SHEET_W / 2) * k;
    moving.mesh.position.y = EXIT_Y + (topY - EXIT_Y) * k * k;
    if (k >= 1) landSheet();
  }

  function stepSheet(dt: number, speed: number) {
    if (phase === "none") return;
    phaseT += dt;
    if (phase === "emerge") emerge(speed);
    else travel(speed);
  }

  function stepSpawn(dt: number, intensity: number) {
    spawnIn -= dt;
    if (spawnIn > 0 || phase !== "none" || stackCount >= SECTIONS) return;
    spawnSheet();
    spawnIn = 4.6 - intensity * 3.9 + rand() * 0.5;
  }

  function stepPlane(dt: number) {
    if (planeT < 0) return;
    planeT += dt;
    const k = Math.min(1, planeT / PLANE_SECONDS);
    const rise = 1 - (1 - k) * (1 - k);
    const p = plane.position;
    p.x = STACK_X + (PLANE_TO.x - STACK_X) * k;
    p.y = PLANE_FROM_Y + (PLANE_TO.y - PLANE_FROM_Y) * rise;
    p.z = STACK_Z + (PLANE_TO.z - STACK_Z) * k;
    plane.rotation.z = Math.atan2((PLANE_TO.y - PLANE_FROM_Y) * 2 * (1 - k), PLANE_TO.x - STACK_X);
    plane.rotation.y = 0.5;
    plane.scale.setScalar(1 - k * 0.55);
    if (k < 1) return;
    planeT = -1;
    plane.visible = false;
  }

  function stepBars(dt: number, intensity: number) {
    barChangeIn -= dt;
    sinceBarChange += dt;
    if (barChangeIn <= 0) {
      bars[Math.floor(rand() * BAR_COUNT)].target = 0.15 + rand() * 0.75;
      const t = Math.floor(rand() * TREND_POINTS);
      trendTargets[t] = rand();
      barChangeIn = 2.6 - intensity * 2.0 + rand() * 0.6;
      sinceBarChange = 0;
    }
    const ease = Math.min(1, dt * 3);
    for (const bar of bars) {
      bar.value += (bar.target - bar.value) * ease;
      bar.mesh.scale.y = Math.max(0.02, bar.value * 0.6);
      bar.mesh.position.y = -0.44 + (bar.value * 0.6) / 2;
    }
    for (let i = 0; i < TREND_POINTS; i += 1) trendValues[i] += (trendTargets[i] - trendValues[i]) * ease;
    writeTrend();
  }

  function stepFlash(dt: number) {
    if (flashT >= 1) {
      flashMat.opacity = 0;
      return;
    }
    flashT += dt * 1.8;
    const k = Math.min(1, flashT);
    flash.scale.setScalar(1 + k * 2.6);
    flashMat.opacity = (1 - k) * 0.9;
  }

  function pickCaption(intensity: number): string {
    if (planeT >= 0) return `Sending the recap to ${recipients} managers`;
    if (phase === "none" && sinceBarChange < 1.6 && intensity < 0.6) return "Charting what keeps breaking this month";
    return `Drafting the weekly digest — ${Math.min(SECTIONS, stackCount + (phase === "none" ? 0 : 1))} of ${SECTIONS} sections`;
  }

  function clearMoving() {
    moving.mesh.visible = false;
    phase = "none";
    plane.visible = false;
    planeT = -1;
  }

  function update(_t: number, dt: number, intensity: number) {
    if (intensity <= 0.05) {
      clearMoving();
      caption = "Switched off";
      stepFlash(dt);
      return;
    }
    const speed = 0.6 + intensity * 0.9;
    roll.rotation.z -= dt * speed * 1.5 * (phase === "none" ? 0.1 : 1);
    for (const r of rollers) r.rotation.z += dt * speed * (phase === "none" ? 0.4 : 4);
    stepSpawn(dt, intensity);
    stepSheet(dt, speed);
    stepPlane(dt);
    stepBars(dt, intensity);
    stepFlash(dt);
    caption = pickCaption(intensity);
  }

  writeTrend();
  for (let i = 0; i < BAR_COUNT; i += 1) {
    bars[i].mesh.scale.y = bars[i].value * 0.6;
    bars[i].mesh.position.y = -0.44 + (bars[i].value * 0.6) / 2;
  }

  return { group, update, caption: () => caption, dispose: disposeAll };
}
