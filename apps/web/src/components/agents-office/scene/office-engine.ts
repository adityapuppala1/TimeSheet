/**
 * WHAT: the Agents Office scene — a furnished office floor where each agent is a person who sits at
 * a desk, walks (A* route, physics-resolved steps), works its room's equipment while a run is live,
 * and between runs gets coffee, chats at a colleague's desk or joins a stand-up. `createOffice` is the
 * only export; AgentOffice.tsx owns the DOM around it.
 *
 * WHAT DRIVES AN AGENT (office-model.ts `goalFor`): its REAL mood. Switched off → it walks out of the
 * door. A run queued or running → it stands up and walks to its zone, a task card appears over it and
 * that room's equipment runs flat out. A recent failed run → it stands at its desk waving for help. A
 * run just finished → it cheers and lobs a paper ball at the bin (a real projectile in the physics
 * world). Otherwise it sits at its desk, laptop lit. A real goal always interrupts office life.
 *
 * OFFICE LIFE (coffee, chats, stand-ups) is seeded ambience for agents with nothing running, reported
 * through `onLife` so the UI can label it as idle. Zone equipment captions and the task card's text
 * are tagged "Simulated". Hand-off packets between rooms move only while the upstream agent really works.
 *
 * LOOK: ACES tone mapping over an sRGB output, a soft image-based light from three's RoomEnvironment
 * (prefiltered once with PMREM), a warm key light with soft shadows and a cool fill. Post-processing
 * (SSAO, outline, bloom) was weighed and left out: each is a full-screen pass that roughly doubles the
 * frame cost on a laptop iGPU, and the baked light pools, contact shadows and emissive highlight buy
 * most of the look for none of it.
 *
 * FILES: camera.ts (orbit rig), building.ts (the office, cut-away walls), people.ts (a person),
 * labels.ts (tags, bubbles, task cards), flows.ts (hand-off and conversation arcs), physics.ts.
 *
 * FRAME POLICY: lib/render-loop.ts — nothing off screen or in a background tab, 30fps, and a rest
 * state when everyone is away and the camera is still. Reduced motion: no loop, nobody walks (they
 * are placed where they are going), one frame per change.
 *
 * Loaded by dynamic import only: three.js, Rapier and the models never reach another page.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createRenderLoop, type RenderLoopHandle } from "../../../lib/render-loop";
import { AGENT_PALETTE, hashSeed, mulberry32, type Archetype } from "../../agents-studio/studio-model";
import { buildSim, type Sim } from "../../agents-studio/scene/sims";
import type { StudioAgent, StudioTheme } from "../../agents-studio/scene/types";
import {
  activeFlows,
  declutter,
  BIN,
  buildNavGrid,
  castPeople,
  COFFEE_SPOT,
  DESKS,
  equipmentCentre,
  findPath,
  goalFor,
  headingTo,
  idlePause,
  MAX_AGENTS,
  MEETING_SEATS,
  obstacles,
  OUTSIDE,
  pickIdleActivity,
  roomById,
  speechLine,
  TASK_TITLE,
  turnBetween,
  WALK_SPEED,
  ZONE_OF,
  zoneSpot,
  type Desk,
  type Goal,
  type Seat,
  type Vec2
} from "../office-model";
import { buildOffice } from "./building";
import { createCameraRig, FOV } from "./camera";
import { createFlows, type ArcSpec } from "./flows";
import { CARD_W, LABEL_UNIT, TAG_H, TAG_W } from "./labels";
import { createPerson, type Person } from "./people";
import { createPhysics, type PropKind } from "./physics";

export interface OfficeEvents {
  onHover(id: string | null, x: number, y: number): void;
  onSelect(id: string | null): void;
  /** What the agent in focus is doing. `simulated` marks a zone-equipment caption (an illustration). */
  onCaption(id: string, text: string, simulated: boolean): void;
  /** A piece of office life (idle ambience), for the feed. */
  onLife(agentId: string, text: string): void;
  onLost(): void;
}

export interface OfficeHandle {
  setAgents(agents: readonly StudioAgent[]): void;
  select(id: string | null): void;
  setTheme(theme: StudioTheme): void;
  /** Multiply the camera distance (<1 zooms in). */
  zoom(factor: number): void;
  resetView(): void;
  /** Let the mouse wheel zoom without Ctrl — on in full-screen, off while the page needs to scroll. */
  setWheelZoom(enabled: boolean): void;
  destroy(): void;
}

type Act = "away" | "walk" | "seated" | "zone" | "alert" | "cheer" | "coffee" | "chat" | "meeting";

interface Slide {
  from: Vec2;
  to: Vec2;
  fromHeading: number;
  toHeading: number;
  t: number;
}

interface Actor {
  agent: StudioAgent;
  person: Person;
  desk: Desk;
  deskIndex: number;
  pos: Vec2;
  heading: number;
  /** Current walking speed (m/s): eases up from a standstill and down into the last waypoint. */
  speed: number;
  act: Act;
  goal: Goal;
  path: Vec2[];
  then: (() => void) | null;
  /** Seconds left in the current timed activity. */
  timer: number;
  /** Seconds until an idle agent considers a break. */
  idleIn: number;
  /** In a piece of office life (or hosting a chat) — not available for another. */
  busy: boolean;
  partner: Actor | null;
  rand: () => number;
  seed: number;
  stuck: number;
  ghost: number;
  /** Plain-words account of what it is doing (the selection panel). */
  label: string;
  /** The same in two or three words (the name tag). */
  status: string;
  slide: Slide | null;
  sim: Sim | null;
}

const SIM_SCALE = 0.85;
const FAR_AWAY: Vec2 = { x: 0, z: 40 };
const SLIDE_S = 0.55;
const PROPS: ReadonlyArray<[PropKind, number, number]> = [
  ["ball", -6.2, 2.4],
  ["ball", 6.2, 6.4],
  ["ball", -0.2, 6.9],
  ["ball", 3.1, 2.2],
  ["box", -6.4, 6.6],
  ["box", 6.3, 0.6],
  ["box", -3.0, 7.0]
];
const PAPERS = 6;
const PROP_COLOR: Readonly<Record<PropKind, number>> = { ball: 0xf97316, box: 0xc8a27a, paper: 0xf8fafc };
const ALERT_LABEL = "Needs a look — its last run failed or was blocked";

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function createRenderer(host: HTMLElement, small: boolean) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 2 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;cursor:grab";
  host.appendChild(canvas);
  return renderer;
}

/** Soft image-based light plus a warm key (with shadows) and a cool fill. */
function createLights(scene: THREE.Scene, renderer: THREE.WebGLRenderer, small: boolean) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = env;
  const hemi = new THREE.HemisphereLight(0xfff8ef, 0x8a7f72, 0.55);
  const sun = new THREE.DirectionalLight(0xffe4bd, 2.3);
  sun.position.set(-8, 17, 11);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(small ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 12, bottom: -12, near: 2, far: 45 });
  const fill = new THREE.DirectionalLight(0xc7dcff, 0.45);
  fill.position.set(10, 8, -6);
  scene.add(hemi, sun, fill);
  return {
    apply(theme: StudioTheme) {
      const dark = theme === "dark";
      scene.environmentIntensity = dark ? 0.22 : 0.42;
      hemi.intensity = dark ? 0.32 : 0.55;
      sun.intensity = dark ? 1.35 : 2.3;
      sun.color.setHex(dark ? 0xffd6a0 : 0xffe4bd);
      fill.intensity = dark ? 0.35 : 0.45;
    },
    dispose() {
      env.dispose();
    }
  };
}

export async function createOffice(host: HTMLElement, events: OfficeEvents, opts: { reducedMotion: boolean; theme: StudioTheme }): Promise<OfficeHandle> {
  const instant = opts.reducedMotion;
  const width = () => host.clientWidth || 1;
  const height = () => host.clientHeight || 1;
  const small = width() < 640;

  const solid = obstacles();
  const grid = buildNavGrid(solid);
  const physics = await createPhysics(solid);

  const renderer = createRenderer(host, small);
  renderer.setSize(width(), height());
  const canvas = renderer.domElement;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, width() / height(), 0.1, 200);
  const rig = createCameraRig(camera, instant);
  const lights = createLights(scene, renderer, small);
  /** Labels shrink a little on a phone, where three tags would otherwise cover the office. */
  const compact = () => (width() < 640 ? 0.78 : 1);
  const fitLabels = () => {
    LABEL_UNIT.value = ((2 * Math.tan((FOV * Math.PI) / 360)) / height()) * compact();
  };
  fitLabels();

  let theme = opts.theme;
  const building = buildOffice(theme);
  scene.add(building.group);
  const flows = createFlows();
  scene.add(flows.group);

  // ---- loose props, mirrored from the physics world ------------------------------------------------
  const propGeo: Record<PropKind, THREE.BufferGeometry> = {
    ball: new THREE.SphereGeometry(0.11, 20, 14),
    box: new THREE.BoxGeometry(0.34, 0.34, 0.34),
    paper: new THREE.IcosahedronGeometry(0.06, 0)
  };
  const propMat: Record<PropKind, THREE.Material> = {
    ball: new THREE.MeshStandardMaterial({ color: PROP_COLOR.ball, roughness: 0.45 }),
    box: new THREE.MeshStandardMaterial({ color: PROP_COLOR.box, roughness: 0.85 }),
    paper: new THREE.MeshStandardMaterial({ color: PROP_COLOR.paper, roughness: 0.9, flatShading: true })
  };
  const propMeshes: THREE.Mesh[] = [];
  const addProp = (kind: PropKind, x: number, y: number, z: number) => {
    physics.addProp(kind, x, y, z);
    const mesh = new THREE.Mesh(propGeo[kind], propMat[kind]);
    mesh.castShadow = true;
    propMeshes.push(mesh);
    scene.add(mesh);
  };
  for (const [kind, x, z] of PROPS) addProp(kind, x, 0.4, z);
  const firstPaper = PROPS.length;
  for (let i = 0; i < PAPERS; i += 1) addProp("paper", BIN.x + (i % 2) * 0.08 - 0.04, 0.15 + i * 0.13, BIN.z);
  let nextPaper = 0;

  // ---- actors ----------------------------------------------------------------------------------------
  const actors = new Map<string, Actor>();
  const loading = new Set<string>();
  let populated = false;
  let selectedId: string | null = null;
  /** What the page asked to select — models load asynchronously, so the person may not exist yet. */
  let wantedId: string | null = null;
  let hoveredId: string | null = null;
  let dead = false;
  let clock = 0;

  const say = (a: Actor, text: string) => events.onLife(a.agent.id, text);
  const idleNow = () => [...actors.values()].filter((a) => a.act === "seated" && a.goal === "desk" && !a.busy);

  function doing(a: Actor, label: string, status: string) {
    a.label = label;
    if (a.status === status) return;
    a.status = status;
    a.person.setStatus(status);
  }

  function place(a: Actor, at: Vec2, heading: number) {
    a.pos = { x: at.x, z: at.z };
    a.heading = heading;
    a.slide = null;
    physics.placePerson(a.agent.id, at);
    a.person.root.position.set(at.x, 0, at.z);
    a.person.root.rotation.y = heading;
  }

  /** Ease from where it stands into a spot (a chair, a work position), turning as it goes. */
  function settleAt(a: Actor, at: Vec2, heading: number) {
    if (instant) return place(a, at, heading);
    physics.placePerson(a.agent.id, at);
    a.slide = { from: { ...a.pos }, to: { x: at.x, z: at.z }, fromHeading: a.heading, toHeading: heading, t: 0 };
  }

  function sit(a: Actor, seat: Seat, act: Act, label: string, status: string) {
    settleAt(a, seat.seat, seat.heading);
    a.person.play("sit", 0.45);
    a.act = act;
    doing(a, label, status);
  }

  /** Walk to a point, then do something. Under reduced motion nobody walks: they are simply there. */
  function walkTo(a: Actor, target: Vec2, label: string, status: string, then: () => void) {
    building.setLaptop(a.deskIndex, false);
    doing(a, label, status);
    a.then = then;
    if (instant) {
      place(a, target, a.heading);
      finishWalk(a);
      return;
    }
    a.path = findPath(grid, a.pos, target) ?? [target];
    a.act = "walk";
    a.stuck = 0;
    a.speed = Math.min(a.speed, 0.3);
    a.person.play("walk", 0.3);
  }

  function finishWalk(a: Actor) {
    const then = a.then;
    a.then = null;
    a.path = [];
    then?.();
  }

  /** Step back into the building from outside, if it was away. */
  function enter(a: Actor) {
    if (a.act !== "away") return;
    a.person.root.visible = true;
    place(a, OUTSIDE, Math.PI);
  }

  function goDesk(a: Actor, label = "Heading back to the desk") {
    enter(a);
    walkTo(a, a.desk.access, label, "Back to the desk", () => {
      const working = a.agent.archetype === "assistant" && a.goal === "zone";
      sit(a, a.desk, "seated", working ? "Working at the desk" : "At the desk", working ? "Working at the desk" : "At the desk");
      building.setLaptop(a.deskIndex, true);
      a.idleIn = idlePause(a.rand);
    });
  }

  function goAway(a: Actor) {
    if (a.act === "away") return;
    walkTo(a, OUTSIDE, "Heading out — switched off", "Heading out", () => {
      a.act = "away";
      doing(a, "Switched off", "Switched off");
      a.person.root.visible = false;
      place(a, FAR_AWAY, 0);
    });
  }

  function goZone(a: Actor) {
    const roomId = ZONE_OF[a.agent.archetype];
    const spot = zoneSpot(roomId);
    if (!spot) return goDesk(a, "Starting the run at the desk");
    enter(a);
    walkTo(a, spot.stand, `Walking to ${roomById(roomId)?.label ?? "the zone"}`, `To ${roomById(roomId)?.label ?? "the zone"}`, () => {
      settleAt(a, spot.stand, headingTo(spot.stand, spot.face));
      a.act = "zone";
      a.timer = 0;
      doing(a, TASK_TITLE[a.agent.archetype], TASK_TITLE[a.agent.archetype]);
      a.person.play("point");
    });
  }

  function goAlert(a: Actor) {
    enter(a);
    walkTo(a, a.desk.access, "Flagging a problem", "Flagging a problem", () => {
      settleAt(a, a.desk.access, 0);
      a.act = "alert";
      doing(a, ALERT_LABEL, "Needs a look");
      a.person.play("wave");
      a.person.setBubble("⚠ Run failed");
    });
  }

  function celebrate(a: Actor) {
    if (a.act === "away") return goDesk(a);
    a.path = [];
    a.then = null;
    a.act = "cheer";
    doing(a, "Just finished a run", "Run finished");
    a.timer = 2.4;
    a.person.play("cheer", 0.15);
    a.person.setBubble("Done! ✓");
    physics.tossPaper(firstPaper + (nextPaper % PAPERS), { x: a.pos.x, y: 1.9, z: a.pos.z });
    nextPaper += 1;
  }

  function hush(a: Actor) {
    a.person.setTalking(false);
    a.person.setBubble(null);
    a.person.lookAt(null);
    a.busy = false;
  }

  /** Drop whatever office life it was in — a real goal always wins. */
  function interrupt(a: Actor) {
    hush(a);
    const partner = a.partner;
    a.partner = null;
    if (!partner) return;
    partner.partner = null;
    hush(partner);
  }

  const GOAL_ACTION: Readonly<Record<Goal, (a: Actor) => void>> = { away: goAway, zone: goZone, alert: goAlert, celebrate, desk: goDesk };

  function applyGoal(a: Actor) {
    interrupt(a);
    GOAL_ACTION[a.goal](a);
  }

  /** First paint: everyone is already where their state puts them, nobody walks in. */
  function settle(a: Actor) {
    if (a.goal === "away") {
      a.act = "away";
      doing(a, "Switched off", "Switched off");
      a.person.root.visible = false;
      place(a, FAR_AWAY, 0);
      return;
    }
    a.person.root.visible = true;
    place(a, a.desk.access, 0);
    settleInto(a);
  }

  function settleInto(a: Actor) {
    const spot = a.goal === "zone" ? zoneSpot(ZONE_OF[a.agent.archetype]) : null;
    if (spot) {
      place(a, spot.stand, headingTo(spot.stand, spot.face));
      a.act = "zone";
      doing(a, TASK_TITLE[a.agent.archetype], TASK_TITLE[a.agent.archetype]);
      a.person.play("point", 0);
      return;
    }
    if (a.goal === "alert") {
      a.act = "alert";
      doing(a, ALERT_LABEL, "Needs a look");
      a.person.play("wave", 0);
      a.person.setBubble("⚠ Run failed");
      return;
    }
    place(a, a.desk.seat, a.desk.heading);
    a.person.play("sit", 0);
    a.act = "seated";
    doing(a, "At the desk", "At the desk");
    building.setLaptop(a.deskIndex, true);
    a.idleIn = 8 + idlePause(a.rand) * a.rand();
    if (a.goal === "celebrate") celebrate(a);
  }

  function freeDesk(): number {
    const used = new Set([...actors.values()].map((a) => a.deskIndex));
    for (let i = 0; i < DESKS.length; i += 1) if (!used.has(i)) return i;
    return 0;
  }

  function newActor(agent: StudioAgent, person: Person): Actor {
    const deskIndex = freeDesk();
    const seed = hashSeed(agent.id);
    return {
      agent,
      person,
      desk: DESKS[deskIndex],
      deskIndex,
      pos: { ...FAR_AWAY },
      heading: 0,
      speed: 0,
      act: "away",
      goal: goalFor(agent.mood),
      path: [],
      then: null,
      timer: 0,
      idleIn: 10,
      busy: false,
      partner: null,
      rand: mulberry32(seed),
      seed,
      stuck: 0,
      ghost: 0,
      label: "",
      status: "",
      slide: null,
      sim: null
    };
  }

  async function addActor(agent: StudioAgent, file: string, walkIn: boolean) {
    loading.add(agent.id);
    const person = await createPerson(file, agent.name, agent.tint, agent.mood);
    loading.delete(agent.id);
    if (dead || actors.has(agent.id)) return person.dispose();
    const a = newActor(agent, person);
    const room = roomById(ZONE_OF[agent.archetype]);
    if (room) {
      a.sim = buildSim(agent.archetype, agent.id, 0x38bdf8);
      const centre = equipmentCentre(room);
      a.sim.group.position.set(centre.x, 0, centre.z);
      a.sim.group.scale.setScalar(SIM_SCALE);
      scene.add(a.sim.group);
    }
    physics.addPerson(agent.id, FAR_AWAY);
    person.root.visible = false;
    scene.add(person.root);
    actors.set(agent.id, a);
    if (agent.id === wantedId) select(wantedId);
    if (walkIn) applyGoal(a);
    else settle(a);
    wake();
  }

  function removeActor(a: Actor) {
    interrupt(a);
    scene.remove(a.person.root);
    a.person.dispose();
    if (a.sim) {
      scene.remove(a.sim.group);
      a.sim.dispose();
    }
    building.setLaptop(a.deskIndex, false);
    physics.removePerson(a.agent.id);
    actors.delete(a.agent.id);
    if (selectedId === a.agent.id) selectedId = null;
  }

  function updateActor(a: Actor, agent: StudioAgent) {
    const moodChanged = agent.mood !== a.agent.mood;
    a.agent = agent;
    if (!moodChanged) return;
    a.person.setMood(agent.mood);
    const goal = goalFor(agent.mood);
    if (goal === a.goal) return;
    a.goal = goal;
    applyGoal(a);
  }

  function setAgents(agents: readonly StudioAgent[]) {
    const incoming = agents.slice(0, MAX_AGENTS);
    const ids = new Set(incoming.map((x) => x.id));
    for (const a of [...actors.values()]) if (!ids.has(a.agent.id)) removeActor(a);
    const cast = castPeople(incoming.map((x) => x.archetype));
    incoming.forEach((agent, i) => {
      const existing = actors.get(agent.id);
      if (existing) updateActor(existing, agent);
      else if (!loading.has(agent.id)) void addActor(agent, cast[i], populated);
    });
    populated = true;
    wake();
  }

  // ---- office life -------------------------------------------------------------------------------------
  function startCoffee(a: Actor) {
    a.busy = true;
    walkTo(a, COFFEE_SPOT.stand, "Getting a coffee", "Coffee break", () => {
      settleAt(a, COFFEE_SPOT.stand, headingTo(COFFEE_SPOT.stand, COFFEE_SPOT.face));
      a.act = "coffee";
      a.timer = 5;
      a.person.play("idle");
      a.person.setBubble("☕ Coffee break");
      say(a, "is getting a coffee");
    });
  }

  function startChat(a: Actor, host: Actor) {
    a.busy = true;
    host.busy = true;
    a.partner = host;
    host.partner = a;
    walkTo(a, host.desk.access, `Stopping by ${host.agent.name}'s desk`, `To ${host.agent.name}`, () => {
      settleAt(a, host.desk.access, headingTo(host.desk.access, host.desk.seat));
      a.act = "chat";
      a.timer = 8;
      doing(a, `Chatting with ${host.agent.name}`, `Chatting with ${host.agent.name}`);
      doing(host, `Chatting with ${a.agent.name}`, `Chatting with ${a.agent.name}`);
      a.person.play("idle");
      say(a, `is chatting with ${host.agent.name}`);
    });
  }

  function startStandup(members: Actor[]) {
    members.forEach((m, i) => {
      m.busy = true;
      const seat = MEETING_SEATS[i];
      walkTo(m, seat.access, "Heading to a stand-up", "To the stand-up", () => {
        sit(m, seat, "meeting", "In a stand-up", "In a stand-up");
        m.timer = 12;
      });
    });
    say(members[0], `called a stand-up with ${members.length - 1} others`);
  }

  function startIdleLife(a: Actor) {
    a.idleIn = idlePause(a.rand);
    const others = idleNow().filter((o) => o !== a);
    const choice = pickIdleActivity(a.rand, others.length + 1);
    if (choice === "coffee") startCoffee(a);
    else if (choice === "chat") startChat(a, others[Math.floor(a.rand() * others.length)]);
    else if (choice === "standup") startStandup([a, ...others].slice(0, MEETING_SEATS.length));
  }

  function endLife(a: Actor) {
    const host = a.partner;
    interrupt(a);
    if (host?.act === "seated") doing(host, "At the desk", "At the desk");
    goDesk(a);
  }

  // ---- per-frame behaviour -----------------------------------------------------------------------------
  /** Metres left along the path — to slow into the last waypoint instead of stopping dead. */
  function remaining(a: Actor): number {
    let total = 0;
    let from = a.pos;
    for (const p of a.path) {
      total += Math.hypot(p.x - from.x, p.z - from.z);
      from = p;
    }
    return total;
  }

  function stepWalk(a: Actor, dt: number) {
    const target = a.path[0];
    if (!target) return finishWalk(a);
    const dx = target.x - a.pos.x;
    const dz = target.z - a.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.1) {
      a.path.shift();
      return;
    }
    // Ease in from a standstill, ease out into the destination; slow down for sharp turns.
    const turn = Math.abs(turnBetween(a.heading, headingTo(a.pos, target)));
    const want = WALK_SPEED * Math.min(1, Math.max(0.35, remaining(a) / 0.9)) * (turn > 1.2 ? 0.55 : 1);
    a.speed += (want - a.speed) * Math.min(1, dt * 3.5);
    a.person.setPace(a.speed / WALK_SPEED);
    const step = Math.min(dist, a.speed * dt);
    const next = physics.movePerson(a.agent.id, (dx / dist) * step, (dz / dist) * step, a.ghost > 0);
    const moved = Math.hypot(next.x - a.pos.x, next.z - a.pos.z);
    a.stuck = moved < step * 0.3 ? a.stuck + dt : 0;
    a.ghost = a.stuck > 1.2 ? 1.5 : a.ghost - dt;
    a.pos = next;
    // Hopelessly wedged (a prop in a doorway, say): skip to the waypoint rather than walk on the spot forever.
    if (a.stuck > 3.5) {
      place(a, target, a.heading);
      a.stuck = 0;
    }
    a.heading += turnBetween(a.heading, headingTo(a.pos, target)) * Math.min(1, dt * 7);
    a.person.root.position.set(a.pos.x, 0, a.pos.z);
    a.person.root.rotation.y = a.heading;
  }

  function stepSlide(a: Actor, dt: number) {
    const s = a.slide;
    if (!s) return;
    s.t = Math.min(1, s.t + dt / SLIDE_S);
    const k = smoothstep(s.t);
    a.pos = { x: s.from.x + (s.to.x - s.from.x) * k, z: s.from.z + (s.to.z - s.from.z) * k };
    a.heading = s.fromHeading + turnBetween(s.fromHeading, s.toHeading) * k;
    a.person.root.position.set(a.pos.x, 0, a.pos.z);
    a.person.root.rotation.y = a.heading;
    if (s.t >= 1) a.slide = null;
  }

  function stepSeated(a: Actor, dt: number) {
    if (instant || a.busy || a.goal !== "desk") return;
    a.idleIn -= dt;
    if (a.idleIn <= 0) startIdleLife(a);
  }

  function stepZone(a: Actor, dt: number) {
    // Alternate pointing at the equipment with standing back to watch it.
    a.timer += dt;
    a.person.play(a.timer % 9 < 5.5 ? "point" : "idle", 0.5);
  }

  function stepTimed(a: Actor, dt: number) {
    a.timer -= dt;
    if (a.timer <= 0) endLife(a);
  }

  const headOf = (a: Actor, y: number) => new THREE.Vector3(a.pos.x, y, a.pos.z);

  function stepChat(a: Actor, dt: number) {
    const host = a.partner;
    if (!host || host.goal !== "desk") return endLife(a);
    const turn = Math.floor((8 - a.timer) / 2);
    const mine = turn % 2 === 0;
    a.person.setTalking(mine);
    host.person.setTalking(!mine);
    const kind = turn === 0 ? "open" : "reply";
    a.person.setBubble(mine ? speechLine(kind, a.seed, turn) : null);
    host.person.setBubble(mine ? null : speechLine("reply", host.seed, turn));
    a.person.lookAt(headOf(host, 1.2));
    host.person.lookAt(headOf(a, 1.6));
    stepTimed(a, dt);
  }

  function stepMeeting(a: Actor, dt: number) {
    const seated = [...actors.values()].filter((m) => m.act === "meeting");
    const turn = Math.floor(clock / 2.4);
    const speaker = seated[turn % Math.max(1, seated.length)];
    a.person.setTalking(speaker === a);
    a.person.setBubble(speaker === a ? speechLine("standup", a.seed, turn) : null);
    a.person.lookAt(speaker && speaker !== a ? headOf(speaker, 1.2) : null);
    stepTimed(a, dt);
  }

  function stepCheer(a: Actor, dt: number) {
    a.timer -= dt;
    if (a.timer > 0 || a.goal === "celebrate") return;
    a.person.setBubble(null);
    GOAL_ACTION[a.goal](a);
  }

  const noop = () => undefined;
  const STEP: Readonly<Record<Act, (a: Actor, dt: number) => void>> = {
    away: noop,
    walk: stepWalk,
    seated: stepSeated,
    zone: stepZone,
    alert: noop,
    cheer: stepCheer,
    coffee: stepTimed,
    chat: stepChat,
    meeting: stepMeeting
  };

  function simIntensity(a: Actor): number {
    if (a.act === "zone") return 1;
    return a.act === "away" ? 0 : 0.18;
  }

  /** The hovered person glances at the camera; everyone else looks where their activity says. */
  function glance(a: Actor) {
    if (a.agent.id !== hoveredId || a.act === "chat" || a.act === "meeting") return;
    a.person.lookAt(camera.position);
  }

  function stepActors(dt: number): boolean {
    let anyone = false;
    for (const a of actors.values()) {
      stepSlide(a, dt);
      STEP[a.act](a, dt);
      a.sim?.update(clock, dt, simIntensity(a));
      if (a.act === "away") continue;
      anyone = true;
      glance(a);
      a.person.update(dt, clock);
    }
    return anyone;
  }

  // ---- task cards and flows (refreshed a few times a second, not every frame) ---------------------------
  function cardFor(a: Actor) {
    if (a.act !== "zone" || !a.sim) return null;
    return { icon: a.agent.emoji, title: TASK_TITLE[a.agent.archetype], caption: a.sim.caption(), accent: AGENT_PALETTE[a.agent.tint % AGENT_PALETTE.length].css };
  }

  function zoneAnchor(archetype: Archetype): THREE.Vector3 | null {
    const room = roomById(ZONE_OF[archetype]);
    if (!room) return null;
    const c = equipmentCentre(room);
    return new THREE.Vector3(c.x, 1.7, c.z);
  }

  function pipelineArcs(): ArcSpec[] {
    const present = [...actors.values()].filter((a) => a.act !== "away");
    const working = new Set(present.filter((a) => a.act === "zone").map((a) => a.agent.archetype));
    const there = new Set(present.map((a) => a.agent.archetype));
    const arcs: ArcSpec[] = [];
    for (const f of activeFlows(working, there)) {
      const from = zoneAnchor(f.from);
      const to = zoneAnchor(f.to);
      if (from && to) arcs.push({ key: `p-${f.from}-${f.to}`, from, to, color: 0x38bdf8, lift: 1.6, strength: f.both ? 1 : 0.65, twoWay: false });
    }
    return arcs;
  }

  function talkArcs(): ArcSpec[] {
    const arcs: ArcSpec[] = [];
    for (const a of actors.values()) {
      if (a.act === "chat" && a.partner) arcs.push({ key: `c-${a.agent.id}`, from: headOf(a, 1.75), to: headOf(a.partner, 1.35), color: 0x34d399, lift: 0.5, strength: 0.5, twoWay: true });
    }
    const meeting = [...actors.values()].filter((m) => m.act === "meeting" && !m.slide);
    const speaker = meeting[Math.floor(clock / 2.4) % Math.max(1, meeting.length)];
    for (const m of meeting) {
      if (speaker && m !== speaker) arcs.push({ key: `m-${m.agent.id}`, from: headOf(speaker, 1.35), to: headOf(m, 1.35), color: 0xa5b4fc, lift: 0.45, strength: 0.4, twoWay: false });
    }
    return arcs;
  }

  let infoAcc = 0;
  function refreshInfo(dt: number) {
    infoAcc += dt;
    if (infoAcc < 0.4) return;
    infoAcc = 0;
    for (const a of actors.values()) a.person.card.set(cardFor(a));
    flows.set([...pipelineArcs(), ...talkArcs()]);
    const a = actors.get(selectedId ?? hoveredId ?? "");
    if (!a) return;
    if (a.act === "zone" && a.sim) events.onCaption(a.agent.id, a.sim.caption(), true);
    else events.onCaption(a.agent.id, a.label, false);
  }

  /** Lift name tags that would land on top of each other (screen space, every frame — ≤ 8 tags). */
  const anchorAt = new THREE.Vector3();
  function arrangeLabels() {
    const present = [...actors.values()].filter((a) => a.act !== "away");
    const boxes = present.map((a) => {
      a.person.labelAnchor(anchorAt).project(camera);
      return { x: ((anchorAt.x + 1) / 2) * width(), y: ((1 - anchorAt.y) / 2) * height(), h: a.person.stackHeight() * compact() };
    });
    const k = compact();
    // Keep the widest label (the task card) inside the canvas, with an 8 px margin.
    const half = (CARD_W * k) / 2 + 8;
    declutter(boxes, TAG_W * k, TAG_H * k).forEach((lift, i) => {
      const x = boxes[i].x;
      const inside = Math.min(width() - half, Math.max(half, x));
      // Never lift a stack off the top of the canvas — a slight overlap beats a missing name.
      const ceiling = Math.max(0, boxes[i].y - boxes[i].h - 8);
      present[i].person.setLift(Math.min(lift, ceiling) / k, (inside - x) / k);
    });
  }

  // ---- selection and hover -----------------------------------------------------------------------------
  function emphasise() {
    for (const a of actors.values()) {
      let level: 0 | 1 | 2 = 0;
      if (a.agent.id === selectedId) level = 2;
      else if (a.agent.id === hoveredId) level = 1;
      a.person.setEmphasis(level);
      if (level === 0 && a.act !== "chat" && a.act !== "meeting") a.person.lookAt(null);
    }
  }

  function select(id: string | null) {
    wantedId = id;
    selectedId = id && actors.has(id) ? id : null;
    emphasise();
    if (selectedId) rig.closeIn(9);
    else rig.resetView();
    wake();
  }

  // ---- pointer -----------------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number; dragged: boolean } | null = null;

  function aim(e: PointerEvent | MouseEvent): DOMRect {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return rect;
  }

  function pickActor(): Actor | null {
    const present = [...actors.values()].filter((a) => a.act !== "away");
    const hit = raycaster.intersectObjects(
      present.map((a) => a.person.hit),
      false
    )[0];
    return hit ? (present.find((a) => a.person.hit === hit.object) ?? null) : null;
  }

  function flickProp(): boolean {
    const hit = raycaster.intersectObjects(propMeshes, false)[0];
    if (!hit) return false;
    const away = new THREE.Vector3().subVectors(hit.point, camera.position).setY(0).normalize();
    physics.flick(propMeshes.indexOf(hit.object as THREE.Mesh), away.x, away.z);
    return true;
  }

  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY, dragged: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (down) {
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.dragged && Math.hypot(dx, dy) < 5) return;
      down = { x: e.clientX, y: e.clientY, dragged: true };
      rig.orbit(dx, dy);
      canvas.style.cursor = "grabbing";
      return wake();
    }
    const rect = aim(e);
    const over = pickActor();
    const next = over?.agent.id ?? null;
    canvas.style.cursor = over ? "pointer" : "grab";
    if (next !== hoveredId) {
      hoveredId = next;
      emphasise();
      wake();
    }
    events.onHover(hoveredId, e.clientX - rect.left, e.clientY - rect.top);
  };
  const onUp = (e: PointerEvent) => {
    const wasDrag = down?.dragged ?? false;
    down = null;
    canvas.style.cursor = "grab";
    if (wasDrag) return;
    aim(e);
    const over = pickActor();
    if (!over && flickProp()) return wake();
    select(over && over.agent.id !== selectedId ? over.agent.id : null);
    events.onSelect(selectedId);
  };
  const onLeave = () => {
    hoveredId = null;
    emphasise();
    events.onHover(null, 0, 0);
  };
  const onWheel = (e: WheelEvent) => {
    if (!wheelZoom && !e.ctrlKey) return;
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.0012));
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    events.onLost();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("webglcontextlost", onLost);

  let wheelZoom = false;
  function zoom(factor: number) {
    rig.zoom(factor);
    wake();
  }

  // ---- frame -------------------------------------------------------------------------------------------
  function syncProps() {
    const states = physics.props();
    for (let i = 0; i < states.length; i += 1) {
      const s = states[i];
      propMeshes[i].position.set(s.position.x, s.position.y, s.position.z);
      propMeshes[i].quaternion.set(s.rotation.x, s.rotation.y, s.rotation.z, s.rotation.w);
    }
  }

  function step(dt: number): boolean {
    clock += dt;
    const anyone = stepActors(dt);
    physics.step(dt);
    syncProps();
    const followed = selectedId ? actors.get(selectedId) : undefined;
    const follow = followed && followed.act !== "away" ? new THREE.Vector3(followed.pos.x, 0, followed.pos.z) : null;
    const cameraMoving = rig.step(dt, follow, anyone && !selectedId && down === null);
    const wallsMoving = building.update(camera, dt);
    refreshInfo(dt);
    arrangeLabels();
    const flowing = flows.update(clock, dt);
    return anyone || cameraMoving || wallsMoving || flowing || down !== null;
  }

  let loop: RenderLoopHandle | undefined;
  let last = performance.now();
  function frame(): boolean {
    if (dead) return false;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const keepGoing = step(dt);
    renderer.render(scene, camera);
    return keepGoing;
  }

  function wake() {
    if (dead) return;
    if (!instant) return loop?.wake();
    infoAcc = 1;
    for (let i = 0; i < 12; i += 1) step(0.05);
    renderer.render(scene, camera);
  }

  function applyTheme(next: StudioTheme) {
    theme = next;
    building.setTheme(next);
    lights.apply(next);
  }

  const observer = new ResizeObserver(() => {
    renderer.setSize(width(), height());
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    fitLabels();
    rig.refit(selectedId !== null);
    wake();
  });
  observer.observe(host);

  applyTheme(theme);
  if (!instant) loop = createRenderLoop({ host, fps: 30, render: frame });

  return {
    setAgents,
    select,
    setTheme: (next) => {
      applyTheme(next);
      wake();
    },
    zoom,
    resetView: () => {
      rig.resetView();
      wake();
    },
    setWheelZoom: (enabled) => {
      wheelZoom = enabled;
    },
    destroy: () => {
      dead = true;
      loop?.stop();
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const a of [...actors.values()]) removeActor(a);
      building.dispose();
      flows.dispose();
      lights.dispose();
      for (const g of Object.values(propGeo)) g.dispose();
      for (const m of Object.values(propMat)) m.dispose();
      physics.dispose();
      renderer.dispose();
      canvas.remove();
    }
  };
}
