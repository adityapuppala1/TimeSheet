import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const notificationRouter = Router();
notificationRouter.use(requireAuth);

notificationRouter.get("/", async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const unread = notifications.filter((n) => !n.readAt).length;
  res.json({ items: notifications, unread });
});

notificationRouter.post(
  "/:id/read",
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const id = String(req.params.id);
    const userId = req.user!.id;
    await prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() }
    });
    res.status(204).send();
  }
);

notificationRouter.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null },
    data: { readAt: new Date() }
  });
  res.status(204).send();
});

// Per-user notification preferences have been removed. The workspace-wide
// settings live at /api/settings/notifications and are SUPER_ADMIN only.
