/**
 * WHAT: workspace maintenance mode — schedule a window, lock everyone but SUPER_ADMINs out during
 * it, see who's online, warn them, and force-log-out the stragglers.
 *
 * WHY THE ACTIVE-CHECK IS CACHED: `isMaintenanceActive` runs inside requireAuth — the hot path of
 * every authenticated request. An uncached read would add one query to every API call for a value
 * that changes a handful of times a year. A 10-second in-memory TTL per tenant means enforcement
 * lags a toggle by at most 10 seconds, which is far inside the tolerance of "we're starting
 * maintenance now", and costs the hot path one Map lookup.
 *
 * WHY SUPER_ADMIN IS EXEMPT (and only that role): someone has to be able to DO the maintenance,
 * verify the result, and turn the mode off again. Exempting more roles would defeat the point;
 * exempting nobody would lock the key inside the room.
 */
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { env } from "../config/env.js";
import { dispatchNotification } from "./notify.service.js";
import { isPrivateIpAddress, parseUserAgent, type DeviceFormFactor } from "../utils/user-agent.js";

import { templates } from "./mail-templates.js";

const GLOBAL_ID = "global";
/** How stale the cached settings may be. The trade is explicit: a toggle takes effect within this
 *  many seconds, in exchange for zero per-request queries. */
const CACHE_TTL_MS = 10_000;
/** A session counts as "online" when it made an authenticated request this recently. Must be
 *  comfortably larger than the lastSeenAt write throttle (5 min) or active users flicker offline
 *  between throttled writes. */
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

const cache = new Map<string, { fetchedAt: number; settings: MaintenanceSettingsShape }>();

export interface MaintenanceSettingsShape {
  enabled: boolean;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  message: string | null;
  updatedAt: Date;
  /** True while the PLATFORM armed this window across the fleet. See `assertNotPlatformManaged`. */
  managedByPlatform: boolean;
  /** Who to name in the workspace's read-only notice. Free text — the actor has no user row here. */
  managedByLabel: string | null;
  /** The broadcast id, so support can join the workspace's story to the platform's. */
  managedReference: string | null;
}

/** Who is asking to change the window. The default is the workspace, because that is who almost
 *  always is; the platform passes its own source explicitly. */
export type MaintenanceSource = "tenant" | "platform";

/**
 * The sentence a workspace administrator reads when they try to change a platform-armed window.
 *
 * Exported because it is asserted by a test and reused by the UI: a control that is disabled
 * without saying why reads as a bug, and the first thing an admin does with an unexplained
 * disabled switch is raise a ticket.
 */
export const PLATFORM_MANAGED_MESSAGE =
  "This maintenance window was scheduled by platform operations for the whole deployment, so it cannot be changed or cancelled from inside the workspace. It lifts automatically when the platform clears it. Super administrators keep full access throughout — everything is read-only for everyone else.";

export async function getMaintenanceSettings(): Promise<MaintenanceSettingsShape> {
  const row = await prisma.maintenanceSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {},
    create: { id: GLOBAL_ID }
  });
  return row;
}

/** The window states, in the order they occur. `scheduled` shows users a countdown banner but
 *  blocks nothing; only `active` enforces. */
export type MaintenancePhase = "off" | "scheduled" | "active" | "ended";

export function phaseOf(settings: MaintenanceSettingsShape, now = new Date()): MaintenancePhase {
  if (!settings.enabled || !settings.scheduledStartAt) return "off";
  if (now < settings.scheduledStartAt) return "scheduled";
  if (settings.scheduledEndAt && now > settings.scheduledEndAt) return "ended";
  return "active";
}

/**
 * The hot-path check. Cached per tenant; callers get at most CACHE_TTL_MS of staleness.
 * Fails OPEN on any error: a broken maintenance lookup must degrade to "app works normally",
 * never to "everyone is locked out by an exception".
 */
export async function isMaintenanceActive(): Promise<boolean> {
  try {
    const { orgId } = requireTenantContext();
    const cached = cache.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return phaseOf(cached.settings) === "active";
    }
    const settings = await getMaintenanceSettings();
    cache.set(orgId, { fetchedAt: Date.now(), settings });
    return phaseOf(settings) === "active";
  } catch {
    return false;
  }
}

/** Called by the PATCH so a toggle is enforced immediately rather than after the TTL — the one
 *  place where 10 seconds of lag would actually be felt is the admin clicking "enable" and then
 *  watching nothing happen. */
function invalidateCache(): void {
  try {
    cache.delete(requireTenantContext().orgId);
  } catch {
    /* outside tenant context — nothing cached under that key anyway */
  }
}

export async function updateMaintenanceSettings(params: {
  enabled: boolean;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  message: string | null;
  userId: string;
  /** Defaults to "tenant" so a caller that forgets is treated as the LESS privileged one. */
  source?: MaintenanceSource;
  /** Platform only: who to name in the workspace's notice, and which broadcast this came from. */
  managedByLabel?: string | null;
  managedReference?: string | null;
}): Promise<MaintenanceSettingsShape> {
  const source: MaintenanceSource = params.source ?? "tenant";

  // THE LOCK, and it is checked before validation on purpose: a workspace admin who cannot change
  // the window at all should be told that, not told their dates are wrong.
  if (source === "tenant") {
    const current = await getMaintenanceSettings();
    if (current.managedByPlatform && current.enabled) {
      throw new AppError(409, PLATFORM_MANAGED_MESSAGE, { code: "MAINTENANCE_PLATFORM_MANAGED" });
    }
  }

  if (params.enabled) {
    // Enabling requires a coherent window — an armed maintenance mode with no start would either
    // never fire (surprising) or fire instantly (more surprising). Both rejected loudly instead.
    if (!params.scheduledStartAt) throw new AppError(422, "Pick when the maintenance window starts.");
    if (!params.scheduledEndAt) throw new AppError(422, "Pick when the maintenance window ends.");
    if (params.scheduledEndAt <= params.scheduledStartAt) {
      throw new AppError(422, "The window must end after it starts.");
    }
    if (params.scheduledEndAt <= new Date()) {
      throw new AppError(422, "That window is entirely in the past — pick an end time that hasn't happened yet.");
    }
    // A NEW start time must be now or later — scheduling a window to have already begun is
    // either a typo or a stale form. The one legitimate past-start is an UNCHANGED one: an
    // admin extending or re-wording a window that is already running must not be told their
    // own active window is invalid. Five minutes of grace absorbs form-filling time.
    const stored = await getMaintenanceSettings();
    const startChanged = stored.scheduledStartAt?.getTime() !== params.scheduledStartAt.getTime();
    if (startChanged && params.scheduledStartAt.getTime() < Date.now() - 5 * 60 * 1000) {
      throw new AppError(422, "The window can't start in the past — pick the current time or later.");
    }
  }

  // The flag rides with the window rather than persisting past it: a platform window that is
  // cleared hands the control back, and a workspace arming its own window afterwards owns it.
  const managed = source === "platform" && params.enabled;
  const provenance = {
    managedByPlatform: managed,
    managedByLabel: managed ? (params.managedByLabel ?? "Platform operations") : null,
    managedReference: managed ? (params.managedReference ?? null) : null
  };

  const row = await prisma.maintenanceSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {
      enabled: params.enabled,
      scheduledStartAt: params.scheduledStartAt,
      scheduledEndAt: params.scheduledEndAt,
      message: params.message?.trim() || null,
      updatedById: params.userId,
      ...provenance
    },
    create: {
      id: GLOBAL_ID,
      enabled: params.enabled,
      scheduledStartAt: params.scheduledStartAt,
      scheduledEndAt: params.scheduledEndAt,
      message: params.message?.trim() || null,
      updatedById: params.userId,
      ...provenance
    }
  });
  invalidateCache();
  return row;
}

/**
 * userId -> most recent lastSeenAt, for everyone "online" (same definition as getOnlineUsers
 * below). The lightweight sibling the admin Users list decorates its rows with — it needs only
 * the id->freshness map, not names/roles it already has.
 */
export async function getOnlineSeenByUser(): Promise<Map<string, Date>> {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS);
  const sessions = await prisma.session.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: since } },
    select: { userId: true, lastSeenAt: true },
    orderBy: { lastSeenAt: "desc" }
  });
  const byUser = new Map<string, Date>();
  for (const session of sessions) {
    if (session.lastSeenAt && !byUser.has(session.userId)) byUser.set(session.userId, session.lastSeenAt);
  }
  return byUser;
}

/** One live session, decoded for display. Deliberately NOT the Prisma row: refreshHash and
 *  previousRefreshHash are credentials and must never leave the service, let alone the API. */
export interface OnlineSession {
  id: string;
  ipAddress: string | null;
  /** True for LAN/loopback addresses — see utils/user-agent.ts#isPrivateIpAddress for why. */
  ipIsPrivate: boolean;
  browser: string;
  os: string;
  formFactor: DeviceFormFactor;
  /** "Chrome on macOS", or "Unknown device" when the UA string couldn't be decoded. */
  device: string;
  signedInAt: Date;
  lastSeenAt: Date | null;
}

export interface OnlineUser {
  id: string;
  name: string;
  email: string;
  role: string;
  lastSeenAt: Date | null;
  /** Every live session this person has, freshest first — a phone AND a laptop is two entries. */
  sessions: OnlineSession[];
}

/**
 * Who is using the app right now. "Online" = an unrevoked, unexpired session whose lastSeenAt is
 * inside the window — expiresAt alone would count everyone who logged in this month.
 *
 * ONE ROW PER PERSON, BUT EVERY SESSION ATTACHED. `count` stays a headcount because that is what
 * the panel's badge, the warn-users flow and the admin's mental model all mean by "online" —
 * "7 online" that turns out to be 3 people makes an admin over-warn. But the extra sessions are
 * carried rather than discarded: "who is online" is very often really "why is that account on a
 * second device", and an answer that silently collapses the two devices destroys the only
 * evidence of it. `sessionCount` is the honest device-level total alongside the headcount.
 */
export async function getOnlineUsers(): Promise<{ count: number; sessionCount: number; users: OnlineUser[] }> {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS);
  const sessions = await prisma.session.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: since } },
    // Field-by-field, never a bare `include`: this row also holds refresh-token hashes.
    select: {
      id: true,
      lastSeenAt: true,
      createdAt: true,
      userAgent: true,
      ipAddress: true,
      user: { select: { id: true, name: true, email: true, deletedAt: true, role: { select: { name: true } } } }
    },
    orderBy: { lastSeenAt: "desc" }
  });

  const byUser = new Map<string, OnlineUser>();
  let sessionCount = 0;
  for (const session of sessions) {
    if (session.user.deletedAt) continue;
    sessionCount += 1;
    const existing = byUser.get(session.user.id);
    const parsed = parseUserAgent(session.userAgent);
    const detail: OnlineSession = {
      id: session.id,
      ipAddress: session.ipAddress,
      ipIsPrivate: isPrivateIpAddress(session.ipAddress),
      browser: parsed.browser,
      os: parsed.os,
      formFactor: parsed.formFactor,
      device: parsed.label,
      signedInAt: session.createdAt,
      lastSeenAt: session.lastSeenAt
    };
    if (existing) {
      // The query is already lastSeenAt-desc, so appending keeps sessions freshest-first and the
      // user's own lastSeenAt (set from the first session seen) stays the most recent one.
      existing.sessions.push(detail);
      continue;
    }
    byUser.set(session.user.id, {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: session.user.role.name,
      lastSeenAt: session.lastSeenAt,
      sessions: [detail]
    });
  }
  const users = [...byUser.values()];
  return { count: users.length, sessionCount, users };
}

/**
 * Revokes every session belonging to non-SUPER_ADMIN users.
 *
 * Server-side revocation, not a client suggestion: their next API call 401s (requireAuth checks
 * the session row), the refresh fails, and the client lands on /login — where, with maintenance
 * active, the login itself is refused and they're shown the maintenance page. The chain needs no
 * cooperation from the client at all, which is the property that makes it an actual control.
 */
export async function forceLogoutNonAdmins(actorUserId: string): Promise<{ revokedSessions: number }> {
  const result = await prisma.session.updateMany({
    where: {
      revokedAt: null,
      user: { role: { name: { not: "SUPER_ADMIN" } } }
    },
    data: { revokedAt: new Date() }
  });
  void actorUserId; // audited by the controller — the parameter documents who may call this.
  return { revokedSessions: result.count };
}

/**
 * Warns every active non-SUPER_ADMIN user: in-app notification (awaited — the bell must not miss
 * it) plus email (fire-and-forget inside dispatchNotification, same as every other category).
 * Sent to ONLINE users only by default — emailing 500 dormant accounts about a Tuesday-night
 * window helps nobody and gets the sender marked as spam.
 */
export async function notifyUsersOfMaintenance(): Promise<{ notified: number }> {
  const settings = await getMaintenanceSettings();
  if (!settings.enabled || !settings.scheduledStartAt) {
    throw new AppError(422, "Enable and schedule the maintenance window first — the notification quotes it.");
  }

  const { users } = await getOnlineUsers();
  const recipients = users.filter((user) => user.role !== "SUPER_ADMIN");

  const start = settings.scheduledStartAt;
  const end = settings.scheduledEndAt;
  const windowText = `${start.toLocaleString()}${end ? ` until ${end.toLocaleString()}` : ""}`;
  const extra = settings.message ? ` ${settings.message}` : "";

  for (const user of recipients) {
    await dispatchNotification({
      userId: user.id,
      category: "maintenance.scheduled",
      title: "Scheduled maintenance — please wrap up",
      body: `The workspace goes into maintenance ${windowText}. Save your work and sign out before it starts; you'll be signed out automatically once it begins.${extra}`,
      link: "/app",
      email: {
        templateKey: "maintenance.scheduled",
        vars: { name: user.name, window: windowText, message: settings.message ?? "", appUrl: env.APP_BASE_URL },
        // PRE-RENDERED, not {{templated}}: renderEmailTemplate returns this fallback verbatim
        // when no DB override exists (vars are only applied to overrides), so placeholders here
        // would reach inboxes literally as "Hi {{name}}". The `vars` above still matter — they
        // feed a template an admin edits under this key in the Email templates page. The
        // branded template escapes every value itself, the admin's free-text message included.
        fallback: {
          subject: "Scheduled maintenance — please save your work",
          html: templates.maintenanceScheduled({
            name: user.name,
            window: windowText,
            message: settings.message ?? ""
          })
        }
      }
    });
  }
  return { notified: recipients.length };
}
