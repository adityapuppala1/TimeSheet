/**
 * Admin-editable cross-cutting tags (e.g. "regression", "customer-reported") that attach to
 * tickets many-to-many via TicketLabel. CRUD lives here; the attach/detach-to-a-ticket routes
 * live on ticket.controller.ts since they modify the Ticket, not the Label catalog itself.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";

export const labelRouter = Router();
labelRouter.use(requireAuth);

labelRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  const labels = await prisma.label.findMany({ orderBy: { name: "asc" } });
  res.json(labels);
});

const createSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(60),
    color: z.string().max(20).optional()
  })
});

labelRouter.post("/", requirePermission(permissions.TICKETS_MANAGE), validate(createSchema), async (req, res) => {
  const created = await prisma.label.create({ data: { name: req.body.name, color: req.body.color } });
  await audit(req.user!.id, "label.created", "Label", created.id);
  res.status(201).json(created);
});

const patchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      name: z.string().min(1).max(60).optional(),
      color: z.string().max(20).optional().nullable()
    })
    .strict()
});

labelRouter.patch("/:id", requirePermission(permissions.TICKETS_MANAGE), validate(patchSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.name === "string") data.name = req.body.name;
  if ("color" in req.body) data.color = req.body.color;

  const updated = await prisma.label.update({ where: { id: String(req.params.id) }, data });
  await audit(req.user!.id, "label.updated", "Label", updated.id, data);
  res.json(updated);
});

labelRouter.delete("/:id", requirePermission(permissions.TICKETS_MANAGE), async (req, res) => {
  await prisma.label.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "label.deleted", "Label", String(req.params.id));
  res.status(204).send();
});
