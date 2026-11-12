/**
 * TRIAGE's world: an inbox conveyor. Tickets ride the belt, a scan beam reads each one and colours it by
 * priority, and it flies into the matching bin; the occasional duplicate is spotted and merged away.
 */
import * as THREE from "three";
import { mulberry32 } from "../../studio-model";
import { disposer, makeScreen, type Sim } from "./shared";

const TITLES = [
  "Checkout fails on Safari",
  "Password reset email delayed",
  "Export to CSV drops a column",
  "Dark mode flashes on load",
  "Invoice PDF shows wrong total",
  "Search returns stale results",
  "Mobile menu overlaps the logo",
  "SSO redirect loops once",
  "Webhook retried twice",
  "Report date range off by one",
  "Upload stalls at 99%",
  "Notification badge never clears"
];

const PRIORITIES = [
  { name: "Critical", color: 0xf87171 },
  { name: "High", color: 0xfb923c },
  { name: "Medium", color: 0xfacc15 },
  { name: "Low", color: 0x4ade80 }
] as const;

interface Card {
  mesh: THREE.Mesh;
  strip: THREE.Mesh;
  stripMat: THREE.MeshBasicMaterial;
  phase: "free" | "ride" | "read" | "fly" | "merge";
  t: number;
  priority: number;
  title: string;
  duplicate: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

const BELT_Z = 1.1;
const BELT_Y = 0.34;
const READ_X = -0.35;
const BIN_X = 1.35;
const BIN_ZS = [-0.1, 0.4, 0.9, 1.4];

export function triageSim(seed: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();

  // The belt: a dark slab with moving ribs, so motion is visible even between tickets.
  const belt = new THREE.Mesh(track(new THREE.BoxGeometry(2.5, 0.12, 0.5)), track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 })));
  belt.position.set(-0.45, 0.22, BELT_Z);
  group.add(belt);
  const ribMat = track(new THREE.MeshBasicMaterial({ color: 0x334155 }));
  const ribGeo = track(new THREE.BoxGeometry(0.05, 0.005, 0.5));
  const ribs: THREE.Mesh[] = [];
  for (let i = 0; i < 12; i += 1) {
    const rib = new THREE.Mesh(ribGeo, ribMat);
    rib.position.set(-1.65 + i * 0.22, 0.29, BELT_Z);
    ribs.push(rib);
    group.add(rib);
  }

  // The bins, one per priority.
  const binGeo = track(new THREE.BoxGeometry(0.5, 0.28, 0.36));
  const slotGeo = track(new THREE.BoxGeometry(0.42, 0.01, 0.28));
  const slotMat = track(new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  const bins = PRIORITIES.map((p, i) => {
    const mat = track(new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.55 }));
    const bin = new THREE.Mesh(binGeo, mat);
    bin.position.set(BIN_X, 0.22, BIN_ZS[i]);
    const slot = new THREE.Mesh(slotGeo, slotMat);
    slot.position.set(0, 0.145, 0);
    bin.add(slot);
    group.add(bin);
    return { bin, pulse: 0 };
  });

  // Ticket cards, pooled.
  const cardGeo = track(new THREE.BoxGeometry(0.34, 0.025, 0.24));
  const stripGeo = track(new THREE.BoxGeometry(0.34, 0.03, 0.06));
  const cardMat = track(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.75 }));
  const cards: Card[] = [];
  for (let i = 0; i < 8; i += 1) {
    const stripMat = track(new THREE.MeshBasicMaterial({ color: 0x94a3b8 }));
    const mesh = new THREE.Mesh(cardGeo, cardMat);
    const strip = new THREE.Mesh(stripGeo, stripMat);
    strip.position.set(0, 0.002, -0.09);
    mesh.add(strip);
    mesh.visible = false;
    group.add(mesh);
    cards.push({ mesh, strip, stripMat, phase: "free", t: 0, priority: 0, title: "", duplicate: false, from: new THREE.Vector3(), to: new THREE.Vector3() });
  }

  // The scan beam that sweeps a card while it is read.
  const scanMat = track(new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  const scan = new THREE.Mesh(track(new THREE.PlaneGeometry(0.46, 0.04)), scanMat);
  scan.rotation.x = -Math.PI / 2;
  scan.visible = false;
  group.add(scan);

  // A ring that flashes where a duplicate is merged away.
  const flashMat = track(new THREE.MeshBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const flash = new THREE.Mesh(track(new THREE.RingGeometry(0.18, 0.24, 32)), flashMat);
  flash.rotation.x = -Math.PI / 2;
  flash.position.set(READ_X, BELT_Y + 0.04, BELT_Z);
  group.add(flash);
  let flashT = 1;

  const screen = makeScreen("#7dd3fc", seed, track);
  screen.group.position.set(-1.25, 2.05, -0.6);
  screen.group.rotation.y = 0.35;
  group.add(screen.group);

  let spawnIn = 0.4;
  let nextKey = 100 + Math.floor(rand() * 800);
  let caption = "Watching the inbox";
  let lastTitle = TITLES[0];
  const reading = () => cards.find((c) => c.phase === "read");

  function spawn(duplicateOf?: Card) {
    const card = cards.find((c) => c.phase === "free");
    if (!card) return;
    card.phase = "ride";
    card.t = 0;
    card.duplicate = Boolean(duplicateOf);
    card.title = duplicateOf ? duplicateOf.title : TITLES[Math.floor(rand() * TITLES.length)];
    // Most tickets are calm; the urgent ones are the minority.
    card.priority = duplicateOf ? duplicateOf.priority : Math.min(3, Math.max(0, 3 - Math.floor(rand() * 4 * (0.4 + rand() * 0.6))));
    card.stripMat.color.setHex(0x94a3b8);
    card.mesh.position.set(-1.65 + (duplicateOf ? 0.42 : 0), BELT_Y, BELT_Z);
    card.mesh.rotation.set(0, (rand() - 0.5) * 0.2, 0);
    card.mesh.scale.setScalar(1);
    card.mesh.visible = true;
    nextKey += 1;
  }

  /** The belt's ribs crawl and the screen scrolls — motion that shows even between tickets. */
  function stepBelt(dt: number, speed: number, intensity: number) {
    for (const rib of ribs) {
      rib.position.x += dt * speed;
      if (rib.position.x > 0.95) rib.position.x -= 2.64;
    }
    screen.scroll(dt * (0.04 + intensity * 0.22));
  }

  /** Spawn cadence follows intensity: a trickle when on duty, a stream when working. */
  function stepSpawn(dt: number, intensity: number) {
    spawnIn -= dt;
    if (spawnIn > 0) return;
    spawn();
    if (rand() < 0.16 + intensity * 0.06) spawn(cards.find((c) => c.phase === "ride"));
    spawnIn = 4.2 - intensity * 3.3 + rand() * 0.8;
  }

  function retire(card: Card) {
    card.phase = "free";
    card.mesh.visible = false;
    card.mesh.rotation.z = 0;
  }

  function rideCard(card: Card, dt: number, speed: number) {
    card.mesh.position.x += dt * speed;
    if (card.mesh.position.x >= READ_X && !reading()) {
      card.mesh.position.x = READ_X;
      card.phase = "read";
      card.t = 0;
      lastTitle = card.title;
    }
  }

  /** The scan beam sweeps the card, then its strip takes the priority colour — that is the triage. */
  function readCard(card: Card, intensity: number) {
    const dwell = 0.9 - intensity * 0.45;
    const k = Math.min(1, card.t / dwell);
    scan.visible = true;
    scan.position.set(READ_X, BELT_Y + 0.05, BELT_Z - 0.12 + k * 0.24);
    card.mesh.position.y = BELT_Y + Math.sin(k * Math.PI) * 0.05;
    if (k >= 0.5) card.stripMat.color.setHex(PRIORITIES[card.priority].color);
    caption = card.duplicate ? `Spotted a duplicate of TS-${nextKey - 1}` : `Reading “${card.title}” → ${PRIORITIES[card.priority].name}`;
    if (k < 1) return;
    scan.visible = false;
    card.t = 0;
    if (card.duplicate) {
      card.phase = "merge";
      flashT = 0;
      return;
    }
    card.phase = "fly";
    card.from.copy(card.mesh.position);
    card.to.set(BIN_X, 0.42, BIN_ZS[card.priority]);
  }

  function flyCard(card: Card) {
    const k = Math.min(1, card.t / 0.7);
    const eased = 1 - (1 - k) * (1 - k);
    const m = card.mesh;
    m.position.lerpVectors(card.from, card.to, eased);
    m.position.y += Math.sin(k * Math.PI) * 0.55;
    m.rotation.z = k * 0.6;
    if (k < 1) return;
    retire(card);
    bins[card.priority].pulse = 1;
  }

  function mergeCard(card: Card) {
    const k = Math.min(1, card.t / 0.45);
    card.mesh.scale.setScalar(1 - k);
    card.mesh.position.y = BELT_Y + k * 0.15;
    if (k >= 1) retire(card);
  }

  function stepCard(card: Card, dt: number, speed: number, intensity: number) {
    card.t += dt;
    if (card.phase === "ride") rideCard(card, dt, speed);
    else if (card.phase === "read") readCard(card, intensity);
    else if (card.phase === "fly") flyCard(card);
    else if (card.phase === "merge") mergeCard(card);
  }

  function stepCards(dt: number, speed: number, intensity: number, moving: boolean) {
    for (const card of cards) {
      if (card.phase === "free") continue;
      // Powered down: whatever was on the belt simply clears (a card already in flight finishes its arc).
      if (!moving && card.phase !== "fly") retire(card);
      else stepCard(card, dt, speed, intensity);
    }
  }

  /** The caption, the bins' pulse and the duplicate flash — everything that is not a card. */
  function settle(dt: number, intensity: number, moving: boolean) {
    if (!moving) {
      scan.visible = false;
      caption = "Switched off";
    } else if (!reading()) {
      scan.visible = false;
      caption = intensity > 0.6 ? `Sorting — last: “${lastTitle}”` : "Watching the inbox";
    }
    for (const b of bins) {
      b.pulse = Math.max(0, b.pulse - dt * 3);
      b.bin.scale.set(1 + b.pulse * 0.1, 1 + b.pulse * 0.18, 1 + b.pulse * 0.1);
    }
    if (flashT < 1) {
      flashT += dt * 2.2;
      const k = Math.min(1, flashT);
      flash.scale.setScalar(1 + k * 2.2);
      flashMat.opacity = (1 - k) * 0.9;
    } else {
      flashMat.opacity = 0;
    }
  }

  function update(_t: number, dt: number, intensity: number) {
    const moving = intensity > 0.05;
    const speed = 0.35 + intensity * 0.75;
    if (moving) {
      stepBelt(dt, speed, intensity);
      stepSpawn(dt, intensity);
    }
    stepCards(dt, speed, intensity, moving);
    settle(dt, intensity, moving);
  }

  return { group, update, caption: () => caption, dispose: disposeAll };
}

