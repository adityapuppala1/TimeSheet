/**
 * WHAT: the per-IP limiter on the two unauthenticated routes that send mail to an address the
 * caller types — `/api/auth/forgot-password` and the workspace finder's `/api/auth/workspaces/start`.
 * One function app.ts calls, so the test drives the real wiring (tests/unit/auth-limits.test.ts).
 *
 * WHY THEY ARE NOT ON THE LOGIN LIMITER ANY MORE (security audit #5). That limiter skips successful
 * requests, which is right for a password guesser, who only ever produces failures. These two routes
 * ALWAYS answer 202 — that is what keeps them from saying whether an address exists — and
 * express-rate-limit counts anything under 400 as a success. So not one request to either was ever
 * counted, and the only ceiling left was the global 900/min/IP: enough to mail-bomb an inbox and to
 * fill the token tables. Here every request counts.
 *
 * ONE BUDGET PER ROUTE, so a person hunting for their workspace address does not use up their own
 * password reset. The per-ADDRESS cap (three mails an hour) is a different control, held in the
 * database every replica shares — see auth.service.ts#requestPasswordReset and
 * auth.controller.ts's `/workspaces/start`. This one bounds what a single network can make the
 * server do; that one bounds what any number of networks can send to one inbox.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";

export const MAIL_ROUTE_WINDOW_MS = 15 * 60_000;
/** Ten in fifteen minutes per IP: room for an office behind one NAT where a few people forget
 *  their password the same morning, and nowhere near enough to bomb anyone. */
export const FORGOT_PASSWORD_LIMIT_PER_WINDOW = 10;
/** Sixty for the finder, because on a multi-org deployment it is not an occasional route: the apex
 *  `/login` sends everybody to `/find-workspace` (Login.tsx), so EVERY apex sign-in is one request
 *  here, and ten throttled the eleventh person in an office behind one NAT (review R1-4). The
 *  three-codes-an-hour cap per ADDRESS is what stops an inbox being bombed; this only bounds what
 *  one network can make the server do. */
export const WORKSPACE_FINDER_LIMIT_PER_WINDOW = 60;

const MAIL_ROUTE_LIMITS: ReadonlyArray<[path: string, limit: number]> = [
  ["/api/auth/forgot-password", FORGOT_PASSWORD_LIMIT_PER_WINDOW],
  ["/api/auth/workspaces/start", WORKSPACE_FINDER_LIMIT_PER_WINDOW]
];

export function mountMailRouteLimiters(app: Express): void {
  for (const [path, limit] of MAIL_ROUTE_LIMITS) {
    app.use(
      path,
      rateLimit({
        windowMs: MAIL_ROUTE_WINDOW_MS,
        limit,
        standardHeaders: true,
        message: { message: "Too many requests from this network. Wait a few minutes and try again." }
      })
    );
  }
}
