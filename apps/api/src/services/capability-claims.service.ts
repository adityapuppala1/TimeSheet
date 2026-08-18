/**
 * WHAT: which agent, if any, currently owns a capability — and the rule that stops two from owning
 * the same one.
 *
 * WHY THIS EXISTS (a defect in V8 phase 3, fixed in the same release): the roster introduced a
 * second screen that talks about the same twenty-two capabilities Workspace Settings → AI features
 * already lists. Left alone, that produced three problems, and only the first is cosmetic:
 *
 *   1. THE SAME ROWS IN TWO PLACES with no cross-reference, so the product looked like it held two
 *      copies of its own capability list.
 *   2. AMBIGUOUS OWNERSHIP. Two enabled profiles could both contain `triage`. There is exactly ONE
 *      `AiCapabilityPolicy` per capability, so both would describe the same behaviour, neither would
 *      be the reason it happened, and switching one off would change nothing. "Which teammate does
 *      this?" has to have one answer or the roster is decoration.
 *   3. A CONTROL THAT ISN'T. The roster reads like where a teammate is configured, while the actual
 *      lever lives in settings — so an agent could sit there saying "On" while every capability in
 *      it resolved to something that cannot act.
 *
 * The fix is ownership, not a second store: a capability may be claimed by at most one ENABLED
 * profile. Drafts may overlap freely (they are off, so they describe nothing), and enabling is where
 * the conflict is refused. `AiCapabilityPolicy` remains the single source of truth for authority;
 * this only answers "whose name is on it".
 *
 * WHY IT IS ITS OWN MODULE: `agent-profile.service.ts` imports `ai-autonomy.service.ts`, and the
 * autonomy catalogue needs claims — importing the profile service there would close a cycle. This
 * file imports nothing but Prisma.
 *
 * WHO CALLS THIS: `agent-profile.service.ts` (enforcement), `ai-autonomy.service.ts` (display).
 */
import { prisma } from "../config/prisma.js";

export interface CapabilityClaim {
  profileId: string;
  name: string;
  emoji: string;
}

/**
 * capability id → the enabled profile that owns it.
 *
 * Only ENABLED, non-deleted profiles claim anything. A disabled profile is a draft: it makes no
 * assertion about behaviour, so letting it hold a claim would block the live roster for the sake of
 * something switched off.
 */
export async function getCapabilityClaims(excludeProfileId?: string): Promise<Map<string, CapabilityClaim>> {
  const profiles = await prisma.agentProfile.findMany({
    where: {
      deletedAt: null,
      enabled: true,
      ...(excludeProfileId ? { id: { not: excludeProfileId } } : {})
    },
    select: { id: true, name: true, emoji: true, capabilities: true }
  });

  const claims = new Map<string, CapabilityClaim>();
  for (const profile of profiles) {
    const ids = Array.isArray(profile.capabilities) ? profile.capabilities.map((c) => String(c)) : [];
    for (const id of ids) {
      // First writer wins. Two enabled profiles cannot legitimately share a capability — the
      // enable-time check below is what prevents it — so this branch only matters for a database
      // that predates the rule, where reporting SOMETHING is better than reporting nothing.
      if (!claims.has(id)) claims.set(id, { profileId: profile.id, name: profile.name, emoji: profile.emoji });
    }
  }
  return claims;
}

/**
 * The capabilities `candidate` would take from another enabled profile.
 *
 * Returns them grouped by the owner so the refusal can name it: "Triage already covers ticket
 * triage" is actionable, "conflict" is not.
 */
export async function findClaimConflicts(
  capabilityIds: string[],
  selfProfileId: string
): Promise<Array<{ owner: CapabilityClaim; capabilities: string[] }>> {
  const claims = await getCapabilityClaims(selfProfileId);
  const byOwner = new Map<string, { owner: CapabilityClaim; capabilities: string[] }>();
  for (const id of capabilityIds) {
    const owner = claims.get(id);
    if (!owner) continue;
    const entry = byOwner.get(owner.profileId) ?? { owner, capabilities: [] };
    entry.capabilities.push(id);
    byOwner.set(owner.profileId, entry);
  }
  return [...byOwner.values()];
}
