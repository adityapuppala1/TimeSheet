/**
 * WHAT: a signed-in user's own in-app notification inbox — list (with unread count) and
 * mark-one/mark-all read.
 * WHY: separate from the workspace-wide notification *settings* (which category emails send at
 * all — that's SUPER_ADMIN-only, in settings.controller.ts) — this is purely "what's in my
 * bell icon," scoped to `req.user.id`, no permission beyond being logged in.
 * WHO calls this: `apps/web/src/components/NotificationsBell.tsx`. Rows themselves are created
 * by `services/notify.service.ts#dispatchNotification` from all over the app.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { shownInBell } from "../services/inbox.service.js";

export const notificationRouter = Router();
notificationRouter.use(requireAuth);

/**
 * The bell.
 *
 * IT RESPECTS THE INBOX'S TRIAGE STATE (fixed in V8 phase 2's follow-up). Before this, the bell
 * listed every row regardless, which made the two surfaces disagree about one table: snoozing an item
 * in the Inbox left it sitting in the bell — defeating the snooze — and an item marked done stayed
 * there too. The bell is the glance and the Inbox is the queue, but "what is still outstanding" has to
 * mean one thing in both.
 *
 * `handledAt: null` and a snooze that has not yet come round are the same predicate the Inbox's
 * "to do" filter uses. Anything hidden here is still reachable at /app/inbox under Snoozed or Done —
 * nothing is lost, it is just not shouting.
 */
// `shownInBell` lives in inbox.service.ts now, so the Inbox brief's "Unread notifications" counts
// exactly the rows this badge counts.

notificationRouter.get("/", async (req, res) => {
  const visible = shownInBell(req.user!.id, new Date());
  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where: visible, orderBy: { createdAt: "desc" }, take: 50 }),
    // Counted, not derived from the 50 listed: with the newest 50 all read and older ones unread,
    // the badge said nothing and "Mark all read" disappeared.
    prisma.notification.count({ where: { ...visible, readAt: null } })
  ]);
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
  const now = new Date();
  // Only what the bell shows. Marking a snoozed row read meant it returned from its snooze with no
  // dot and no count — the reason for snoozing it, gone.
  await prisma.notification.updateMany({
    where: { ...shownInBell(req.user!.id, now), readAt: null },
    data: { readAt: now }
  });
  res.status(204).send();
});

// Per-user notification preferences have been removed. The workspace-wide
// settings live at /api/settings/notifications and are SUPER_ADMIN only.
