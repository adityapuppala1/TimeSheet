/**
 * Admin-editable ticket type catalog (Bug/Task/Improvement seeded by default, admins can
 * add/rename/retire more). `Ticket.type` is a free string validated against the active rows
 * here rather than a hard-coded enum — mirrors how `Timesheet.activityType` already related
 * to `ActivityType` in this codebase, so new types never need a schema migration.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";

export const ticketTypeRouter = Router();
ticketTypeRouter.use(requireAuth);

ticketTypeRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const includeInactive = req.query.all === "true" && req.user!.permissions.includes(permissions.TICKETS_MANAGE);
  const types = await prisma.ticketType.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { createdAt: "asc" }
  });
  res.json(types);
});

const createSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(60),
    color: z.string().max(20).optional()
  })
});

ticketTypeRouter.post("/", requirePermission(permissions.TICKETS_MANAGE), validate(createSchema), async (req, res) => {
  const created = await prisma.ticketType.create({ data: { name: req.body.name, color: req.body.color } });
  await audit(req.user!.id, "ticket_type.created", "TicketType", created.id);
  res.status(201).json(created);
});

const patchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      name: z.string().min(1).max(60).optional(),
      color: z.string().max(20).optional().nullable(),
      isActive: z.boolean().optional()
    })
    .strict()
});

ticketTypeRouter.patch("/:id", requirePermission(permissions.TICKETS_MANAGE), validate(patchSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.name === "string") data.name = req.body.name;
  if ("color" in req.body) data.color = req.body.color;
  if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;

  const updated = await prisma.ticketType.update({ where: { id: String(req.params.id) }, data });
  await audit(req.user!.id, "ticket_type.updated", "TicketType", updated.id, data);
  res.json(updated);
});
