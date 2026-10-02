/**
 * Inbound SCIM 2.0 provisioning — a subset of RFC 7644 covering the /Users resource (create,
 * read, list-with-filter, PATCH active/deactivate, DELETE), the operations every SCIM-capable
 * IdP (Okta, Azure AD/Entra, OneLogin, ...) actually needs to push user lifecycle events into
 * an app. Mounted on `app` BEFORE the blanket `app.use("/api", resolveTenant)`, same reasoning
 * as devops-webhook.controller.ts/chat-webhook.controller.ts: the IdP calls a fixed base URL
 * with no Host-header subdomain to resolve a tenant from, so the org is identified directly
 * from the URL path (`/:orgSlug/v2/...`).
 *
 * Auth: one shared bearer token per org (ScimSettings.encryptedToken, generated from Workspace
 * Settings → Single sign-on), compared with `constantTimeEqual` — same pattern as
 * IngestionSettings' token. A 404 (not 401) when SCIM was never enabled for the org, same
 * "never configured" signal every other webhook receiver in this app gives.
 *
 * Deliberately NOT implemented (kept out to avoid building unverifiable surface — see
 * docs/ROADMAP.md's "Integrations" theme): Groups resource, ServiceProviderConfig/Schemas
 * discovery endpoints, and PUT (full-replace) on Users — most IdPs work fine with PATCH alone
 * for the lifecycle operations that matter (provision, deprovision, reactivate).
 */
import express, { Router, type Request } from "express";
import { z } from "zod";
import { getTenantClient, prisma } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import { hasRoomFor, seatHeadroom, syncSeatsAfterChange, takesASeat } from "../services/seats.service.js";
import { decryptSecret } from "../utils/encryption.js";
import { constantTimeEqual, hashPassword, opaqueToken } from "../utils/security.js";

export const scimRouter = Router();

/**
 * RFC 7644's media type. The app's global `express.json()` parses `application/json` only, so a
 * request from an IdP that labels its body correctly (`application/scim+json`, which Entra ID and
 * Okta send) arrived here with no body at all and was answered 400 — every create and every
 * deprovision. A body the global parser already read is not parsed twice.
 */
scimRouter.use(express.json({ type: ["application/scim+json"], limit: "1mb" }));

/**
 * SCIM's `active`, as IdPs actually send it. RFC 7643 makes it a boolean, but Entra ID's default
 * provisioning sends the STRING "True"/"False" (capitalised) unless an app opts into its compliant
 * mode — and reading only `typeof value === "boolean"` turned Entra's deprovision into a 200 that
 * left the person active. Anything else is "not said" rather than guessed.
 */
export function readScimActive(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  return undefined;
}

/** Same tenant-resolution-from-URL-path helper as devops-webhook.controller.ts's
 *  withOrgTenant — duplicated rather than imported since each ingest-style controller is an
 *  independent integration surface that happens to share this pattern, not a shared dependency. */
async function withOrgTenant<T>(orgSlug: string, fn: () => Promise<T>): Promise<T> {
  const org = await resolveActiveOrgBySlug(orgSlug);
  const dsn = decryptSecret(org.database!.encryptedDsn);
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, fn);
}

async function requireValidScimToken(req: Request): Promise<void> {
  const settings = await prisma.scimSettings.findUnique({ where: { id: "global" } });
  if (!settings?.isEnabled || !settings.encryptedToken) throw new AppError(404, "SCIM provisioning isn't enabled for this workspace.");

  const authHeaderRaw = req.headers.authorization;
  const authHeader = (Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw) ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!constantTimeEqual(bearerToken, decryptSecret(settings.encryptedToken))) {
    throw new AppError(401, "Invalid SCIM bearer token.");
  }
}

function scimError(status: number, detail: string) {
  return { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail };
}

type ScimUserRow = { id: string; name: string; email: string; status: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION"; scimExternalId: string | null };

function toScimUser(user: ScimUserRow, orgSlug: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    externalId: user.scimExternalId,
    userName: user.email,
    name: { formatted: user.name },
    emails: [{ value: user.email, primary: true }],
    active: user.status === "ACTIVE",
    meta: { resourceType: "User", location: `/api/scim/${orgSlug}/v2/Users/${user.id}` }
  };
}

const USER_SELECT = { id: true, name: true, email: true, status: true, scimExternalId: true } as const;

/**
 * GET /Users — supports the one filter form every IdP actually sends when checking whether a
 * user already exists before creating one: `userName eq "someone@example.com"`. Anything more
 * exotic (multi-clause filters, pagination beyond a flat list) isn't needed for this subset.
 */
scimRouter.get("/:orgSlug/v2/Users", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidScimToken(req);
      const { orgSlug } = requireTenantContext();
      const filter = String(req.query.filter ?? "");
      const emailMatch = filter.match(/userName eq "([^"]+)"/i);

      const users = await prisma.user.findMany({
        where: { deletedAt: null, ...(emailMatch ? { email: emailMatch[1] } : {}) },
        select: USER_SELECT,
        take: 200
      });

      res.json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: users.length,
        itemsPerPage: users.length,
        startIndex: 1,
        Resources: users.map((u) => toScimUser(u, orgSlug))
      });
    });
  } catch (error) {
    next(error);
  }
});

scimRouter.get("/:orgSlug/v2/Users/:id", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidScimToken(req);
      const { orgSlug } = requireTenantContext();
      const user = await prisma.user.findFirst({ where: { id: String(req.params.id), deletedAt: null }, select: USER_SELECT });
      if (!user) return res.status(404).json(scimError(404, "User not found"));
      res.json(toScimUser(user, orgSlug));
    });
  } catch (error) {
    next(error);
  }
});

const createUserSchema = z.object({
  userName: z.string().email(),
  externalId: z.string().max(255).optional(),
  name: z.object({ formatted: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  // Same "True"/"False" leniency as PATCH below (see readScimActive): an unreadable value fails the
  // schema rather than being taken as either answer.
  active: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const read = readScimActive(value);
      if (read === undefined) ctx.addIssue({ code: "custom", message: "active must be true or false" });
      return read;
    }),
  emails: z.array(z.object({ value: z.string().email() })).optional()
});

/**
 * POST /Users — provisions a new tenant User with the unusable-random-password pattern already
 * used for SSO-first-login accounts (see auth.service.ts#completeSsoLogin's own comment): a
 * SCIM-provisioned user is expected to authenticate via SSO, not a local password, so the hash
 * exists purely to satisfy User's required field. Always created as EMPLOYEE — same
 * "admin promotes afterward" posture as SSO auto-provisioning, since SCIM carries no reliable
 * signal for what role a person should have inside this app.
 */
scimRouter.post("/:orgSlug/v2/Users", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidScimToken(req);
      const { orgSlug } = requireTenantContext();
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json(scimError(400, "Invalid SCIM User payload."));
      const body = parsed.data;

      const existing = await prisma.user.findUnique({ where: { email: body.userName } });
      if (existing) return res.status(409).json(scimError(409, "A user with this userName already exists."));

      const seats = await seatHeadroom();
      if (!hasRoomFor(seats, 1)) return res.status(403).json(scimError(403, `Seat limit reached (${seats.limit} seats on the current plan).`));

      const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "EMPLOYEE" } });
      const name = body.name?.formatted || [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") || body.userName.split("@")[0];

      const user = await prisma.user.create({
        data: {
          name,
          email: body.userName,
          passwordHash: await hashPassword(opaqueToken()),
          roleId: employeeRole.id,
          status: body.active === false ? "INACTIVE" : "ACTIVE",
          scimExternalId: body.externalId,
          notificationPreference: { create: {} },
          // The account holds the role it was created with (the one-off multi-role backfill never
          // reaches accounts created after it). Nested, so the user and the row land together.
          userRoles: { create: { roleId: employeeRole.id } }
        },
        select: USER_SELECT
      });
      // The billed seat count follows — SCIM used to move it on no route at all.
      await syncSeatsAfterChange();

      res.status(201).json(toScimUser(user, orgSlug));
    });
  } catch (error) {
    next(error);
  }
});

const patchOperationSchema = z.object({
  Operations: z.array(
    z.object({
      op: z.string(),
      path: z.string().optional(),
      value: z.unknown().optional()
    })
  )
});

/** The `active` a PATCH's operations leave the user with, or undefined when none of them says. Both
 *  forms IdPs send: `{path:"active", value}` and the path-less `{value:{active}}`. The last one wins. */
function activeFromOperations(operations: Array<{ op: string; path?: string; value?: unknown }>): boolean | undefined {
  let nextActive: boolean | undefined;
  for (const operation of operations) {
    // Attribute names are case-insensitive in SCIM (RFC 7643 §2.1), so `path` is compared that way.
    const path = operation.path?.toLowerCase();
    if (operation.op.toLowerCase() !== "replace" || (path && path !== "active")) continue;
    const raw = path ? operation.value : (operation.value as { active?: unknown } | undefined)?.active;
    nextActive = readScimActive(raw) ?? nextActive;
  }
  return nextActive;
}

/**
 * PATCH /Users/:id — supports the one operation every IdP actually sends for lifecycle
 * management: `{"op":"replace","path":"active","value":false}` to deprovision (and the
 * `value:true` inverse to reactivate). Deprovisioning flips User.status to INACTIVE rather than
 * deleting — consistent with every other "remove" action in this app being a soft, reversible
 * state change, not a hard delete.
 *
 * Reactivation takes a seat exactly as provisioning does, and is refused the same way (403, the
 * SCIM error POST already returns) when the plan is full.
 */
scimRouter.patch("/:orgSlug/v2/Users/:id", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidScimToken(req);
      const { orgSlug } = requireTenantContext();
      const user = await prisma.user.findFirst({ where: { id: String(req.params.id), deletedAt: null }, select: { ...USER_SELECT, isAgent: true } });
      if (!user) return res.status(404).json(scimError(404, "User not found"));

      const parsed = patchOperationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json(scimError(400, "Invalid SCIM PATCH payload."));

      const nextActive = activeFromOperations(parsed.data.Operations);
      if (nextActive === undefined) return res.json(toScimUser(user, orgSlug));
      const nextStatus = nextActive ? "ACTIVE" : "INACTIVE";

      if (takesASeat(user, nextStatus)) {
        const seats = await seatHeadroom();
        if (!hasRoomFor(seats, 1)) return res.status(403).json(scimError(403, `Seat limit reached (${seats.limit} seats on the current plan).`));
      }
      const updated = await prisma.user.update({ where: { id: user.id }, data: { status: nextStatus }, select: USER_SELECT });
      if (nextStatus !== user.status) await syncSeatsAfterChange();

      res.json(toScimUser(updated, orgSlug));
    });
  } catch (error) {
    next(error);
  }
});

/** DELETE /Users/:id — same soft-deprovision semantics as the PATCH active:false path above,
 *  since RFC 7644 leaves the actual server-side effect of DELETE to the implementation and a
 *  hard delete would strand every other table's foreign keys into this user. */
scimRouter.delete("/:orgSlug/v2/Users/:id", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidScimToken(req);
      const user = await prisma.user.findFirst({ where: { id: String(req.params.id), deletedAt: null }, select: { id: true } });
      if (!user) return res.status(404).json(scimError(404, "User not found"));
      await prisma.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });
      await syncSeatsAfterChange();
      res.status(204).send();
    });
  } catch (error) {
    next(error);
  }
});
