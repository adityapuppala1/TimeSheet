/**
 * WHAT: the Agents Office scene — a furnished office floor where each agent is a person who sits at
 * a desk, walks (A* route, physics-resolved steps), works its room's equipment while a run is live,
 * and between runs gets coffee, chats at a colleague's desk or joins a stand-up. `createOffice` is the
 * only export; AgentOffice.tsx owns the DOM around it.
 *
 * WHAT DRIVES AN AGENT (office-model.ts `goalFor`): its REAL mood. Switched off → it walks out of the
 * door. A run queued or running → it stands up and walks to its zone, and that room's equipment runs
 * flat out. A recent failed run → it stands at its desk waving for help. A run just finished → it
 * cheers and lobs a paper ball at the bin (a real projectile in the physics world). Otherwise it sits
 * at its desk, laptop lit. A real goal always interrupts office life, never the other way round.
 *
 * OFFICE LIFE (coffee, chats, stand-ups) is seeded ambience for agents with nothing running, reported
 * through `onLife` so the UI can label it as idle. Zone equipment captions are still "simulated".
 *
 * FRAME POLICY: lib/render-loop.ts — nothing off screen or in a background tab, 30fps, and a rest
 * state when everyone is away and the camera is still. Reduced motion: no loop, nobody walks (they
 * are placed where they are going), one frame per change.
 *
 * Loaded by dynamic import only: three.js, Rapier and the models never reach another page.
 */
import * as THREE from "three";
import { createRenderLoop, type RenderLoopHandle } from "../../../lib/render-loop";
import { hashSeed, mulberry32 } from "../../agents-studio/studio-model";
import { buildSim, type Sim } from "../../agents-studio/scene/sims";
import type { StudioAgent, StudioTheme } from "../../agents-studio/scene/types";
import {
  BIN,
  buildNavGrid,
  castPeople,
  COFFEE_SPOT,
  DESKS,
  equipmentCentre,
  findPath,
  FLOOR,
  goalFor,
  headingTo,
  idlePause,
  MAX_AGENTS,
  MEETING_SEATS,
  obstacles,
  OUTSIDE,
  pickIdleActivity,
  roomById,
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

interface Actor {
  agent: StudioAgent;
  person: Person;
  desk: Desk;
  deskIndex: number;
  pos: Vec2;
  heading: number;
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
  stuck: number;
  ghost: number;
  /** Plain-words account of what it is doing. */
  label: string;
  sim: Sim | null;
}

const FOV = 38;
const SIM_SCALE = 0.85;
const FAR_AWAY: Vec2 = { x: 0, z: 40 };
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

export async function createOffice(host: HTMLElement, events: OfficeEvents, opts: { reducedMotion: boolean; theme: StudioTheme }): Promise<OfficeHandle> {
  const instant = opts.reducedMotion;
  const width = () => host.clientWidth || 1;
  const height = () => host.clientHeight || 1;

  const solid = obstacles();
  const grid = buildNavGrid(solid);
  const physics = await createPhysics(solid);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(width(), height());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;cursor:grab";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, width() / height(), 0.1, 200);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x94a3b8, 1.2);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.set(-9, 18, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 14, bottom: -14, near: 1, far: 50 });
  scene.add(hemi, sun);

  let theme = opts.theme;
  const building = buildOffice(theme);
  scene.add(building.group);

  // ---- loose props, mirrored from the physics world ------------------------------------------------
  const propGeo: Record<PropKind, THREE.BufferGeometry> = {
    ball: new THREE.SphereGeometry(0.11, 16, 12),
    box: new THREE.BoxGeometry(0.34, 0.34, 0.34),
    paper: new THREE.IcosahedronGeometry(0.06, 0)
  };
  const propMats: THREE.Material[] = [];
  const propMeshes: THREE.Mesh[] = [];
  const addProp = (kind: PropKind, x: number, y: number, z: number) => {
    physics.addProp(kind, x, y, z);
    const material = new THREE.MeshStandardMaterial({ color: PROP_COLOR[kind], roughness: 0.6, flatShading: kind === "paper" });
    propMats.push(material);
    const mesh = new THREE.Mesh(propGeo[kind], material);
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

  function place(a: Actor, at: Vec2, heading: number) {
    a.pos = { x: at.x, z: at.z };
    a.heading = heading;
    physics.placePerson(a.agent.id, at);
    a.person.root.position.set(at.x, 0, at.z);
    a.person.root.rotation.y = heading;
  }

  function sit(a: Actor, seat: Seat, act: Act, label: string) {
    place(a, seat.seat, seat.heading);
    a.person.play("sit");
    a.act = act;
    a.label = label;
  }

  /** Walk to a point, then do something. Under reduced motion nobody walks: they are simply there. */
  function walkTo(a: Actor, target: Vec2, label: string, then: () => void) {
    building.setLaptop(a.deskIndex, false);
    a.label = label;
    a.then = then;
    if (instant) {
      place(a, target, a.heading);
      finishWalk(a);
      return;
    }
    a.path = findPath(grid, a.pos, target) ?? [target];
    a.act = "walk";
    a.stuck = 0;
    a.person.play("walk", 0.25);
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
    walkTo(a, a.desk.access, label, () => {
      sit(a, a.desk, "seated", a.agent.archetype === "assistant" && a.goal === "zone" ? "Working at the desk" : "At the desk");
      building.setLaptop(a.deskIndex, true);
      a.idleIn = idlePause(a.rand);
    });
  }

  function goAway(a: Actor) {
    if (a.act === "away") return;
    walkTo(a, OUTSIDE, "Heading out — switched off", () => {
      a.act = "away";
      a.label = "Switched off";
      a.person.root.visible = false;
      place(a, FAR_AWAY, 0);
    });
  }

  function goZone(a: Actor) {
    const roomId = ZONE_OF[a.agent.archetype];
    const spot = zoneSpot(roomId);
    if (!spot) return goDesk(a, "Starting the run at the desk");
    enter(a);
    walkTo(a, spot.stand, `Walking to ${roomById(roomId)?.label ?? "the zone"}`, () => {
      place(a, spot.stand, headingTo(spot.stand, spot.face));
      a.act = "zone";
      a.timer = 0;
      a.person.play("point");
    });
  }

  function goAlert(a: Actor) {
    enter(a);
    walkTo(a, a.desk.access, "Flagging a problem", () => {
      place(a, a.desk.access, 0);
      a.act = "alert";
      a.label = "Needs a look — its last run failed or was blocked";
      a.person.play("wave");
      a.person.setBubble("!");
    });
  }

  function celebrate(a: Actor) {
    if (a.act === "away") return goDesk(a);
    a.path = [];
    a.then = null;
    a.act = "cheer";
    a.label = "Just finished a run";
    a.timer = 2.4;
    a.person.play("cheer", 0.15);
    a.person.setBubble("✓");
    physics.tossPaper(firstPaper + (nextPaper % PAPERS), { x: a.pos.x, y: 1.9, z: a.pos.z });
    nextPaper += 1;
  }

  /** Drop whatever office life it was in — a real goal always wins. */
  function interrupt(a: Actor) {
    a.person.setTalking(false);
    a.person.setBubble(null);
    a.busy = false;
    const partner = a.partner;
    a.partner = null;
    if (!partner) return;
    partner.partner = null;
    partner.busy = false;
    partner.person.setTalking(false);
    partner.person.setBubble(null);
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
      a.label = "Switched off";
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
      a.person.play("point", 0);
      return;
    }
    if (a.goal === "alert") {
      a.act = "alert";
      a.label = "Needs a look — its last run failed or was blocked";
      a.person.play("wave", 0);
      a.person.setBubble("!");
      return;
    }
    sit(a, a.desk, "seated", "At the desk");
    building.setLaptop(a.deskIndex, true);
    a.idleIn = 8 + idlePause(a.rand) * a.rand();
    if (a.goal === "celebrate") celebrate(a);
  }

  function freeDesk(): number {
    const used = new Set([...actors.values()].map((a) => a.deskIndex));
    for (let i = 0; i < DESKS.length; i += 1) if (!used.has(i)) return i;
    return 0;
  }

  async function addActor(agent: StudioAgent, file: string, walkIn: boolean) {
    loading.add(agent.id);
    const person = await createPerson(file, agent.name, agent.tint, agent.mood);
    loading.delete(agent.id);
    if (dead || actors.has(agent.id)) return person.dispose();
    const deskIndex = freeDesk();
    const a: Actor = {
      agent,
      person,
      desk: DESKS[deskIndex],
      deskIndex,
      pos: { ...FAR_AWAY },
      heading: 0,
      act: "away",
      goal: goalFor(agent.mood),
      path: [],
      then: null,
      timer: 0,
      idleIn: 10,
      busy: false,
      partner: null,
      rand: mulberry32(hashSeed(agent.id)),
      stuck: 0,
      ghost: 0,
      label: "",
      sim: null
    };
    const roomId = ZONE_OF[agent.archetype];
    const room = roomById(roomId);
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
    walkTo(a, COFFEE_SPOT.stand, "Getting a coffee", () => {
      place(a, COFFEE_SPOT.stand, headingTo(COFFEE_SPOT.stand, COFFEE_SPOT.face));
      a.act = "coffee";
      a.timer = 5;
      a.person.play("idle");
      a.person.setBubble("☕");
      say(a, "is getting a coffee");
    });
  }

  function startChat(a: Actor, host: Actor) {
    a.busy = true;
    host.busy = true;
    a.partner = host;
    host.partner = a;
    walkTo(a, host.desk.access, `Stopping by ${host.agent.name}'s desk`, () => {
      place(a, host.desk.access, headingTo(host.desk.access, host.desk.seat));
      a.act = "chat";
      a.timer = 7;
      a.person.play("idle");
      a.person.setBubble("💬");
      say(a, `is chatting with ${host.agent.name}`);
    });
  }

  function startStandup(members: Actor[]) {
    members.forEach((m, i) => {
      m.busy = true;
      const seat = MEETING_SEATS[i];
      walkTo(m, seat.access, "Heading to a stand-up", () => {
        sit(m, seat, "meeting", "In a stand-up");
        m.timer = 11;
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
    interrupt(a);
    goDesk(a);
  }

  // ---- per-frame behaviour -----------------------------------------------------------------------------
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
    const step = Math.min(dist, WALK_SPEED * dt);
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
    a.heading += turnBetween(a.heading, headingTo(a.pos, target)) * Math.min(1, dt * 9);
    a.person.root.position.set(a.pos.x, 0, a.pos.z);
    a.person.root.rotation.y = a.heading;
  }

  function stepSeated(a: Actor, dt: number) {
    if (instant || a.busy || a.goal !== "desk") return;
    a.idleIn -= dt;
    if (a.idleIn <= 0) startIdleLife(a);
  }

  function stepZone(a: Actor, dt: number) {
    // Alternate pointing at the equipment with standing back to watch it.
    a.timer += dt;
    a.person.play(a.timer % 9 < 5.5 ? "point" : "idle", 0.4);
  }

  function stepTimed(a: Actor, dt: number) {
    a.timer -= dt;
    if (a.timer <= 0) endLife(a);
  }

  function stepChat(a: Actor, dt: number) {
    const host = a.partner;
    if (!host || host.goal !== "desk") return endLife(a);
    const mine = Math.floor(a.timer / 1.7) % 2 === 0;
    a.person.setTalking(mine);
    host.person.setTalking(!mine);
    host.person.setBubble(mine ? null : "💬");
    stepTimed(a, dt);
  }

  function stepMeeting(a: Actor, dt: number) {
    const seated = [...actors.values()].filter((m) => m.act === "meeting");
    const speaker = seated[Math.floor(clock / 2.2) % Math.max(1, seated.length)];
    a.person.setTalking(speaker === a);
    a.person.setBubble(speaker === a ? "💬" : null);
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

  function stepActors(dt: number): boolean {
    let anyone = false;
    for (const a of actors.values()) {
      STEP[a.act](a, dt);
      a.sim?.update(clock, dt, simIntensity(a));
      if (a.act === "away") continue;
      anyone = true;
      a.person.update(dt, clock);
    }
    return anyone;
  }

  // ---- camera ------------------------------------------------------------------------------------------
  const view = { yaw: 0, pitch: 0.74, dist: 30, target: new THREE.Vector3(0, 0.6, 1.4) };
  const goal = { yaw: 0, pitch: 0.74, dist: 30, target: new THREE.Vector3(0, 0.6, 1.4) };
  let wheelZoom = false;

  function overviewDist(): number {
    const half = Math.tan((FOV * Math.PI) / 360);
    return Math.max((FLOOR.w / 2 + 2.2) / (half * camera.aspect), (FLOOR.d / 2 + 3) / half) * 0.78;
  }

  function resetView() {
    goal.yaw = 0;
    goal.pitch = 0.74;
    goal.dist = overviewDist();
    goal.target.set(0, 0.6, 1.4);
    wake();
  }

  function stepCamera(dt: number): boolean {
    const followed = selectedId ? actors.get(selectedId) : undefined;
    if (followed && followed.act !== "away") goal.target.set(followed.pos.x, 1, followed.pos.z);
    const k = instant ? 1 : 1 - Math.exp(-dt * 4);
    view.yaw += (goal.yaw - view.yaw) * k;
    view.pitch += (goal.pitch - view.pitch) * k;
    view.dist += (goal.dist - view.dist) * k;
    view.target.lerp(goal.target, k);
    const flat = Math.cos(view.pitch) * view.dist;
    camera.position.set(view.target.x + Math.sin(view.yaw) * flat, view.target.y + Math.sin(view.pitch) * view.dist, view.target.z + Math.cos(view.yaw) * flat);
    camera.lookAt(view.target);
    return Math.abs(goal.yaw - view.yaw) + Math.abs(goal.pitch - view.pitch) + Math.abs(goal.dist - view.dist) / 10 + view.target.distanceTo(goal.target) > 0.004;
  }

  function select(id: string | null) {
    wantedId = id;
    selectedId = id && actors.has(id) ? id : null;
    for (const a of actors.values()) a.person.setSelected(a.agent.id === selectedId);
    if (selectedId) goal.dist = Math.min(goal.dist, 9.5);
    else resetView();
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
      goal.yaw -= dx * 0.006;
      goal.pitch = Math.min(1.4, Math.max(0.3, goal.pitch + dy * 0.005));
      canvas.style.cursor = "grabbing";
      return wake();
    }
    const rect = aim(e);
    const over = pickActor();
    hoveredId = over?.agent.id ?? null;
    canvas.style.cursor = over ? "pointer" : "grab";
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

  function zoom(factor: number) {
    goal.dist = Math.min(46, Math.max(4.5, goal.dist * factor));
    wake();
  }

  // ---- frame -------------------------------------------------------------------------------------------
  let captionAcc = 0;
  function emitCaption(dt: number) {
    captionAcc += dt;
    if (captionAcc < 0.4) return;
    captionAcc = 0;
    const a = actors.get(selectedId ?? hoveredId ?? "");
    if (!a) return;
    if (a.act === "zone" && a.sim) events.onCaption(a.agent.id, a.sim.caption(), true);
    else events.onCaption(a.agent.id, a.label, false);
  }

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
    const cameraMoving = stepCamera(dt);
    emitCaption(dt);
    return anyone || cameraMoving || down !== null;
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
    for (let i = 0; i < 12; i += 1) step(0.05);
    renderer.render(scene, camera);
  }

  function applyTheme(next: StudioTheme) {
    theme = next;
    building.setTheme(next);
    hemi.intensity = next === "dark" ? 0.7 : 1.2;
    sun.intensity = next === "dark" ? 1.5 : 2.4;
  }

  const observer = new ResizeObserver(() => {
    renderer.setSize(width(), height());
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    if (!selectedId) goal.dist = overviewDist();
    wake();
  });
  observer.observe(host);

  applyTheme(theme);
  goal.dist = overviewDist();
  view.dist = goal.dist;
  if (!instant) loop = createRenderLoop({ host, fps: 30, render: frame });

  return {
    setAgents,
    select,
    setTheme: (next) => {
      applyTheme(next);
      wake();
    },
    zoom,
    resetView,
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
      for (const g of Object.values(propGeo)) g.dispose();
      for (const m of propMats) m.dispose();
      physics.dispose();
      renderer.dispose();
      canvas.remove();
    }
  };
}
