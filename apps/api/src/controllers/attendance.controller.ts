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
import { assertAttendanceOn, getMyToday, punchIn } from "../services/attendance-punch.service.js";
import { isoDate } from "../services/attendance-settings.service.js";
import { listEnabledMissedReasonOptions, missedDayReasonState } from "../services/missed-day-reason.service.js";
import { userClock } from "../services/user-clock.service.js";
import {
  getMyHistory,
  getPersonTimeline,
  getTeamDay,
  MAX_HISTORY_DAYS,
  MAX_TIMELINE_DAYS,
  spanDays
} from "../services/attendance-team.service.js";
import { AppError } from "../middleware/error.js";

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

/* ----------------------------- Team Activity (V17 A5) ----------------------------- */

const dayStatuses = ["WEEKEND", "HOLIDAY", "LEAVE", "PRESENT", "ABSENT", "PENDING"] as const;
const sourceKinds = ["WEB", "API", "WEBHOOK", "MCP", "CSV"] as const;

/** Parsed here, not by validate(): validate() discards its parse, and these are query strings. */
const teamDayQuery = z.object({
  date: isoDate.optional(),
  search: z.string().max(120).optional(),
  status: z.enum(dayStatuses).optional(),
  source: z.enum(sourceKinds).optional(),
  managerId: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

/** A from/to window, both required, ordered, and no longer than `maxDays`. */
function rangeQuery(query: unknown, maxDays: number) {
  const { from, to } = z.object({ from: isoDate, to: isoDate }).parse(query);
  if (to < from) throw new AppError(422, "`to` must be on or after `from`.");
  if (spanDays(from, to) > maxDays) throw new AppError(422, `Ask for at most ${maxDays} days at a time.`);
  return { from, to };
}

attendanceRouter.get("/team/today", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  const q = teamDayQuery.parse(req.query);
  // "Today" is the viewer's own day unless they picked one.
  const date = q.date ?? (await userClock(req.user!.id)).today.toISOString().slice(0, 10);
  res.json(await getTeamDay({ id: req.user!.id, role: req.user!.role }, { ...q, date }));
});

attendanceRouter.get("/team/:userId/timeline", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  const { from, to } = rangeQuery(req.query, MAX_TIMELINE_DAYS);
  res.json(await getPersonTimeline({ id: req.user!.id, role: req.user!.role }, String(req.params.userId), from, to));
});

attendanceRouter.get("/me/history", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  const { from, to } = rangeQuery(req.query, MAX_HISTORY_DAYS);
  res.json(await getMyHistory(req.user!.id, from, to));
});
