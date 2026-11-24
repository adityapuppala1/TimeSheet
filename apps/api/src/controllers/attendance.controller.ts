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
import { optInHoliday, optOutHoliday } from "../services/holiday-opt-in.service.js";
import { Router } from "express";
import { z } from "zod";
import { aiRateLimit } from "../middleware/ai-rate-limit.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { assertAttendanceOn, getMyHolidays, getMyToday, punchIn, punchOut } from "../services/attendance-punch.service.js";
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
import {
  cancelRegularization,
  decideRegularization,
  listMyRegularizations,
  listRegularizationInbox,
  regularizationDecisionBody,
  regularizationRequestBody,
  requestRegularization
} from "../services/attendance-regularization.service.js";
import {
  cancelOvertimeClaim,
  decideOvertimeClaim,
  getMyOvertime,
  listMyOvertimeClaims,
  listOvertimeInbox,
  MAX_OVERTIME_WEEKS,
  overtimeClaimBody,
  overtimeDecisionBody,
  requestOvertimeClaim
} from "../services/attendance-overtime.service.js";
import { getDayGrid, parseGridRange } from "../services/attendance-day-grid.service.js";
import {
  defaultRange,
  getInsights,
  dismissInsight,
  insightPeriod,
  getMyAnalytics,
  getOrgAnalytics,
  getTeamAnalytics,
  MAX_RANGE_DAYS,
  type AnalyticsAudience
} from "../services/attendance-analytics.service.js";

export const attendanceRouter = Router();

const actorOf = (req: { user?: { id: string; role: string } }) => ({ id: req.user!.id, role: req.user!.role });
const regIdParam = (req: { params: Record<string, unknown> }) => z.string().min(1).max(64).parse(String(req.params.id));

/* ----------------------------- Regularisation (7.0.0) ----------------------------- */

attendanceRouter.get("/regularizations/me", requireAuth, async (req, res) => {
  res.json({ items: await listMyRegularizations(req.user!.id) });
});

attendanceRouter.post("/regularizations", requireAuth, validate(z.object({ body: regularizationRequestBody })), async (req, res) => {
  const body = regularizationRequestBody.parse(req.body);
  res.status(201).json(await requestRegularization({ userId: req.user!.id, ...body }));
});

attendanceRouter.post("/regularizations/:id/cancel", requireAuth, async (req, res) => {
  res.json(await cancelRegularization(req.user!.id, regIdParam(req)));
});

attendanceRouter.get("/regularizations/inbox", requireAuth, async (req, res) => {
  res.json(await listRegularizationInbox(actorOf(req)));
});

attendanceRouter.post("/regularizations/:id/decision", requireAuth, validate(z.object({ body: regularizationDecisionBody })), async (req, res) => {
  const body = regularizationDecisionBody.parse(req.body);
  res.json(await decideRegularization({ actor: actorOf(req), requestId: regIdParam(req), decision: body.decision, note: body.note ?? null }));
});

/* ----------------------------- Overtime (7.0.0) ----------------------------- */

attendanceRouter.get("/overtime/me", requireAuth, async (req, res) => {
  const q = z.object({ from: isoDate, to: isoDate }).passthrough().parse(req.query);
  if (q.to < q.from) throw new AppError(422, "`to` must be on or after `from`.");
  if (spanDays(q.from, q.to) > MAX_OVERTIME_WEEKS * 7) throw new AppError(422, `Ask for at most ${MAX_OVERTIME_WEEKS} weeks at a time.`);
  res.json(await getMyOvertime(req.user!.id, { from: q.from, to: q.to }));
});

attendanceRouter.get("/overtime/claims/me", requireAuth, async (req, res) => {
  res.json({ items: await listMyOvertimeClaims(req.user!.id) });
});

attendanceRouter.post("/overtime/claims", requireAuth, validate(z.object({ body: overtimeClaimBody })), async (req, res) => {
  const body = overtimeClaimBody.parse(req.body);
  res.status(201).json(await requestOvertimeClaim({ userId: req.user!.id, weekStart: body.weekStart }));
});

attendanceRouter.post("/overtime/claims/:id/cancel", requireAuth, async (req, res) => {
  res.json(await cancelOvertimeClaim(req.user!.id, regIdParam(req)));
});

attendanceRouter.get("/overtime/claims/inbox", requireAuth, async (req, res) => {
  res.json(await listOvertimeInbox(actorOf(req)));
});

attendanceRouter.post("/overtime/claims/:id/decision", requireAuth, validate(z.object({ body: overtimeDecisionBody })), async (req, res) => {
  const body = overtimeDecisionBody.parse(req.body);
  res.json(await decideOvertimeClaim({ actor: actorOf(req), requestId: regIdParam(req), decision: body.decision, note: body.note ?? null }));
});

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

/** Punch out of today's web punch. No body: the server stamps the time, so a client cannot backdate it. */
attendanceRouter.post("/punch-out", requireAuth, async (req, res) => {
  const result = await punchOut({ userId: req.user!.id });
  res.status(result.updated ? 201 : 200).json(result);
});

/** The signed-in person's holiday calendar over a window (max 400 days): the Holidays screen and .ics. */
attendanceRouter.get("/me/holidays", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  const { from, to } = rangeQuery(req.query, 400);
  res.json(await getMyHolidays(req.user!.id, from, to));
});

/** 7.0.0: take (PUT) or drop (DELETE) one optional holiday in the caller's own calendar. */
attendanceRouter.put("/me/optional-holidays/:holidayId", requireAuth, async (req, res) => {
  res.json(await optInHoliday(req.user!.id, String(req.params.holidayId)));
});
attendanceRouter.delete("/me/optional-holidays/:holidayId", requireAuth, async (req, res) => {
  res.json(await optOutHoliday(req.user!.id, String(req.params.holidayId)));
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
const sourceKinds = ["WEB", "API", "WEBHOOK", "MCP", "CSV", "REGULARIZATION"] as const;

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

/**
 * GET /attendance/day-grid?from&to — every visible person's day status over a window, for the Home
 * dashboard's logging grid and timeline and the Reports page's attendance & leave summary. Never
 * 403s for "module off": it answers `{ enabled: false }` so the dashboard can always ask.
 */
attendanceRouter.get("/day-grid", requireAuth, async (req, res) => {
  const range = parseGridRange(req.query as Record<string, unknown>);
  res.json(await getDayGrid({ id: req.user!.id, permissions: req.user!.permissions }, range));
});

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

/* ----------------------------- Analytics (V17 A6) ----------------------------- */

/** from/to are optional together: neither = the last 30 days ending on the viewer's today. */
async function analyticsRange(query: Record<string, unknown>, userId: string) {
  if (query.from === undefined && query.to === undefined) {
    return defaultRange((await userClock(userId)).today.toISOString().slice(0, 10));
  }
  return rangeQuery(query, MAX_RANGE_DAYS);
}

attendanceRouter.get("/analytics/me", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  res.json(await getMyAnalytics(req.user!.id, await analyticsRange(req.query, req.user!.id)));
});

attendanceRouter.get("/analytics/team", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  res.json(await getTeamAnalytics({ id: req.user!.id, role: req.user!.role }, await analyticsRange(req.query, req.user!.id)));
});

attendanceRouter.get("/analytics/org", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  res.json(await getOrgAnalytics({ id: req.user!.id, role: req.user!.role }, await analyticsRange(req.query, req.user!.id)));
});

// aiRateLimit (per user, shared with the other AI routes) — a cache miss here is a model call.
attendanceRouter.get("/analytics/:audience/insights", requireAuth, aiRateLimit, async (req, res) => {
  await assertAttendanceOn();
  const audience = z.enum(["me", "team", "org"]).parse(req.params.audience) as AnalyticsAudience;
  res.json(await getInsights({ id: req.user!.id, role: req.user!.role }, audience, await analyticsRange(req.query, req.user!.id)));
});

/** 7.0.0: a dismissed suggestion stays dismissed for this person, audience and range. */
attendanceRouter.post("/analytics/:audience/insights/:insightId/dismiss", requireAuth, async (req, res) => {
  await assertAttendanceOn();
  const audience = z.enum(["me", "team", "org"]).parse(req.params.audience) as AnalyticsAudience;
  const insightId = z.string().trim().min(1).max(64).parse(String(req.params.insightId));
  const range = await analyticsRange(req.query, req.user!.id);
  await dismissInsight(req.user!.id, insightId, insightPeriod(audience, range));
  res.status(204).end();
});
