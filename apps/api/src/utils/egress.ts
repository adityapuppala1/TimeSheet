/**
 * WHAT: the one place that decides whether this server is allowed to make an HTTP request to a
 * URL somebody configured. Format check (`egressUrlProblem`, synchronous — used by the Zod
 * schemas so a bad value is refused at SAVE time with a message that says why) plus the real
 * gate (`assertPublicEgressTarget`, async — used immediately before every `fetch`, because it
 * resolves DNS).
 *
 * WHY IT EXISTS: four features let an admin type a URL that the API then fetches — outbound
 * webhooks (services/webhook-dispatch.service.ts), the Google Chat incoming webhook
 * (services/chat-outbound.service.ts), the Bot Framework reply endpoint, and the BYOK
 * OpenAI-compatible `baseUrl` (services/ai.service.ts). Before this file, all four accepted
 * anything `new URL()` parses. That is server-side request forgery: the API sits inside the
 * deployment's trusted network, so `http://169.254.169.254/latest/meta-data/iam/...`,
 * `http://127.0.0.1:3306`, or an internal admin panel are all reachable from it and from
 * nowhere the caller could otherwise get to.
 *
 * The reason it mattered here rather than being theoretical: a tenant SUPER_ADMIN is a CUSTOMER
 * in the SaaS deployment (controllers/platform-admin.controller.ts is the operator's console,
 * not this one), and two of those four surfaces hand the result back:
 * `POST /settings/ai/available-models` returns the remote body or its error message, and the
 * webhook test/retry routes return `http_<status>` — which turns a blind request into an
 * internal port scanner with a readable oracle.
 *
 * -- WHY DNS IS RESOLVED HERE AND NOT LEFT TO `fetch` ----------------------------------------
 *
 * Checking the hostname's TEXT is not a control: `internal.attacker.com` with an A record of
 * 127.0.0.1 passes every string test there is. So the host is resolved and EVERY returned
 * address must be public — a name that resolves to both a public and a private address is
 * refused, because which one `fetch` picks is not ours to decide.
 *
 * This leaves a DNS-rebinding window (the record can change between this check and the socket).
 * Closing it properly needs a pinned-IP custom agent; that is a bigger change than this pass,
 * and the window is a far harder attack than the wide-open door it replaces. Stated so the next
 * person knows it is a known bound, not an oversight.
 *
 * -- WHY THE ESCAPE HATCH EXISTS AND WHY IT IS OFF BY DEFAULT --------------------------------
 *
 * A self-hosted, on-prem install genuinely has legitimate private-network webhook targets — an
 * internal ticketing system on 10.x is the normal case there, not an attack. So
 * `ALLOW_PRIVATE_NETWORK_EGRESS=true` re-permits them, and development permits them anyway (a
 * local webhook receiver on localhost is how anyone tests this feature). The DEFAULT is closed,
 * matching TRUST_PROXY_HOPS's posture in app.ts: the safe value ships, and a deployment whose
 * topology needs the other one opts in explicitly.
 *
 * WHO calls this: services/webhook-dispatch.service.ts, services/chat-outbound.service.ts,
 * services/ai.service.ts, and the Zod schemas in controllers/settings.controller.ts and
 * controllers/chat-integrations.controller.ts.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";

/** Only these two. `file:`, `gopher:`, `ftp:` and friends all parse fine as URLs and none of
 *  them is a webhook — `new URL()` accepting them is exactly the gap. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Hostname suffixes that never name an internet host. `.internal` is GCP's metadata domain,
 * `.local`/`.localhost` are mDNS/loopback, and the rest are RFC 6761 reserved names.
 */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa"];

/** Exact hostnames worth naming even though the IP checks below would also catch most of them —
 *  a clear refusal beats a confusing one, and `metadata.google.internal` resolves differently
 *  depending on where you ask. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/** Reads an IPv4 dotted quad into its 32-bit integer, or null if it isn't one. */
function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * The IPv4 space that is not routable on the public internet.
 *
 * 169.254.0.0/16 is the one that matters most and is the least obvious: it is link-local, and it
 * is where EVERY major cloud puts its instance-metadata service (169.254.169.254 on AWS, Azure
 * and GCP alike). A credential-issuing endpoint reachable with no authentication from any process
 * on the box is the single highest-value SSRF target there is.
 */
// Reviewed: `sonarjs/no-hardcoded-ip` asks whether a literal address is safe here. These nine
// literals ARE the security control — a blocklist of the IANA special-purpose ranges, which are
// fixed by RFC and cannot be configuration. Sourcing them from an env var would let a deployment
// weaken the very check this file exists to perform. Disabled for the table only, then re-enabled
// immediately below, so the rule keeps guarding the rest of the file.
/* eslint-disable sonarjs/no-hardcoded-ip -- the blocklist itself; see the note above */
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], //        "this host on this network"
  ["10.0.0.0", 8], //       RFC 1918 private
  ["100.64.0.0", 10], //    RFC 6598 carrier-grade NAT
  ["127.0.0.0", 8], //      loopback
  ["169.254.0.0", 16], //   link-local — cloud instance metadata
  ["172.16.0.0", 12], //    RFC 1918 private
  ["192.0.0.0", 24], //     IETF protocol assignments
  ["192.0.2.0", 24], //     TEST-NET-1
  ["192.168.0.0", 16], //   RFC 1918 private
  ["198.18.0.0", 15], //    benchmarking
  ["198.51.100.0", 24], //  TEST-NET-2
  ["203.0.113.0", 24], //   TEST-NET-3
  ["224.0.0.0", 4], //      multicast
  ["240.0.0.0", 4] //       reserved, incl. 255.255.255.255 broadcast
];
/* eslint-enable sonarjs/no-hardcoded-ip */

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  return BLOCKED_IPV4_CIDRS.some(([network, bits]) => {
    const base = ipv4ToInt(network);
    if (base === null) return false;
    // `2 ** (32 - bits)` rather than a bit shift: `<<` in JS is a 32-bit SIGNED operation, so a
    // /0 or /1 mask overflows into a negative number and silently matches nothing.
    const mask = bits === 0 ? 0 : -(2 ** (32 - bits));
    return (value & mask) === (base & mask);
  });
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];

  // IPv4-mapped (::ffff:127.0.0.1) and NAT64 (64:ff9b::7f00:1) carry a real IPv4 inside an IPv6
  // literal. Judging them as "some IPv6 address" is how a loopback address gets waved through.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (embedded && isBlockedIpv4(embedded[1])) return true;

  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) return true;

  const firstGroup = parseInt(lower.split(":")[0] || "0", 16);
  if (Number.isNaN(firstGroup)) return false;
  if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstGroup & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}

/**
 * Strips the brackets a URL wraps an IPv6 literal in.
 *
 * WHY THIS EXISTS AS ITS OWN STEP (a real bypass, found by probing the running server rather than
 * by unit-testing the predicate): `new URL("http://[::ffff:127.0.0.1]/").hostname` returns
 * `"[::ffff:127.0.0.1]"` — brackets INCLUDED. `net.isIP` says that is not an IP address, so the
 * IPv6 branch below never ran, the hostname matched no blocked name or suffix, and a loopback
 * target sailed through the guard while `isBlockedAddress("::ffff:127.0.0.1")` — the same address
 * without brackets — was correctly refused in the tests. The predicate was right; nothing was
 * handing it the form the URL parser actually produces.
 */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True when this address must never be the target of a server-initiated request. Accepts either
 *  a bare address or the bracketed form a URL's `hostname` yields for IPv6. */
export function isBlockedAddress(address: string): boolean {
  const bare = unbracket(address);
  const family = net.isIP(bare);
  if (family === 4) return isBlockedIpv4(bare);
  if (family === 6) return isBlockedIpv6(bare);
  return false;
}

/** Whether private/loopback targets are permitted for this deployment — see the header. */
export function privateEgressAllowed(): boolean {
  return env.ALLOW_PRIVATE_NETWORK_EGRESS || env.NODE_ENV !== "production";
}

/**
 * Format-level validation, no DNS. Returns an error MESSAGE (not a boolean) so the Zod schemas
 * and the pre-fetch gate can both say the same specific thing to the same person; `null` means
 * the shape is fine.
 *
 * Deliberately not the whole control — a hostname that resolves to a private address passes this
 * and is caught by `assertPublicEgressTarget`. This exists so the settings form rejects an
 * obviously-wrong value while the admin is still looking at it.
 */
export function egressUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a valid absolute URL (including http:// or https://)";
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return `must use http:// or https:// (got "${url.protocol}")`;
  }
  // Credentials in the URL get logged, cached and forwarded in ways nobody expects, and no
  // legitimate webhook receiver needs them — there is an Authorization header for that.
  if (url.username || url.password) {
    return "must not embed a username or password";
  }
  if (privateEgressAllowed()) return null;

  const hostname = unbracket(url.hostname.toLowerCase());
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return `must not point at "${hostname}" — the target has to be reachable from the internet`;
  }
  const blockedSuffix = BLOCKED_HOST_SUFFIXES.find((suffix) => hostname.endsWith(suffix));
  if (blockedSuffix) {
    return `must not point at an internal-only name ending in "${blockedSuffix}"`;
  }
  if (isBlockedAddress(hostname)) {
    return `must not point at the private or loopback address ${hostname}`;
  }
  return null;
}

/**
 * The Zod field type for every admin-entered URL this server will later fetch.
 *
 * WHY BOTH THIS AND THE PRE-FETCH GATE, when the gate alone is what actually stops the request:
 * so the person typing the value finds out immediately, on the form, instead of saving something
 * that silently never delivers and reading "blocked" in a status column later. The gate is the
 * security control; this is the error message. Same two-layer split as
 * services/ai-chat-guardrails.ts's "a tool is filtered twice" — the cheap early check exists to
 * make the expensive real one legible, and neither is load-bearing alone.
 *
 * `maxLength` is passed through rather than fixed because the existing columns differ (300 for
 * the AI base URL, 500 for the Google Chat webhook) and a validator that silently widened a
 * database column's limit would move the failure to the INSERT.
 */
export function egressUrl(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .superRefine((value, ctx) => {
      const problem = egressUrlProblem(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `URL ${problem}.` });
    });
}

/**
 * The real gate: everything `egressUrlProblem` checks, plus DNS resolution of the hostname with
 * every returned address required to be public. Call this immediately before `fetch`.
 *
 * Throws `AppError(422)` rather than returning false so a misconfigured integration surfaces as a
 * readable message on the admin's own screen, and so a caller cannot forget to check a boolean.
 *
 * A hostname that does not resolve at all is REFUSED here rather than passed through to `fetch`:
 * "I could not verify where this points" is not a reason to send the request anyway.
 */
export async function assertPublicEgressTarget(raw: string, label = "This URL"): Promise<URL> {
  const problem = egressUrlProblem(raw);
  if (problem) throw new AppError(422, `${label} ${problem}.`);

  const url = new URL(raw);
  if (privateEgressAllowed()) return url;

  // `unbracket` for the same reason as isBlockedAddress: a URL yields `[::1]`, not `::1`, and
  // without it a bracketed literal is not recognised as an IP and gets sent to a DNS lookup that
  // can only fail.
  const hostname = unbracket(url.hostname.toLowerCase());
  // Already an IP literal — `egressUrlProblem` checked it, and there is nothing to resolve.
  if (net.isIP(hostname)) return url;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(422, `${label} points at "${hostname}", which could not be resolved.`);
  }
  if (addresses.length === 0) {
    throw new AppError(422, `${label} points at "${hostname}", which resolved to no addresses.`);
  }

  // EVERY address, not the first: a name with one public and one loopback record would otherwise
  // pass this check and then connect to whichever the resolver handed `fetch`.
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked) {
    throw new AppError(
      422,
      `${label} points at "${hostname}", which resolves to the private or loopback address ${blocked.address}. ` +
        `Set ALLOW_PRIVATE_NETWORK_EGRESS=true only if this server is meant to reach internal hosts.`
    );
  }
  return url;
}
