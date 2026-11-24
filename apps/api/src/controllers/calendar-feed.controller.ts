/**
 * /api/calendar — 7.0.0 private calendar feed (services/calendar-feed.service.ts has the rules).
 *
 *   GET    /feed/:file          PUBLIC (no auth header — calendar apps cannot send one). The token
 *                               in the path is the credential. Per-IP rate limit; same 404 for
 *                               every failure.
 *   GET    /feed-token          signed in: is my feed on, its hint, is a team feed available
 *   POST   /feed-token/rotate   signed in: create or rotate; the token is returned once
 *   DELETE /feed-token          signed in: revoke
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { teamScopeFor } from "../services/attendance-team.service.js";
import { getFeedStatus, renderFeed, revokeFeedToken, rotateFeedToken } from "../services/calendar-feed.service.js";
import { isLeaveOn } from "../services/leave.service.js";

export const calendarFeedRouter = Router();

// A calendar app polls every few hours; 30 a minute per IP is generous for an office NAT and still
// makes guessing a 256-bit token pointless as well as slow.
const feedLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true });

calendarFeedRouter.get("/feed/:file", feedLimiter, async (req, res) => {
  const body = await renderFeed(String(req.params.file));
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  res.send(body);
});

calendarFeedRouter.get("/feed-token", requireAuth, async (req, res) => {
  const status = await getFeedStatus(req.user!.id);
  res.json({ ...status, teamFeedAvailable: Boolean(teamScopeFor(req.user!.role)) && (await isLeaveOn()) });
});

calendarFeedRouter.post("/feed-token/rotate", requireAuth, async (req, res) => {
  res.status(201).json(await rotateFeedToken(req.user!.id));
});

calendarFeedRouter.delete("/feed-token", requireAuth, async (req, res) => {
  await revokeFeedToken(req.user!.id);
  res.status(204).end();
});
