/**
 * Where to send somebody after they sign in.
 *
 * WHAT WAS WRONG. Two halves of the same missing idea:
 *
 *  1. A protected route bounced an unauthenticated visitor to `/login` and threw away where they
 *     were going. Opening a link to a specific ticket, signing in, and landing on the dashboard
 *     instead is the most common single complaint about home-grown auth, and it is entirely
 *     self-inflicted: the destination was known at the moment of the redirect and simply not kept.
 *
 *  2. `/login` had no inverse guard at all, so an already-signed-in person was shown the form again
 *     and had to re-enter a password to reach a session they already held.
 *
 * WHY A `next` PARAM AND NOT SESSION STORAGE: it survives a full page load and a new tab, it is
 * visible and therefore debuggable, and it is what every OAuth flow in this app already does with
 * its own state. The cost is that it is attacker-controllable, which is what `safeReturnTo` below
 * is for.
 */

const FALLBACK = "/app";

/**
 * Sanitises a `next` value into a path this app will actually navigate to.
 *
 * THIS IS AN OPEN-REDIRECT GUARD, and it is the only reason this file is not two inline lines.
 * `?next=` is written by whoever crafted the link, so `/login?next=https://evil.example/harvest`
 * would otherwise hand a freshly-authenticated person to an attacker's page — with the referrer,
 * and with every appearance of having been sent there by us. That is the classic post-login
 * phishing pivot, and it is graded as a real vulnerability precisely because the victim has just
 * proven they trust the site.
 *
 * The rules, each closing a specific bypass:
 *  - must start with a single `/`  — rejects `https://evil.example` and `javascript:alert(1)`
 *  - must NOT start with `//`      — rejects `//evil.example`, which browsers read as protocol-relative
 *  - must NOT start with `/\`      — same trick with a backslash, which some parsers normalise to `/`
 *  - must not be an auth page      — bouncing back to `/login` after signing in is a loop
 *
 * Anything that fails becomes `/app`. Silently: a rejected `next` is either an attack or a typo,
 * and neither is worth an error message to the person who just signed in.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return FALLBACK;
  let value: string;
  try {
    // A `next` that arrived encoded, which is how it is written. Decoding can throw on a malformed
    // sequence, which is itself a good enough reason to fall back.
    value = decodeURIComponent(raw);
  } catch {
    return FALLBACK;
  }

  if (!value.startsWith("/")) return FALLBACK;
  if (value.startsWith("//") || value.startsWith("/\\")) return FALLBACK;

  const path = value.split("?")[0].split("#")[0];
  if (AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return FALLBACK;

  return value;
}

/** The pages a signed-in person has no reason to be on. Kept here so the guard and the sanitiser
 *  cannot disagree about what counts as one. */
export const AUTH_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password", "/find-workspace"] as const;

/** Builds the `/login?next=…` a protected route should redirect to, preserving query and hash so a
 *  deep link into a filtered view comes back filtered. */
export function loginUrlFor(location: { pathname: string; search: string; hash: string }): string {
  const target = `${location.pathname}${location.search}${location.hash}`;
  if (target === "/app" || target === "/app/") return "/login";
  return `/login?next=${encodeURIComponent(target)}`;
}
