/**
 * WHAT: the workspace-side half of the MCP server — the settings singleton a super admin edits,
 * the credential lookup that turns a bearer token into an acting user, and the catalogue
 * projection the settings UI renders.
 * WHY separate from services/mcp-tools.ts: that file owns what the tools DO and who may run them,
 * this one owns whether they are switched on at all and who is asking. Keeping them apart is also
 * what lets `mcp-tools.ts` export its registry without exporting a single handler (see its header)
 * — a dispatcher living in another module would have needed one.
 * WHO calls this: controllers/mcp.controller.ts (per request) and controllers/settings.controller.ts
 * (the admin surface).
 */
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";
import type { RequestUser } from "../middleware/auth.js";
import { isMaintenanceActive } from "./maintenance.service.js";
import { defaultEnabledFor, isToolEnabled, MCP_TOOLS, type McpEnablementSettings } from "./mcp-tools.js";

const GLOBAL_ID = "global";

/** Prefix on every issued token, so one found in a log or a config file is identifiable at a
 *  glance as a TimeSphere MCP credential (and greppable by a secret scanner). */
const TOKEN_PREFIX = "tsm_";

export type McpSettings = McpEnablementSettings & {
  updatedAt: Date;
  updatedById: string | null;
};

/** Upserted on read, same convention as every other Global* settings table — the first GET seeds
 *  the closed-by-default row instead of requiring a seed step. */
export async function getGlobalMcpSettings(): Promise<McpSettings> {
  const row = await prisma.globalMcpSettings.upsert({
    where: { id: GLOBAL_ID },
    update: {},
    create: { id: GLOBAL_ID }
  });
  return {
    enabled: row.enabled,
    allowWrites: row.allowWrites,
    toolOverrides: row.toolOverrides,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById
  };
}

export async function updateGlobalMcpSettings(
  actorId: string,
  patch: { enabled?: boolean; allowWrites?: boolean; toolOverrides?: Record<string, boolean> }
): Promise<McpSettings> {
  const row = await prisma.globalMcpSettings.upsert({
    where: { id: GLOBAL_ID },
    update: { ...patch, updatedById: actorId },
    create: { id: GLOBAL_ID, ...patch, updatedById: actorId }
  });
  return {
    enabled: row.enabled,
    allowWrites: row.allowWrites,
    toolOverrides: row.toolOverrides,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById
  };
}

/** One catalogue row for the settings UI: what the tool is, what it costs to enable, and whether
 *  it is live right now under the current settings. */
export interface McpCatalogueEntry {
  name: string;
  title: string;
  description: string;
  permission: string | null;
  mutating: boolean;
  destructive: boolean;
  untrustedContent: boolean;
  /** The workspace's explicit choice, or null when it has never expressed one. */
  override: boolean | null;
  defaultEnabled: boolean;
  /** The answer the MCP endpoint itself would give — already accounts for the master switch and
   *  the read-only latch, so the UI never has to re-derive the rule and get it subtly wrong. */
  effectiveEnabled: boolean;
}

export function describeMcpCatalogue(settings: McpEnablementSettings): McpCatalogueEntry[] {
  const overrides = (settings.toolOverrides ?? {}) as Record<string, unknown>;
  return MCP_TOOLS.map((spec) => {
    const override = overrides[spec.name];
    return {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      permission: spec.permission,
      mutating: spec.mutating,
      destructive: spec.destructive,
      untrustedContent: spec.untrustedContent,
      override: typeof override === "boolean" ? override : null,
      defaultEnabled: defaultEnabledFor(spec),
      effectiveEnabled: isToolEnabled(spec, settings)
    };
  });
}

/* ------------------------------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------------------------------ */

export function hashMcpToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/** 32 random bytes, hex — the same strength as the public API key, and long enough that the
 *  `tokenPrefix` kept for display leaks nothing useful about the rest. */
export function generateMcpToken(): { plaintext: string; tokenHash: string; tokenPrefix: string } {
  const plaintext = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  return { plaintext, tokenHash: hashMcpToken(plaintext), tokenPrefix: plaintext.slice(0, 12) };
}

export interface McpPrincipal {
  credentialId: string;
  credentialName: string;
  user: RequestUser;
}

/**
 * Resolve a bearer token to the person it acts as, or null.
 *
 * WHY THE USER IS LOADED IN FULL, role and permissions included: this is the MCP equivalent of
 * `middleware/auth.ts#requireAuth`, and it must produce the identical `req.user` shape, because
 * every downstream check reads that shape. Anything less would mean MCP callers being evaluated
 * against a different, thinner notion of identity than web callers — which is precisely how an
 * integration surface ends up more privileged than the UI.
 *
 * Returns null for every failure (no such token, revoked, the account since deactivated or
 * deleted) so the caller answers one indistinguishable 401 and this cannot be used to learn which
 * tokens exist.
 */
export async function resolveMcpPrincipal(plaintextToken: string): Promise<McpPrincipal | null> {
  const record = await prisma.mcpCredential.findUnique({
    where: { tokenHash: hashMcpToken(plaintextToken) },
    include: { user: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
  });
  if (!record || record.revokedAt) return null;

  const user = record.user;
  if (!user || user.deletedAt || user.status !== "ACTIVE") return null;

  // Same maintenance gate requireAuth applies, for the same reason: while a workspace is closed
  // for maintenance it is closed to integrations too, otherwise the one class of caller that
  // never sees the maintenance banner keeps writing to a database somebody is working on.
  if (user.role.name !== "SUPER_ADMIN" && (await isMaintenanceActive())) return null;

  // Fire-and-forget: "last used" is bookkeeping and must never fail a call.
  void prisma.mcpCredential.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return {
    credentialId: record.id,
    credentialName: record.name,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions: user.role.permissions.map((p) => p.permission.key)
    }
  };
}
