/**
 * WHAT: `audit()` — writes one row to the tenant `AuditLog` table.
 * WHY: every administrative/approval/AI action in this app should leave a trail, and a
 * per-entity Activity tab (tickets, in particular) is just this same log filtered to one
 * `entityId` — so a single generic write function here backs both the admin audit-log page and
 * every entity's own Activity tab, rather than maintaining two separate logging mechanisms.
 * WHO calls this: dozens of call sites across controllers/services whenever something
 * noteworthy happens (e.g. `settings.sso_updated`, `chat_intake.ticket_created`,
 * `user.profile_updated`) — `actorId` is `undefined` for system-triggered actions (email/chat
 * intake, cron workers) that have no human in the loop.
 */
import { prisma } from "../config/prisma.js";

export async function audit(actorId: string | undefined, action: string, entity: string, entityId?: string, metadata?: object) {
  await prisma.auditLog.create({ data: { actorId, action, entity, entityId, metadata } });
}

