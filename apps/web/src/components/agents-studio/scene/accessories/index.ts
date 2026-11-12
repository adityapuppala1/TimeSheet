/**
 * The registry: what each archetype carries or wears. One line per archetype, one file each.
 */
import type { Archetype } from "../../studio-model";
import { balancerAccessory } from "./balancer";
import { plannerAccessory } from "./planner";
import { reporterAccessory } from "./reporter";
import { riskAccessory } from "./risk";
import { securityAccessory } from "./security";
import { triageAccessory } from "./triage";
import type { Accessory, AccessoryContext } from "./types";

export type { Accessory, AccessoryContext } from "./types";

export function buildAccessory(archetype: Archetype, ctx: AccessoryContext): Accessory | null {
  switch (archetype) {
    case "triage":
      return triageAccessory(ctx);
    case "planner":
      return plannerAccessory(ctx);
    case "risk":
      return riskAccessory(ctx);
    case "security":
      return securityAccessory(ctx);
    case "reporter":
      return reporterAccessory(ctx);
    case "balancer":
      return balancerAccessory(ctx);
    default:
      return null;
  }
}
