/**
 * WHAT: the sentence the console's "Organization provisioned" toast adds about the owner's company
 * domain. Pure, so tests/unit/domain-claim.test.ts pins it.
 *
 * WHY THE CONFLICT IS SPELLED OUT. Provisioning succeeds either way, so a conflict would otherwise go
 * unnoticed — and while it stands, that company's people who arrive at /signup are pointed at the
 * OTHER workspace. The operator settles it on Company domains; the toast says where and with whom.
 */
import type { ProvisionOrgResult } from "../services/platform-admin-api";

export function domainClaimNote(claim: ProvisionOrgResult["domainClaim"]): string | null {
  if (!claim) return null;
  switch (claim.outcome) {
    case "claimed":
      return `People signing up with an @${claim.domain} address are now pointed at this workspace.`;
    case "conflict":
      return `${claim.domain} already belongs to "${claim.heldBy.name}", so this workspace did not claim it — settle it on Company domains.`;
    case "error":
      return "The owner's company domain could not be claimed — assign it on Company domains.";
    default:
      // "none" (a personal or missing address) and "already-held" (signup made the claim) say nothing.
      return null;
  }
}
