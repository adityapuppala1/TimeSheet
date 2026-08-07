/**
 * Replay protection for inbound webhooks: a bounded, TTL'd set of delivery ids that have already
 * been acted on. Also backs the one non-webhook single-use token in the app — the GitHub OAuth
 * connect `state`'s `jti` (services/git-provider.service.ts) — which wants exactly this contract
 * ("record an id, tell me whether it was already recorded") and should not get a second
 * implementation of it.
 *
 * WHY IT'S NEEDED AT ALL: an HMAC signature proves a body came from someone holding the secret.
 * It says nothing about WHEN, so a delivery captured once (a proxy log, a CI artifact, a
 * mis-scoped APM trace) stays valid forever. For `pull_request:opened` that is not a cosmetic
 * problem — replaying it re-runs the AI summary and posts another review to GitHub, on somebody
 * else's schedule and somebody else's budget.
 *
 * WHERE IT IS A REAL BOUNDARY: only where the credential does NOT transit with the request.
 * GitHub / Gitea / Forgejo / Bitbucket sign the body with a secret that never leaves the server,
 * so a captured delivery is a replayable *message* and nothing more — deduping it closes the
 * hole. Where the shared secret IS the request (GitLab's `X-Gitlab-Token`, Azure DevOps' basic
 * auth / `?token=`, the static bearers on devops-webhook and SCIM), whoever captured a delivery
 * also captured the credential and can mint fresh, never-before-seen requests at will; a nonce
 * store there is theatre. Those endpoints are covered by secret rotation, not by this module.
 *
 * LIMITATIONS, stated rather than implied:
 * - PER PROCESS. Two Node processes behind a load balancer keep independent sets, so a delivery
 *   replayed against the other process is not caught, and a restart forgets everything. A
 *   schema-backed table would fix both; it is deliberately not built, because this app runs as a
 *   single Node process (see the database-per-organization note in the root README) and a table
 *   with a row per webhook delivery is a real write-amplification cost for a guarantee nothing
 *   currently needs.
 * - BOUNDED. Past `MAX_ENTRIES` the oldest ids are dropped, so an attacker who can flood the
 *   endpoint with fresh signed deliveries could evict a specific id and then replay it. Flooding
 *   with valid signatures already requires the secret, at which point replay is the least of it.
 *   The OAuth-state nonces share that cap, so the same flood could in principle evict one and
 *   reopen a single state for the rest of its 10 minutes — still gated on holding a webhook
 *   secret, and still narrower than the unlimited replay it replaced.
 * - TTL'd. A capture replayed after `TTL_MS` is not caught. The window is the trade between
 *   memory and coverage, not a claim that older captures are harmless.
 */

/** 24h: long enough that a delivery captured and replayed in the same operational window is
 *  rejected, short enough that the set stays small on a busy repo. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** ~1MB of keys at the sizes providers actually use (UUIDs). */
const MAX_ENTRIES = 10_000;

/** Insertion-ordered, which is what makes "drop the oldest" a single `keys().next()`. */
const seen = new Map<string, number>();

function purgeExpired(now: number): void {
  for (const [key, expiresAt] of seen) {
    // Entries are inserted with a constant TTL, so insertion order IS expiry order: the first
    // key that is still live means every key after it is too.
    if (expiresAt > now) break;
    seen.delete(key);
  }
}

/**
 * Records a delivery and reports whether it had already been recorded.
 *
 * `namespace` MUST carry the tenant (and provider) — one process serves every organization, and
 * two tenants' providers can hand out colliding delivery ids.
 *
 * Returns `true` when this exact delivery has been seen inside the TTL, i.e. the caller should
 * refuse to act on it.
 */
export function isReplayedDelivery(namespace: string, deliveryId: string): boolean {
  const key = `${namespace}:${deliveryId}`;
  const now = Date.now();
  purgeExpired(now);

  const existing = seen.get(key);
  if (existing !== undefined && existing > now) return true;

  // Delete-then-set so a re-inserted (previously expired) key moves to the back of the
  // insertion order and purgeExpired's early `break` stays correct.
  seen.delete(key);
  seen.set(key, now + TTL_MS);
  while (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
  return false;
}

/** Test seam — the set is module-level state shared by every test in a file. */
export function resetWebhookReplayStore(): void {
  seen.clear();
}
