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
import { apiKeyGrants, type ApiKeyGrant } from "@timesheet/shared";
import { AppError } from "./error.js";

export interface PublicApiRequest extends Request {
  apiKey?: { id: string; scope: "READ" | "WRITE"; grants: ApiKeyGrant[] };
}

/**
 * ApiKey.grants (comma-separated) → the known grants. Unknown tokens are dropped rather than
 * trusted: a typo in a hand-edited row must not become a capability. NULL → none, which is what
 * every key issued before grants existed carries.
 */
export function parseApiKeyGrants(raw: string | null | undefined): ApiKeyGrant[] {
  if (!raw) return [];
  const known = new Set<string>(apiKeyGrants);
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => known.has(s)))] as ApiKeyGrant[];
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
  // Unknown, revoked and EXPIRED all answer identically, and deliberately so: a distinct "your
  // key expired" would confirm to an unauthenticated caller that the key they hold was once real,
  // which is the one bit of information a guesser actually wants. Same single-message discipline
  // as middleware/mcp-auth.ts.
  //
  // `expiresAt === null` means never expires — every key issued before that column existed reads
  // that way, so nothing working stops working on upgrade (see the migration's note).
  if (!record || record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) {
    throw new AppError(401, "Invalid or revoked API key.");
  }

  await prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  req.apiKey = { id: record.id, scope: record.scope as "READ" | "WRITE", grants: parseApiKeyGrants(record.grants) };
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

/**
 * Granular grant check (V17 A3). Deliberately independent of READ/WRITE: a WRITE key does NOT
 * imply attendance:write, because broad keys were minted before attendance existed and their
 * holders never agreed to carry the power to punch people in. Only an explicit tick grants it.
 */
export function requireApiGrant(grant: ApiKeyGrant) {
  return (req: PublicApiRequest, _res: Response, next: NextFunction) => {
    if (!req.apiKey?.grants.includes(grant)) {
      throw new AppError(403, `This API key lacks the '${grant}' scope. Create a key with it ticked in Workspace Settings -> Public API.`);
    }
    next();
  };
}
