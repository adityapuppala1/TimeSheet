import { prisma } from "../config/prisma.js";

export async function audit(actorId: string | undefined, action: string, entity: string, entityId?: string, metadata?: object) {
  await prisma.auditLog.create({ data: { actorId, action, entity, entityId, metadata } });
}

