/**
 * The LDAP user filter, built from an admin's template and the address a person typed — ONE
 * implementation, used by sign-in (sso.service.ts#authenticateLdap) and by the connection test
 * (sso-validation.service.ts#testLdapConnection), so a test can never pass on a filter sign-in
 * would send differently.
 */

/** Escapes an LDAP filter value per RFC 4515 — the submitted email is untrusted user input being
 *  interpolated into a search filter string, so this is the LDAP-injection defence. */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${(c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`);
}

/**
 * Substitutes EVERY `{{email}}` in the template. This used `String#replace` with a string pattern,
 * which replaces the first occurrence only — so the usual Active Directory filter,
 * `(|(mail={{email}})(userPrincipalName={{email}}))`, reached the directory with a literal
 * `{{email}}` in its second half (audit L4).
 */
export function buildLdapUserFilter(template: string, email: string): string {
  return template.replaceAll("{{email}}", escapeLdapFilterValue(email));
}
