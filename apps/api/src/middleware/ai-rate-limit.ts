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
