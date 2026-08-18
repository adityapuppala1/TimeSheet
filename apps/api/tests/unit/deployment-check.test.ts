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

const check = (over: Partial<{ appBaseUrl: string; webOrigin: string; nodeEnv: string }> = {}) =>
  inspectDeploymentConfig({
    appBaseUrl: "https://timesphere.example.com",
    webOrigin: "https://timesphere.example.com",
    nodeEnv: "production",
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
      check({ appBaseUrl: "https://192.168.1.20:5173", webOrigin: "https://192.168.1.20:5173", nodeEnv: "development" })
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
      check({ appBaseUrl: "https://192.168.4.77:5173", webOrigin: "http://localhost:5173", nodeEnv: "development" })
    ).toEqual([]);
    expect(check({ appBaseUrl: "http://10.0.0.8:5173", webOrigin: "http://localhost:5173", nodeEnv: "development" })).toEqual([]);
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
        webOrigin: "http://localhost:5173, https://staging.example.com , https://app.example.com"
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
    const dev = check({ appBaseUrl: "http://localhost:5173", webOrigin: "http://localhost:5173", nodeEnv: "development" });
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
