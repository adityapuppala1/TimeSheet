/**
 * The control plane's own audit trail. A tenant's `AuditLog` cannot record an action taken ON the
 * tenant from outside it — provisioning, a rescue, a retention hold, the deletion itself — because
 * those happen before the tenant exists, or after it is gone, or by somebody who has no user row in
 * it. This is where they go. Never contains tenant content.
 *
 * Never throws: an audit row that cannot be written must not turn a successful deletion into a
 * thrown error half-way through a worker tick. It warns, loudly, instead.
 */
import { controlPrisma } from "../config/control-prisma.js";

export type PlatformActorType = "PLATFORM_ADMIN" | "SYSTEM" | "CUSTOMER";

export async function platformAudit(
  actorType: PlatformActorType,
  actorLabel: string | null,
  action: string,
  entity: string,
  entityId?: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await controlPrisma.platformAuditLog.create({
      data: {
        actorType,
        actorLabel,
        action,
        entity,
        entityId: entityId ?? null,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined
      }
    });
  } catch (error) {
    console.warn(`[platform-audit] could not record ${action}: ${(error as Error).message}`);
  }
}
