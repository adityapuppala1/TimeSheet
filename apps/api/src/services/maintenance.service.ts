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

const GLOBAL_ID = "global";
/** How stale the cached settings may be. The trade is explicit: a toggle takes effect within this
 *  many seconds, in exchange for zero per-request queries. */
const CACHE_TTL_MS = 10_000;
/** A session counts as "online" when it made an authenticated request this recently. Must be
 *  comfortably larger than the lastSeenAt write throttle (5 min) or active users flicker offline
 *  between throttled writes. */
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

const cache = new Map<string, { fetchedAt: number; settings: MaintenanceSettingsShape }>();

/** The admin's free-text message ends up inside email HTML — escaped, because "maintenance note"
 *  and "HTML injection vector" should stay different things. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface MaintenanceSettingsShape {
  enabled: boolean;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  message: string | null;
  updatedAt: Date;
}

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
}): Promise<MaintenanceSettingsShape> {
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
  }

  const row = await prisma.maintenanceSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {
      enabled: params.enabled,
      scheduledStartAt: params.scheduledStartAt,
      scheduledEndAt: params.scheduledEndAt,
      message: params.message?.trim() || null,
      updatedById: params.userId
    },
    create: {
      id: GLOBAL_ID,
      enabled: params.enabled,
      scheduledStartAt: params.scheduledStartAt,
      scheduledEndAt: params.scheduledEndAt,
      message: params.message?.trim() || null,
      updatedById: params.userId
    }
  });
  invalidateCache();
  return row;
}

/**
 * Who is using the app right now. "Online" = an unrevoked, unexpired session whose lastSeenAt is
 * inside the window — expiresAt alone would count everyone who logged in this month.
 */
export async function getOnlineUsers(): Promise<{
  count: number;
  users: Array<{ id: string; name: string; email: string; role: string; lastSeenAt: Date | null }>;
}> {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS);
  const sessions = await prisma.session.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: since } },
    select: {
      lastSeenAt: true,
      user: { select: { id: true, name: true, email: true, deletedAt: true, role: { select: { name: true } } } }
    },
    orderBy: { lastSeenAt: "desc" }
  });

  // One row per person, keeping their most recent activity — several tabs/devices are still one
  // human, and "7 online" meaning "3 people" makes the admin over-warn.
  const byUser = new Map<string, { id: string; name: string; email: string; role: string; lastSeenAt: Date | null }>();
  for (const session of sessions) {
    if (session.user.deletedAt) continue;
    if (!byUser.has(session.user.id)) {
      byUser.set(session.user.id, {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: session.user.role.name,
        lastSeenAt: session.lastSeenAt
      });
    }
  }
  const users = [...byUser.values()];
  return { count: users.length, users };
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
        // feed a template an admin later creates under this key in Email templates.
        fallback: {
          subject: "Scheduled maintenance — please save your work",
          html: `<p>Hi ${escapeHtml(user.name)},</p>
<p>This workspace is going into <strong>scheduled maintenance</strong>: <strong>${escapeHtml(windowText)}</strong>.</p>
<p>Please save your work and sign out before the window starts — active sessions are signed out
automatically when it begins, and signing in is disabled until it ends.</p>
${settings.message ? `<p>${escapeHtml(settings.message)}</p>` : ""}
<p>— TimeSphere</p>`
        }
      }
    });
  }
  return { notified: recipients.length };
}
