import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePermission(permissions.AUDIT_VIEW));

/**
 * Bounded, validated query params. `action` and `entity` are constrained to a
 * reasonable character set so an attacker cannot probe Prisma string matching
 * with megabyte-sized payloads.
 */
const querySchema = z.object({
  query: z.object({
    action: z.string().max(80).regex(/^[a-zA-Z0-9._-]*$/).optional().or(z.literal("")),
    entity: z.string().max(80).regex(/^[a-zA-Z0-9._-]*$/).optional().or(z.literal("")),
    actorId: z.string().uuid().optional().or(z.literal("")),
    take: z.coerce.number().int().min(1).max(500).optional()
  })
});

auditRouter.get("/", validate(querySchema), async (req, res) => {
  const action = (req.query.action as string | undefined) || undefined;
  const entity = (req.query.entity as string | undefined) || undefined;
  const actor = (req.query.actorId as string | undefined) || undefined;
  const take = Math.min(Number(req.query.take ?? 100) || 100, 500);
  const rows = await prisma.auditLog.findMany({
    where: { action, entity, actorId: actor },
    orderBy: { createdAt: "desc" },
    take,
    include: { actor: { select: { id: true, name: true, email: true } } }
  });
  res.json(rows);
});
