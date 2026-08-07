/**
 * WHAT: turns a stored `/uploads/...` path into a short-lived, org-bound capability URL, and
 * verifies one on the way back in. Plus `signFileUrlsDeep`, which applies that transform to a
 * whole outgoing JSON body.
 *
 * WHY IT EXISTS: `/uploads` was an unauthenticated static mount over the storage root. Filenames
 * were `<millisecond timestamp>-<the user's own filename>`, which is a guess, not a secret, and
 * the documents tree has no organization segment — so one tenant's ticket attachment was readable
 * from any tenant's hostname by anyone who never logged in.
 *
 * ── WHY SIGNED URLS RATHER THAN `requireAuth` ON `/uploads` ─────────────────────────────────
 *
 * Two constraints rule out an authenticated route on its own:
 *
 *  1. Attachments are rendered as `<a href>` and `<img src>` (Tickets.tsx, ProofingPanel.tsx,
 *     every avatar in the app). This API authenticates with `Authorization: Bearer` — a header a
 *     browser never attaches to a navigation or an image load — and the refresh cookie is scoped
 *     to `path=/api/auth`, so it isn't sent to `/uploads` either. There is no credential on those
 *     requests to check.
 *  2. `controllers/approval.controller.ts` hands attachment URLs to UNAUTHENTICATED guest
 *     reviewers by design. Any scheme that demands a session breaks that flow outright.
 *
 * So the capability travels in the URL, exactly as an S3 presigned link does: the API mints it
 * only into a response it has already decided the caller is allowed to receive, and it expires.
 * An attacker who cannot obtain a response containing the link cannot construct one, because the
 * signature is an HMAC over (org, path, expiry) they cannot forge. The guest reviewer keeps
 * working with no special case at all — their link is minted into the same JSON the public
 * approval route already returns, which the guest token already gated.
 *
 * ── WHY THE EXPIRY IS BUCKETED ──────────────────────────────────────────────────────────────
 *
 * A signature computed from `Date.now()` produces a different URL on every response, which
 * defeats the browser cache for avatars — the thing rendered dozens of times per page. Rounding
 * the expiry up to the next hour means every response within that hour emits the IDENTICAL URL
 * for the same file, so `Cache-Control: max-age=1d` on the static mounts still does its job. The
 * cost is that the real lifetime of a link is between TTL and TTL + bucket, which for a
 * download link is not a meaningful distinction.
 *
 * WHO calls this: app.ts (the `/api` response signer and the `/uploads` verification gate).
 */
import crypto from "node:crypto";
import { env } from "../config/env.js";

export const UPLOADS_PREFIX = "/uploads/";

/**
 * Derived from the access-token secret rather than being its own env var, deliberately: this key
 * has exactly the same blast radius and the same rotation story as a session, and adding a
 * required variable would make this security fix a deployment change every operator has to make
 * correctly before their attachments work again. The domain separator stops a value signed here
 * from ever being interchangeable with a JWT signature.
 */
const SIGNING_KEY = crypto.createHash("sha256").update(`${env.JWT_ACCESS_SECRET}|timesphere-file-url-v1`).digest();

/**
 * 24h. Long enough that a React Query cache, an open guest-review tab, or a link someone left on
 * a second monitor overnight still resolves; short enough that a URL leaked through a referrer,
 * a proxy log or a forwarded screenshot stops being useful within a day.
 */
const TTL_SECONDS = 24 * 60 * 60;
const BUCKET_SECONDS = 60 * 60;

/** Truncated to 128 bits — full HMAC-SHA256 doubles the URL length for no security anyone can
 *  use, and 128 bits of forgery resistance is not the weak link in this design. */
function digest(orgId: string, key: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(`${orgId}\n${key}\n${expiresAt}`)
    .digest("base64url")
    .slice(0, 22);
}

function bucketedExpiry(nowMs: number): number {
  const now = Math.floor(nowMs / 1000);
  return (Math.floor(now / BUCKET_SECONDS) + 1) * BUCKET_SECONDS + TTL_SECONDS;
}

/** `null` for malformed percent-encoding ("%ZZ") — a shape nothing legitimate produces, and one
 *  that must not become a 500 by letting URIError escape. */
export function decodeFileKey(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Signs one stored URL. Anything that isn't an `/uploads/` path is returned untouched, so this is
 * safe to run over an entire response body without knowing which strings are file references.
 *
 * An existing query string is DROPPED rather than merged: the only thing that puts one there is a
 * previous signing pass, and appending a second `s=` would leave Express reading `req.query.s` as
 * an array and failing every verification.
 */
export function signFileUrl(storedUrl: string, orgId: string, nowMs = Date.now()): string {
  const queryAt = storedUrl.indexOf("?");
  const rawPath = queryAt === -1 ? storedUrl : storedUrl.slice(0, queryAt);
  if (!rawPath.startsWith(UPLOADS_PREFIX)) return storedUrl;

  const key = decodeFileKey(rawPath.slice(UPLOADS_PREFIX.length));
  if (!key) return storedUrl;

  const expiresAt = bucketedExpiry(nowMs);
  return `${rawPath}?o=${encodeURIComponent(orgId)}&e=${expiresAt}&s=${digest(orgId, key, expiresAt)}`;
}

/**
 * Verifies a grant against the DECODED path the request is asking for. Returns the org the link
 * was minted for, or `null` — never a partial answer, because a caller holding an org id will use
 * it for the containment check.
 *
 * Deliberately does no filesystem work: an unsigned request is refused identically whether or not
 * the file exists, so this gate cannot be used to enumerate what is on disk.
 */
export function verifyFileGrant(key: string, query: unknown, nowMs = Date.now()): { orgId: string } | null {
  const params = (query ?? {}) as Record<string, unknown>;
  const orgId = typeof params.o === "string" ? params.o : "";
  const signature = typeof params.s === "string" ? params.s : "";
  const expiresAt = typeof params.e === "string" ? Number(params.e) : Number.NaN;
  if (!orgId || !signature || !Number.isSafeInteger(expiresAt)) return null;
  if (expiresAt * 1000 <= nowMs) return null;

  const expected = digest(orgId, key, expiresAt);
  // Length check first: timingSafeEqual THROWS on a length mismatch rather than returning false,
  // which would turn a truncated signature into a 500.
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { orgId };
}

/** Deep enough for the most nested response this app produces (ticket -> comments -> author ->
 *  avatar); a bound at all is what stops a cyclic structure from being an infinite loop. */
const MAX_DEPTH = 16;

/**
 * Rewrites every `/uploads/...` string in a response body into a signed URL.
 *
 * COPY-ON-WRITE, not in-place mutation: some of what passes through here is cached by the service
 * that produced it, and stamping a signature onto a cached object would serve a stale (eventually
 * expired) link forever. Subtrees containing no file reference are returned by reference, so the
 * overwhelming majority of responses allocate nothing.
 *
 * Only arrays and plain objects are traversed. Dates, Buffers, Decimals and every other class
 * instance are passed through untouched — rebuilding one as a plain object would silently change
 * how it serializes.
 */
export function signFileUrlsDeep<T>(value: T, orgId: string, depth = 0): T {
  if (typeof value === "string") {
    return (value.startsWith(UPLOADS_PREFIX) ? signFileUrl(value, orgId) : value) as T;
  }
  if (!value || typeof value !== "object" || depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const signed = signFileUrlsDeep(entry, orgId, depth + 1);
      if (signed !== entry) changed = true;
      return signed;
    });
    return (changed ? next : value) as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [property, entry] of Object.entries(value as Record<string, unknown>)) {
    const signed = signFileUrlsDeep(entry, orgId, depth + 1);
    if (signed !== entry) changed = true;
    next[property] = signed;
  }
  return (changed ? next : value) as T;
}
