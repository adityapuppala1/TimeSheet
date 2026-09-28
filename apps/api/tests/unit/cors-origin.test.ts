/**
 * Which origins may talk to this API.
 *
 * This is a security control whose failure modes point in both directions, and both were reported by
 * a real user in the same week: too tight, and somebody reaching their own deployment over a public
 * static IP is told "Origin ... not allowed by CORS" at the sign-in screen with no hint what to
 * change; too loose, and any site on the internet can drive a signed-in browser against it.
 *
 * The whole decision is three lines, and every interesting case is a boundary — which is exactly the
 * shape that should be pinned by a test rather than re-read carefully.
 */
import { describe, expect, it } from "vitest";

// From the leaf module rather than from app.ts: the rule has one home now, shared with the boot
// check, and importing it no longer drags in the entire Express app.
const { isOriginAllowed } = await import("../../src/config/origins.js");

const LIST = ["http://localhost:5173", "https://203.0.113.10:5173", "https://timesphere.example.com"];

describe("an explicitly listed origin", () => {
  it("is allowed in development and in production alike", () => {
    for (const dev of [true, false]) {
      expect(isOriginAllowed("https://203.0.113.10:5173", LIST, dev), `dev=${dev}`).toBe(true);
      expect(isOriginAllowed("https://timesphere.example.com", LIST, dev), `dev=${dev}`).toBe(true);
    }
  });

  it("must match the scheme, the host AND the port", () => {
    // A browser treats each of these as a different origin, so this has to as well. Getting it wrong
    // in the lenient direction would let http reach an https-only deployment.
    expect(isOriginAllowed("http://203.0.113.10:5173", LIST, false)).toBe(false);
    expect(isOriginAllowed("https://203.0.113.10:5174", LIST, false)).toBe(false);
    expect(isOriginAllowed("https://203.0.113.11:5173", LIST, false)).toBe(false);
  });
});

describe("the development shortcut for private addresses", () => {
  it("accepts the ranges that cannot be reached from the internet", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://192.168.88.5:5173",
      "http://10.1.2.3:4000",
      "http://172.16.0.9:5173",
      "http://172.31.255.254:5173"
    ]) {
      expect(isOriginAllowed(origin, [], true), origin).toBe(true);
    }
  });

  it("does not treat neighbouring public ranges as private", () => {
    // 172.16–172.31 is the private block; 172.15 and 172.32 are ordinary internet addresses, and an
    // off-by-one here silently opens the API to two /12s worth of strangers.
    expect(isOriginAllowed("http://172.15.0.1:5173", [], true)).toBe(false);
    expect(isOriginAllowed("http://172.32.0.1:5173", [], true)).toBe(false);
    expect(isOriginAllowed("http://11.0.0.1:5173", [], true)).toBe(false);
    expect(isOriginAllowed("http://193.168.1.1:5173", [], true)).toBe(false);
  });

  it("never applies to a public address, even in development", () => {
    // The reported case. A public IP has to be listed; the shortcut is safe only because the ranges
    // it covers are unroutable, and extending it to public addresses would remove the whole control.
    expect(isOriginAllowed("https://183.82.124.162:5173", [], true)).toBe(false);
    expect(isOriginAllowed("https://evil.example.com", [], true)).toBe(false);
  });

  it("is switched off entirely in production", () => {
    expect(isOriginAllowed("https://192.168.88.5:5173", [], false)).toBe(false);
    expect(isOriginAllowed("http://localhost:5173", [], false)).toBe(false);
  });
});

describe("a request with no Origin header", () => {
  it("is allowed, because it is not a cross-origin request at all", () => {
    // curl, server-to-server calls and same-origin form posts send none. Refusing these would break
    // every non-browser caller while protecting nothing: CORS is a browser control.
    expect(isOriginAllowed(undefined, [], false)).toBe(true);
    expect(isOriginAllowed("", [], false)).toBe(true);
  });
});

/**
 * WORKSPACE ORIGINS — the case a comma-separated list cannot express.
 *
 * WHAT BROKE, in a browser, on this machine. Every workspace is served at its own hostname, and a
 * browser treats each as a separate origin — so `acme.example.com` sends
 * `Origin: https://acme.example.com` on every POST even though the request is same-origin from the
 * page's point of view. `WEB_ORIGIN` is fixed at deploy time, so CORS refused every workspace nobody
 * had hand-listed. The shape of the failure is what made it confusing: a same-origin GET sends no
 * `Origin` header at all, so the login page RENDERED correctly, fetched its branding and its SSO
 * buttons, and then refused the sign-in with a message about an allow-list.
 *
 * Reproduced before the fix: POST with `Origin: https://acme.localhost:5173` → 403, while
 * `https://localhost:5173` and a LAN IP → 401 (i.e. reached the handler).
 */
describe("workspace subdomains of ROOT_DOMAIN", () => {
  const PROD = ["https://timesphere.app"];

  it("accepts any workspace under the configured root, without listing one of them", () => {
    // The whole point: a deployment cannot enumerate its customers, and must not have to.
    for (const slug of ["acme", "globex", "a-very-long-hyphenated-name"]) {
      expect(isOriginAllowed(`https://${slug}.timesphere.app`, PROD, false, "timesphere.app"), slug).toBe(true);
    }
  });

  it("refuses them when no ROOT_DOMAIN is configured", () => {
    // A single-org deployment gains nothing here and should keep exactly the behaviour it had.
    expect(isOriginAllowed("https://acme.timesphere.app", PROD, false, undefined)).toBe(false);
    expect(isOriginAllowed("https://acme.timesphere.app", PROD, false, "")).toBe(false);
  });

  it("will not accept a different domain that merely ENDS with the root's letters", () => {
    // The leading dot in the suffix check. Without it `nottimesphere.app` matches as a string and a
    // domain belonging to somebody else is trusted as one of this deployment's own pages.
    expect(isOriginAllowed("https://nottimesphere.app", PROD, false, "timesphere.app")).toBe(false);
    expect(isOriginAllowed("https://acme.nottimesphere.app", PROD, false, "timesphere.app")).toBe(false);
    expect(isOriginAllowed("https://timesphere.app.evil.com", PROD, false, "timesphere.app")).toBe(false);
  });

  it("holds the transport fixed while the subdomain floats", () => {
    /**
     * THE SECURITY BOUNDARY OF THIS RULE. The subdomain is what varies; the scheme and port must
     * still match something the operator actually wrote in WEB_ORIGIN. Without that, an https
     * deployment would also trust `http://acme.timesphere.app`, and a network attacker who can
     * answer plain HTTP gets an origin the API believes.
     */
    expect(isOriginAllowed("http://acme.timesphere.app", PROD, false, "timesphere.app")).toBe(false);
    expect(isOriginAllowed("https://acme.timesphere.app:8443", PROD, false, "timesphere.app")).toBe(false);

    // ...and it follows the list rather than hardcoding https: a deployment listed on http:8080
    // accepts its own workspaces on http:8080 and nothing else.
    const LAN = ["http://timesphere.internal:8080"];
    expect(isOriginAllowed("http://acme.timesphere.internal:8080", LAN, false, "timesphere.internal")).toBe(true);
    expect(isOriginAllowed("https://acme.timesphere.internal:8080", LAN, false, "timesphere.internal")).toBe(false);
    expect(isOriginAllowed("http://acme.timesphere.internal:9090", LAN, false, "timesphere.internal")).toBe(false);
  });

  it("does not let an empty allow-list become a wildcard", () => {
    // With nothing listed there is no scheme/port to match, so nothing matches. A rule that opened
    // up when the operator configured less would be the wrong way round.
    expect(isOriginAllowed("https://acme.timesphere.app", [], false, "timesphere.app")).toBe(false);
  });

  it("ignores a malformed origin instead of throwing", () => {
    // `Origin` is caller-supplied, so this is reachable from the network on every request.
    for (const junk of ["not a url", "://", "https://", "javascript:alert(1)"]) {
      expect(isOriginAllowed(junk, PROD, false, "timesphere.app"), junk).toBe(false);
    }
  });
});

describe("*.localhost in development", () => {
  it("accepts a workspace subdomain of localhost, which is how a second tenant is tested", () => {
    // Browsers resolve every *.localhost name to loopback with no hosts entry (RFC 6761), so this
    // is exactly as safe as the bare `localhost` the shortcut already accepted — and it is the
    // address docs/DEPLOYMENT.md tells people to browse.
    expect(isOriginAllowed("https://acme.localhost:5173", [], true)).toBe(true);
    expect(isOriginAllowed("http://default.localhost:5173", [], true)).toBe(true);
    expect(isOriginAllowed("https://localhost:5173", [], true)).toBe(true);
  });

  it("still refuses them in production, like every other development shortcut", () => {
    expect(isOriginAllowed("https://acme.localhost:5173", [], false)).toBe(false);
  });

  it("does not let a public domain smuggle itself in by ending with the word", () => {
    // `evil.com.localhost` IS under .localhost and is fine; `localhost.evil.com` is not, and the
    // anchored pattern is what tells them apart.
    expect(isOriginAllowed("https://localhost.evil.com", [], true)).toBe(false);
    expect(isOriginAllowed("https://notlocalhost", [], true)).toBe(false);
  });
});

/**
 * VERIFIED CUSTOM DOMAINS — a workspace on `time.acme.com` rather than under ROOT_DOMAIN.
 *
 * The last origin a static list cannot hold, and the one that appears AFTER the process started:
 * an operator verifies a customer's domain in the platform console, and that workspace's login page
 * then renders perfectly and cannot sign anybody in. Same silent shape as the two before it.
 *
 * The predicate is injected rather than imported so this module stays pure — the cache that answers
 * it lives in config/custom-domain-origins.ts and is refreshed when a domain is verified or removed.
 */
describe("verified custom domains", () => {
  const PROD = ["https://timesphere.app"];
  const verified = (...hosts: string[]) => (h: string) => hosts.includes(h.toLowerCase());

  it("accepts a domain the control plane has verified", () => {
    expect(isOriginAllowed("https://time.acme.com", PROD, false, "timesphere.app", verified("time.acme.com"))).toBe(true);
  });

  it("refuses one it has not", () => {
    // Verification is a DNS TXT record the customer publishes. An unverified row is a claim.
    expect(isOriginAllowed("https://time.evil.com", PROD, false, "timesphere.app", verified("time.acme.com"))).toBe(false);
  });

  it("refuses everything when no predicate is supplied, which is every single-org install", () => {
    expect(isOriginAllowed("https://time.acme.com", PROD, false, "timesphere.app")).toBe(false);
  });

  it("holds the transport fixed here too", () => {
    // Same boundary as the ROOT_DOMAIN rule: the HOST is what verification vouches for, never the
    // scheme. An https deployment must not start trusting a plain-http origin.
    const isTime = verified("time.acme.com");
    expect(isOriginAllowed("http://time.acme.com", PROD, false, "timesphere.app", isTime)).toBe(false);
    expect(isOriginAllowed("https://time.acme.com:8443", PROD, false, "timesphere.app", isTime)).toBe(false);
  });

  it("matches case-insensitively, because a hostname is", () => {
    expect(isOriginAllowed("https://TIME.Acme.COM", PROD, false, undefined, verified("time.acme.com"))).toBe(true);
  });

  it("works with no ROOT_DOMAIN at all — a single-org deployment can still have one custom domain", () => {
    expect(isOriginAllowed("https://time.acme.com", PROD, false, undefined, verified("time.acme.com"))).toBe(true);
  });
});
