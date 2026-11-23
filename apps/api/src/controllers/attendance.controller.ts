/**
 * /api/attendance — the employee routes (V17 A2): today's status for the punch-in pop-up, and the
 * punch itself. Any signed-in person; the module gate lives in attendance-punch.service.ts.
 *
 * Per-route requireAuth rather than router.use: this router is mounted at /api/attendance, which
 * also prefixes the admin router, and a router-level middleware here would run on every admin
 * request too.
 *
 * IP and user agent are taken from the request, never the body — a client that could name its own
 * IP would make the evidence worthless.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getMyToday, punchIn } from "../services/attendance-punch.service.js";
import { isoDate } from "../services/attendance-settings.service.js";
import { listEnabledMissedReasonOptions, missedDayReasonState } from "../services/missed-day-reason.service.js";
import { userClock } from "../services/user-clock.service.js";

export const attendanceRouter = Router();

attendanceRouter.get("/me/today", requireAuth, async (req, res) => {
  res.json(await getMyToday(req.user!.id));
});

/** No z.coerce: validate() discards its parse, and JSON already carries real numbers. */
export const punchInBody = z
  .object({
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    accuracyM: z.number().min(0).max(1_000_000).nullable().optional(),
    consentAccepted: z.boolean().optional(),
    verificationId: z.string().min(1).max(64).nullable().optional()
  })
  .strict()
  // Half a coordinate is a client bug, not a location.
  .refine((b) => (b.lat == null) === (b.lng == null), { message: "Send both lat and lng, or neither." });

attendanceRouter.post("/punch-in", requireAuth, validate(z.object({ body: punchInBody })), async (req, res) => {
  const body = punchInBody.parse(req.body);
  const ua = req.headers["user-agent"];
  const result = await punchIn({
    userId: req.user!.id,
    lat: body.lat,
    lng: body.lng,
    accuracyM: body.accuracyM,
    consentAccepted: body.consentAccepted,
    verificationId: body.verificationId,
    ip: req.ip ?? null,
    userAgent: typeof ua === "string" ? ua : null
  });
  res.status(result.created ? 201 : 200).json(result);
});

/**
 * V17 A4: the enabled "why was this day missed?" options, for any signed-in person (the timesheet
 * form renders them). Labels and codes only — nothing an employee should not see.
 */
attendanceRouter.get("/missed-reasons/options", requireAuth, async (_req, res) => {
  res.json({ options: await listEnabledMissedReasonOptions() });
});

/**
 * V17 A4: would creating an entry on `date` need a reason, for ME, right now? The form asks this when
 * the date changes so the prompt shows before Save; saveTimesheet enforces the same rule regardless.
 */
attendanceRouter.get("/missed-reasons/check", requireAuth, async (req, res) => {
  const date = isoDate.parse(req.query.date);
  const today = (await userClock(req.user!.id)).today.toISOString().slice(0, 10);
  res.json({ date, ...(await missedDayReasonState(req.user!.id, date, today)) });
});
