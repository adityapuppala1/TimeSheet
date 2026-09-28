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

import { isOriginAllowed } from "./origins.js";

/** Loopback, link-local, and the three RFC 1918 ranges — everything unreachable from the internet.
 *  Broader than `origins.ts`'s pattern on purpose: that one matches whole ORIGINS for the allow-list,
 *  this one matches bare HOSTNAMES to decide whether emailed links can leave the building. */
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
  /** Raw `ROOT_DOMAIN`. Unset means single-org mode, which is what every on-prem install runs. */
  rootDomain: string | undefined;
  /** `DEFAULT_ORG_SLUG` — needed because a hostname whose first label happens to equal it resolves
   *  correctly by accident, and a check that cannot tell the difference cries wolf. */
  defaultOrgSlug: string;
  /** How many organizations are ACTIVE, or `null` when the control plane could not be asked. Null
   *  suppresses the multi-workspace finding rather than guessing — a boot check that invents an
   *  input is worse than one that stays quiet about it. */
  activeOrgCount: number | null;
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
   * requests from. A browser opening APP_BASE_URL sends exactly that origin, so if CORS would refuse
   * it, every sign-in from the only address users were given fails — while localhost keeps working
   * perfectly for whoever is testing.
   *
   * Asked of `isOriginAllowed` rather than by scanning the list, so this cannot disagree with what the
   * middleware will actually do. The first version DID disagree: it did not know about the
   * development shortcut for private LAN addresses, so a fresh machine running `APP_BASE_URL="auto"`
   * — whose entire purpose is adapting to whatever address that machine has — booted with a loud
   * error about a setup that worked fine.
   */
  // ROOT_DOMAIN threaded through for the same reason this function asks the rule instead of
  // reading the list: a multi-workspace deployment accepts every subdomain of it, and a boot check
  // that did not know would report an ERROR about a configuration that works.
  if (!isOriginAllowed(base, allowed, !isProduction, input.rootDomain)) {
    const autoAllowed = !isProduction ? " (development also auto-accepts private LAN addresses, and this is not one)" : "";
    findings.push({
      severity: "error",
      problem: `APP_BASE_URL is ${base}, but CORS will refuse that origin${autoAllowed} — every browser opening the address people are given will be turned away.`,
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

  findings.push(...inspectTenantRouting(input, url));

  return findings;
}

/**
 * Which workspace a hostname resolves to — checked at boot, because the failure mode is a 404 for
 * every request and there is no other warning anywhere.
 *
 * WHY THIS IS SEPARATE FROM THE ADDRESSING CHECKS ABOVE: those are about whether people can reach
 * the app at all. These are about whether they reach the RIGHT WORKSPACE, which is a different
 * question with a different reader — and one that did not exist as a question until a deployment
 * served more than one organization.
 *
 * WHAT WENT WRONG, MEASURED AGAINST A RUNNING SERVER. `middleware/tenant.ts` derives the workspace
 * from the `Host` header, and with `ROOT_DOMAIN` unset it does so by COUNTING DNS LABELS: three or
 * more labels means the first one is a workspace slug. That rule is correct for `acme.example.com`
 * and catastrophic for `timesheet.company.com`, which is what a real deployment's hostname looks
 * like — it searches for a workspace called "timesheet", finds none, and answers
 * `404 Unknown workspace.` to every single request. Three probes, one server:
 *
 *     Host: timesheet.company.com  ->  404 Unknown workspace.
 *     Host: hics.com.sg            ->  404 Unknown workspace.
 *     Host: localhost              ->  200
 *
 * Nothing in the logs explains it, because from the router's point of view nothing went wrong: it
 * was asked for a workspace that does not exist. The fix is one line of configuration, and the only
 * thing missing was somebody saying so before the traffic arrived.
 */
function inspectTenantRouting(input: DeploymentInputs, url: URL): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const root = input.rootDomain?.trim().toLowerCase() ?? "";
  const host = url.hostname.toLowerCase();
  const labels = host.split(".").filter(Boolean);
  const hostIsIp = IP_LITERAL_RE.test(host);

  if (!root) {
    /**
     * THE 404 ABOVE. Fires on the exact shape that breaks — three or more labels, not an IP — and
     * stays silent when the first label happens to equal `DEFAULT_ORG_SLUG`, because then the label
     * rule resolves to the right workspace by coincidence and the deployment genuinely works.
     */
    if (!hostIsIp && labels.length >= 3 && labels[0] !== input.defaultOrgSlug) {
      findings.push({
        severity: "error",
        problem:
          `ROOT_DOMAIN is unset, so the workspace is taken from the FIRST LABEL of the hostname — and APP_BASE_URL is ` +
          `${host}, whose first label is "${labels[0]}". Unless a workspace with the slug "${labels[0]}" exists, every ` +
          `request to this address answers "404 Unknown workspace.", including the login page.`,
        fix:
          `Set ROOT_DOMAIN="${labels.slice(1).join(".")}" so the slug is derived by stripping that suffix instead of ` +
          `counting labels (then ${host} is the workspace "${labels[0]}", and workspaces live at ` +
          `<slug>.${labels.slice(1).join(".")}). If this deployment has only one workspace and should answer on this ` +
          `exact hostname, rename that organization's slug to "${labels[0]}" instead. See docs/DEPLOYMENT.md ` +
          `§ "Turning on multi-org routing".`
      });
    }

    /**
     * More than one workspace and no way to address the others. Every request falls back to
     * `DEFAULT_ORG_SLUG`, so the second organization exists, bills, provisions a database and runs
     * its workers — and is reachable by nobody.
     */
    if (input.activeOrgCount !== null && input.activeOrgCount > 1) {
      const unreachable = input.activeOrgCount - 1;
      findings.push({
        severity: "error",
        problem:
          `${input.activeOrgCount} organizations are ACTIVE, but ROOT_DOMAIN is unset — so every request resolves to ` +
          `"${input.defaultOrgSlug}" and the other ${unreachable} ${unreachable === 1 ? "has" : "have"} no address ` +
          `anyone can reach.`,
        fix:
          "Set ROOT_DOMAIN to the domain workspace subdomains hang off, point a wildcard DNS record and a wildcard " +
          "certificate at this deployment, and read Platform admin → Organizations first: it lists the URL each " +
          "workspace will get. Alternatively give each workspace a verified custom domain."
      });
    }
    return findings;
  }

  // A value that can never match a hostname. `resolveOrgSlug` compares against `.${ROOT_DOMAIN}`
  // after lowercasing the host, so a scheme, a port, a path or a stray dot silently matches nothing
  // and the deployment behaves as if multi-org mode were off — while the readout says it is on.
  const malformed =
    root.includes("://") || root.includes("/") || root.includes(":") || root.startsWith(".") || root.endsWith(".");
  if (malformed) {
    findings.push({
      severity: "error",
      problem: `ROOT_DOMAIN is "${input.rootDomain}", which is not a bare hostname, so it will never match any request and no subdomain will resolve to its workspace.`,
      fix: 'Set it to a bare domain with no scheme, port, path or surrounding dots — e.g. ROOT_DOMAIN="timesphere.app".'
    });
    return findings;
  }

  const isApex = host === root || host === `www.${root}`;
  const isUnderRoot = host.endsWith(`.${root}`);

  if (!isApex && !isUnderRoot) {
    findings.push({
      severity: "error",
      problem:
        `ROOT_DOMAIN is "${root}" but APP_BASE_URL is ${host}, which is neither that domain nor under it. Workspace ` +
        `addresses are built as <slug>.${root}, so the addresses this deployment hands out and the address it is ` +
        `actually served on are different hostnames.`,
      fix: `Point APP_BASE_URL at https://${root} (the apex), or correct ROOT_DOMAIN to the domain ${host} sits under.`
    });
  } else if (isUnderRoot && host !== `www.${root}`) {
    /**
     * APP_BASE_URL pointing at ONE workspace in a multi-workspace deployment. Emailed links are
     * tenant-aware now (services/workspace-directory.service.ts#tenantBaseUrl), so this is no longer
     * the outage it was — but two things are still built from APP_BASE_URL alone and must be, because
     * they are registered with a third party and have to be a single fixed string: the OAuth
     * `redirect_uri` (services/sso.service.ts) and the git provider callback. Registering those on
     * one customer's hostname works, and reads to everyone else like a mistake.
     */
    findings.push({
      severity: "warning",
      problem:
        `APP_BASE_URL (${host}) is a workspace subdomain of ROOT_DOMAIN, not the apex. The SSO redirect_uri and the ` +
        `git provider callback are registered once from this value, so both would sit on one workspace's hostname.`,
      fix: `Set APP_BASE_URL to https://${root} and let each workspace be reached at its own <slug>.${root}.`
    });
  }

  return findings;
}

/** Boot-time report. Silent when everything is consistent, so it stays worth reading. */
export function reportDeploymentConfig(input: DeploymentInputs): ConfigFinding[] {
  const findings = inspectDeploymentConfig(input);
  if (findings.length > 0) {
    console.warn("\n[config] Problems with how this deployment is addressed:");
    for (const finding of findings) {
      console.warn(`[config]   ${finding.severity === "error" ? "ERROR  " : "warning"}  ${finding.problem}`);
      console.warn(`[config]            fix: ${finding.fix}`);
    }
    console.warn("[config] The app still starts — see docs/DEPLOYMENT.md.\n");
  }
  return findings;
}
