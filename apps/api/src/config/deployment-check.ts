/**
 * WHAT: the boot-time sanity check on the three settings that decide whether people outside this
 * machine can actually use the app — `APP_BASE_URL`, `WEB_ORIGIN`, and `NODE_ENV`.
 *
 * WHY IT EXISTS: each of these is individually valid and they fail as a COMBINATION, which is why
 * nothing caught them. A workspace was reachable over a public IP and refused every sign-in with
 * "Origin ... not allowed by CORS", because the address people were told to use was not in the
 * allow-list. The same deployment then emailed password-reset links built on a private LAN address
 * that no recipient outside the building could open. Both are one line of configuration; neither
 * produced a single word at startup, and the first anybody knew was a user who could not sign in.
 *
 * WHY IT WARNS RATHER THAN REFUSING TO START: the same reason `resolveAppBaseUrl` only warns about
 * `auto` in production — an on-prem LAN pilot IS production to the people using it, and a process
 * that refuses to boot over a debatable address is worse than one that says clearly what is wrong.
 * The one thing this must never do is stay silent.
 *
 * WHY THE CHECK IS PURE AND THE PRINTING IS NOT: every finding here is a string comparison over
 * three inputs, and the interesting cases are boundaries — a public IP versus a private one, an
 * origin that matches on host but not on port. That deserves a table of tests, not a careful read.
 *
 * WHO CALLS THIS: `server.ts` at boot, before it starts listening.
 */

/** Loopback, link-local, and the three RFC 1918 ranges — everything unreachable from the internet. */
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/i;

const IP_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export type Severity = "error" | "warning";

export interface ConfigFinding {
  severity: Severity;
  /** What is wrong, in one sentence. */
  problem: string;
  /** What to change. Every finding has one — a warning nobody can act on is noise. */
  fix: string;
}

export interface DeploymentInputs {
  appBaseUrl: string;
  /** Raw `WEB_ORIGIN`, comma-separated as the environment supplies it. */
  webOrigin: string;
  nodeEnv: string | undefined;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Every problem worth saying out loud, in the order somebody should act on them.
 *
 * Deliberately quiet about correct-but-unusual setups: a private address in development with a
 * matching allow-list entry is exactly right and gets nothing, because a check that fires on healthy
 * deployments is one people learn to scroll past.
 */
export function inspectDeploymentConfig(input: DeploymentInputs): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const isProduction = input.nodeEnv === "production";

  const base = originOf(input.appBaseUrl);
  if (!base) {
    return [
      {
        severity: "error",
        problem: `APP_BASE_URL is not a valid absolute URL: "${input.appBaseUrl}".`,
        fix: 'Set it to a full origin including the scheme, e.g. "https://timesphere.example.com".'
      }
    ];
  }

  const allowed = input.webOrigin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => originOf(value) ?? value);

  const url = new URL(input.appBaseUrl);
  const hostIsPrivate = PRIVATE_HOST_RE.test(url.hostname);
  const hostIsIpLiteral = IP_LITERAL_RE.test(url.hostname);

  /**
   * THE ONE THAT BIT. The address the app tells people to use must be an address the app accepts
   * requests from. A browser opening APP_BASE_URL sends exactly that origin, so if it is missing
   * from WEB_ORIGIN every sign-in from the only address users were given fails on CORS — while
   * localhost keeps working perfectly for whoever is testing.
   */
  if (!allowed.includes(base)) {
    findings.push({
      severity: "error",
      problem: `APP_BASE_URL is ${base}, but that origin is not in WEB_ORIGIN — every browser opening the address people are given will be refused on CORS.`,
      fix: `Add ${base} to WEB_ORIGIN (comma-separated, exact scheme/host/port) and restart the API.`
    });
  }

  /**
   * Emailed links are built on this base and read by people who may be anywhere.
   *
   * Only in PRODUCTION. A private address in development is the normal, correct setup — a laptop
   * serving colleagues on the same Wi-Fi — and warning about it would fire on every healthy dev
   * machine, which is how a check teaches people to scroll past it. `resolveAppBaseUrl` already
   * prints the resolved base at boot, so a developer can see what links will use.
   */
  if (hostIsPrivate) {
    if (isProduction) {
      findings.push({
        severity: "error",
        problem: `APP_BASE_URL points at ${url.hostname}, which is only reachable from this machine or this LAN. Every emailed password reset, invitation and digest link will be unopenable for anyone outside it.`,
        fix: "Set APP_BASE_URL to the address people actually type — a DNS name if you have one. If this deployment really is LAN-only, this is correct and can be ignored."
      });
    }
    // A private address never reaches the certificate warning below: nobody expects a publicly
    // issued certificate for 192.168.x, and saying so on every dev machine would be pure noise.
  } else if (hostIsIpLiteral) {
    findings.push({
      severity: "warning",
      problem: `APP_BASE_URL uses a bare IP address (${url.hostname}). No public certificate authority issues certificates for IP addresses, so every emailed link opens with a browser security warning — and password-reset links that train people to click past warnings are worth avoiding.`,
      fix: "Put a DNS name in front of this deployment and use a publicly issued certificate. See docs/DEPLOYMENT.md."
    });
  }

  if (url.protocol === "http:" && !hostIsPrivate) {
    findings.push({
      severity: "error",
      problem: `APP_BASE_URL is plain HTTP over a public address (${base}). Session cookies and password-reset tokens would travel unencrypted.`,
      fix: "Serve this deployment over HTTPS and change APP_BASE_URL to the https:// origin."
    });
  }

  /**
   * Real users on a development build. Detectable, and worth saying: `npm run dev` runs a Vite dev
   * server with hot reload and source maps, has none of the production build's hardening, and is not
   * something to expose beyond a trusted network.
   */
  if (!isProduction && !hostIsPrivate) {
    findings.push({
      severity: "warning",
      problem: `NODE_ENV is not "production" but APP_BASE_URL is a public address (${base}) — people outside this network are being pointed at a development server.`,
      fix: "For anything beyond a demo, build and run the production image (see docs/DEPLOYMENT.md) and set NODE_ENV=production."
    });
  }

  return findings;
}

/** Boot-time report. Silent when everything is consistent, so it stays worth reading. */
export function reportDeploymentConfig(input: DeploymentInputs): ConfigFinding[] {
  const findings = inspectDeploymentConfig(input);
  if (findings.length === 0) return findings;

  console.warn("\n[config] Problems with how this deployment is addressed:");
  for (const finding of findings) {
    console.warn(`[config]   ${finding.severity === "error" ? "ERROR  " : "warning"}  ${finding.problem}`);
    console.warn(`[config]            fix: ${finding.fix}`);
  }
  console.warn("[config] The app still starts — see docs/DEPLOYMENT.md.\n");
  return findings;
}
