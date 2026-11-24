/**
 * 7.0.0 kiosk / QR punch (services/attendance-kiosk.service.ts has the rules).
 *
 *   /api/attendance/admin/kiosks   SUPER_ADMIN: list, create (token shown once), rename / re-site,
 *                                  rotate (new token shown once), revoke
 *   /api/attendance/kiosk
 *     GET  /status        signed in: is kiosk punch on
 *     GET  /device/code   PUBLIC, the device token in `X-Kiosk-Token` is the credential. Per-IP limit.
 *     POST /punch         signed in: { code, verificationId? }. Per-IP limit.
 *
 * The tenant is the Host (resolveTenant runs before both), so a device or a code only ever reaches
 * its own workspace.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createKiosk, isKioskOn, issueKioskCode, kioskPunch, listKiosks, revokeKiosk, rotateKiosk, updateKiosk } from "../services/attendance-kiosk.service.js";
import { assertAttendanceEntitled } from "../services/attendance-settings.service.js";

export const kioskBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    siteId: z.string().min(1).max(64).nullable().optional()
  })
  .strict();

export const kioskPunchBody = z
  .object({
    code: z.string().min(1).max(400),
    verificationId: z.string().min(1).max(64).nullable().optional()
  })
  .strict();

const idParams = z.object({ id: z.string().min(1).max(64) });

export const kioskAdminRouter = Router();
kioskAdminRouter.use(requireAuth, requireSuperAdmin);

kioskAdminRouter.get("/", async (_req, res) => {
  res.json({ items: await listKiosks(), enabled: await isKioskOn() });
});

kioskAdminRouter.post("/", validate(z.object({ body: kioskBody })), async (req, res) => {
  await assertAttendanceEntitled();
  const body = kioskBody.parse(req.body);
  res.status(201).json(await createKiosk(body, req.user!.id));
});

kioskAdminRouter.put("/:id", validate(z.object({ params: idParams, body: kioskBody.partial() })), async (req, res) => {
  await assertAttendanceEntitled();
  const body = kioskBody.partial().parse(req.body);
  res.json(await updateKiosk(String(req.params.id), body, req.user!.id));
});

kioskAdminRouter.post("/:id/rotate", validate(z.object({ params: idParams })), async (req, res) => {
  await assertAttendanceEntitled();
  res.json(await rotateKiosk(String(req.params.id), req.user!.id));
});

kioskAdminRouter.post("/:id/revoke", validate(z.object({ params: idParams })), async (req, res) => {
  await revokeKiosk(String(req.params.id), req.user!.id);
  res.status(204).end();
});

export const kioskRouter = Router();

// A kiosk asks for a code about twice a minute; 30 a minute per IP leaves room for a few devices
// behind one NAT and makes guessing a 256-bit token pointless.
const deviceLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true });
// One person punches once a day; 20 a minute per IP covers a queue at the office door.
const punchLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true });

kioskRouter.get("/status", requireAuth, async (_req, res) => {
  res.json({ enabled: await isKioskOn() });
});

kioskRouter.get("/device/code", deviceLimiter, async (req, res) => {
  const token = req.get("x-kiosk-token");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.json(await issueKioskCode(token));
});

kioskRouter.post("/punch", punchLimiter, requireAuth, validate(z.object({ body: kioskPunchBody })), async (req, res) => {
  const body = kioskPunchBody.parse(req.body);
  const result = await kioskPunch({ userId: req.user!.id, code: body.code, verificationId: body.verificationId ?? null, ip: req.ip ?? null, userAgent: req.get("user-agent")?.slice(0, 500) ?? null });
  res.status(result.created ? 201 : 200).json(result);
});
