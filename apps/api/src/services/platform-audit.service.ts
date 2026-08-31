/**
 * The control plane's own audit trail. A tenant's `AuditLog` cannot record an action taken ON the
 * tenant from outside it — provisioning, a rescue, a retention hold, the deletion itself — because
 * those happen before the tenant exists, or after it is gone, or by somebody who has no user row in
 * it. This is where they go. Never contains tenant content.
 *
 * Never throws: an audit row that cannot be written must not turn a successful deletion into a
 * thrown error half-way through a worker tick. It warns, loudly, instead.
 *
 * 5.0.0 — WHY THE SIXTH PARAMETER IS AN OBJECT AND NOT THREE MORE POSITIONALS. This function has
 * roughly thirty call sites, most of which pass four or five arguments and none of which want to
 * write `undefined, undefined, undefined` to reach the seventh. `PlatformProvenance` mirrors the
 * tenant `AuditProvenance` in services/audit.service.ts exactly, for the same reason and with the
 * same field names, so an engineer who has read one has read both. Spreading an absent provenance
 * contributes nothing, so every existing call still writes precisely the row it wrote before.
 */
import type { Prisma } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";

export type PlatformActorType = "PLATFORM_ADMIN" | "SYSTEM" | "CUSTOMER";

export interface PlatformProvenance {
  /**
   * WHY the operator did it, in their own words, captured at the moment of the action.
   *
   * The tenant `AuditLog` grew `before`/`after` because "an autonomous change nobody can
   * reconstruct is an autonomous change nobody can review". This is the harder half of that
   * problem: a control-plane row records something done TO a customer from outside their
   * workspace, where the customer cannot supply the context and the reviewer six months later has
   * no ticket to read. Collected by middleware/platform-admin-auth.ts#requirePlatformReason on
   * every route that touches a tenant or destroys something.
   */
  reason?: string;
  /** The state before and after. Only worth passing where a diff is meaningful. */
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /** `req.ip`. An administrative change made across tenant boundaries is exactly the row where
   *  "from where" matters — the tenant AuditLog's own comment says as much about its twin. */
  ipAddress?: string;
}

export async function platformAudit(
  actorType: PlatformActorType,
  actorLabel: string | null,
  action: string,
  entity: string,
  entityId?: string | null,
  metadata?: Record<string, unknown>,
  provenance?: PlatformProvenance
): Promise<void> {
  try {
    await controlPrisma.platformAuditLog.create({
      data: {
        actorType,
        actorLabel,
        action,
        entity,
        entityId: entityId ?? null,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
        ...provenance
      }
    });
  } catch (error) {
    console.warn(`[platform-audit] could not record ${action}: ${(error as Error).message}`);
  }
}

/**
 * The shorthand every console route now uses: pull the actor, the reason and the IP straight off
 * the request rather than re-deriving them at thirty call sites.
 *
 * Takes the pieces of a Request rather than a Request, so it stays callable from a replayed
 * two-person action — which has an approver and a stored reason but no live HTTP request at all.
 */
export function platformAuditFor(req: {
  platformAdmin?: { email: string };
  platformReason?: string;
  ip?: string;
}): (action: string, entity: string, entityId?: string | null, metadata?: Record<string, unknown>, extra?: PlatformProvenance) => Promise<void> {
  const label = req.platformAdmin?.email ?? "platform-admin";
  return (action, entity, entityId, metadata, extra) =>
    platformAudit("PLATFORM_ADMIN", label, action, entity, entityId, metadata, { reason: req.platformReason, ipAddress: req.ip, ...extra });
}
