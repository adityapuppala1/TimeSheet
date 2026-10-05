/**
 * Which workspace a hostname resolves to.
 *
 * WHY THIS DESERVES A TABLE. `resolveOrgSlug` is the first decision made about every single request
 * and the only one a client cannot influence: the tenant comes from the `Host` header, before
 * authentication, because the login page has to know whose SSO configuration to offer before it
 * knows who is asking. It had no tests. Two consequences of that went unnoticed for a release:
 *
 *  1. THE THREE-LABEL TRAP. With `ROOT_DOMAIN` unset, any hostname with three or more labels has
 *     its FIRST label read as a workspace slug. `timesheet.company.com` therefore looks for a
 *     workspace called "timesheet", finds none, and answers `404 Unknown workspace.` to every
 *     request — which is most of the hostnames a real deployment is reachable at. Measured against
 *     a running server before this file existed: `Host: hics.com.sg` → 404, `Host: localhost` → 200.
 *     The fix for a deployment is to set `ROOT_DOMAIN`; the fix for the silence is
 *     `config/deployment-check.ts`, which now says so at boot. This pins the behaviour so the
 *     boot check and the router can never drift apart.
 *
 *  2. `isRootDomainRequest` existed, was documented as "what lets the routing layer serve the
 *     finder", and had no callers at all — so the apex served one customer's branded login page,
 *     which is the exact thing its comment says it exists to prevent.
 *
 * The cases below are boundaries — a public suffix versus a subdomain, the apex versus `www`, an IP
 * literal versus a name — and boundaries are what a table catches and a careful read does not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Sets (or clears) `ROOT_DOMAIN` for the next module load.
 *
 * `""` AND NOT `delete`, AND THAT IS THE WHOLE POINT OF THIS FUNCTION EXISTING. `config/env.ts` calls
 * `dotenv.config()` at import time, and dotenv never overwrites a variable that is ALREADY SET but
 * happily fills in one that is absent. So `delete process.env.ROOT_DOMAIN` followed by a fresh import
 * hands the test whatever the developer happens to have in `apps/api/.env` — these seven cases passed
 * for exactly as long as that file had no `ROOT_DOMAIN` line in it, and went red the moment one was
 * added to test a second workspace locally. An empty string is set, so dotenv leaves it alone, and
 * `ROOT_DOMAIN: z.string().optional()` makes it falsy, which is what "unset" means everywhere it is
 * read. The test now says the same thing on every machine.
 */
function setRootDomain(rootDomain: string | undefined): void {
  process.env.ROOT_DOMAIN = rootDomain ?? "";
}

type TenantModule = typeof import("../../src/middleware/tenant.js");

/**
 * Loads `middleware/tenant.ts` against a chosen `ROOT_DOMAIN`.
 *
 * `env` is parsed from `process.env` when `config/env.ts` is first imported, so changing the
 * variable requires dropping the module registry — mutating the frozen parsed object would test a
 * shape the application never runs in.
 */
async function loadWith(rootDomain?: string): Promise<TenantModule> {
  vi.resetModules();
  setRootDomain(rootDomain);
  return import("../../src/middleware/tenant.js");
}

/** The only part of a Request these two functions read. */
const req = (host: string | undefined) => ({ headers: { host } }) as never;

afterEach(() => {
  // Empty, not deleted — see setRootDomain. A deleted variable lets the developer's own .env decide
  // what the next test in this file sees.
  process.env.ROOT_DOMAIN = "";
});

describe("single-org / on-prem: ROOT_DOMAIN unset", () => {
  it.each([
    ["localhost", "default", "the local dev and on-prem case"],
    ["localhost:5173", "default", "a port is not a label"],
    ["LOCALHOST", "default", "hostnames are case-insensitive"],
    ["192.168.1.20", "default", "a private IP literal has no subdomain to read"],
    ["203.0.113.10", "default", "nor does a public one"],
    ["timesheet.local", "default", "two labels cannot carry a subdomain"],
    ["example.com", "default", "the bare apex of a two-label domain"],
    ["", "default", "a request with no Host header at all"]
  ])("%s resolves to the default workspace (%s — %s)", async (host, expected) => {
    const { resolveOrgSlug } = await loadWith(undefined);
    expect(resolveOrgSlug(req(host || undefined))).toBe(expected);
  });

  it.each([
    ["acme.example.com", "acme", "the case this rule is designed for"],
    ["acme.example.test", "acme", "and any other three-label host"],
    ["acme.localhost", "acme", "a .localhost subdomain is a subdomain despite having two labels"],
    ["acme.localhost:5173", "acme", "with the dev server's port"],
    ["www.localhost", "default", "www is never a workspace"],
    ["timesheet.company.com", "timesheet", "THE TRAP: a deployment's own hostname becomes a slug"],
    ["hics.com.sg", "hics", "a public suffix is indistinguishable from a subdomain by label count"],
    ["app.mycorp.co.uk", "app", "so is this"]
  ])("%s reads the first label as a slug (%s — %s)", async (host, expected) => {
    const { resolveOrgSlug } = await loadWith(undefined);
    expect(resolveOrgSlug(req(host))).toBe(expected);
  });

  it("never reports a root-domain request, because there is no root domain configured", async () => {
    const { isRootDomainRequest } = await loadWith(undefined);
    for (const host of ["example.com", "www.example.com", "localhost"]) {
      expect(isRootDomainRequest(req(host)), host).toBe(false);
    }
  });
});

describe("multi-org: ROOT_DOMAIN set", () => {
  it.each([
    ["acme.timesphere.app", "acme", "the ordinary workspace address"],
    ["ACME.timesphere.app", "acme", "lowercased before matching"],
    ["acme.timesphere.app:8443", "acme", "the port is stripped first"],
    ["timesphere.app", "default", "the apex falls through to the default, and the finder is served by flag"],
    ["www.timesphere.app", "default", "www is never a workspace"],
    ["a.b.timesphere.app", "a.b", "a hostname nothing was provisioned for yields a slug nothing matches"],
    ["unrelated.example.com", "default", "a custom domain is resolved by the caller, before this"]
  ])("%s resolves to %s (%s)", async (host, expected) => {
    const { resolveOrgSlug } = await loadWith("timesphere.app");
    expect(resolveOrgSlug(req(host))).toBe(expected);
  });

  it("fixes the three-label trap for its own domain", async () => {
    // The same hostname that 404s above. This is the difference the boot check tells people about.
    const { resolveOrgSlug } = await loadWith("company.com");
    expect(resolveOrgSlug(req("timesheet.company.com"))).toBe("timesheet");
    expect(resolveOrgSlug(req("company.com"))).toBe("default");
  });

  it("is not fooled by a domain that merely ends with the same letters", async () => {
    // `nottimesphere.app` ends with "timesphere.app" as a STRING but is a different domain. The
    // suffix match includes the dot for exactly this reason; without it, somebody else's domain
    // resolves to one of your workspaces.
    const { resolveOrgSlug } = await loadWith("timesphere.app");
    expect(resolveOrgSlug(req("nottimesphere.app"))).toBe("default");
    expect(resolveOrgSlug(req("acme.nottimesphere.app"))).toBe("default");
  });

  it("identifies the apex and www as root-domain requests, and nothing else", async () => {
    const { isRootDomainRequest } = await loadWith("timesphere.app");
    expect(isRootDomainRequest(req("timesphere.app"))).toBe(true);
    expect(isRootDomainRequest(req("www.timesphere.app"))).toBe(true);
    expect(isRootDomainRequest(req("TIMESPHERE.APP"))).toBe(true);
    expect(isRootDomainRequest(req("timesphere.app:443"))).toBe(true);
    // A workspace is not the root domain, and neither is somebody else's domain.
    expect(isRootDomainRequest(req("acme.timesphere.app"))).toBe(false);
    expect(isRootDomainRequest(req("nottimesphere.app"))).toBe(false);
  });
});

/**
 * The other half of the same question: not "which workspace is this request for" but "which
 * workspace does this LINK belong to". They have to agree, and for one release they did not.
 *
 * MEASURED ON A RUNNING SERVER. A password reset requested at `Host: acme.example.test` wrote its
 * token row to the `acme_corp` database (0 → 1) while the default org's table stayed at 4 rows — and
 * the emailed link was built from the single global `APP_BASE_URL`, whose hostname resolves to the
 * DEFAULT workspace. Opening it made `resetPassword` search the wrong database, so the person was
 * told the link was invalid. Every reset, for every tenant but one.
 */
describe("tenantBaseUrl — the address an emailed link should use", () => {
  /** Loads the service and the context store from ONE module registry, so `run()` and the reader
   *  are the same AsyncLocalStorage instance. Importing them separately would silently test nothing. */
  async function loadAddressing(rootDomain?: string) {
    vi.resetModules();
    setRootDomain(rootDomain);
    const [{ tenantBaseUrl, workspaceUrlForSlug }, { tenantContext }] = await Promise.all([
      import("../../src/services/workspace-directory.service.js"),
      import("../../src/config/tenant-context.js")
    ]);
    // The reader goes through `requireTenantContext`, not `tenantContext.getStore()`, so that the
    // twelve suites which stub this module with a one-line factory keep working — see the note in
    // `tenantBaseUrl`. Driving it through the REAL store here is what proves the two still agree.
    const inTenant = <T>(orgSlug: string, fn: () => T): T =>
      tenantContext.run({ orgId: "org-id", orgSlug, client: null as never }, fn);
    return { tenantBaseUrl, workspaceUrlForSlug, inTenant };
  }

  it("returns the deployment's own address outside any tenant, for control-plane mail", async () => {
    // Platform-admin mail, sales leads and the console's own alerts are not about a workspace.
    const { tenantBaseUrl } = await loadAddressing(undefined);
    expect(tenantBaseUrl()).toBe("http://localhost:5173");
  });

  it("is unchanged from APP_BASE_URL in single-org mode, even inside a tenant", async () => {
    /**
     * THE COMPATIBILITY GUARANTEE. Every on-prem install runs with ROOT_DOMAIN unset, and this
     * change touched nine call sites that build emailed links. If this assertion ever fails, those
     * installs started sending links to a hostname that was invented rather than configured.
     */
    const { tenantBaseUrl, inTenant } = await loadAddressing(undefined);
    expect(inTenant("default", tenantBaseUrl)).toBe("http://localhost:5173");
    expect(inTenant("acme", tenantBaseUrl)).toBe("http://localhost:5173");
  });

  it("addresses each tenant's own workspace in multi-org mode", async () => {
    const { tenantBaseUrl, inTenant } = await loadAddressing("timesphere.app");
    expect(inTenant("acme", tenantBaseUrl)).toBe("https://acme.timesphere.app");
    expect(inTenant("globex", tenantBaseUrl)).toBe("https://globex.timesphere.app");
    // And the reverse of the bug: two tenants no longer share one link base.
    expect(inTenant("acme", tenantBaseUrl)).not.toBe(inTenant("globex", tenantBaseUrl));
  });

  it("keeps the dev server's scheme and port when the root domain is localhost", async () => {
    // A port-less https://acme.localhost reached whatever listened on 443/80, not the SPA on 5173,
    // so the signup page's "Open your workspace" button and the welcome email were dead in dev.
    const { tenantBaseUrl, inTenant } = await loadAddressing("localhost");
    expect(inTenant("acme", tenantBaseUrl)).toBe("http://acme.localhost:5173");
  });

  it("produces a base that resolveOrgSlug routes straight back to the same workspace", async () => {
    /**
     * The round trip is the actual requirement, and neither half proves it alone: a link base is
     * only correct if the hostname in it resolves to the tenant whose database holds the token.
     */
    const { tenantBaseUrl, inTenant } = await loadAddressing("timesphere.app");
    const { resolveOrgSlug } = await import("../../src/middleware/tenant.js");
    for (const slug of ["acme", "globex", "a-long-hyphenated-name"]) {
      const host = new URL(inTenant(slug, tenantBaseUrl)).host;
      expect(resolveOrgSlug(req(host)), `${slug} -> ${host}`).toBe(slug);
    }
  });

  it("never carries a trailing slash, because every call site appends a path", async () => {
    const { tenantBaseUrl, inTenant } = await loadAddressing("timesphere.app");
    expect(inTenant("acme", tenantBaseUrl)).not.toMatch(/\/$/);
    const { tenantBaseUrl: single, inTenant: inSingle } = await loadAddressing(undefined);
    expect(inSingle("acme", single)).not.toMatch(/\/$/);
  });
});

/**
 * The diagnostic that finds a rewritten Host in a deployment you cannot see.
 *
 * This is what `GET /api/platform-admin/routing` reports, and the reason it exists: the routing
 * readout used to describe only the CONFIGURATION, which was correct on the machine where subdomain
 * routing had never once worked. `changeOrigin: true` in the dev proxy replaced the header the whole
 * scheme depends on, and no readout, log line or test noticed — because nothing looked at the
 * request. nginx's `proxy_pass` rewrites the same header by default, so this is the likeliest single
 * thing to be wrong about a cloud deployment.
 */
describe("describeObservedRouting — reading a request back", () => {
  const headers = (h: Record<string, string | string[]>) => ({ headers: h }) as never;

  it("reports the workspace a request really resolved to, port and case included", async () => {
    const { describeObservedRouting } = await loadWith("timesphere.app");
    const seen = describeObservedRouting(headers({ host: "ACME.timesphere.app:8443" }));
    expect(seen.hostHeaderSeen).toBe("ACME.timesphere.app:8443");
    expect(seen.resolvedSlug).toBe("acme");
    expect(seen.isApex).toBe(false);
  });

  it("flags the apex, which is served the finder rather than a workspace", async () => {
    const { describeObservedRouting } = await loadWith("timesphere.app");
    expect(describeObservedRouting(headers({ host: "timesphere.app" })).isApex).toBe(true);
  });

  it("suspects a rewrite when the forwarded host disagrees with the host that arrived", async () => {
    // Exactly the shape a `changeOrigin`-style proxy produces: the browser asked for Acme, the API
    // was told the request was for the proxy's own address.
    const { describeObservedRouting } = await loadWith("timesphere.app");
    const seen = describeObservedRouting(
      headers({ host: "localhost:4000", "x-forwarded-host": "acme.timesphere.app" })
    );
    expect(seen.hostRewriteSuspected).toBe(true);
    // And the consequence is visible in the same response: the wrong workspace.
    expect(seen.resolvedSlug).toBe("default");
  });

  it("does not cry rewrite when the two agree apart from the port", async () => {
    // TLS terminates at the proxy, so `:443` on one side and `:8443` on the other is normal and is
    // not evidence of anything. Comparing with ports included made this finding fire on healthy
    // deployments, which is how a diagnostic stops being read.
    const { describeObservedRouting } = await loadWith("timesphere.app");
    expect(
      describeObservedRouting(headers({ host: "acme.timesphere.app:8443", "x-forwarded-host": "acme.timesphere.app:443" }))
        .hostRewriteSuspected
    ).toBe(false);
  });

  it("takes the first entry when a chain of proxies appended to X-Forwarded-Host", async () => {
    // Two hops produce "original, intermediate". The original is the client's, and the one that
    // matters. Both the comma-list and the repeated-header forms occur in the wild.
    const { describeObservedRouting } = await loadWith("timesphere.app");
    expect(
      describeObservedRouting(headers({ host: "acme.timesphere.app", "x-forwarded-host": "acme.timesphere.app, edge.internal" }))
        .hostRewriteSuspected
    ).toBe(false);
    expect(
      describeObservedRouting(headers({ host: "acme.timesphere.app", "x-forwarded-host": ["acme.timesphere.app", "edge.internal"] }))
        .hostRewriteSuspected
    ).toBe(false);
  });

  it("claims nothing when there is no forwarded host to compare against", async () => {
    /**
     * THE HONEST LIMIT OF THIS CHECK. A proxy can rewrite `Host` and set no `X-Forwarded-Host` at
     * all, leaving this with nothing to detect — which is why `hostHeaderSeen` and `resolvedSlug`
     * are reported raw beside it. Asserting false here pins that the flag stays a hint and never
     * becomes a "no rewrite happened" guarantee somebody could rely on.
     */
    const { describeObservedRouting } = await loadWith("timesphere.app");
    const seen = describeObservedRouting(headers({ host: "localhost:4000" }));
    expect(seen.hostRewriteSuspected).toBe(false);
    expect(seen.forwardedHost).toBeNull();
    // What DOES give it away is right here in the same object, for a reader who knows what they
    // aimed at: they asked for a workspace and the API resolved the default.
    expect(seen.resolvedSlug).toBe("default");
  });
});
