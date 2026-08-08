/**
 * WHAT: the throttle every router that can reach a model mounts.
 *
 * WHY IT IS NOT JUST THE DEFAULT LIMITER: express-rate-limit buckets on `req.ip` unless told
 * otherwise, and for AI routes that is the wrong axis twice over. An office behind one NAT shares
 * a single 20/min allowance between everybody in it, so the limit fires on legitimate use; and one
 * person on a phone, a laptop and a VPN gets three allowances, so it does not fire on the case it
 * exists for. Spend is attributable to a USER — `AIUsageLog.userId` is what the usage panel breaks
 * down by — so that is what the bucket is keyed on.
 *
 * IP REMAINS THE FALLBACK for a request that somehow arrives unauthenticated: every router using
 * this mounts `requireAuth` first, so that branch should be unreachable, but a limiter that
 * silently degrades to "one shared global bucket" when `req.user` is missing would be worse than
 * one that keeps counting per address. `ipKeyGenerator` is not exported by this version of
 * express-rate-limit, so the address is normalised here — an IPv6 client gets a /64 bucket rather
 * than a fresh allowance per address in its prefix.
 *
 * WHO USES THIS: `controllers/ai.controller.ts` and `controllers/ai-proposal.controller.ts`. The
 * budget cap in `services/ai.service.ts#preflight` bounds what a workspace can SPEND in a month;
 * this bounds how fast one account can spend it.
 */
import rateLimit from "express-rate-limit";
import type { Request } from "express";

/** Shared by both AI routers so a second router can't quietly run looser than the first. */
const AI_REQUESTS_PER_MINUTE = 20;

function ipBucket(req: Request): string {
  const ip = req.ip ?? "unknown";
  if (!ip.includes(":")) return `ip:${ip}`;
  // IPv6: collapse to the /64 an ISP hands a single subscriber, so rotating within it buys nothing.
  return `ip6:${ip.split(":").slice(0, 4).join(":")}`;
}

export const aiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: AI_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  keyGenerator: (req: Request) => (req.user ? `user:${req.user.id}` : ipBucket(req))
});

/**
 * The same idea for `/api/mcp`, which had no per-caller throttle at all.
 *
 * WHY IT NEEDED ITS OWN: an MCP credential is a bearer token carrying one person's full authority,
 * handed to a language model that decides for itself how many calls to make. `app.ts` mounts a
 * plain 120/min limiter in front of the router, but that one keys on `req.ip` — the exact axis the
 * comment at the top of this file explains is wrong, and wrong here for a third reason too: an
 * agent runs from wherever it is hosted, so every credential pointed at the same hosted assistant
 * shares one bucket while a self-hosted one gets its own.
 *
 * WHY IT IS KEYED ON THE CREDENTIAL AND NOT THE USER: a person may hold several credentials — one
 * per client — and revoking a misbehaving one should be enough. Keying on the user would mean a
 * runaway agent throttling that person's other, well-behaved clients, and would make "which
 * credential is doing this" unanswerable from the limiter's own behaviour.
 *
 * MUST BE MOUNTED AFTER `mcpAuth`, because `req.mcp` does not exist before it. That ordering is
 * the reason this could not simply be added to the existing mount in app.ts.
 *
 * The limit is higher than the AI one on purpose: these are ordinary reads against the database,
 * not model calls, and a tool-using agent legitimately makes several in a row while working
 * through one request. Spend is still bounded by the monthly budget, which this does not replace.
 */
const MCP_REQUESTS_PER_MINUTE = 120;

export const mcpRateLimit = rateLimit({
  windowMs: 60_000,
  limit: MCP_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  keyGenerator: (req: Request) => {
    const credentialId = (req as Request & { mcp?: { credentialId?: string } }).mcp?.credentialId;
    return credentialId ? `mcp:${credentialId}` : ipBucket(req);
  }
});
