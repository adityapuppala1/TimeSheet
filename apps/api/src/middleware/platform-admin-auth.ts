/**
 * WHAT: `requirePlatformAdmin` — the platform-admin equivalent of middleware/auth.ts#requireAuth —
 * plus the authorization layer that sits on top of it: `requirePlatformCapability`,
 * `requirePlatformRole`, and `requirePlatformReason`.
 * WHY: the `/platform-admin` console (org lifecycle, plan tiers, cross-org analytics) must never
 * be reachable by a tenant user's credentials, even a compromised SUPER_ADMIN's — so this
 * verifies against a completely separate token secret, session table (`PlatformAdminSession`),
 * and user table (`PlatformAdminUser`, which doesn't exist in any tenant database at all).
 * HOW: same shape as tenant `requireAuth` (verify JWT, check session not revoked, load the
 * admin row) but every dependency is the control-plane's own — see
 * utils/platform-admin-security.ts for why the signing secret is deliberately distinct.
 * WHO calls this: every route in controllers/platform-admin.controller.ts and
 * controllers/platform-admin-console.controller.ts.
 *
 * 5.0.0 — WHY THERE IS AN AUTHORIZATION LAYER AT ALL. Until this release `requirePlatformAdmin`
 * was the whole surface: it proved you were *an* admin and stopped. Every platform admin could
 * therefore drop any tenant's database, restore a snapshot over one, retune every plan tier and
 * read every stored credential. The guards below are the same two shapes middleware/auth.ts uses
 * for tenants (`requirePermission` / `requireRole`), against the control plane's own vocabulary in
 * `@timesheet/shared`.
 */
import type { NextFunction, Request, Response } from "express";
import { PLATFORM_ROLE_CAPABILITIES, platformRoleHas, type PlatformCapability, type PlatformRole } from "@timesheet/shared";
import { controlPrisma } from "../config/control-prisma.js";
import { verifyPlatformAdminAccessToken } from "../utils/platform-admin-security.js";
import { AppError } from "./error.js";

export interface PlatformAdminRequestUser {
  id: string;
  name: string;
  email: string;
  /** Read from the database on every request, never from the token — see the note in
   *  `requirePlatformAdmin` for why that is the whole design. */
  role: PlatformRole;
}

declare global {
  namespace Express {
    interface Request {
      platformAdmin?: PlatformAdminRequestUser;
      platformAdminSessionId?: string;
      /** The operator's one-line justification, from `X-Platform-Reason`. Set by
       *  `requirePlatformReason`; read by the audit calls and the two-person queue. */
      platformReason?: string;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape as middleware/auth.ts#requireAuth, but against PlatformAdminUser/Session and a
 *  completely separate signing secret — see utils/platform-admin-security.ts's header comment. */
export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError(401, "Authentication required");

  let payload: { sub?: unknown; sid?: unknown };
  try {
    payload = verifyPlatformAdminAccessToken(token);
  } catch {
    throw new AppError(401, "Session expired");
  }

  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) throw new AppError(401, "Invalid session");
  if (typeof payload.sid !== "string" || !UUID_RE.test(payload.sid)) throw new AppError(401, "Invalid session");

  const session = await controlPrisma.platformAdminSession.findUnique({ where: { id: payload.sid }, select: { revokedAt: true } });
  if (!session || session.revokedAt) throw new AppError(401, "Session revoked");

  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: payload.sub } });
  if (!admin || admin.status !== "ACTIVE") throw new AppError(401, "Invalid session");

  /*
   * THE ROLE COMES FROM THIS ROW, NOT FROM THE TOKEN, AND THAT IS THE POINT.
   *
   * The obvious design is a `role` claim in the access JWT — one fewer thing to think about at
   * request time. It is also how a demotion becomes advisory for the next fifteen minutes: the
   * operator you just moved to READ_ONLY keeps every power their old token claims until it
   * expires, and the only fixes are shortening the TTL for everyone or a revocation list.
   *
   * This function already re-reads the admin row on EVERY request — it has to, to honour
   * `status !== "ACTIVE"` immediately — so the role is free, and reading it here means a role
   * change takes effect on the very next request with no token games at all. Deactivating an
   * admin already revokes their sessions; demoting one now has the same immediacy.
   */
  // Fails CLOSED on a value this build does not recognise — a role renamed in a future release, or
  // hand-edited in the control database, degrades to READ_ONLY rather than to unchecked.
  const role: PlatformRole = Object.hasOwn(PLATFORM_ROLE_CAPABILITIES, admin.role) ? (admin.role as PlatformRole) : "READ_ONLY";

  req.platformAdmin = { id: admin.id, name: admin.name, email: admin.email, role };
  req.platformAdminSessionId = payload.sid;
  next();
}

/**
 * Mirrors middleware/auth.ts#requirePermission. The 403 names the capability and the role that
 * lacks it, because "Forbidden" on an internal operations console sends the reader to check their
 * network before they think to check their access.
 */
export function requirePlatformCapability(capability: PlatformCapability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.platformAdmin;
    if (!admin) throw new AppError(401, "Authentication required");
    if (!platformRoleHas(admin.role, capability)) {
      throw new AppError(403, `Your platform role (${admin.role}) does not include "${capability}". Ask an OWNER for the access this needs.`);
    }
    next();
  };
}

/** Mirrors middleware/auth.ts#requireRole — used where the gate really is "which role", not
 *  "which capability": the owner-only account-management routes. */
export function requirePlatformRole(allowed: PlatformRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.platformAdmin;
    if (!admin) throw new AppError(401, "Authentication required");
    if (!allowed.includes(admin.role)) throw new AppError(403, `This needs one of: ${allowed.join(", ")}. You are ${admin.role}.`);
    next();
  };
}

/**
 * Reason-for-access: refuse the request unless the operator said why.
 *
 * WHY A HEADER AND NOT A BODY FIELD. Most of these routes validate `.strict()` schemas, so a
 * `reason` key in the body would be a 422 on arrival and every one of those schemas would have to
 * grow a field that is not part of the operation. Worse, the single largest exfiltration route in
 * the console — `GET /backups/:id/download` — has no body at all. A reason is metadata ABOUT the
 * request rather than an argument TO it, and a header carries it uniformly across every verb
 * without touching a single existing schema.
 *
 * WHY IT IS ENFORCED AT THE DOOR rather than trusted to each handler: a reason prompt is only as
 * good as the row it lands on, and a handler that forgets to read it fails silently and forever.
 */
export const PLATFORM_REASON_HEADER = "x-platform-reason";
const REASON_MIN = 8;
const REASON_MAX = 500;

/**
 * Mounted router-wide. It never refuses anything — it just puts the header on the request so that
 * EVERY audit row can carry a reason when the operator offered one, not only the routes that
 * insist on it. Splitting "capture" from "require" is what lets the console send a reason with any
 * action at all while the demand stays targeted at the ones that touch a customer.
 *
 * Truncated rather than refused at the long end: an operator who pasted a whole ticket body should
 * have their action go through with the first useful part of it recorded, not be bounced.
 */
export function capturePlatformReason(req: Request, _res: Response, next: NextFunction) {
  const raw = req.headers[PLATFORM_REASON_HEADER];
  const header = (Array.isArray(raw) ? raw[0] : (raw ?? "")).toString().trim();
  if (header) req.platformReason = decodeReason(header).slice(0, REASON_MAX);
  next();
}

/**
 * PERCENT-DECODED, because an HTTP header value cannot carry the characters people actually type.
 *
 * Found by a test, not by reasoning: the first matrix run sent a reason containing an em dash and
 * superagent refused it outright — "Invalid character in header content". A browser does the same,
 * so a real operator writing a customer's name with an accent, a curly apostrophe, or the em dash
 * this codebase's own prose is full of would have had their action fail with a message about
 * headers. The console encodes with `encodeURIComponent`; this reverses it.
 *
 * Falls back to the raw value rather than throwing: a stray `%` in a hand-rolled curl call should
 * record a slightly odd reason, not refuse an operator's action.
 */
function decodeReason(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function requirePlatformReason(req: Request, _res: Response, next: NextFunction) {
  capturePlatformReason(req, _res, () => undefined);
  if ((req.platformReason ?? "").length < REASON_MIN) {
    throw new AppError(
      400,
      `This action is recorded against a customer, so it needs a reason of at least ${REASON_MIN} characters. Send it in the ${PLATFORM_REASON_HEADER} header.`,
      { code: "REASON_REQUIRED" }
    );
  }
  next();
}
