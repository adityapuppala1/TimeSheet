/**
 * "Build all five and do not make duplicates."
 *
 * Every agent must be its OWN character with its OWN working world. The registries fall back — to the
 * emoji badge and to the generic ambient world — for an archetype that has not been built, which is
 * exactly how a missing character would slip through: it would still render something. So these tests
 * hold the line from the other side: all six specialist archetypes must have a real accessory that
 * replaces the badge, and a real world that is richer than the placeholder, runs at every intensity,
 * says something different from every other world, is deterministic per agent, and goes quiet when off.
 *
 * three.js runs without a GL context here (no renderer is created), which is enough to construct and
 * step a scene graph.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildAccessory } from "../../src/components/agents-studio/scene/accessories";
import { buildSim } from "../../src/components/agents-studio/scene/sims";
import type { Archetype } from "../../src/components/agents-studio/studio-model";

const SPECIALISTS: ReadonlyArray<Archetype> = ["triage", "planner", "risk", "security", "reporter", "balancer"];
const ACCENT = 0xbef264;

function accessoryContext() {
  return {
    rig: new THREE.Group(),
    neck: new THREE.Group(),
    armL: new THREE.Group(),
    armR: new THREE.Group(),
    body: new THREE.Color(ACCENT),
    head: new THREE.Color(ACCENT),
    trim: new THREE.Color(ACCENT),
    tint: ACCENT,
    track: <T extends { dispose(): void }>(item: T) => item
  };
}

/** Every mesh and sprite in a world, however deeply nested — a truer measure of how built-out it is than its top-level children. */
function visualParts(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.Sprite || node instanceof THREE.Points) count += 1;
  });
  return count;
}

/** Steps a world for `seconds` of simulated time at a given intensity, returning its final caption. */
function run(archetype: Archetype, id: string, intensity: number, seconds: number): string {
  const sim = buildSim(archetype, id, ACCENT);
  for (let t = 0; t < seconds; t += 0.05) sim.update(t, 0.05, intensity);
  const caption = sim.caption();
  sim.dispose();
  return caption;
}

/** Every distinct sentence a world says over a long shift at full intensity. */
function narration(archetype: Archetype): Set<string> {
  const sentences = new Set<string>();
  const sim = buildSim(archetype, "agent-1", ACCENT);
  for (let step = 0; step < 800; step += 1) {
    sim.update(step * 0.05, 0.05, 1);
    sentences.add(sim.caption());
  }
  sim.dispose();
  return sentences;
}

describe("every specialist has its own accessory", () => {
  it.each(SPECIALISTS)("%s carries or wears something that replaces the emoji badge", (archetype) => {
    const ctx = accessoryContext();
    const accessory = buildAccessory(archetype, ctx);
    expect(accessory, `${archetype} has no accessory — it would fall back to the badge`).not.toBeNull();
    expect(accessory?.replacesBadge).toBe(true);
    // It must actually add geometry to the character, on the body, the head or an arm.
    const added = ctx.rig.children.length + ctx.neck.children.length + ctx.armL.children.length + ctx.armR.children.length;
    expect(added, `${archetype}'s accessory added nothing`).toBeGreaterThan(0);
  });

  it("gives the generic assistant none — it wears the badge", () => {
    expect(buildAccessory("assistant", accessoryContext())).toBeNull();
  });

  it.each(SPECIALISTS)("%s's accessory animates through every mood without throwing", (archetype) => {
    const accessory = buildAccessory(archetype, accessoryContext());
    for (const mood of ["off", "idle", "working", "attention", "celebrating"] as const) {
      expect(() => {
        accessory?.update(mood, 1.3, 1.1, 0.05);
        accessory?.arms?.(mood, 1.3);
      }).not.toThrow();
    }
  });
});

describe("every specialist has its own world", () => {
  const placeholder = visualParts(buildSim("assistant", "any", ACCENT).group);

  it.each(SPECIALISTS)("%s's world is built out, not the generic placeholder", (archetype) => {
    const world = buildSim(archetype, "agent-1", ACCENT);
    expect(visualParts(world.group), `${archetype} still looks like the ambient placeholder`).toBeGreaterThan(placeholder);
    world.dispose();
  });

  it.each(SPECIALISTS)("%s's world runs at every intensity", (archetype) => {
    for (const intensity of [0, 0.22, 0.4, 0.75, 1]) {
      expect(() => run(archetype, "agent-1", intensity, 8)).not.toThrow();
    }
  });

  it.each(SPECIALISTS)("%s's world goes quiet when the agent is off", (archetype) => {
    expect(run(archetype, "agent-1", 0, 3)).toBe("Switched off");
  });

  it.each(SPECIALISTS)("%s tells the same story on every visit (seeded)", (archetype) => {
    expect(run(archetype, "agent-1", 1, 12)).toBe(run(archetype, "agent-1", 1, 12));
  });

  it("gives no two worlds the same account of themselves", () => {
    const said = new Map(SPECIALISTS.map((a) => [a, narration(a)] as const));
    for (const [a, sa] of said) {
      sa.delete("Switched off");
      expect(sa.size, `${a} narrates almost nothing`).toBeGreaterThan(1);
    }
    for (const [a, sa] of said) {
      for (const [b, sb] of said) {
        if (a >= b) continue;
        const shared = [...sa].filter((sentence) => sb.has(sentence));
        expect(shared, `${a} and ${b} narrate the same sentence`).toEqual([]);
      }
    }
  });
});
