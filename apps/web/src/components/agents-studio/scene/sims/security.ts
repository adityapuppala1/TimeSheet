/**
 * SECURITY DESK's world: a scanning checkpoint plus a CI pipeline. Code files travel FRONT-TO-BACK through
 * a scanning arch; a beam sweeps each one and the risky ones spit out glowing gems (red high, orange medium,
 * yellow low) that arc into colour-coded evidence lockers. Behind it a four-stage pipeline (build, test,
 * scan, deploy) carries a glowing token that turns each stage green as it passes — and now and then one
 * stage flashes red and stops, a failing build, which the desk "summarises" before the line resets.
 *
 * Designed to differ from Triage on purpose: depth-wise travel through a gate, not a left-to-right
 * conveyor. Everything is a seeded illustration (nothing here is read from a real scanner), and the
 * activity rate follows `intensity`: a calm file every few seconds when on duty, a stream when flat out.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";
import { disposer, type Sim } from "./shared";

const FILES = ["auth/session.ts", "api/invoices.ts", "lib/crypto.ts", "web/Login.tsx", "db/migrate.sql", "api/upload.ts", "scim/users.ts", "cfg/secrets.yml", "web/Export.tsx", "api/webhook.ts"];
const SEVERITY = [
  { name: "high", color: 0xef4444 },
  { name: "medium", color: 0xfb923c },
  { name: "low", color: 0xfacc15 }
] as const;
const STAGES = ["Build", "Test", "Scan", "Deploy"] as const;
const LINE_COLOURS = [0x7dd3fc, 0xa78bfa, 0x94a3b8, 0xf472b6, 0x4ade80];

const ARCH_X = 0.75;
const ARCH_Z = -0.25;
const ARCH_H = 1.05;
const PATH_START = 1.6;
const PATH_END = -1.25;
const CARD_Y = 0.15;
const LOCKER_X = 1.62;
const LOCKER_ZS = [-0.95, -0.35, 0.25];
const PIPE_Z = 1.2;
const PIPE_XS = [-1.3, -0.8, -0.3, 0.2];
const GREEN = 0x4ade80;
const RED = 0xef4444;
const DIM = 0x334155;

interface FileCard {
  mesh: THREE.Mesh;
  lineMats: THREE.MeshBasicMaterial[];
  phase: "free" | "ride" | "scan" | "out";
  t: number;
  name: string;
  findings: number[];
}

interface Gem {
  mesh: THREE.Mesh;
  phase: "free" | "pop" | "fly";
  t: number;
  severity: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

type PipePhase = "idle" | "run" | "fail" | "done";

/** "2 findings (1 high)" / "clean" — the tail of the scanning caption. */
function findingsText(findings: number[]): string {
  if (findings.length === 0) return "clean";
  const high = findings.filter((f) => f === 0).length;
  const noun = findings.length > 1 ? "findings" : "finding";
  return high > 0 ? `${findings.length} ${noun} (${high} high)` : `${findings.length} ${noun}`;
}

export function securitySim(seed: number, accent: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();

  // ---- the scanning arch -------------------------------------------------------------------------
  const archMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5, metalness: 0.3 }));
  const trimMat = track(new THREE.MeshBasicMaterial({ color: accent }));
  const postGeo = track(new THREE.BoxGeometry(0.14, ARCH_H, 0.3));
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, archMat);
    post.position.set(ARCH_X + side * 0.45, ARCH_H / 2, ARCH_Z);
    group.add(post);
  }
  const lintel = new THREE.Mesh(track(new THREE.BoxGeometry(1.04, 0.16, 0.34)), archMat);
  lintel.position.set(ARCH_X, ARCH_H + 0.04, ARCH_Z);
  const lintelLight = new THREE.Mesh(track(new THREE.BoxGeometry(0.6, 0.04, 0.02)), trimMat);
  lintelLight.position.set(ARCH_X, ARCH_H + 0.04, ARCH_Z + 0.18);
  group.add(lintel, lintelLight);
  // A dark path strip the files ride along, front to back.
  const pathMat = track(new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.8 }));
  const path = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.04, PATH_START - PATH_END + 0.3)), pathMat);
  path.position.set(ARCH_X, 0.02, (PATH_START + PATH_END) / 2);
  group.add(path);

  const beamMat = track(new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const beam = new THREE.Mesh(track(new THREE.PlaneGeometry(0.76, 0.05)), beamMat);
  beam.position.set(ARCH_X, 0.1, ARCH_Z);
  beam.visible = false;
  const veilMat = track(new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const veil = new THREE.Mesh(track(new THREE.PlaneGeometry(0.76, ARCH_H)), veilMat);
  veil.position.set(ARCH_X, ARCH_H / 2, ARCH_Z);
  veil.visible = false;
  group.add(beam, veil);

  // ---- evidence lockers --------------------------------------------------------------------------
  const lockerGeo = track(new THREE.BoxGeometry(0.42, 0.7, 0.4));
  const doorGeo = track(new THREE.BoxGeometry(0.34, 0.5, 0.02));
  const slotGeo = track(new THREE.BoxGeometry(0.22, 0.03, 0.03));
  const slotMat = track(new THREE.MeshBasicMaterial({ color: 0x020617 }));
  const lockerBodyMat = track(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.55, metalness: 0.3 }));
  const lockers = SEVERITY.map((sev, i) => {
    const locker = new THREE.Mesh(lockerGeo, lockerBodyMat);
    locker.position.set(LOCKER_X, 0.35, LOCKER_ZS[i]);
    locker.rotation.y = -0.25;
    const door = new THREE.Mesh(doorGeo, track(new THREE.MeshStandardMaterial({ color: sev.color, roughness: 0.5 })));
    door.position.set(0, -0.02, 0.21);
    const slot = new THREE.Mesh(slotGeo, slotMat);
    slot.position.set(0, 0.2, 0.225);
    locker.add(door, slot);
    group.add(locker);
    return { locker, pulse: 0 };
  });

  // ---- file cards and gems (pooled) --------------------------------------------------------------
  const cardGeo = track(new THREE.BoxGeometry(0.34, 0.02, 0.42));
  const cardMat = track(new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.75 }));
  const lineGeo = track(new THREE.BoxGeometry(0.22, 0.012, 0.03));
  const cards: FileCard[] = [];
  for (let i = 0; i < 4; i += 1) {
    const mesh = new THREE.Mesh(cardGeo, cardMat);
    const lineMats: THREE.MeshBasicMaterial[] = [];
    for (let l = 0; l < 4; l += 1) {
      const mat = track(new THREE.MeshBasicMaterial({ color: 0x94a3b8 }));
      const line = new THREE.Mesh(lineGeo, mat);
      line.position.set(-0.02 + (l % 2) * 0.03, 0.014, -0.13 + l * 0.085);
      mesh.add(line);
      lineMats.push(mat);
    }
    mesh.visible = false;
    group.add(mesh);
    cards.push({ mesh, lineMats, phase: "free", t: 0, name: "", findings: [] });
  }
  const gemGeo = track(new THREE.OctahedronGeometry(0.1, 0));
  const gemMats = SEVERITY.map((s) => track(new THREE.MeshBasicMaterial({ color: s.color })));
  const gems: Gem[] = [];
  for (let i = 0; i < 10; i += 1) {
    const mesh = new THREE.Mesh(gemGeo, gemMats[0]);
    mesh.visible = false;
    group.add(mesh);
    gems.push({ mesh, phase: "free", t: 0, severity: 0, from: new THREE.Vector3(), to: new THREE.Vector3() });
  }

  // ---- the CI pipeline ---------------------------------------------------------------------------
  const railMat = track(new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.5, metalness: 0.4 }));
  const rail = new THREE.Mesh(track(new THREE.BoxGeometry(PIPE_XS[3] - PIPE_XS[0] + 0.3, 0.05, 0.08)), railMat);
  rail.position.set((PIPE_XS[0] + PIPE_XS[3]) / 2, 0.38, PIPE_Z);
  group.add(rail);
  const blockGeo = track(new THREE.BoxGeometry(0.36, 0.3, 0.36));
  const blockMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.55 }));
  const lampGeo = track(new THREE.SphereGeometry(0.12, 14, 10));
  const stages = PIPE_XS.map((x) => {
    const block = new THREE.Mesh(blockGeo, blockMat);
    block.position.set(x, 0.15, PIPE_Z);
    const lampMat = track(new THREE.MeshBasicMaterial({ color: DIM }));
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(x, 0.52, PIPE_Z);
    group.add(block, lamp);
    return { lampMat };
  });
  const tokenMat = track(new THREE.MeshBasicMaterial({ color: 0xfde047 }));
  const token = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 12, 10)), tokenMat);
  token.visible = false;
  group.add(token);

  // ---- state -------------------------------------------------------------------------------------
  let spawnIn = 0.6;
  let caption = "Switched off";
  let lastScan = FILES[0];
  let filesScanned = 0;
  let riskyFiles = 0;
  let summaryT = 0;
  let pipePhase: PipePhase = "idle";
  let pipeT = 0;
  let pipePos = 0;
  let failAt = -1;
  let buildNo = 480 + Math.floor(rand() * 40);
  let pipeWait = 1.2;
  const scanning = () => cards.find((c) => c.phase === "scan");

  function retireCard(card: FileCard) {
    card.phase = "free";
    card.mesh.visible = false;
  }

  function spawnCard() {
    const card = cards.find((c) => c.phase === "free");
    if (!card) return;
    card.phase = "ride";
    card.t = 0;
    card.name = FILES[Math.floor(rand() * FILES.length)];
    card.findings.length = 0;
    // Most files are clean; the risky ones are the minority.
    const count = rand() < 0.62 ? Math.floor(rand() * 3) + 1 : 0;
    for (let i = 0; i < count; i += 1) card.findings.push(Math.min(2, Math.floor(rand() * rand() * 3.2)));
    card.lineMats.forEach((m) => m.color.setHex(LINE_COLOURS[Math.floor(rand() * LINE_COLOURS.length)]));
    card.mesh.position.set(ARCH_X, CARD_Y, PATH_START);
    card.mesh.rotation.y = (rand() - 0.5) * 0.15;
    card.mesh.visible = true;
  }

  function emitGem(card: FileCard, severity: number, delay: number) {
    const gem = gems.find((g) => g.phase === "free");
    if (!gem) return;
    gem.phase = "pop";
    gem.t = -delay;
    gem.severity = severity;
    gem.mesh.material = gemMats[severity];
    gem.from.set(ARCH_X, CARD_Y + 0.05, card.mesh.position.z);
    gem.to.set(LOCKER_X - 0.02, 0.8, LOCKER_ZS[severity]);
    gem.mesh.position.copy(gem.from);
    gem.mesh.scale.setScalar(0.01);
    gem.mesh.visible = true;
  }

  function rideCard(card: FileCard, dt: number, speed: number) {
    card.mesh.position.z -= dt * speed;
    if (card.mesh.position.z > ARCH_Z || scanning()) return;
    card.mesh.position.z = ARCH_Z;
    card.phase = "scan";
    card.t = 0;
    lastScan = card.name;
  }

  function scanCard(card: FileCard, intensity: number) {
    const dwell = 1.3 - intensity * 0.7;
    const k = Math.min(1, card.t / dwell);
    beam.visible = true;
    veil.visible = true;
    beam.position.y = 0.1 + (0.5 - 0.5 * Math.cos(k * Math.PI * 2)) * (ARCH_H - 0.2);
    caption = `Scanning ${card.name} — ${findingsText(card.findings)}`;
    if (k < 1) return;
    beam.visible = false;
    veil.visible = false;
    card.phase = "out";
    card.t = 0;
    filesScanned += 1;
    if (card.findings.length) riskyFiles += 1;
    card.findings.forEach((sev, i) => emitGem(card, sev, i * 0.18));
    if (filesScanned % 5 === 0) summaryT = 2.6;
  }

  function outCard(card: FileCard, dt: number, speed: number) {
    card.mesh.position.z -= dt * speed;
    if (card.mesh.position.z <= PATH_END) retireCard(card);
  }

  function stepCard(card: FileCard, dt: number, speed: number, intensity: number) {
    card.t += dt;
    if (card.phase === "ride") rideCard(card, dt, speed);
    else if (card.phase === "scan") scanCard(card, intensity);
    else if (card.phase === "out") outCard(card, dt, speed);
  }

  function stepCards(dt: number, speed: number, intensity: number, moving: boolean) {
    for (const card of cards) {
      if (card.phase === "free") continue;
      if (moving) stepCard(card, dt, speed, intensity);
      else retireCard(card);
    }
  }

  function popGem(gem: Gem) {
    const k = Math.min(1, gem.t / 0.4);
    gem.mesh.scale.setScalar(Math.max(0.01, k));
    gem.mesh.position.set(gem.from.x, gem.from.y + k * 0.45, gem.from.z);
    if (k < 1) return;
    gem.phase = "fly";
    gem.t = 0;
    gem.from.copy(gem.mesh.position);
  }

  function flyGem(gem: Gem) {
    const k = Math.min(1, gem.t / 0.7);
    gem.mesh.position.lerpVectors(gem.from, gem.to, k);
    gem.mesh.position.y += Math.sin(k * Math.PI) * 0.35;
    if (k < 1) return;
    gem.phase = "free";
    gem.mesh.visible = false;
    lockers[gem.severity].pulse = 1;
  }

  function stepGems(dt: number, moving: boolean) {
    for (const gem of gems) {
      if (gem.phase === "free") continue;
      if (!moving) {
        gem.phase = "free";
        gem.mesh.visible = false;
        continue;
      }
      gem.t += dt;
      gem.mesh.rotation.y += dt * 4;
      if (gem.t < 0) continue;
      if (gem.phase === "pop") popGem(gem);
      else flyGem(gem);
    }
  }

  // ---- pipeline ----------------------------------------------------------------------------------
  function setStage(i: number, color: number) {
    stages[i].lampMat.color.setHex(color);
  }

  function resetPipe() {
    stages.forEach((_, i) => setStage(i, DIM));
    token.visible = false;
    pipePhase = "idle";
    pipePos = 0;
  }

  function startRun(intensity: number) {
    pipePhase = "run";
    pipePos = 0;
    buildNo += 1;
    failAt = rand() < Math.max(0, intensity - 0.25) * 0.55 ? 1 + Math.floor(rand() * 2) : -1;
  }

  function runPipe(dt: number, intensity: number) {
    pipePos += dt * (0.5 + intensity * 0.9);
    const idx = Math.min(3, Math.floor(pipePos));
    token.visible = true;
    const x = PIPE_XS[0] + Math.min(pipePos, 3) * (PIPE_XS[1] - PIPE_XS[0]);
    token.position.set(x, 0.52 + Math.abs(Math.sin(pipePos * 6)) * 0.05, PIPE_Z + 0.2);
    for (let i = 0; i < idx; i += 1) setStage(i, GREEN);
    if (idx === failAt && pipePos - idx > 0.35) {
      pipePhase = "fail";
      pipeT = 0;
      return;
    }
    if (pipePos >= 3.6) {
      stages.forEach((_, i) => setStage(i, GREEN));
      pipePhase = "done";
      pipeT = 0;
    }
  }

  function failPipe(dt: number) {
    pipeT += dt;
    const flash = Math.sin(pipeT * 14) > 0;
    setStage(failAt, flash ? RED : 0x7f1d1d);
    caption = `Build #${buildNo} failed at ${STAGES[failAt]} — summarising the log`;
    if (pipeT > 2.2) {
      resetPipe();
      pipeWait = 2;
    }
  }

  function donePipe(dt: number) {
    pipeT += dt;
    if (pipeT > 1) {
      resetPipe();
      pipeWait = 3;
    }
  }

  function idlePipe(dt: number, intensity: number) {
    pipeWait -= dt * (0.4 + intensity);
    if (pipeWait <= 0) startRun(intensity);
  }

  const PIPE_STEP: Record<PipePhase, (dt: number, intensity: number) => void> = {
    idle: idlePipe,
    run: runPipe,
    fail: failPipe,
    done: donePipe
  };

  // ---- per frame ---------------------------------------------------------------------------------
  function settle(dt: number, moving: boolean) {
    for (const l of lockers) {
      l.pulse = Math.max(0, l.pulse - dt * 3);
      l.locker.scale.set(1 + l.pulse * 0.08, 1 + l.pulse * 0.12, 1 + l.pulse * 0.08);
    }
    if (!moving) {
      caption = "Switched off";
      return;
    }
    if (pipePhase === "fail") return;
    if (summaryT > 0) {
      summaryT -= dt;
      caption = `Summarising pull request: ${filesScanned} files, ${riskyFiles} risky`;
    } else if (!scanning()) {
      caption = filesScanned ? `Standing watch — last scan: ${lastScan}` : "Standing watch at the checkpoint";
    }
  }

  function update(_t: number, dt: number, intensity: number) {
    const moving = intensity > 0.05;
    const speed = 0.55 + intensity * 0.9;
    if (moving) {
      spawnIn -= dt;
      if (spawnIn <= 0) {
        spawnCard();
        spawnIn = 4.6 - intensity * 3.6 + rand() * 0.8;
      }
      PIPE_STEP[pipePhase](dt, intensity);
    } else {
      resetPipe();
      beam.visible = false;
      veil.visible = false;
    }
    stepCards(dt, speed, intensity, moving);
    stepGems(dt, moving);
    settle(dt, moving);
  }

  return { group, update, caption: () => caption, dispose: disposeAll };
}
