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
