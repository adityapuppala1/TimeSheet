/**
 * The calm default world: a holo ring, a few orbiting glyphs and a data screen. Used by the generic
 * assistant (a custom agent with no recognisable specialty) and as the placeholder for any archetype
 * whose own world is not built yet.
 */
import * as THREE from "three";
import { mulberry32, type Archetype } from "../../studio-model";
import { disposer, makeScreen, type Sim } from "./shared";

const AMBIENT_CAPTION: Readonly<Record<Archetype, string>> = {
  triage: "Watching the inbox",
  planner: "Laying out the plan",
  risk: "Watching the risk score",
  security: "Screening findings",
  reporter: "Drafting the recap",
  balancer: "Checking who has room",
  assistant: "Standing by"
};

export function ambientSim(archetype: Archetype, seed: number, accent: number): Sim {
  const { track, disposeAll } = disposer();
  const rand = mulberry32(seed);
  const group = new THREE.Group();

  const ringMat = track(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(1.05, 0.025, 8, 64)), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0.5, 0.5, 0.9);
  group.add(ring);

  const orbGeo = track(new THREE.OctahedronGeometry(0.1));
  const orbMat = track(new THREE.MeshBasicMaterial({ color: accent }));
  const orbs = Array.from({ length: 6 }, (_, i) => {
    const orb = new THREE.Mesh(orbGeo, orbMat);
    group.add(orb);
    return { orb, offset: (i / 6) * Math.PI * 2, lift: rand() * 0.3 };
  });

  const screen = makeScreen("#" + accent.toString(16).padStart(6, "0"), seed, track);
  screen.group.position.set(-1.25, 2.05, -0.6);
  screen.group.rotation.y = 0.35;
  group.add(screen.group);

  let caption = AMBIENT_CAPTION[archetype];
  return {
    group,
    update(t, dt, intensity) {
      const moving = intensity > 0.05;
      ring.rotation.z += dt * (0.3 + intensity * 1.6);
      ringMat.opacity = 0.12 + intensity * 0.5;
      for (const o of orbs) {
        const a = t * (0.5 + intensity * 1.5) + o.offset;
        o.orb.position.set(0.5 + Math.cos(a) * 1.05, 0.55 + o.lift + Math.sin(a * 2) * 0.12, 0.9 + Math.sin(a) * 1.05);
        o.orb.rotation.y += dt * 2;
        o.orb.visible = moving;
      }
      screen.scroll(moving ? dt * (0.04 + intensity * 0.2) : 0);
      caption = moving ? AMBIENT_CAPTION[archetype] : "Switched off";
    },
    caption: () => caption,
    dispose: disposeAll
  };
}

