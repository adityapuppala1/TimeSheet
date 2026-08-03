/**
 * WHAT: proofing — pin and region comments anchored to a point on an attached image or PDF.
 *
 * WHY COORDINATES ARE NORMALISED 0-1 AND NOT PIXELS: the same annotation has to land on the same
 * spot when the file is viewed on a phone, on a 4K monitor, and inside a PDF export — three
 * different render sizes. Storing pixels would mean storing the viewport that happened to be open
 * when someone clicked, and every other viewer would see the pin somewhere else.
 *
 * WHY THREADING IS ONE LEVEL IN PRACTICE: a reply carries `parentId`, and the UI renders replies
 * under their root. Arbitrary nesting was not modelled because a review conversation about one
 * spot on one image is a thread, not a tree, and deep nesting makes the rail unreadable at the
 * width it has to live in.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { assertPlanningCapability } from "../services/planning.service.js";
import { assertTicketVisible } from "../services/ticket.service.js";

export const proofRouter = Router();
proofRouter.use(requireAuth);

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

const assertProofingEnabled = () => assertPlanningCapability("enableProofing", "proofingEnabled", "Proofing");

/** Every annotation on one attachment, roots first with their replies attached. */
proofRouter.get(
  "/attachment/:attachmentId",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ attachmentId: z.string().uuid() }) })),
  async (req, res) => {
    await assertProofingEnabled();
    const attachment = await prisma.ticketAttachment.findUnique({
      where: { id: String(req.params.attachmentId) },
      select: { id: true, ticket: { select: { projectId: true } } }
    });
    if (!attachment) throw new AppError(404, "Attachment not found");
    await assertTicketVisible(req, attachment.ticket.projectId);

    const rows = await prisma.proofAnnotation.findMany({
      where: { attachmentId: attachment.id },
      include: { author: { select: USER_SUMMARY } },
      orderBy: { createdAt: "asc" }
    });

    const roots = rows.filter((r) => !r.parentId);
    res.json(
      roots.map((root) => ({
        ...root,
        replies: rows.filter((r) => r.parentId === root.id)
      }))
    );
  }
);

const createSchema = z.object({
  params: z.object({ attachmentId: z.string().uuid() }),
  body: z
    .object({
      // Normalised, so the pin survives any render size. Clamped at the edges rather than
      // rejected — a click one pixel outside the image is a click on the image.
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1).nullish(),
      h: z.number().min(0).max(1).nullish(),
      pageIndex: z.number().int().min(0).max(2000).nullish(),
      body: z.string().min(1).max(4000),
      parentId: z.string().uuid().nullish()
    })
    .strict()
});

proofRouter.post(
  "/attachment/:attachmentId",
  requirePermission(permissions.TICKETS_WRITE),
  validate(createSchema),
  async (req, res) => {
    await assertProofingEnabled();
    const attachment = await prisma.ticketAttachment.findUnique({
      where: { id: String(req.params.attachmentId) },
      select: { id: true, ticketId: true, ticket: { select: { projectId: true } } }
    });
    if (!attachment) throw new AppError(404, "Attachment not found");
    await assertTicketVisible(req, attachment.ticket.projectId);

    if (req.body.parentId) {
      const parent = await prisma.proofAnnotation.findUnique({
        where: { id: req.body.parentId },
        select: { id: true, attachmentId: true, parentId: true }
      });
      if (!parent || parent.attachmentId !== attachment.id) {
        throw new AppError(404, "The comment being replied to is not on this file.");
      }
      // Replies attach to a root, never to another reply — see the file header on why the thread
      // is deliberately one level deep.
      if (parent.parentId) throw new AppError(400, "Reply to the original comment rather than to a reply.");
    }

    const created = await prisma.proofAnnotation.create({
      data: {
        attachmentId: attachment.id,
        authorId: req.user!.id,
        x: req.body.x,
        y: req.body.y,
        w: req.body.w ?? null,
        h: req.body.h ?? null,
        pageIndex: req.body.pageIndex ?? null,
        // Stored verbatim and rendered as plain text. Proofing notes are short review comments,
        // not documents, so there is nothing to gain from allowing markup and a stored-XSS
        // surface to lose.
        body: req.body.body,
        parentId: req.body.parentId ?? null
      },
      include: { author: { select: USER_SUMMARY } }
    });

    await audit(req.user!.id, "proof.annotation_added", "ProofAnnotation", created.id, { ticketId: attachment.ticketId });
    res.status(201).json({ ...created, replies: [] });
  }
);

/** Resolving is a toggle, not a delete: a resolved note is the record of a review round, and
 *  deleting it loses why a change was made. */
proofRouter.patch(
  "/:id/resolve",
  requirePermission(permissions.TICKETS_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ resolved: z.boolean() }).strict() })),
  async (req, res) => {
    await assertProofingEnabled();
    const annotation = await prisma.proofAnnotation.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, attachment: { select: { ticket: { select: { projectId: true } } } } }
    });
    if (!annotation) throw new AppError(404, "Comment not found");
    await assertTicketVisible(req, annotation.attachment.ticket.projectId);

    const updated = await prisma.proofAnnotation.update({
      where: { id: annotation.id },
      data: { resolvedAt: req.body.resolved ? new Date() : null }
    });
    res.json({ id: updated.id, resolvedAt: updated.resolvedAt });
  }
);

proofRouter.delete(
  "/:id",
  requirePermission(permissions.TICKETS_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertProofingEnabled();
    const annotation = await prisma.proofAnnotation.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, authorId: true, attachment: { select: { ticket: { select: { projectId: true } } } } }
    });
    if (!annotation) throw new AppError(404, "Comment not found");
    await assertTicketVisible(req, annotation.attachment.ticket.projectId);

    // Own comments only, unless you can manage tickets. Someone deleting another reviewer's
    // objection is exactly what a review record must not allow.
    const privileged = req.user!.permissions.includes(permissions.TICKETS_MANAGE);
    if (annotation.authorId !== req.user!.id && !privileged) {
      throw new AppError(403, "You can only remove your own comments.");
    }

    await prisma.proofAnnotation.delete({ where: { id: annotation.id } });
    await audit(req.user!.id, "proof.annotation_deleted", "ProofAnnotation", annotation.id);
    res.status(204).end();
  }
);
