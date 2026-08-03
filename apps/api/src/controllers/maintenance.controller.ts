/**
 * WHAT: maintenance-mode endpoints — one PUBLIC status probe (`GET /status`, what the lockout
 * page and the login screen poll) and the SUPER_ADMIN control surface (view settings + who's
 * online, PATCH the schedule, force-log-out everyone, send the "wrap up" warning).
 * WHY the status probe is unauthenticated: the people who most need it are exactly the people
 * whose requests are being 503'd — a locked-out user has no working token, and the /maintenance
 * page must still know when the window ends so it can send them back to /login. It exposes only
 * what the lockout page itself displays (phase, window, admin's message) — never settings
 * internals or who is online.
 * WHO calls this: `pages/Maintenance.tsx` (public poll), `Login.tsx` (redirect check), and
 * `pages/settings/MaintenanceSettingsCard.tsx` (admin surface). Mounted in app.ts AFTER
 * `resolveTenant` — maintenance is a per-workspace state, so the probe needs to know which
 * tenant it's answering for.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import {
  forceLogoutNonAdmins,
  getMaintenanceSettings,
  getOnlineUsers,
  notifyUsersOfMaintenance,
  phaseOf,
  updateMaintenanceSettings
} from "../services/maintenance.service.js";
import { getSystemHealth } from "../services/system-health.service.js";

export const maintenanceRouter = Router();

/**
 * PUBLIC — the only unauthenticated route in this controller. Everything else below opts into
 * requireAuth per-route (instead of the usual router-wide `router.use(requireAuth)`) precisely
 * because this one route must answer people whose sessions were just revoked.
 */
maintenanceRouter.get("/status", async (_req, res) => {
  const settings = await getMaintenanceSettings();
  const phase = phaseOf(settings);
  res.json({
    phase,
    // Window + message only while the mode is armed — a disabled maintenance mode should look
    // indistinguishable from "never configured" to an anonymous caller.
    scheduledStartAt: settings.enabled ? settings.scheduledStartAt : null,
    scheduledEndAt: settings.enabled ? settings.scheduledEndAt : null,
    message: settings.enabled ? settings.message : null
  });
});

/* ---------------------------- SUPER_ADMIN surface ---------------------------- */

maintenanceRouter.get("/admin", requireAuth, requireSuperAdmin, async (_req, res) => {
  const [settings, online] = await Promise.all([getMaintenanceSettings(), getOnlineUsers()]);
  res.json({ settings, phase: phaseOf(settings), online });
});

const updateSchema = z.object({
  body: z
    .object({
      enabled: z.boolean(),
      // datetime({ offset: true }) so "2026-08-03T18:30:00+05:30" from the browser parses too,
      // not just UTC "Z" strings. Nulls clear the window (only legal while disabled — the
      // service rejects enabling without a coherent window).
      scheduledStartAt: z.string().datetime({ offset: true }).nullable(),
      scheduledEndAt: z.string().datetime({ offset: true }).nullable(),
      message: z.string().max(500).nullable()
    })
    .strict()
});

maintenanceRouter.patch("/settings", requireAuth, requireSuperAdmin, validate(updateSchema), async (req, res) => {
  const body = req.body as z.infer<typeof updateSchema>["body"];
  const settings = await updateMaintenanceSettings({
    enabled: body.enabled,
    scheduledStartAt: body.scheduledStartAt ? new Date(body.scheduledStartAt) : null,
    scheduledEndAt: body.scheduledEndAt ? new Date(body.scheduledEndAt) : null,
    message: body.message,
    userId: req.user!.id
  });
  await audit(req.user!.id, "maintenance.settings_updated", "MaintenanceSettings", "global", {
    enabled: settings.enabled,
    scheduledStartAt: settings.scheduledStartAt,
    scheduledEndAt: settings.scheduledEndAt
  });
  res.json({ settings, phase: phaseOf(settings) });
});

maintenanceRouter.post("/force-logout", requireAuth, requireSuperAdmin, async (req, res) => {
  const { revokedSessions } = await forceLogoutNonAdmins(req.user!.id);
  await audit(req.user!.id, "maintenance.force_logout", "Session", undefined, { revokedSessions });
  res.json({ revokedSessions });
});

maintenanceRouter.post("/notify", requireAuth, requireSuperAdmin, async (req, res) => {
  const { notified } = await notifyUsersOfMaintenance();
  await audit(req.user!.id, "maintenance.users_notified", "MaintenanceSettings", "global", { notified });
  res.json({ notified });
});

/**
 * Live server vitals for the Server health card — CPU/RAM/disk/latency/component checks, all
 * measured on the instance answering (see system-health.service.ts's honesty rules). Not
 * audited: it's a read-only dashboard poll, and one row every 10 seconds would drown the
 * audit log in noise.
 */
maintenanceRouter.get("/health", requireAuth, requireSuperAdmin, async (_req, res) => {
  res.json(await getSystemHealth());
});
