/**
 * LDAP sign-in's user lookup (audit L4, first two points).
 *
 *  - The filter template's `{{email}}` was substituted with `String#replace` and a string pattern,
 *    which replaces the FIRST occurrence only. A filter like `(|(mail={{email}})(userPrincipalName={{email}}))`
 *    — the usual Active Directory shape — went to the directory with a literal `{{email}}` in its
 *    second half.
 *  - When the filter matched several entries, the first was used. Which entry a directory returns
 *    first is not defined, so the person's password was checked against whichever account happened to
 *    come back — and on success, that account's address is who they became.
 *
 * ldapts is replaced by a fake directory that records what it was asked; the control plane by the one
 * row the lookup reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { directory } = vi.hoisted(() => ({
  directory: {
    entries: [] as Array<Record<string, unknown>>,
    filters: [] as string[],
    binds: [] as Array<[string, string]>,
    badPasswordFor: new Set<string>()
  }
}));

vi.mock("ldapts", () => ({
  Client: class {
    async bind(dn: string, password: string) {
      directory.binds.push([dn, password]);
      if (directory.badPasswordFor.has(dn)) throw new Error("InvalidCredentialsError");
    }
    async search(_base: string, options: { filter: string }) {
      directory.filters.push(options.filter);
      return { searchEntries: directory.entries };
    }
    async unbind() {}
  }
}));

const { ldapRow } = vi.hoisted(() => ({ ldapRow: { current: null as Record<string, unknown> | null } }));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgSsoConfig: { findUnique: async () => ldapRow.current } }
}));

const { encryptSecret } = await import("../../src/utils/encryption.js");
const { authenticateLdap } = await import("../../src/services/sso.service.js");
const { testLdapConnection } = await import("../../src/services/sso-validation.service.js");

const AD_FILTER = "(|(mail={{email}})(userPrincipalName={{email}}))";

beforeEach(() => {
  directory.entries = [{ dn: "cn=Sam,dc=acme,dc=example", mail: "sam@acme.example", displayName: "Sam" }];
  directory.filters = [];
  directory.binds = [];
  directory.badPasswordFor.clear();
  ldapRow.current = {
    isEnabled: true,
    ldapUrl: "ldaps://dc.acme.example",
    ldapBindDn: "cn=svc,dc=acme,dc=example",
    encryptedLdapBindCredential: encryptSecret("svc-password"),
    ldapSearchBase: "dc=acme,dc=example",
    ldapUserFilter: AD_FILTER,
    ldapTlsRejectUnauthorized: true
  };
});

describe("the user filter", () => {
  it("replaces EVERY {{email}} in the template, not just the first", async () => {
    await authenticateLdap("org-1", "sam@acme.example", "pw");
    expect(directory.filters[0]).toBe("(|(mail=sam@acme.example)(userPrincipalName=sam@acme.example))");
  });

  it("escapes the address in every place it lands (RFC 4515)", async () => {
    await authenticateLdap("org-1", "sam*)(uid=*@acme.example", "pw").catch(() => undefined);
    expect(directory.filters[0]).toBe("(|(mail=sam\\2a\\29\\28uid=\\2a@acme.example)(userPrincipalName=sam\\2a\\29\\28uid=\\2a@acme.example))");
  });

  it("is built the same way by the connection test, so a test cannot pass on a filter sign-in would send differently", async () => {
    await testLdapConnection({
      url: "ldaps://dc.acme.example",
      bindDn: "cn=svc,dc=acme,dc=example",
      bindCredential: "svc-password",
      searchBase: "dc=acme,dc=example",
      userFilter: AD_FILTER,
      tlsRejectUnauthorized: true,
      probeEmail: "sam@acme.example"
    });
    expect(directory.filters[0]).toBe("(|(mail=sam@acme.example)(userPrincipalName=sam@acme.example))");
  });
});

describe("an ambiguous match", () => {
  it("is refused rather than signing the person in as whichever entry came back first", async () => {
    directory.entries = [
      { dn: "cn=Sam,ou=Staff,dc=acme,dc=example", mail: "sam@acme.example" },
      { dn: "cn=Sam,ou=Contractors,dc=acme,dc=example", mail: "sam.contractor@acme.example" }
    ];
    await expect(authenticateLdap("org-1", "sam@acme.example", "pw")).rejects.toMatchObject({ code: "SSO_CONFIG" });
    // Refused BEFORE any user bind: no password was tried against either account.
    expect(directory.binds.map(([dn]) => dn)).toEqual(["cn=svc,dc=acme,dc=example"]);
  });

  it("still signs in the one person a filter matches", async () => {
    await expect(authenticateLdap("org-1", "sam@acme.example", "pw")).resolves.toMatchObject({ email: "sam@acme.example", name: "Sam" });
  });

  it("is reported by the connection test as a failure, naming the count", async () => {
    directory.entries = [{ dn: "cn=a" }, { dn: "cn=b" }];
    const result = await testLdapConnection({
      url: "ldaps://dc.acme.example",
      bindDn: "cn=svc",
      bindCredential: "x",
      searchBase: "dc=acme,dc=example",
      userFilter: AD_FILTER,
      tlsRejectUnauthorized: true,
      probeEmail: "sam@acme.example"
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/2 entries/);
  });
});
