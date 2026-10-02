/**
 * WHAT: which Microsoft directories (Entra `tid`) people sign in to a workspace from — recorded on
 * every successful Microsoft sign-in, read back by the Single sign-on card and the platform console.
 *
 * WHY (audit C1). A Microsoft configuration with a blank tenant ID — or `common`, `organizations`,
 * `consumers` — accepts a token minted in ANY directory, and accounts are matched by email. Pinning the
 * tenant is the fix; pinning BLIND locks out whoever signs in from a directory the admin did not know
 * about, which in an SSO-only workspace is everyone. So the rollout observes first: this table answers
 * "if I restrict to directory X, who stops being able to sign in?" before the admin commits to it.
 *
 * WHAT IS RECORDED: the directory id and the email DOMAIN, counted — organisations, never people.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { emailDomainOf } from "./sso-jit.service.js";
import { isMultiTenantMicrosoftAuthority } from "./sso.service.js";

export interface ObservedDirectory {
  tenantId: string;
  /** Successful sign-ins from this directory since recording began. */
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** The email domains seen from it, most frequent first. */
  emailDomains: Array<{ domain: string; count: number }>;
}

/**
 * Records one successful Microsoft sign-in. Called AFTER the session exists (sso.controller.ts), for
 * every Microsoft sign-in, pinned or not — a pinned workspace's history is what shows an operator the
 * pin is right.
 *
 * Best-effort, like recordSsoLoginSuccess: a bookkeeping write must never fail a sign-in that has
 * already succeeded. A lost row costs one count.
 */
export async function recordMicrosoftDirectory(orgId: string, tenantId: string | null | undefined, email: string): Promise<void> {
  const emailDomain = emailDomainOf(email);
  if (!tenantId || !emailDomain) return;
  try {
    await controlPrisma.orgSsoObservedTenant.upsert({
      where: { organizationId_tenantId_emailDomain: { organizationId: orgId, tenantId, emailDomain } },
      update: { count: { increment: 1 }, lastSeenAt: new Date() },
      create: { organizationId: orgId, tenantId, emailDomain }
    });
  } catch {
    /* see above — never fails the sign-in it is recording */
  }
}

/**
 * The platform console's read-only view of a workspace's Microsoft sign-in (audit C1, step d): whether
 * it accepts ANY directory, and the directories it has actually been used from. Null when Microsoft
 * sign-in is not switched on — there is then nothing to be exposed by.
 */
export async function microsoftSignInExposure(
  orgId: string,
  configs: Array<{ providerType: string; isEnabled: boolean; tenantHint: string | null }>
): Promise<{ acceptsAnyDirectory: boolean; tenantId: string | null; observedDirectories: ObservedDirectory[] } | null> {
  const microsoft = configs.find((config) => config.providerType === "MICROSOFT");
  if (!microsoft?.isEnabled) return null;
  const acceptsAnyDirectory = isMultiTenantMicrosoftAuthority(microsoft.tenantHint);
  return {
    acceptsAnyDirectory,
    tenantId: acceptsAnyDirectory ? null : microsoft.tenantHint,
    observedDirectories: await observedMicrosoftDirectories(orgId)
  };
}

/** One entry per directory, most sign-ins first, with its email domains folded in. */
export async function observedMicrosoftDirectories(orgId: string): Promise<ObservedDirectory[]> {
  const rows = await controlPrisma.orgSsoObservedTenant.findMany({ where: { organizationId: orgId } });
  const byTenant = new Map<string, ObservedDirectory>();
  for (const row of rows) {
    const entry = byTenant.get(row.tenantId) ?? { tenantId: row.tenantId, count: 0, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, emailDomains: [] };
    entry.count += row.count;
    if (row.firstSeenAt < entry.firstSeenAt) entry.firstSeenAt = row.firstSeenAt;
    if (row.lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = row.lastSeenAt;
    entry.emailDomains.push({ domain: row.emailDomain, count: row.count });
    byTenant.set(row.tenantId, entry);
  }
  const directories = [...byTenant.values()];
  for (const directory of directories) directory.emailDomains.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  return directories.sort((a, b) => b.count - a.count || a.tenantId.localeCompare(b.tenantId));
}
