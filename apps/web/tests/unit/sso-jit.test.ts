/**
 * The "allowed email domains" field for automatic account creation on SSO sign-in (audit H5).
 *
 * An admin types or pastes a list; what is saved must be the list they meant — and an empty field
 * means "any domain" (today's behaviour), which is the state the card warns about.
 */
import { describe, expect, it } from "vitest";
import { formatDomainList, opensToAnyone, parseDomainList } from "../../src/lib/sso-jit";

describe("parseDomainList", () => {
  it("splits on commas, spaces and new lines, lower-cases and de-duplicates", () => {
    expect(parseDomainList(" Acme.com, acme.co.uk\nACME.com  gmail.com,, ")).toEqual(["acme.com", "acme.co.uk", "gmail.com"]);
  });

  it("strips a leading @ — people paste domains the way they write addresses", () => {
    expect(parseDomainList("@acme.com")).toEqual(["acme.com"]);
  });

  it("is empty for an empty field, which the API stores as 'any domain'", () => {
    expect(parseDomainList("   ")).toEqual([]);
  });

  it("round-trips through formatDomainList", () => {
    expect(parseDomainList(formatDomainList(["acme.com", "gmail.com"]))).toEqual(["acme.com", "gmail.com"]);
    expect(formatDomainList(null)).toBe("");
  });
});

describe("opensToAnyone", () => {
  it("is true when accounts are created automatically with no domain limit — the warning case", () => {
    expect(opensToAnyone({ jitEnabled: true, jitAllowedDomains: null })).toBe(true);
    expect(opensToAnyone({ jitEnabled: undefined, jitAllowedDomains: undefined })).toBe(true);
  });

  it("is false once a domain list is set, or automatic creation is off", () => {
    expect(opensToAnyone({ jitEnabled: true, jitAllowedDomains: ["acme.com"] })).toBe(false);
    expect(opensToAnyone({ jitEnabled: false, jitAllowedDomains: null })).toBe(false);
  });
});
