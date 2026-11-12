/**
 * WHAT: the Agents Studio's three.js scene — a stage with a row of agent stations, a camera that
 * frames them all and dollies in on the one you pick, and the pointer picking that makes it
 * interactive. `createStudio` is the only export that matters; the React shell (AgentStudio.tsx) owns
 * the DOM around it and talks to this through `StudioHandle` and `StudioEvents`.
 *
 * THE FRAME POLICY IS THE REPO'S (lib/render-loop.ts), not a new one: nothing renders off screen or in
 * a background tab, the budget is 30fps, and the scene RESTS when nothing is changing — every agent
 * off, the camera settled, the pointer still. A stage of switched-off agents costs one early return a
 * frame. Under `prefers-reduced-motion` there is no loop at all: poses are settled once and a frame is
 * drawn per interaction, so a person who asked for no motion gets a still diorama they can still pick.
 *
 * WHY NO SHADOW MAPS: the floor is a soft gradient and each character carries its own blob shadow.
 * Real shadows would double the draw calls for a scene whose whole job is to be left running.
 *
 * LOADED BY DYNAMIC IMPORT ONLY, so three.js is never on a default page load.
 */
import * as THREE from "three";
import { createRenderLoop, type RenderLoopHandle } from "../../../lib/render-loop";
import { focusPose, layoutStations, mulberry32, overviewPose, type CameraPose } from "../studio-model";
import { buildStation, type Station } from "./station";
import type { StudioAgent, StudioEvents, StudioHandle, StudioTheme } from "./types";

export interface StudioOptions {
  reducedMotion: boolean;
  theme: StudioTheme;
}

const FOV = 34;
const DUST = 90;

function floorTexture(theme: StudioTheme): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
    const base = theme === "dark" ? "30,41,59" : "226,232,240";
    g.addColorStop(0, `rgba(${base},0.95)`);
    g.addColorStop(0.55, `rgba(${base},0.45)`);
    g.addColorStop(1, `rgba(${base},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createStudio(host: HTMLElement, events: StudioEvents, opts: StudioOptions): StudioHandle {
  const width = () => host.clientWidth || 1;
  const height = () => host.clientHeight || 1;

  // Throws if there is no WebGL; the shell catches it and shows the 2D view.
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  // 1.5: decoration that is left running, and a retina panel would otherwise fill four times the pixels.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(width(), height());
  const canvas = renderer.domElement;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "pan-y";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, width() / height(), 0.1, 140);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x94a3b8, 1.15);
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-6, 10, 8);
  const rim = new THREE.DirectionalLight(0x7dd3fc, 0.9);
  rim.position.set(8, 5, -8);
  scene.add(hemi, key, rim);

  let theme = opts.theme;
  let floorTex = floorTexture(theme);
  const floorMat = new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(28, 64), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -0.01, -2);
  scene.add(floor);

  // Drifting motes: ambient life, and the sense that data is in the air.
  // Seeded, so the same motes hang in the same places every visit (and a screenshot is repeatable).
  const dustRand = mulberry32(0x5eed1e);
  const dustPositions = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i += 1) {
    dustPositions[i * 3] = (dustRand() - 0.5) * 22;
    dustPositions[i * 3 + 1] = dustRand() * 7;
    dustPositions[i * 3 + 2] = (dustRand() - 0.5) * 14 - 2;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dustMat = new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.07, transparent: true, opacity: 0.5, depthWrite: false });
  const dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);

  function applyTheme(next: StudioTheme) {
    theme = next;
    const dark = next === "dark";
    hemi.intensity = dark ? 0.95 : 1.2;
    hemi.groundColor.setHex(dark ? 0x1e293b : 0xcbd5e1);
    key.intensity = dark ? 1.9 : 2.1;
    dustMat.color.setHex(dark ? 0x7dd3fc : 0x0ea5e9);
    dustMat.opacity = dark ? 0.5 : 0.35;
    floorTex.dispose();
    floorTex = floorTexture(next);
    floorMat.map = floorTex;
    floorMat.needsUpdate = true;
    for (const station of stations.values()) station.setTheme(next);
  }

  // ---- stations -----------------------------------------------------------------------------------
  const stations = new Map<string, Station>();
  const arriving = new Map<string, number>();
  let order: string[] = [];
  let selectedId: string | null = null;
  let hoveredId: string | null = null;

  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const goalPos = new THREE.Vector3();
  const goalTarget = new THREE.Vector3();
  let started = false;
  /** True once the first roster has been placed — only LATER arrivals drop in from above. */
  let populated = false;

  function poseGoal(): CameraPose {
    const slots = order.map((id) => stations.get(id)!.slot);
    const selected = selectedId ? stations.get(selectedId) : undefined;
    return selected ? focusPose(selected.slot, camera.aspect, FOV) : overviewPose(slots, camera.aspect, FOV);
  }

  function retarget(snap = false) {
    const pose = poseGoal();
    goalPos.set(...pose.position);
    goalTarget.set(...pose.target);
    if (snap || !started) {
      camPos.copy(goalPos);
      camTarget.copy(goalTarget);
      started = true;
    }
  }

  function setAgents(agents: readonly StudioAgent[]) {
    const incoming = agents.slice(0, 8);
    const ids = new Set(incoming.map((a) => a.id));
    for (const [id, station] of stations) {
      if (!ids.has(id)) {
        scene.remove(station.group);
        station.dispose();
        stations.delete(id);
        if (selectedId === id) selectedId = null;
      }
    }
    order = incoming.map((a) => a.id);
    const slots = layoutStations(incoming.length);
    incoming.forEach((agent, i) => {
      const existing = stations.get(agent.id);
      if (existing) {
        existing.setAgent(agent);
        existing.slot.x = slots[i].x;
        existing.slot.z = slots[i].z;
        existing.slot.rotY = slots[i].rotY;
        existing.group.position.set(slots[i].x, 0, slots[i].z);
        existing.group.rotation.y = slots[i].rotY;
      } else {
        const station = buildStation(agent, slots[i], theme);
        station.setTheme(theme);
        stations.set(agent.id, station);
        scene.add(station.group);
        // A new teammate drops in; the first paint of an existing roster does not.
        if (populated) arriving.set(agent.id, 0);
      }
    });
    populated = true;
    retarget();
    wake();
  }

  function select(id: string | null) {
    selectedId = id && stations.has(id) ? id : null;
    for (const station of stations.values()) station.setSelected(station.id === selectedId);
    retarget();
    wake();
  }

  // ---- pointer ------------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(0, 0);
  let pointerOver = false;
  let pointerQuiet = 0;
  const tmp = new THREE.Vector3();

  function updatePointer(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    pointerOver = true;
    pointerQuiet = 0;
    return rect;
  }

  function pick(): string | null {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      order.map((id) => stations.get(id)!.hit),
      false
    );
    if (!hits.length) return null;
    for (const [id, station] of stations) if (station.hit === hits[0].object) return id;
    return null;
  }

  const onMove = (e: PointerEvent) => {
    const rect = updatePointer(e);
    const id = pick();
    if (id !== hoveredId) {
      hoveredId = id;
      canvas.style.cursor = id ? "pointer" : "default";
    }
    events.onHover(id, e.clientX - rect.left, e.clientY - rect.top);
    wake();
  };
  const onLeave = () => {
    pointerOver = false;
    hoveredId = null;
    canvas.style.cursor = "default";
    events.onHover(null, 0, 0);
    wake();
  };
  const onClick = (e: MouseEvent) => {
    updatePointer(e as PointerEvent);
    const id = pick();
    select(id === selectedId ? null : id);
    events.onSelect(selectedId);
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    events.onLost();
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("webglcontextlost", onLost);

  // ---- frame --------------------------------------------------------------------------------------
  let clock = 0;
  let captionAcc = 0;
  let loop: RenderLoopHandle | undefined;
  let last = performance.now();
  let dead = false;

  function lookFor(station: Station): [number, number] {
    if (!pointerOver) return [0, 0];
    tmp.set(station.slot.x, 1.6, station.slot.z).project(camera);
    return [Math.max(-1, Math.min(1, (pointer.x - tmp.x) * 1.3)), Math.max(-1, Math.min(1, (pointer.y - tmp.y) * 1.3))];
  }

  /** How far the pointer nudges the camera: a breath of parallax in the overview, less once focused. */
  function parallax(): [number, number] {
    if (!pointerOver) return [0, 0];
    return selectedId ? [pointer.x * 0.25, 0] : [pointer.x * 0.7, pointer.y * 0.35];
  }

  /** Ease the camera toward its goal. Returns true while it is still travelling. */
  function stepCamera(dt: number): boolean {
    const k = opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.4);
    const [px, py] = parallax();
    const gx = goalPos.x + px;
    const gy = goalPos.y + py;
    camPos.x += (gx - camPos.x) * k;
    camPos.y += (gy - camPos.y) * k;
    camPos.z += (goalPos.z - camPos.z) * k;
    camTarget.lerp(goalTarget, k);
    camera.position.copy(camPos);
    camera.lookAt(camTarget);
    return Math.abs(gx - camPos.x) + Math.abs(gy - camPos.y) + Math.abs(goalPos.z - camPos.z) + camTarget.distanceTo(goalTarget) > 0.01;
  }

  /** A new teammate drops in from above. Returns true while it is still falling. */
  function stepArrival(station: Station, dt: number): boolean {
    const drop = arriving.get(station.id);
    if (drop === undefined) return false;
    const next = Math.min(1, drop + dt * 1.4);
    const eased = 1 - (1 - next) ** 3;
    const landed = next >= 1;
    station.group.position.y = landed ? 0 : (1 - eased) * 6;
    station.group.scale.setScalar(landed ? 1 : 0.7 + 0.3 * eased);
    if (landed) arriving.delete(station.id);
    else arriving.set(station.id, next);
    return !landed;
  }

  function stepStations(dt: number): boolean {
    let busy = false;
    for (const station of stations.values()) {
      const [lx, ly] = lookFor(station);
      station.update(clock, dt, lx, ly);
      const falling = stepArrival(station, dt);
      busy = busy || station.busy() || falling;
    }
    return busy;
  }

  /** Dust only drifts while somebody is on duty — an all-off stage should be able to rest. */
  function stepDust(dt: number): boolean {
    const anyOn = [...stations.values()].some((s) => s.mood !== "off");
    if (!anyOn) return false;
    for (let i = 0; i < DUST; i += 1) {
      dustPositions[i * 3 + 1] += dt * 0.12;
      if (dustPositions[i * 3 + 1] > 7) dustPositions[i * 3 + 1] = 0;
    }
    (dustGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    return true;
  }

  /** Tell the page what the station in focus (selected, else hovered) is illustrating. */
  function emitCaption(dt: number) {
    captionAcc += dt;
    if (captionAcc <= 0.35) return;
    captionAcc = 0;
    const id = selectedId ?? hoveredId;
    const station = id ? stations.get(id) : undefined;
    if (id && station) events.onCaption(id, station.caption());
  }

  /** One tick of the world. Returns false when nothing is changing, so the loop can rest. */
  function step(dt: number): boolean {
    clock += dt;
    const cameraMoving = stepCamera(dt);
    const busy = stepStations(dt);
    const anyOn = stepDust(dt);
    emitCaption(dt);
    pointerQuiet += dt;
    return busy || cameraMoving || anyOn || (pointerOver && pointerQuiet < 1.2);
  }

  function frame(): boolean {
    if (dead) return false;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const keepGoing = step(dt);
    renderer.render(scene, camera);
    return keepGoing;
  }

  /** Reduced motion: settle every pose in one go, then draw. No loop is ever started. */
  function drawStill() {
    if (dead) return;
    for (let i = 0; i < 40; i += 1) step(0.05);
    renderer.render(scene, camera);
  }

  function wake() {
    if (opts.reducedMotion) drawStill();
    else loop?.wake();
  }

  const resize = () => {
    renderer.setSize(width(), height());
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    retarget(true);
    wake();
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(host);

  applyTheme(theme);
  retarget(true);
  if (!opts.reducedMotion) loop = createRenderLoop({ host, fps: 30, render: frame });

  return {
    setAgents,
    select,
    setTheme: (next) => {
      applyTheme(next);
      wake();
    },
    destroy: () => {
      dead = true;
      loop?.stop();
      observer?.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const station of stations.values()) station.dispose();
      stations.clear();
      floorTex.dispose();
      floorMat.dispose();
      floor.geometry.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      renderer.dispose();
      canvas.remove();
    }
  };
}
