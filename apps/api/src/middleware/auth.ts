/**
 * WHAT: tenant-side auth middleware — `requireAuth` (verifies the access JWT and attaches
 * `req.user`), plus `requirePermission`/`requireRole`/`requireSuperAdmin` for authorization
 * once `req.user` exists.
 * WHY: every tenant route needs the same three checks (valid token, session not revoked, org
 * claim matches the resolved tenant) — centralizing them here means a controller just declares
 * `requireAuth` and never re-implements token verification itself.
 * HOW: reads the `Authorization: Bearer` header, verifies it against `JWT_ACCESS_SECRET`
 * (utils/security.ts), cross-checks the `org` claim against `tenant-context.ts`'s resolved org,
 * and (if the token carries a session id) confirms that specific Session row hasn't been
 * revoked — this is what makes single-device logout take effect immediately rather than
 * waiting for the access token to expire on its own.
 * WHO calls this: every authenticated route in every controller (`app.ts` doesn't apply it
 * globally — each router opts in), and `requireSuperAdmin` specifically gates admin-only
 * settings endpoints.
 */
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { verifyAccessToken } from "../utils/security.js";
import { isMaintenanceActive } from "../services/maintenance.service.js";
import { AppError } from "./error.js";

/** Session-id -> last lastSeenAt write, for the liveness throttle below. In-memory is correct
 *  here: losing it on restart merely causes one extra UPDATE per live session, and sharing it
 *  across instances would defeat the point of avoiding writes. */
const lastSeenWrites = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Swept on write, because an entry is worthless the moment it is older than the throttle window
 * — the next request for that session writes regardless — while the map itself kept every
 * session id the process had ever seen, for the life of the process. Long-lived deployments
 * accumulate one entry per session ever authenticated: not a leak, just an unbounded map.
 *
 * No timer, and no per-entry timer least of all: entries are (re)inserted with a constant TTL, so
 * insertion order IS expiry order and the first live key ends the scan. The delete-then-set in
 * the caller is what keeps that invariant true when an existing session is refreshed.
 */
function purgeStaleLastSeen(now: number) {
  for (const [sid, writtenAt] of lastSeenWrites) {
    if (writtenAt + LAST_SEEN_THROTTLE_MS > now) break;
    lastSeenWrites.delete(sid);
  }
}

/** Test-only: the sweep is invisible in any response, so pin it on the size directly. */
export function __lastSeenTrackerSizeForTests() {
  return lastSeenWrites.size;
}

/** Test-only: module state shared by every test in a file. */
export function __resetLastSeenTrackerForTests() {
  lastSeenWrites.clear();
}

export interface RequestUser {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: RequestUser;
      /** The access token's session id, when present (see utils/security.ts#AccessTokenPayload). */
      sessionId?: string;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError(401, "Authentication required");

  let payload: { sub?: unknown; sid?: unknown; org?: unknown };
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new AppError(401, "Session expired");
  }

  // Validate sub is a UUID before sending to Prisma — otherwise a forged token
  // with `sub: "garbage"` triggers a Prisma error → uncaught 500 leak.
  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) {
    throw new AppError(401, "Invalid session");
  }

  // Cross-check the token's org claim against whichever tenant this request actually
  // resolved to (middleware/tenant.ts, already run by this point). Every org currently
  // shares one JWT_ACCESS_SECRET, so without this check a token minted under one org would
  // still verify successfully if presented against another — in practice `sub` almost
  // certainly wouldn't resolve to a real user in a different org's database (UUIDs are
  // effectively globally unique), but this makes that failure explicit and immediate rather
  // than relying on that coincidence. Tokens minted before this claim existed have no `org`
  // and skip the check, same backward-compatibility pattern as the `sid` check below.
  if (typeof payload.org === "string" && payload.org !== requireTenantContext().orgId) {
    throw new AppError(401, "Session does not belong to this workspace");
  }

  // Access tokens minted after the session-management hardening pass carry a `sid` claim,
  // so a single-device logout (which revokes that one Session row) takes effect immediately
  // instead of waiting up to ACCESS_TOKEN_TTL for the token to expire on its own. Tokens
  // issued before this change simply have no `sid` and skip this extra check.
  if (typeof payload.sid === "string") {
    const session = await prisma.session.findUnique({ where: { id: payload.sid }, select: { revokedAt: true } });
    if (!session || session.revokedAt) throw new AppError(401, "Session revoked");
    req.sessionId = payload.sid;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { role: { include: { permissions: { include: { permission: true } } } } }
  });
  if (!user || user.deletedAt || user.status !== "ACTIVE") throw new AppError(401, "Invalid session");

  // MAINTENANCE GATE — one choke point covers every authenticated route, which is exactly why it
  // lives here instead of as a router-level middleware someone forgets to mount on the next
  // controller. SUPER_ADMIN passes: someone has to do the maintenance and switch it back off.
  // 503 with a machine-readable code, not 401: the client must distinguish "your session is bad"
  // (clear tokens, try to log in) from "the workspace is closed" (show the maintenance page) —
  // and the check is CACHED (10s TTL in maintenance.service.ts), costing this hot path a Map
  // lookup, not a query.
  if (user.role.name !== "SUPER_ADMIN" && (await isMaintenanceActive())) {
    throw new AppError(503, "This workspace is undergoing scheduled maintenance.", { code: "MAINTENANCE" });
  }

  // Throttled liveness stamp — what makes the admin's "who is online right now?" panel honest.
  // At most one UPDATE per session per 5 minutes, tracked in-memory: unconditionally writing
  // would add a database write to EVERY api call, and per-request precision buys nothing for a
  // 15-minute online window. Fire-and-forget — liveness bookkeeping must never fail a request.
  if (typeof payload.sid === "string") {
    const sid = payload.sid;
    const now = Date.now();
    const last = lastSeenWrites.get(sid) ?? 0;
    if (now - last > LAST_SEEN_THROTTLE_MS) {
      purgeStaleLastSeen(now);
      lastSeenWrites.delete(sid);
      lastSeenWrites.set(sid, now);
      void prisma.session.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => {
        lastSeenWrites.delete(sid); // let the next request retry rather than sticking silent
      });
    }
  }

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions.map((p) => p.permission.key)
  };
  next();
}

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user?.permissions.includes(permission)) throw new AppError(403, "Forbidden");
    next();
  };
}

export function requireRole(allowed: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !allowed.includes(req.user.role)) throw new AppError(403, "Forbidden");
    next();
  };
}

export const requireSuperAdmin = requireRole(["SUPER_ADMIN"]);
