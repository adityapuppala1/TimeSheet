/**
 * PLANNER's world — NOT BUILT YET. This stub shows the generic ambient world so the agent still has
 * something on its stage. Replace the body of `plannerSim` with the real simulation; keep the signature.
 */
import { type Sim } from "./shared";
import { ambientSim } from "./ambient";

export function plannerSim(seed: number, accent: number): Sim {
  return ambientSim("planner", seed, accent);
}
