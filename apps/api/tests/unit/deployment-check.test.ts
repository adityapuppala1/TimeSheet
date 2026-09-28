/**
 * The boot check on how a deployment is addressed.
 *
 * Every case here is one that actually happened, on one deployment, in one week — and none of them
 * produced a word at startup. The app was reachable over a public IP and refused every sign-in
 * ("Origin ... not allowed by CORS") because that address was absent from `WEB_ORIGIN`; it then
 * emailed password-reset links built on a private LAN address that no outside recipient could open.
 * Each setting was individually valid. They failed as a combination, which is exactly the shape a
 * table of cases catches and a careful read does not.
 */
import { describe, expect, it } from "vitest";

const { inspectDeploymentConfig } = await import("../../src/config/deployment-check.js");

/**
 * The healthy baseline every case varies from.
 *
 * `rootDomain: "timesphere.example.com"` and an APP_BASE_URL at that apex, because the two-label
 * default this file used to carry (`example.com`) is the ONE shape the tenant router handles
 * correctly by accident — and a baseline that is accidentally correct cannot show which cases are
 * deliberately correct. `activeOrgCount: 1` is the single-workspace deployment.
 */
const check = (
  over: Partial<{
    appBaseUrl: string;
    webOrigin: string;
    nodeEnv: string;
    rootDomain: string | undefined;
    defaultOrgSlug: string;
    activeOrgCount: number | null;
  }> = {}
) =>
  inspectDeploymentConfig({
    appBaseUrl: "https://timesphere.example.com",
    webOrigin: "https://timesphere.example.com",
    nodeEnv: "production",
    rootDomain: "timesphere.example.com",
    defaultOrgSlug: "default",
    activeOrgCount: 1,
    ...over
  });

const problems = (findings: ReturnType<typeof check>) => findings.map((f) => f.problem).join(" | ");

describe("a correctly addressed deployment", () => {
  it("says nothing at all", () => {
    expect(check()).toEqual([]);
  });

  it("says nothing for an ordinary LAN development setup", () => {
    // The common, correct case. A check that fires here is one people learn to scroll past.
    expect(
      check({ appBaseUrl: "https://192.168.1.20:5173", webOrigin: "https://192.168.1.20:5173", nodeEnv: "development", rootDomain: undefined })
    ).toEqual([]);
  });
});

describe("the mismatch that caused a real outage", () => {
  it("catches APP_BASE_URL missing from WEB_ORIGIN, as an error", () => {
    const found = check({ appBaseUrl: "https://203.0.113.10:5173", webOrigin: "http://localhost:5173" });
    const finding = found.find((f) => /CORS will refuse that origin/.test(f.problem));
    expect(finding?.severity).toBe("error");
    // The fix must name the exact string to add — that is the whole difference between this and the
    // message users were getting.
    expect(finding?.fix).toContain("https://203.0.113.10:5173");
  });

  it("compares full origins, so a right host on a wrong port is still caught", () => {
    // A browser treats these as different origins. So must this, or the check passes and CORS fails.
    expect(problems(check({ appBaseUrl: "https://app.example.com:8443", webOrigin: "https://app.example.com" }))).toMatch(
      /CORS will refuse that origin/
    );
  });

  it("stays silent for a fresh machine on APP_BASE_URL=auto, because CORS accepts private LAN addresses in development", () => {
    /**
     * THE REGRESSION THIS EXISTS TO PREVENT. `auto` resolves to whatever LAN address the machine has,
     * which by design is not, and cannot be, listed in a checked-in WEB_ORIGIN. The CORS layer accepts
     * any private LAN origin in development, so this configuration WORKS — and the first version of
     * this check said ERROR on every fresh deployment because it read the list instead of asking the
     * rule. A guard that cries on healthy setups is worse than no guard.
     */
    expect(
      check({ appBaseUrl: "https://192.168.4.77:5173", webOrigin: "http://localhost:5173", nodeEnv: "development", rootDomain: undefined })
    ).toEqual([]);
    expect(check({ appBaseUrl: "http://10.0.0.8:5173", webOrigin: "http://localhost:5173", nodeEnv: "development", rootDomain: undefined })).toEqual([]);
  });

  it("still catches an unlisted PUBLIC address in development, which the shortcut never covers", () => {
    expect(
      problems(check({ appBaseUrl: "https://203.0.113.10:5173", webOrigin: "http://localhost:5173", nodeEnv: "development" }))
    ).toMatch(/CORS will refuse that origin/);
  });

  it("does not extend the development shortcut into production", () => {
    // In production the allow-list is the only thing that counts, for private addresses too.
    expect(
      problems(check({ appBaseUrl: "https://192.168.4.77:5173", webOrigin: "https://elsewhere.example.com", nodeEnv: "production" }))
    ).toMatch(/CORS will refuse that origin/);
  });

  it("accepts a match found among several allow-listed origins", () => {
    expect(
      check({
        appBaseUrl: "https://app.example.com",
        webOrigin: "http://localhost:5173, https://staging.example.com , https://app.example.com",
        // The app IS the apex of its own root domain (workspaces would live at
        // <slug>.app.example.com). Stated so this case stays about the allow-list: with ROOT_DOMAIN
        // unset the label-counting fallback would read "app" as a workspace slug, and with
        // ROOT_DOMAIN="example.com" the apex would be one level up — each a different finding.
        rootDomain: "app.example.com"
      })
    ).toEqual([]);
  });
});

describe("emailed links that nobody outside can open", () => {
  it("is an error in production, and silent in development where it is the normal setup", () => {
    const prod = check({ appBaseUrl: "https://192.168.1.20:5173", webOrigin: "https://192.168.1.20:5173" });
    expect(prod.find((f) => /only reachable from this machine or this LAN/.test(f.problem))?.severity).toBe("error");

    // A laptop serving colleagues on the same Wi-Fi is correct, not a misconfiguration. Warning here
    // would fire on every healthy dev machine — which is how a check trains people to ignore it.
    const dev = check({ appBaseUrl: "http://localhost:5173", webOrigin: "http://localhost:5173", nodeEnv: "development", rootDomain: undefined });
    expect(dev).toEqual([]);
  });

  it("treats every private range and loopback form as local", () => {
    // Checked in production, where a LAN-only base IS a problem.
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "172.31.255.254", "169.254.1.1"]) {
      expect(problems(check({ appBaseUrl: `https://${host}`, webOrigin: `https://${host}` })), host).toMatch(/only reachable/);
    }
  });

  it("does not mistake a neighbouring public range for a private one", () => {
    // 172.15 and 172.32 sit either side of the private block and are ordinary internet addresses.
    for (const host of ["172.15.0.1", "172.32.0.1", "11.0.0.1"]) {
      expect(problems(check({ appBaseUrl: `https://${host}`, webOrigin: `https://${host}` })), host).not.toMatch(/only reachable/);
    }
  });
});

describe("things that are unsafe rather than merely broken", () => {
  it("warns that a bare IP can never carry a trusted certificate", () => {
    const found = check({ appBaseUrl: "https://203.0.113.10", webOrigin: "https://203.0.113.10" });
    expect(problems(found)).toMatch(/No public certificate authority issues certificates for IP addresses/);
  });

  it("errors on plain HTTP over a public address", () => {
    // Session cookies and reset tokens in clear text.
    const found = check({ appBaseUrl: "http://app.example.com", webOrigin: "http://app.example.com" });
    expect(found.find((f) => /unencrypted/.test(f.problem))?.severity).toBe("error");
  });

  it("does not complain about plain HTTP on a LAN address", () => {
    // Ordinary and fine for an internal pilot; flagging it would be the noise that hides the rest.
    expect(problems(check({ appBaseUrl: "http://192.168.1.20:5173", webOrigin: "http://192.168.1.20:5173", nodeEnv: "development" }))).not.toMatch(
      /unencrypted/
    );
  });

  it("warns when real users are pointed at a development build", () => {
    const found = check({ appBaseUrl: "https://203.0.113.10:5173", webOrigin: "https://203.0.113.10:5173", nodeEnv: "development" });
    expect(problems(found)).toMatch(/development server/);
  });
});

describe("a malformed value", () => {
  it("reports only that, rather than a cascade of nonsense derived from it", () => {
    const found = inspectDeploymentConfig({ appBaseUrl: "not-a-url", webOrigin: "https://app.example.com", nodeEnv: "production" });
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });
});

describe("every finding is actionable", () => {
  it("carries a fix, because a warning nobody can act on is noise", () => {
    const found = check({ appBaseUrl: "http://203.0.113.10:5173", webOrigin: "http://localhost:5173", nodeEnv: "development" });
    expect(found.length).toBeGreaterThan(1);
    for (const finding of found) expect(finding.fix.length, finding.problem).toBeGreaterThan(20);
  });
});

/**
 * WHICH WORKSPACE A HOSTNAME REACHES — the half of this check that did not exist until a deployment
 * served more than one organization, and the half whose failure mode is a 404 for every request.
 *
 * Measured against a running server before any of this existed:
 *
 *     Host: timesheet.company.com  ->  404 Unknown workspace.
 *     Host: hics.com.sg            ->  404 Unknown workspace.
 *     Host: localhost              ->  200
 *
 * `middleware/tenant.ts` takes the workspace from the first DNS label when ROOT_DOMAIN is unset, so
 * a deployment's own hostname becomes a workspace slug that was never provisioned. Nothing logs it,
 * because from the router's point of view it was asked for a workspace that does not exist.
 */
describe("the hostname that resolves to no workspace at all", () => {
  const routing = (findings: ReturnType<typeof check>) =>
    findings.filter((f) => /workspace|ROOT_DOMAIN|organizations are ACTIVE/.test(f.problem));

  it("catches a three-label production hostname with ROOT_DOMAIN unset, as an error", () => {
    const found = routing(
      check({ appBaseUrl: "https://timesheet.company.com", webOrigin: "https://timesheet.company.com", rootDomain: undefined })
    );
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.problem).toMatch(/404 Unknown workspace/);
    // The fix has to be copy-pasteable, which means naming the exact value. "Configure routing" is
    // what the old silence amounted to.
    expect(found[0]?.fix).toContain('ROOT_DOMAIN="company.com"');
  });

  it("catches a public suffix, which label counting cannot tell from a subdomain", () => {
    // `hics.com.sg` has three labels and no subdomain at all. This is why the label rule was replaced
    // rather than tuned: a domain's real root is not derivable from how many dots it has.
    const found = routing(check({ appBaseUrl: "https://hics.com.sg", webOrigin: "https://hics.com.sg", rootDomain: undefined }));
    expect(found[0]?.problem).toMatch(/first label is "hics"/);
    expect(found[0]?.fix).toContain('ROOT_DOMAIN="com.sg"');
  });

  it("stays silent when the first label happens to BE the default workspace slug", () => {
    /**
     * The coincidence that makes this deployment work, and therefore must not be reported. If the
     * org is genuinely called "timesheet", label counting resolves to it and every request succeeds.
     * A check that fires here would be telling somebody to fix a working deployment.
     */
    expect(
      routing(
        check({
          appBaseUrl: "https://timesheet.company.com",
          webOrigin: "https://timesheet.company.com",
          rootDomain: undefined,
          defaultOrgSlug: "timesheet"
        })
      )
    ).toEqual([]);
  });

  it("stays silent for the hostnames that never had a subdomain to misread", () => {
    for (const host of ["http://localhost:5173", "https://192.168.1.20:5173", "https://timesheet.local"]) {
      expect(
        routing(check({ appBaseUrl: host, webOrigin: host, rootDomain: undefined, nodeEnv: "development" })),
        host
      ).toEqual([]);
    }
  });
});

describe("workspaces nobody can reach", () => {
  it("is an error when several orgs are ACTIVE and no ROOT_DOMAIN gives them addresses", () => {
    // The second workspace exists, bills, provisions a database, runs its workers — and answers to
    // no hostname, because every request falls back to DEFAULT_ORG_SLUG.
    const found = check({ appBaseUrl: "https://example.com", webOrigin: "https://example.com", rootDomain: undefined, activeOrgCount: 4 });
    const finding = found.find((f) => /organizations are ACTIVE/.test(f.problem));
    expect(finding?.severity).toBe("error");
    expect(finding?.problem).toMatch(/the other 3 have no address/);
  });

  it("counts in the singular when exactly one workspace is stranded", () => {
    // The live shape on the development machine this was found on: two orgs, one reachable. Worth an
    // assertion because "the other 1 have no address" is what the first version printed, and a boot
    // message that reads like a bug is a boot message people stop trusting.
    const found = check({ appBaseUrl: "https://example.com", webOrigin: "https://example.com", rootDomain: undefined, activeOrgCount: 2 });
    expect(found.find((f) => /organizations are ACTIVE/.test(f.problem))?.problem).toMatch(/the other 1 has no address/);
  });

  it("says nothing for the single-workspace deployment, which is every on-prem install", () => {
    expect(
      check({ appBaseUrl: "https://example.com", webOrigin: "https://example.com", rootDomain: undefined, activeOrgCount: 1 })
    ).toEqual([]);
  });

  it("says nothing when the control plane could not be counted, rather than guessing", () => {
    // `null` is "unknown". Treating it as 0 or as many would invent an input and report on it.
    expect(
      check({ appBaseUrl: "https://example.com", webOrigin: "https://example.com", rootDomain: undefined, activeOrgCount: null })
    ).toEqual([]);
  });

  it("says nothing about many orgs once ROOT_DOMAIN gives each one an address", () => {
    expect(check({ activeOrgCount: 40 })).toEqual([]);
  });
});

describe("a ROOT_DOMAIN that cannot match anything", () => {
  it.each([
    ["https://timesphere.example.com", "a scheme"],
    ["timesphere.example.com:443", "a port"],
    ["timesphere.example.com/app", "a path"],
    [".timesphere.example.com", "a leading dot"],
    ["timesphere.example.com.", "a trailing dot"]
  ])("rejects %s (%s)", (rootDomain) => {
    /**
     * `resolveOrgSlug` compares the lowercased hostname against `.${ROOT_DOMAIN}`. Any of these
     * matches no request at all, so the deployment behaves as though multi-org mode were off while
     * the routing readout reports it as on — the worst combination, because the readout is where
     * somebody would look.
     */
    const found = check({ rootDomain }).filter((f) => /not a bare hostname/.test(f.problem));
    expect(found[0]?.severity).toBe("error");
  });

  it("accepts a bare domain, and a single label for local multi-tenant testing", () => {
    // `ROOT_DOMAIN="localhost"` is how a second workspace is reached on a development machine
    // (`acme.localhost`), so a rule requiring a dot would reject the documented recipe.
    expect(check({ rootDomain: "timesphere.example.com" })).toEqual([]);
    expect(
      check({ appBaseUrl: "http://localhost:5173", webOrigin: "http://localhost:5173", nodeEnv: "development", rootDomain: "localhost" })
    ).toEqual([]);
  });
});

describe("ROOT_DOMAIN set, but not to the domain being served", () => {
  it("is an error when APP_BASE_URL is outside the root entirely", () => {
    const found = check({
      appBaseUrl: "https://app.elsewhere.net",
      webOrigin: "https://app.elsewhere.net",
      rootDomain: "timesphere.app"
    }).filter((f) => /neither that domain nor under it/.test(f.problem));
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.fix).toContain("https://timesphere.app");
  });

  it("warns — not errors — when APP_BASE_URL is one workspace's own subdomain", () => {
    /**
     * A warning because emailed links became tenant-aware (workspace-directory.service#tenantBaseUrl),
     * so this no longer breaks password resets. It still matters: the OAuth `redirect_uri` and the git
     * provider callback are registered once with a third party from this exact value, so both would
     * live on one customer's hostname.
     */
    const found = check({
      appBaseUrl: "https://acme.timesphere.app",
      webOrigin: "https://acme.timesphere.app",
      rootDomain: "timesphere.app"
    }).filter((f) => /workspace subdomain of ROOT_DOMAIN/.test(f.problem));
    expect(found[0]?.severity).toBe("warning");
  });

  it("is silent for the apex and for www, which are the intended shapes", () => {
    expect(check({ appBaseUrl: "https://timesphere.app", webOrigin: "https://timesphere.app", rootDomain: "timesphere.app" })).toEqual([]);
    expect(
      check({ appBaseUrl: "https://www.timesphere.app", webOrigin: "https://www.timesphere.app", rootDomain: "timesphere.app" })
    ).toEqual([]);
  });
});
