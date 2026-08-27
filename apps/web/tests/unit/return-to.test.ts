/**
 * `safeReturnTo` is an open-redirect guard, so it is tested the way one should be: mostly with the
 * inputs an attacker would try, not the ones a user produces.
 *
 * WHY THIS MATTERS MORE THAN ITS SIZE SUGGESTS. The value comes off the URL of the sign-in page,
 * and it is consumed at the exact moment somebody has just proven they trust this site. An
 * unchecked `next` hands a freshly-authenticated person to an attacker's page, with a referrer that
 * says we sent them. That is the classic post-login phishing pivot, and every one of the bypasses
 * below is a real technique rather than a hypothetical: browsers genuinely read `//host` as
 * protocol-relative, and enough parsers normalise a backslash to a slash that `/\host` is worth
 * refusing on its own.
 */
import { describe, expect, it } from "vitest";
import { loginUrlFor, safeReturnTo } from "../../src/utils/return-to";

describe("safeReturnTo — what it allows", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safeReturnTo("/app/tickets")).toBe("/app/tickets");
  });

  it("keeps the query and hash, so a deep link into a filtered view comes back filtered", () => {
    expect(safeReturnTo("/app/tickets?status=open&sort=due#row-12")).toBe("/app/tickets?status=open&sort=due#row-12");
  });

  it("accepts the encoded form, which is how it actually arrives", () => {
    expect(safeReturnTo(encodeURIComponent("/app/reports?from=2026-01-01"))).toBe("/app/reports?from=2026-01-01");
  });
});

describe("safeReturnTo — what it refuses", () => {
  const FALLBACK = "/app";

  it("refuses an absolute URL to another origin", () => {
    expect(safeReturnTo("https://evil.example/harvest")).toBe(FALLBACK);
    expect(safeReturnTo("http://evil.example")).toBe(FALLBACK);
  });

  it("refuses a protocol-relative URL, which browsers treat as cross-origin", () => {
    // The one most often missed: it starts with "/", so a naive `startsWith("/")` check passes it.
    expect(safeReturnTo("//evil.example/harvest")).toBe(FALLBACK);
  });

  it("refuses the backslash variant of the same trick", () => {
    expect(safeReturnTo("/\\evil.example")).toBe(FALLBACK);
  });

  it("refuses a javascript: payload", () => {
    expect(safeReturnTo("javascript:alert(document.cookie)")).toBe(FALLBACK);
  });

  it("refuses a malformed encoding rather than throwing", () => {
    // `decodeURIComponent("%")` throws. A guard that throws on hostile input is a denial of the
    // sign-in page, not a defence.
    expect(safeReturnTo("%")).toBe(FALLBACK);
    expect(safeReturnTo("%E0%A4%A")).toBe(FALLBACK);
  });

  it("refuses a return to an auth page, which would be a loop", () => {
    expect(safeReturnTo("/login")).toBe(FALLBACK);
    expect(safeReturnTo("/login?next=%2Flogin")).toBe(FALLBACK);
    expect(safeReturnTo("/signup")).toBe(FALLBACK);
    expect(safeReturnTo("/find-workspace")).toBe(FALLBACK);
  });

  it("falls back on nothing at all", () => {
    expect(safeReturnTo(null)).toBe(FALLBACK);
    expect(safeReturnTo(undefined)).toBe(FALLBACK);
    expect(safeReturnTo("")).toBe(FALLBACK);
  });

  it("does not refuse a legitimate path that merely CONTAINS an auth word", () => {
    // The check is on the path segment, not a substring — a real route could plausibly be named
    // this, and refusing it would be a silent, baffling redirect.
    expect(safeReturnTo("/app/settings/login-methods")).toBe("/app/settings/login-methods");
  });
});

describe("loginUrlFor", () => {
  it("carries the whole destination", () => {
    expect(loginUrlFor({ pathname: "/app/tickets", search: "?status=open", hash: "#r1" })).toBe(
      `/login?next=${encodeURIComponent("/app/tickets?status=open#r1")}`
    );
  });

  it("omits the param for the default destination, so the common URL stays clean", () => {
    expect(loginUrlFor({ pathname: "/app", search: "", hash: "" })).toBe("/login");
  });

  it("round-trips through safeReturnTo", () => {
    const target = { pathname: "/app/reports", search: "?from=2026-01-01&to=2026-01-31", hash: "" };
    const next = new URL(loginUrlFor(target), "https://x.test").searchParams.get("next");
    expect(safeReturnTo(next)).toBe("/app/reports?from=2026-01-01&to=2026-01-31");
  });
});
