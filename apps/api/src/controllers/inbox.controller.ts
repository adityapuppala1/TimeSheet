/**
 * WHAT: the Inbox — triage over this person's own notifications, plus the daily brief.
 *
 * WHY EVERY ROUTE IS SCOPED TO `req.user!.id` AND NOTHING ELSE: a notification is addressed to a
 * person. There is no admin view of somebody else's inbox and no id-based lookup that could be
 * pointed at another user's row — every write is `updateMany` filtered on the owner, so a guessed
 * id updates nothing rather than somebody else's queue. That is deliberate: an inbox is the one
 * surface where "who is this for" IS the authorisation.
 *
 * WHY NO PERMISSION AND NO ENTITLEMENT GATE: see inbox.service.ts's header. This is the caller's
 * own queue, and the brief only ever counts what they can already see — the two sections that read
 * beyond their own work (timesheet approvals, project risk) are included only when they hold the
 * permission that already grants those pages.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { buildDailyBrief, inboxCounts, listInbox, type InboxFilter } from "../services/inbox.service.js";

export const inboxRouter = Router();
inboxRouter.use(requireAuth);

const FILTERS: InboxFilter[] = ["unhandled", "snoozed", "handled", "all"];

inboxRouter.get("/", async (req, res) => {
  const requested = String(req.query.filter ?? "unhandled") as InboxFilter;
  const filter = FILTERS.includes(requested) ? requested : "unhandled";
  res.json(await listInbox(req.user!.id, filter));
});

inboxRouter.get("/brief", async (req, res) => {
  res.json(await buildDailyBrief({ id: req.user!.id, permissions: req.user!.permissions }));
});

const patchSchema = z.object({
  body: z
    .object({
      handled: z.boolean().optional(),
      read: z.boolean().optional(),
      /** ISO instant, or null to un-snooze. Bounded to a year out: a five-year snooze is a delete
       *  wearing a friendlier label, and the row should not silently outlive the work. */
      snoozeUntil: z.string().datetime().nullable().optional()
    })
    .strict()
});

inboxRouter.patch("/:id", validate(patchSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>["body"];
  const data: Record<string, unknown> = {};
  if (body.handled !== undefined) data.handledAt = body.handled ? new Date() : null;
  if (body.read !== undefined) data.readAt = body.read ? new Date() : null;
  if (body.snoozeUntil !== undefined) {
    if (body.snoozeUntil === null) data.snoozedUntil = null;
    else {
      const until = new Date(body.snoozeUntil);
      const maxima = new Date(Date.now() + 365 * 86_400_000);
      if (until > maxima) data.snoozedUntil = maxima;
      else data.snoozedUntil = until;
      // Snoozing implies having seen it. Leaving it unread would make the bell keep insisting
      // about something the person has explicitly deferred.
      if (until > new Date()) data.readAt = data.readAt ?? new Date();
    }
  }

  // updateMany + the owner filter: a guessed id belonging to somebody else matches zero rows.
  const result = await prisma.notification.updateMany({ where: { id: String(req.params.id), userId: req.user!.id }, data });
  if (result.count === 0) {
    res.status(404).json({ message: "Notification not found." });
    return;
  }
  res.json(await inboxCounts(req.user!.id));
});

/** Clears the whole visible queue. Marks handled, never deletes: the row is the record that the
 *  person was told, and a support question a month later is answered by it. */
inboxRouter.post("/handle-all", async (req, res) => {
  const now = new Date();
  await prisma.notification.updateMany({
    where: {
      userId: req.user!.id,
      handledAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
    },
    data: { handledAt: now, readAt: now }
  });
  res.json(await inboxCounts(req.user!.id));
});
