/**
 * Auth for the public REST API (controllers/public-api.controller.ts) — separate from the
 * normal JWT/session auth every other tenant route uses, because external integrations (Zapier,
 * a customer's own script) authenticate with a long-lived API key, not a browser session.
 *
 * WHO resolves the tenant: unlike devops-webhook/chat-webhook (mounted before tenant
 * resolution, since a CI job has no subdomain to send), a public-API caller already knows their
 * org's URL (`acme.timesphere.app/api/public/v1/...`) — so this middleware is mounted AFTER the
 * blanket `resolveTenant` in app.ts and just needs to validate the key against *this* org's own
 * ApiKey table, no path-param org resolution required.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { AppError } from "./error.js";

export interface PublicApiRequest extends Request {
  apiKey?: { id: string; scope: "READ" | "WRITE" };
}

function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export async function publicApiAuth(req: PublicApiRequest, _res: Response, next: NextFunction) {
  const authHeaderRaw = req.headers.authorization;
  const authHeader = (Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw) ?? "";
  const key = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new AppError(401, "Missing API key. Pass it as 'Authorization: Bearer <key>'.");

  const record = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(key) } });
  if (!record || record.revokedAt) throw new AppError(401, "Invalid or revoked API key.");

  await prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  req.apiKey = { id: record.id, scope: record.scope as "READ" | "WRITE" };
  next();
}

/** Guards the handful of routes (currently just POST /tickets) that mutate data — a READ-scope
 *  key gets a clear 403 instead of silently succeeding or a confusing generic auth failure. */
export function requireWriteScope(req: PublicApiRequest, _res: Response, next: NextFunction) {
  if (req.apiKey?.scope !== "WRITE") {
    throw new AppError(403, "This API key is read-only. Generate a write-scoped key from Workspace Settings -> Public API to use this endpoint.");
  }
  next();
}
