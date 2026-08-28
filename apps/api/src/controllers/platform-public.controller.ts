/**
 * The two doors a lapsed customer can still open from an email: the feedback form and "restore my
 * workspace". Both are reached by a signed token minted by the retention programme, never by an
 * org id, and both are mounted BEFORE tenant resolution — the person clicking has a workspace that
 * is suspended (refuses every request) or already gone, so nothing here may depend on a Host
 * header resolving to it.
 *
 * SECURITY POSTURE:
 * - The token is an HMAC over {org, purpose, stage, expiry} keyed with the app secret. A feedback
 *   token cannot be replayed as a reactivation, and neither survives its expiry.
 * - Every failure — bad signature, expired, wrong purpose, org no longer eligible — is the same
 *   404. A probe learns nothing about which workspaces exist or what state they are in.
 * - Feedback is PLAIN TEXT, length-capped, and written to the control plane only. It never enters
 *   a tenant database, and it is never rendered as markup anywhere.
 * - Reactivation writes the LEAST it can: the status back to GRACE with a fresh window. It does
 *   not sign anyone in, restore a plan, or touch a password — the owner still signs in and pays.
 * - Rate-limited at the mount (app.ts), on top of the token being unguessable.
 */
import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { describeFeedbackToken, describeReactivateToken, reactivateWorkspace, submitTrialFeedback } from "../services/retention.service.js";

export const platformPublicRouter = Router();

const tokenParam = z.object({ params: z.object({ token: z.string().min(20).max(600) }) });

platformPublicRouter.get("/trial-feedback/:token", validate(tokenParam), async (req, res) => {
  res.json(await describeFeedbackToken(String(req.params.token)));
});

const feedbackSchema = z.object({
  params: z.object({ token: z.string().min(20).max(600) }),
  body: z
    .object({
      rating: z.number().int().min(1).max(5),
      liked: z.string().max(2000).optional(),
      missing: z.string().max(2000).optional(),
      wouldReturn: z.enum(["yes", "maybe", "no"]).optional(),
      comment: z.string().max(4000).optional()
    })
    .strict()
});

platformPublicRouter.post("/trial-feedback/:token", validate(feedbackSchema), async (req, res) => {
  const saved = await submitTrialFeedback(String(req.params.token), req.body);
  res.status(201).json(saved);
});

platformPublicRouter.get("/reactivate/:token", validate(tokenParam), async (req, res) => {
  res.json(await describeReactivateToken(String(req.params.token)));
});

platformPublicRouter.post("/reactivate/:token", validate(tokenParam), async (req, res) => {
  res.json(await reactivateWorkspace(String(req.params.token)));
});
