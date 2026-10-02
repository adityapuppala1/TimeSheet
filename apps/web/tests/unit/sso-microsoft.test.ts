/**
 * "Restrict to my directory" on the Microsoft card (audit C1, staged rollout): before the admin pins
 * Microsoft sign-in to one directory, the card must say exactly who that would shut out — every other
 * directory people have signed in from, with how many sign-ins and which email domains.
 */
import { describe, expect, it } from "vitest";
import { describeRestrictionImpact, isMultiTenantMicrosoft, restrictionImpact } from "../../src/lib/sso-microsoft";

const observed = [
  { tenantId: "home", count: 40, firstSeenAt: "", lastSeenAt: "", emailDomains: [{ domain: "acme.com", count: 40 }] },
  { tenantId: "contractor", count: 3, firstSeenAt: "", lastSeenAt: "", emailDomains: [{ domain: "agency.io", count: 2 }, { domain: "acme.com", count: 1 }] },
  { tenantId: "personal", count: 1, firstSeenAt: "", lastSeenAt: "", emailDomains: [{ domain: "outlook.com", count: 1 }] }
];

describe("restrictionImpact", () => {
  it("lists every OTHER directory, its sign-ins and its domains", () => {
    const impact = restrictionImpact(observed, "home");
    expect(impact.shutOut.map((d) => d.tenantId)).toEqual(["contractor", "personal"]);
    expect(impact.signIns).toBe(4);
    expect(impact.domains).toEqual(["agency.io", "acme.com", "outlook.com"]);
  });

  it("shuts nobody out when only the chosen directory has been seen", () => {
    expect(restrictionImpact(observed.slice(0, 1), "home")).toEqual({ shutOut: [], signIns: 0, domains: [] });
  });

  it("shuts out EVERYONE observed when the chosen directory has never been seen", () => {
    expect(restrictionImpact(observed, "typo").shutOut).toHaveLength(3);
  });
});

describe("isMultiTenantMicrosoft", () => {
  it("treats blank and the three multi-tenant aliases as unpinned", () => {
    for (const hint of ["", "  ", "common", "Organizations", "consumers", null, undefined]) expect(isMultiTenantMicrosoft(hint)).toBe(true);
  });

  it("treats a GUID or a verified domain as pinned", () => {
    expect(isMultiTenantMicrosoft("aaaaaaaa-0000-4000-8000-000000000001")).toBe(false);
    expect(isMultiTenantMicrosoft("contoso.onmicrosoft.com")).toBe(false);
  });
});

describe("describeRestrictionImpact", () => {
  it("names how many directories, sign-ins and which domains lose Microsoft sign-in", () => {
    expect(describeRestrictionImpact(restrictionImpact(observed, "home"))).toBe(
      "People from 2 other directories (4 sign-ins; agency.io, acme.com, outlook.com) will no longer be able to sign in with Microsoft."
    );
  });

  it("says plainly when nobody is shut out", () => {
    expect(describeRestrictionImpact(restrictionImpact(observed.slice(0, 1), "home"))).toMatch(/nobody/i);
  });
});
