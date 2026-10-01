/**
 * WHAT: how the public signup routes are mounted and rate-limited — one function app.ts calls, so the
 * test drives the real wiring rather than a copy of it (tests/unit/signup-limits.test.ts).
 *
 * TWO BUDGETS, BY WHAT A REQUEST COSTS (signup Phase 1). Signup became a 3-to-6-request flow — start,
 * verify, then complete or join, plus a corrected address or a "verify again" — and the join path is,
 * by design, several colleagues behind one office network. One 5-an-hour budget across all of it
 * answered 429 in the middle of an ordinary signup and blamed "this network".
 *  - `/start` SENDS AN EMAIL, so it keeps the tight budget: five codes an hour per network.
 *  - `/verify`, `/complete` and `/join` each need something `/start` already paid for — a token whose
 *    code allows five guesses, or a single-use continuation — so they cannot mint work on their own.
 *    They share a looser budget sized for a whole office finishing the longest designed path.
 * `/status` is outside both: the landing page asks on every visit.
 */
import type { Express, RequestHandler, Router } from "express";
import rateLimit from "express-rate-limit";

const HOUR_MS = 60 * 60_000;
export const SIGNUP_CODE_LIMIT_PER_HOUR = 5;
export const SIGNUP_STEP_LIMIT_PER_HOUR = 30;

export function mountSignupRoutes(app: Express, parts: { router: Router; statusHandler: RequestHandler }): void {
  const statusLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true });
  const codeLimiter = rateLimit({
    windowMs: HOUR_MS,
    limit: SIGNUP_CODE_LIMIT_PER_HOUR,
    standardHeaders: true,
    message: { message: "Too many verification codes from this network in the last hour. Wait a while and try again." }
  });
  const stepLimiter = rateLimit({
    windowMs: HOUR_MS,
    limit: SIGNUP_STEP_LIMIT_PER_HOUR,
    standardHeaders: true,
    // `/start` has its own budget; counting it here too would also overwrite its RateLimit headers
    // with this looser limit, and a client reading them would be told the wrong number.
    skip: (req) => req.path === "/start",
    message: { message: "Too many signup attempts from this network in the last hour. Wait a while and try again." }
  });

  // Registered BEFORE the router so it never reaches either budget.
  app.get("/api/signup/status", statusLimiter, parts.statusHandler);
  // Only the step that sends mail. The step budget below skips it.
  app.use("/api/signup/start", codeLimiter);
  app.use("/api/signup", stepLimiter, parts.router);
}
