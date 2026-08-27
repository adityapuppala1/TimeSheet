/**
 * Custom-domain input handling, tested where it decides something.
 *
 * The two rules with real consequences:
 *
 *  - NORMALISATION. People paste `https://Time.Acme.com/login`, with a trailing dot, with a port.
 *    All of those have to become one hostname, because the row is globally unique and the resolver
 *    matches it exactly against a Host header. A normalisation gap does not fail loudly; it creates
 *    a second row for the same domain that never resolves.
 *  - RESERVATION. A verified `OrgDomain` resolves AHEAD of the subdomain rule, so a row for the
 *    deployment's own root would let one workspace intercept the workspace finder — and unlike the
 *    someone-else's-domain case, the operator genuinely controls that domain and could complete the
 *    DNS check. "The flow cannot be started" is the guarantee that matters here.
 */
import { describe, expect, it } from "vitest";
import { domainProblem, normaliseDomain } from "../../src/services/org-domain.service.js";

describe("normaliseDomain", () => {
  it("strips the things people paste", () => {
    expect(normaliseDomain("  https://Time.Acme.com/login?x=1  ")).toBe("time.acme.com");
    expect(normaliseDomain("http://time.acme.com")).toBe("time.acme.com");
    expect(normaliseDomain("time.acme.com:8443")).toBe("time.acme.com");
    // A trailing dot is a fully-qualified name in DNS and a different string in JavaScript.
    expect(normaliseDomain("time.acme.com.")).toBe("time.acme.com");
  });

  it("leaves an already-clean hostname alone", () => {
    expect(normaliseDomain("time.acme.com")).toBe("time.acme.com");
  });
});

describe("domainProblem", () => {
  const ROOT = "timesphere.app";

  it("accepts a hostname somebody could plausibly own", () => {
    expect(domainProblem("time.acme.com", ROOT)).toBeNull();
    expect(domainProblem("acme.co.uk", ROOT)).toBeNull();
    expect(domainProblem("a-b.example.io", ROOT)).toBeNull();
  });

  it("refuses things that are not hostnames", () => {
    expect(domainProblem("not a domain", ROOT)).not.toBeNull();
    expect(domainProblem("localhost", ROOT)).not.toBeNull();
    expect(domainProblem("acme", ROOT)).not.toBeNull();
    expect(domainProblem("", ROOT)).not.toBeNull();
  });

  it("refuses the deployment's own domain and anything under it", () => {
    // The important cases. Each of these WOULD pass a DNS check, because the operator controls the
    // domain — so refusing them has to happen here, not at verification.
    expect(domainProblem("timesphere.app", ROOT)).toContain("this deployment's own domain");
    expect(domainProblem("www.timesphere.app", ROOT)).toContain("this deployment's own domain");
    expect(domainProblem("acme.timesphere.app", ROOT)).toContain("already have an address");
    expect(domainProblem("anything.deep.timesphere.app", ROOT)).toContain("already have an address");
  });

  it("does not refuse a domain that merely ends in similar text", () => {
    // `nottimesphere.app` does not end with `.timesphere.app`, and refusing it would be a baffling
    // rejection of a domain somebody legitimately owns.
    expect(domainProblem("nottimesphere.app", ROOT)).toBeNull();
  });

  it("has nothing to reserve when the deployment has no root domain", () => {
    // Single-org / on-prem: ROOT_DOMAIN is unset, so there is no apex of ours to protect.
    expect(domainProblem("time.acme.com", undefined)).toBeNull();
    expect(domainProblem("timesphere.app", undefined)).toBeNull();
  });
});
