/**
 * WHAT: proves that the address people are told to use actually reaches THIS deployment.
 *
 * WHY IT EXISTS: a user reported "Origin ... not allowed by CORS" when signing in over their public
 * static IP. Two rounds of fixes went into this machine's config — the allow-list, the certificate,
 * the emailed-link base — and none of them could ever have helped, because port 5173 on that public
 * address is forwarded to a DIFFERENT machine on the same LAN running an older build. Every test that
 * "passed" had been aimed at localhost.
 *
 * The mistake is easy to repeat and hard to see: an IP that answers on port 5173 with a TimeSphere
 * login page looks exactly like your own deployment. What distinguishes them is the build behind it.
 *
 * WHAT IT CHECKS, in the order the answers matter:
 *   1. Does the address answer at all?
 *   2. Is the thing answering THIS build — same version and git sha as the local server?
 *   3. Does it accept its own origin, i.e. is WEB_ORIGIN right on whatever machine that is?
 *   4. Does the TLS certificate it serves cover the address people type?
 *
 * USAGE:  npx tsx scripts/check-public-reachability.ts https://203.0.113.10:5173
 *         (defaults to APP_BASE_URL when no argument is given)
 */
import { X509Certificate } from "node:crypto";
import { connect } from "node:tls";
import { env } from "../src/config/env.js";

// The dev certificate is self-signed, and this script's job is to REPORT on it rather than to trust
// it. Scoped to this process only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const target = (process.argv[2] ?? env.APP_BASE_URL).replace(/\/$/, "");
const local = `http://localhost:${env.API_PORT ?? 4000}`;

const say = (ok: boolean | null, line: string) => console.log(`${ok === null ? "  ?" : ok ? "  OK" : "FAIL"}  ${line}`);

async function json(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    return await res.json().catch(() => ({ _status: res.status }));
  } catch {
    return null;
  }
}

/** The certificate the address actually serves, and whether it covers the host being typed. */
async function certificateFor(url: URL): Promise<{ subject: string; sans: string; covers: boolean } | null> {
  if (url.protocol !== "https:") return null;
  return new Promise((resolve) => {
    const socket = connect(
      { host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: false, timeout: 10_000 },
      () => {
        const raw = socket.getPeerX509Certificate?.();
        socket.end();
        if (!raw) return resolve(null);
        const cert = raw as X509Certificate;
        const sans = cert.subjectAltName ?? "";
        // An IP literal appears as `IP Address:1.2.3.4`, a name as `DNS:example.com`.
        const covers = sans.includes(`IP Address:${url.hostname}`) || sans.includes(`DNS:${url.hostname}`);
        resolve({ subject: cert.subject.replace(/\n/g, " "), sans, covers });
      }
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

console.log(`\nChecking that ${target} reaches THIS deployment\n`);

const mine = await json(`${local}/api/system/version`);
if (!mine) {
  console.log("Could not read the local server's version — start it first (npm run dev).\n");
  process.exit(1);
}
console.log(`  this machine is ${mine.version} (${String(mine.gitSha).slice(0, 12)})\n`);

const theirs = await json(`${target}/api/system/version`);
say(Boolean(theirs), theirs ? `${target} answers` : `${target} did not answer — check the port forward and any firewall`);

let sameBuild = false;
if (theirs) {
  sameBuild = theirs.version === mine.version && theirs.gitSha === mine.gitSha;
  say(
    sameBuild,
    sameBuild
      ? `it is this same build`
      : `it is a DIFFERENT deployment: ${theirs.version} (${String(theirs.gitSha).slice(0, 12)}). Nothing you change here affects it — repoint the forward, or apply the change on that machine.`
  );
}

if (theirs) {
  // Its own origin is the one a browser sends when somebody opens that address.
  const cors = await json(`${target}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: target },
    body: JSON.stringify({ email: "reachability@check.invalid", password: "not-a-real-password" })
  });
  const rejected = typeof cors?.message === "string" && /not allowed by CORS|not in this server/i.test(cors.message);
  say(!rejected, rejected ? `it refuses its own origin — add ${target} to WEB_ORIGIN on the machine serving it` : "it accepts its own origin");
}

const url = new URL(target);
const cert = await certificateFor(url);
if (cert) {
  say(cert.covers, cert.covers ? "the certificate covers this address" : `the certificate does NOT cover ${url.hostname} — browsers will warn about a name mismatch`);
  console.log(`      served by: ${cert.subject}`);
  console.log(`      covers:    ${cert.sans}`);
} else if (url.protocol === "https:") {
  say(null, "could not read the certificate");
}

console.log(
  `\nA self-signed certificate on a bare IP can never be trusted by an outside browser: public CAs do\n` +
    `not issue for IP addresses. For a real padlock, put a DNS name in front and use a public CA.\n`
);
process.exit(0);
