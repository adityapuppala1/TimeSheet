/**
 * The "allowed email domains" list for automatic account creation on SSO sign-in (audit H5), as the
 * Single sign-on card reads and writes it. The API validates and normalises again (sso-jit.service.ts);
 * this only turns what an admin typed into the list they meant.
 *
 * AN EMPTY LIST MEANS ANY DOMAIN — that is what every workspace had before the setting existed, and the
 * API stores an emptied list as NULL for exactly that reason. It is also the state the card warns about.
 */
export function parseDomainList(text: string): string[] {
  const domains = text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return [...new Set(domains)];
}

export function formatDomainList(domains: string[] | null | undefined): string {
  return (domains ?? []).join(", ");
}

/** Accounts are created automatically for whoever the provider authenticates, with no domain limit. */
export function opensToAnyone(config: { jitEnabled?: boolean; jitAllowedDomains?: string[] | null }): boolean {
  return config.jitEnabled !== false && (config.jitAllowedDomains ?? []).length === 0;
}
