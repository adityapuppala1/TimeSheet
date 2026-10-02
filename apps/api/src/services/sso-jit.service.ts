/**
 * WHAT: may a sign-in through this provider CREATE an account for somebody who has none here?
 * The "just-in-time" provisioning policy, read from `OrgSsoConfig.jitEnabled` / `jitAllowedDomains`.
 *
 * WHY IT EXISTS (audit H5). completeSsoLogin created an EMPLOYEE account for any identity a provider
 * authenticated — no switch, no domain limit. For a Google OAuth client whose audience is External,
 * or a Microsoft configuration with no tenant ID, that is anyone on the internet up to the seat cap.
 *
 * DEFAULTS ARE TODAY'S BEHAVIOUR. No row, `jitEnabled` true and `jitAllowedDomains` NULL all mean
 * "create the account", so a workspace that never opens the setting sees no change at all.
 *
 * ONLY ACCOUNT CREATION IS DECIDED HERE. A person who already has an account is matched exactly as
 * before — moving matching off the email address is the identity-binding step, not this one.
 */
import { domainToASCII } from "node:url";
import { controlPrisma } from "../config/control-prisma.js";
import type { SsoProviderType } from "./sso.service.js";

export interface JitPolicy {
  jitEnabled: boolean;
  /** Lower-case domains, or null for "any domain". */
  jitAllowedDomains: string[] | null;
}

const ANY: JitPolicy = { jitEnabled: true, jitAllowedDomains: null };

/** The JSON column, read defensively: anything that is not an array of strings is "no list". An empty
 *  array is also "no list" — the settings route stores an emptied list as NULL, and reading `[]` as
 *  "nobody" would turn a cleared field into a silent lock. */
export function readJitAllowedDomains(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const domains = raw.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim().toLowerCase());
  return domains.length > 0 ? domains : null;
}

export async function loadJitPolicy(orgId: string, provider: SsoProviderType | undefined): Promise<JitPolicy> {
  if (!provider) return ANY;
  const row = await controlPrisma.orgSsoConfig.findUnique({
    where: { organizationId_providerType: { organizationId: orgId, providerType: provider } },
    select: { jitEnabled: true, jitAllowedDomains: true }
  });
  return row ? { jitEnabled: row.jitEnabled !== false, jitAllowedDomains: readJitAllowedDomains(row.jitAllowedDomains) } : ANY;
}

/**
 * An admin-typed allowed domain as it is stored and compared: lower-case ASCII (IDN to punycode, so
 * `bücher.de` and `xn--bcher-kva.de` are one entry), at least two labels. Null when it is not a domain —
 * an address, a URL, a single word.
 */
export function normaliseJitDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[@/\s:]/.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed);
  return ascii.includes(".") && !ascii.startsWith(".") && !ascii.endsWith(".") ? ascii : null;
}

/** The part after the last `@`, normalised the same way allowed domains are; null when there is none. */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at === -1 ? null : normaliseJitDomain(email.slice(at + 1));
}

/**
 * Null when the account may be created; otherwise why not (for the operator, never shown verbatim).
 *
 * GOOGLE IS HELD TO ONE MORE RULE. Google is authoritative for an address only at gmail.com, or when
 * it says so with the `hd` (hosted domain) claim of a Workspace account — a consumer Google account
 * can carry a verified address at any domain. So with a domain list in force, a non-gmail.com address
 * also needs `hd` in that list; otherwise "@acme.com" is merely what somebody typed into a Google
 * account, and Google's `email_verified` only says they could read mail there once.
 */
export function jitRefusalReason(policy: JitPolicy, identity: { email: string; provider?: SsoProviderType; hostedDomain?: string | null }): string | null {
  if (!policy.jitEnabled) return "automatic account creation is switched off for this provider";
  if (!policy.jitAllowedDomains) return null;

  const allowed = new Set(policy.jitAllowedDomains);
  const domain = emailDomainOf(identity.email);
  if (!domain || !allowed.has(domain)) return "the address's domain is not on the allowed list";

  if (identity.provider === "GOOGLE" && domain !== "gmail.com") {
    const hd = identity.hostedDomain?.trim().toLowerCase();
    if (!hd || !allowed.has(hd)) return "Google did not vouch for the domain with an allowed hosted-domain (hd) claim";
  }
  return null;
}
