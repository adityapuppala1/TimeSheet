/**
 * The registry: which world an archetype works in. One line per archetype, one file each, so five
 * worlds can be built and changed independently.
 */
import { hashSeed, type Archetype } from "../../studio-model";
import { ambientSim } from "./ambient";
import { balancerSim } from "./balancer";
import { plannerSim } from "./planner";
import { reporterSim } from "./reporter";
import { riskSim } from "./risk";
import { securitySim } from "./security";
import type { Sim } from "./shared";
import { triageSim } from "./triage";

export type { Sim } from "./shared";

export function buildSim(archetype: Archetype, agentId: string, accent: number): Sim {
  const seed = hashSeed(agentId);
  switch (archetype) {
    case "triage":
      return triageSim(seed);
    case "planner":
      return plannerSim(seed, accent);
    case "risk":
      return riskSim(seed, accent);
    case "security":
      return securitySim(seed, accent);
    case "reporter":
      return reporterSim(seed, accent);
    case "balancer":
      return balancerSim(seed, accent);
    default:
      return ambientSim(archetype, seed, accent);
  }
}
