/**
 * The Microsoft card's "Restrict to my directory" arithmetic (audit C1, staged rollout).
 *
 * A Microsoft configuration with no tenant ID accepts a token from ANY directory. Pinning it is the fix,
 * and pinning it blind is a lockout — so before the admin confirms, the card lists every OTHER directory
 * people have actually signed in from (recorded by the API on each Microsoft sign-in), with how many
 * sign-ins and which email domains. That list is who stops being able to sign in with Microsoft.
 */
export interface ObservedDirectory {
  tenantId: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  emailDomains: Array<{ domain: string; count: number }>;
}

/**
 * Tenant IDs that do NOT restrict sign-in to one organization: blank (the server falls back to
 * Microsoft's `common` authority) and the three aliases somebody could type by hand. Mirrors
 * isMultiTenantMicrosoftAuthority in apps/api/src/services/sso.service.ts.
 */
const MULTI_TENANT_MICROSOFT_AUTHORITIES = new Set(["", "common", "organizations", "consumers"]);

export function isMultiTenantMicrosoft(tenantHint: string | null | undefined): boolean {
  return MULTI_TENANT_MICROSOFT_AUTHORITIES.has((tenantHint ?? "").trim().toLowerCase());
}

/** Who restricting to `tenantId` would shut out: every other observed directory, their sign-ins, their domains. */
export function restrictionImpact(observed: ObservedDirectory[], tenantId: string) {
  const shutOut = observed.filter((directory) => directory.tenantId !== tenantId);
  const domains = [...new Set(shutOut.flatMap((directory) => directory.emailDomains.map((entry) => entry.domain)))];
  return { shutOut, signIns: shutOut.reduce((sum, directory) => sum + directory.count, 0), domains };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The sentence the confirm step shows: exactly who stops being able to sign in with Microsoft. */
export function describeRestrictionImpact(impact: ReturnType<typeof restrictionImpact>): string {
  if (impact.shutOut.length === 0) return "Nobody else has signed in with Microsoft, so nobody who has used it so far is shut out.";
  const who = plural(impact.shutOut.length, "other directory", "other directories");
  const signIns = plural(impact.signIns, "sign-in", "sign-ins");
  return `People from ${who} (${signIns}; ${impact.domains.join(", ")}) will no longer be able to sign in with Microsoft.`;
}
