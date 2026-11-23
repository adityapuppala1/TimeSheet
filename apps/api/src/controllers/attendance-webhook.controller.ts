/**
 * POST /api/integrations/attendance/:sourceId — the signed inbound attendance webhook (V17 A3).
 * Everything that matters lives in services/attendance-webhook.service.ts; this file only adapts
 * HTTP to it.
 *
 * WHY MOUNTED AFTER resolveTenant (unlike the git/chat receivers): the device is configured with
 * the workspace's own URL (acme.timesphere.app), so the Host header already names the tenant —
 * the same reasoning as the public REST API. The RAW body is still needed for the HMAC, so app.ts
 * installs `express.raw()` for this prefix BEFORE the global `express.json()`; json() then skips
 * the already-read body, and req.body arrives here as the exact bytes that were signed.
 */
import { Router } from "express";
import { AppError } from "../middleware/error.js";
import { handleAttendanceWebhook } from "../services/attendance-webhook.service.js";

export const attendanceWebhookRouter = Router();

attendanceWebhookRouter.post("/:sourceId", async (req, res) => {
  // express.raw() fills req.body only for bodies it parsed; anything else (no body at all) has no
  // bytes to verify.
  if (!Buffer.isBuffer(req.body)) throw new AppError(400, "Send the punch as a JSON body.");
  const result = await handleAttendanceWebhook({
    sourceId: String(req.params.sourceId),
    headers: req.headers,
    rawBody: req.body.toString("utf8")
  });
  res.status(result.status).json(result.body);
});
