/**
 * SECURITY DESK's accessory — NOT BUILT YET (planned: a guard cap and a shield). Until then it returns null and the character
 * wears its emoji as a floating badge. Replace the body of `securityAccessory`; see ./types.ts for the contract.
 */
import type { Accessory, AccessoryContext } from "./types";

export function securityAccessory(_ctx: AccessoryContext): Accessory | null {
  return null;
}
