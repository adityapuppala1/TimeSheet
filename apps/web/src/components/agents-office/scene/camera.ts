/**
 * WHAT: the office camera — an orbit rig (yaw, pitch, distance around a target) that eases toward a
 * goal pose instead of jumping, follows a selected person, and drifts very slightly while nobody is
 * steering so a resting overview still feels alive.
 *
 * THE DEFAULT FRAMING is a closer three-quarter view (turned ~18° and looking down ~50°) rather than a
 * square-on plan: people read as people, walls read as walls, and the cut-away side wall (building.ts)
 * opens the room toward the viewer. The distance is fitted to the floor and the viewport's aspect so a
 * phone still sees the whole office.
 *
 * EASING: a critically-damped exponential approach (`1 - e^(-k·dt)`): fast to start, soft to land,
 * frame-rate independent. Reduced motion snaps (k = 1) so nothing glides.
 */
import * as THREE from "three";
import { FLOOR } from "../office-model";

export const FOV = 36;
const HOME = { yaw: 0.24, pitch: 0.88, target: new THREE.Vector3(-1.4, 0.2, 0.5) };
const MIN_DIST = 4.5;
const MAX_DIST = 46;

export interface CameraRig {
  resetView(): void;
  /** Pull in close (follow mode) without changing the angle. */
  closeIn(dist: number): void;
  zoom(factor: number): void;
  orbit(dx: number, dy: number): void;
  /** The overview distance changed (resize): refit, unless the user is following someone. */
  refit(following: boolean): void;
  /** Advance one frame. Returns true while the camera is still settling. */
  step(dt: number, follow: THREE.Vector3 | null, drift: boolean): boolean;
}

export function createCameraRig(camera: THREE.PerspectiveCamera, instant: boolean): CameraRig {
  const view = { yaw: HOME.yaw, pitch: HOME.pitch, dist: 30, target: HOME.target.clone() };
  const goal = { yaw: HOME.yaw, pitch: HOME.pitch, dist: 30, target: HOME.target.clone() };
  let clock = 0;
  let touched = 0;

  /** The distance that fits the floor in the viewport at the home angle — a little tighter than all of it. */
  function overviewDist(): number {
    const half = Math.tan((FOV * Math.PI) / 360);
    const fitW = (FLOOR.w / 2 + 1) / (half * camera.aspect);
    const fitD = (FLOOR.d / 2 + 2) / half;
    // A phone is too narrow to fit the width without shrinking people to dots: frame the depth and
    // let the sides run off (one drag brings them in).
    const fit = camera.aspect < 0.9 ? Math.max(fitD, fitW * 0.55) : Math.max(fitW, fitD);
    return Math.min(MAX_DIST, fit * 0.88);
  }

  function resetView() {
    goal.yaw = HOME.yaw;
    goal.pitch = HOME.pitch;
    goal.dist = overviewDist();
    goal.target.copy(HOME.target);
  }

  resetView();
  view.dist = goal.dist;

  return {
    resetView,
    closeIn(dist) {
      goal.dist = Math.min(goal.dist, dist);
    },
    zoom(factor) {
      goal.dist = Math.min(MAX_DIST, Math.max(MIN_DIST, goal.dist * factor));
      touched = clock;
    },
    orbit(dx, dy) {
      goal.yaw -= dx * 0.006;
      goal.pitch = Math.min(1.4, Math.max(0.3, goal.pitch + dy * 0.005));
      touched = clock;
    },
    refit(following) {
      if (!following) goal.dist = overviewDist();
    },
    step(dt, follow, drift) {
      clock += dt;
      if (follow) goal.target.set(follow.x, 0.9, follow.z);
      // A slow sway of a degree or two, only after the user has left the camera alone for a while.
      const sway = drift && !instant && clock - touched > 6 ? Math.sin(clock * 0.12) * 0.035 : 0;
      const k = instant ? 1 : 1 - Math.exp(-dt * 3.2);
      view.yaw += (goal.yaw + sway - view.yaw) * k;
      view.pitch += (goal.pitch - view.pitch) * k;
      view.dist += (goal.dist - view.dist) * k;
      view.target.lerp(goal.target, k);
      const flat = Math.cos(view.pitch) * view.dist;
      camera.position.set(view.target.x + Math.sin(view.yaw) * flat, view.target.y + Math.sin(view.pitch) * view.dist, view.target.z + Math.cos(view.yaw) * flat);
      camera.lookAt(view.target);
      const settling = Math.abs(goal.yaw + sway - view.yaw) + Math.abs(goal.pitch - view.pitch) + Math.abs(goal.dist - view.dist) / 10 + view.target.distanceTo(goal.target);
      return settling > 0.004 || sway !== 0;
    }
  };
}
