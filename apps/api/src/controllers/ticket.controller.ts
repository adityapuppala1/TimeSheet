/**
 * The Jira-like ticketing surface: CRUD, status workflow, assignment, comments, attachments,
 * watchers, labels, cross-ticket links, sub-task checklists, and the AI-Activity-Log/ai-feedback
 * hooks that other AI features stamp onto a ticket.
 *
 * WHAT each major section does (see the "---------- X ----------" banner comments below):
 * list/detail/create/update own the core record; status enforces `ticketStatusTransitions`
 * (no illegal jump, e.g. OPEN straight to RESOLVED) and stamps resolvedAt/closedAt; watchers/
 * labels/links/checklist are the ticket's many-to-many "extras"; comments/attachments are the
 * collaboration surface.
 *
 * WHY status transitions are enforced server-side (not just hinted in the UI): the Kanban
 * board's drag-and-drop, the AI email-intake pipeline, and manual edits all funnel through this
 * same endpoint, so a single source of truth here is what makes "you can't drag a card
 * anywhere" or "email intake can't skip the review gate" actually true rather than just a UI
 * convention.
 *
 * WHO can touch what: `ticketProjectScope()` (project-visibility) and `canModifyTicket()`
 * (reporter/assignee/privileged-role check), both from ticket.service.ts, are re-checked on
 * every route that reads or writes a specific ticket — never trust that a client-supplied id
 * belongs to a project the caller can see.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions, ticketStatusTransitions, type TicketStatus } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { upload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import {
  assertValidTicketType,
  canModifyTicket,
  canReopenClosedTicket,
  computeTicketDueDate,
  getGlobalTicketSettings,
  isProjectMember,
  issueTicketKey,
  ticketProjectScope
} from "../services/ticket.service.js";
import { sanitizeRichText } from "../utils/sanitize.js";

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;
const TICKET_LINK_SUMMARY = { id: true, key: true, title: true, status: true, priority: true } as const;

/** Human label for a link, from the perspective of the ticket being viewed. */
function linkLabel(type: string, direction: "outgoing" | "incoming"): string {
  if (type === "BLOCKS") return direction === "outgoing" ? "Blocks" : "Blocked by";
  if (type === "DUPLICATE") return direction === "outgoing" ? "Duplicate of" : "Duplicated by";
  return "Relates to";
}

/** Merges linksFrom/linksTo into one `links` array, labeled from the viewed ticket's side. */
function serializeTicketLinks<T extends { linksFrom: any[]; linksTo: any[] }>(ticket: T) {
  const { linksFrom, linksTo, ...rest } = ticket;
  const links = [
    ...linksFrom.map((l) => ({ id: l.id, type: l.type, label: linkLabel(l.type, "outgoing"), ticket: l.targetTicket })),
    ...linksTo.map((l) => ({ id: l.id, type: l.type, label: linkLabel(l.type, "incoming"), ticket: l.sourceTicket }))
  ];
  return { ...rest, links };
}

export const ticketRouter = Router();
ticketRouter.use(requireAuth);

ticketRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && scope.projectIds.length === 0) return res.json([]);

  const statuses =
    typeof req.query.status === "string" && req.query.status
      ? req.query.status.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
  const priority = typeof req.query.priority === "string" && req.query.priority ? req.query.priority : undefined;
  const type = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
  const projectId = typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : undefined;
  const assigneeId = typeof req.query.assigneeId === "string" && req.query.assigneeId ? req.query.assigneeId : undefined;
  const source = typeof req.query.source === "string" && req.query.source ? req.query.source : undefined;
  const labelId = typeof req.query.labelId === "string" && req.query.labelId ? req.query.labelId : undefined;
  // AI Activity Log: every ticket an AI classifier touched, whether email-sourced or a manually-created
  // ticket where the operator accepted a triage suggestion (aiConfidence stamped at create time).
  const aiOnly = req.query.aiOnly === "true";

  const tickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      ...(scope.unrestricted ? {} : { projectId: { in: scope.projectIds } }),
      ...(projectId ? { projectId } : {}),
      ...(statuses && statuses.length ? { status: { in: statuses as TicketStatus[] } } : {}),
      ...(priority ? { priority: priority as any } : {}),
      ...(type ? { type: type as any } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(source ? { source: source as any } : {}),
      ...(labelId ? { labels: { some: { labelId } } } : {}),
      ...(aiOnly ? { OR: [{ source: "EMAIL" }, { aiConfidence: { not: null } }] } : {})
    },
    include: {
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY },
      labels: { include: { label: true } },
      _count: { select: { comments: true, attachments: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  res.json(tickets);
});

ticketRouter.get("/:id", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticket = await prisma.ticket.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    include: {
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY },
      watchers: { include: { user: { select: USER_SUMMARY } } },
      labels: { include: { label: true } },
      comments: { include: { author: { select: USER_SUMMARY } }, orderBy: { createdAt: "asc" } },
      attachments: { include: { uploadedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
      timesheets: {
        where: { deletedAt: null },
        select: { id: true, workDate: true, totalHours: true, user: { select: { id: true, name: true } } },
        orderBy: { workDate: "desc" }
      },
      checklistItems: { orderBy: { position: "asc" } },
      linksFrom: { include: { targetTicket: { select: TICKET_LINK_SUMMARY } } },
      linksTo: { include: { sourceTicket: { select: TICKET_LINK_SUMMARY } } }
    }
  });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && !scope.projectIds.includes(ticket.projectId)) throw new AppError(403, "Forbidden");

  res.json(serializeTicketLinks(ticket));
});

const createSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    moduleId: z.string().uuid().optional().or(z.literal("")),
    type: z.string().min(1).max(60).default("BUG"),
    title: z.string().min(3).max(255),
    description: z.string().max(20000).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    assigneeId: z.string().uuid().optional().or(z.literal("")),
    aiConfidence: z.number().min(0).max(1).optional()
  })
});

ticketRouter.post("/", requirePermission(permissions.TICKETS_WRITE), validate(createSchema), async (req, res) => {
  const isPrivileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
  if (!isPrivileged && !(await isProjectMember(req.user!.id, req.body.projectId))) {
    throw new AppError(403, "You are not assigned to this project");
  }

  const assigneeId = req.body.assigneeId || undefined;
  if (assigneeId && !isPrivileged && !(await isProjectMember(assigneeId, req.body.projectId))) {
    throw new AppError(422, "Assignee is not a member of this project");
  }
  await assertValidTicketType(req.body.type);

  const cleanDescription = req.body.description ? sanitizeRichText(req.body.description) : null;
  const priority = req.body.priority;
  const createdAt = new Date();
  const slaSettings = await getGlobalTicketSettings();

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, req.body.projectId);
    return tx.ticket.create({
      data: {
        key,
        projectId: req.body.projectId,
        moduleId: req.body.moduleId || null,
        type: req.body.type,
        title: req.body.title,
        description: cleanDescription,
        priority,
        reporterId: req.user!.id,
        assigneeId,
        aiConfidence: req.body.aiConfidence,
        dueAt: computeTicketDueDate(createdAt, priority, slaSettings)
      },
      include: {
        project: { select: { id: true, code: true, name: true } },
        module: { select: { id: true, name: true } },
        reporter: { select: USER_SUMMARY },
        assignee: { select: USER_SUMMARY }
      }
    });
  });

  await audit(req.user!.id, "ticket.created", "Ticket", ticket.id, { key: ticket.key });

  if (ticket.assignee && ticket.assignee.id !== req.user!.id) {
    await dispatchNotification({
      userId: ticket.assignee.id,
      category: "ticket.assigned",
      title: `Ticket assigned: ${ticket.key}`,
      body: `${req.user!.name} assigned "${ticket.title}" to you.`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.assigned",
        vars: {
          assigneeName: ticket.assignee.name,
          ticketKey: ticket.key,
          title: ticket.title,
          priority: ticket.priority,
          assignedBy: req.user!.name
        },
        fallback: {
          subject: `Ticket ${ticket.key} assigned to you`,
          html: templates.ticketAssigned({
            assigneeName: ticket.assignee.name,
            ticketKey: ticket.key,
            title: ticket.title,
            priority: ticket.priority,
            assignedBy: req.user!.name
          })
        }
      }
    });
  }

  res.status(201).json(ticket);
});

const patchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      title: z.string().min(3).max(255).optional(),
      description: z.string().max(20000).optional().nullable(),
      type: z.string().min(1).max(60).optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
      moduleId: z.string().uuid().optional().nullable()
    })
    .strict()
});

ticketRouter.patch("/:id", requirePermission(permissions.TICKETS_WRITE), validate(patchSchema), async (req, res) => {
  const existing = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Ticket not found");
  if (!canModifyTicket(req, existing)) throw new AppError(403, "Forbidden");
  if (typeof req.body.type === "string") await assertValidTicketType(req.body.type);

  const data: any = {};
  if (typeof req.body.title === "string") data.title = req.body.title;
  if ("description" in req.body) data.description = req.body.description ? sanitizeRichText(req.body.description) : null;
  if (typeof req.body.type === "string") data.type = req.body.type;
  if (typeof req.body.priority === "string") {
    data.priority = req.body.priority;
    const slaSettings = await getGlobalTicketSettings();
    data.dueAt = computeTicketDueDate(existing.createdAt, req.body.priority as any, slaSettings);
  }
  if ("moduleId" in req.body) data.moduleId = req.body.moduleId || null;

  const ticket = await prisma.ticket.update({
    where: { id: existing.id },
    data,
    include: {
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY }
    }
  });
  await audit(req.user!.id, "ticket.updated", "Ticket", ticket.id, data);
  res.json(ticket);
});

/* ---------- AI feedback (AI Activity Log page) ---------- */

const aiFeedbackSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ feedback: z.enum(["up", "down"]).nullable() })
});

ticketRouter.patch("/:id/ai-feedback", requirePermission(permissions.TICKETS_ASSIGN), validate(aiFeedbackSchema), async (req, res) => {
  const existing = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Ticket not found");

  const updated = await prisma.ticket.update({ where: { id: existing.id }, data: { aiFeedback: req.body.feedback } });
  await audit(req.user!.id, "ticket.ai_feedback_set", "Ticket", updated.id, { feedback: req.body.feedback });
  res.json({ id: updated.id, aiFeedback: updated.aiFeedback });
});

const statusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]) })
});

ticketRouter.patch("/:id/status", requirePermission(permissions.TICKETS_WRITE), validate(statusSchema), async (req, res) => {
  const existing = await prisma.ticket.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    include: { watchers: true }
  });
  if (!existing) throw new AppError(404, "Ticket not found");
  if (!canModifyTicket(req, existing)) throw new AppError(403, "Forbidden");

  const nextStatus = req.body.status as TicketStatus;
  const currentStatus = existing.status as TicketStatus;
  const allowed = ticketStatusTransitions[currentStatus] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new AppError(422, `Cannot move a ticket from ${currentStatus} to ${nextStatus}`);
  }
  if (currentStatus === "CLOSED" && nextStatus === "REOPENED" && !canReopenClosedTicket(req)) {
    throw new AppError(403, "Only an assigner or admin can reopen a closed ticket");
  }

  const data: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "RESOLVED") data.resolvedAt = new Date();
  if (nextStatus === "CLOSED") data.closedAt = new Date();
  if (nextStatus === "IN_PROGRESS" || nextStatus === "REOPENED") {
    data.resolvedAt = null;
    data.closedAt = null;
  }

  const ticket = await prisma.ticket.update({
    where: { id: existing.id },
    data,
    include: {
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY }
    }
  });
  await audit(req.user!.id, "ticket.status_changed", "Ticket", ticket.id, { from: currentStatus, to: nextStatus });

  const recipients = new Set<string>();
  if (existing.reporterId !== req.user!.id) recipients.add(existing.reporterId);
  if (existing.assigneeId && existing.assigneeId !== req.user!.id) recipients.add(existing.assigneeId);
  for (const watcher of existing.watchers) if (watcher.userId !== req.user!.id) recipients.add(watcher.userId);

  for (const userId of recipients) {
    await dispatchNotification({
      userId,
      category: "ticket.status_changed",
      title: `${ticket.key} moved to ${nextStatus}`,
      body: `${req.user!.name} moved "${ticket.title}" from ${currentStatus} to ${nextStatus}.`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.status_changed",
        vars: { ticketKey: ticket.key, title: ticket.title, from: currentStatus, to: nextStatus, changedBy: req.user!.name },
        fallback: {
          subject: `${ticket.key} moved to ${nextStatus}`,
          html: templates.ticketStatusChanged({
            ticketKey: ticket.key,
            title: ticket.title,
            from: currentStatus,
            to: nextStatus,
            changedBy: req.user!.name
          })
        }
      }
    });
  }

  res.json(ticket);
});

const assignSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ assigneeId: z.string().uuid().nullable() })
});

ticketRouter.patch("/:id/assign", requirePermission(permissions.TICKETS_ASSIGN), validate(assignSchema), async (req, res) => {
  const existing = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Ticket not found");

  const isPrivileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
  if (req.body.assigneeId && !isPrivileged && !(await isProjectMember(req.body.assigneeId, existing.projectId))) {
    throw new AppError(422, "Assignee is not a member of this project");
  }

  const ticket = await prisma.ticket.update({
    where: { id: existing.id },
    data: { assigneeId: req.body.assigneeId },
    include: {
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY }
    }
  });
  await audit(req.user!.id, "ticket.assigned", "Ticket", ticket.id, { assigneeId: req.body.assigneeId });

  if (ticket.assignee && ticket.assignee.id !== req.user!.id) {
    await dispatchNotification({
      userId: ticket.assignee.id,
      category: "ticket.assigned",
      title: `Ticket assigned: ${ticket.key}`,
      body: `${req.user!.name} assigned "${ticket.title}" to you.`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.assigned",
        vars: {
          assigneeName: ticket.assignee.name,
          ticketKey: ticket.key,
          title: ticket.title,
          priority: ticket.priority,
          assignedBy: req.user!.name
        },
        fallback: {
          subject: `Ticket ${ticket.key} assigned to you`,
          html: templates.ticketAssigned({
            assigneeName: ticket.assignee.name,
            ticketKey: ticket.key,
            title: ticket.title,
            priority: ticket.priority,
            assignedBy: req.user!.name
          })
        }
      }
    });
  }

  res.json(ticket);
});

ticketRouter.delete("/:id", requirePermission(permissions.TICKETS_MANAGE), async (req, res) => {
  const existing = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Ticket not found");
  await prisma.ticket.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  await audit(req.user!.id, "ticket.deleted", "Ticket", existing.id);
  res.status(204).send();
});

// Scoped, read-only audit view for a single ticket. Deliberately separate from
// GET /api/audit (gated by AUDIT_VIEW, admin-only) — anyone who can see a ticket
// should be able to see its own history, and that endpoint has no entityId filter.
ticketRouter.get("/:id/activity", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticket = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && !scope.projectIds.includes(ticket.projectId)) throw new AppError(403, "Forbidden");

  const activity = await prisma.auditLog.findMany({
    where: { entity: "Ticket", entityId: ticket.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { id: true, name: true, email: true } } }
  });
  res.json(activity);
});

/* ---------- Watchers ---------- */

ticketRouter.post("/:id/watchers", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticketId = String(req.params.id);
  const userId = typeof req.body?.userId === "string" && req.body.userId ? req.body.userId : req.user!.id;
  if (userId !== req.user!.id && !canReopenClosedTicket(req)) {
    throw new AppError(403, "You can only add yourself as a watcher");
  }
  const watcher = await prisma.ticketWatcher.upsert({
    where: { ticketId_userId: { ticketId, userId } },
    update: {},
    create: { ticketId, userId },
    include: { user: { select: USER_SUMMARY } }
  });
  await audit(req.user!.id, "ticket.watcher_added", "Ticket", ticketId, { userId });
  res.status(201).json(watcher);
});

ticketRouter.delete("/:id/watchers/:userId", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticketId = String(req.params.id);
  const userId = String(req.params.userId);
  if (userId !== req.user!.id && !canReopenClosedTicket(req)) {
    throw new AppError(403, "You can only remove yourself as a watcher");
  }
  await prisma.ticketWatcher.deleteMany({ where: { ticketId, userId } });
  await audit(req.user!.id, "ticket.watcher_removed", "Ticket", ticketId, { userId });
  res.status(204).send();
});

/* ---------- Labels ---------- */

ticketRouter.post("/:id/labels", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const ticketId = String(req.params.id);
  const labelId = typeof req.body?.labelId === "string" ? req.body.labelId : "";
  if (!labelId) throw new AppError(422, "labelId is required");

  const created = await prisma.ticketLabel.upsert({
    where: { ticketId_labelId: { ticketId, labelId } },
    update: {},
    create: { ticketId, labelId },
    include: { label: true }
  });
  await audit(req.user!.id, "ticket.label_added", "Ticket", ticketId, { labelId });
  res.status(201).json(created);
});

ticketRouter.delete("/:id/labels/:labelId", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const ticketId = String(req.params.id);
  const labelId = String(req.params.labelId);
  await prisma.ticketLabel.deleteMany({ where: { ticketId, labelId } });
  await audit(req.user!.id, "ticket.label_removed", "Ticket", ticketId, { labelId });
  res.status(204).send();
});

/* ---------- Links ---------- */

const createLinkSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    targetKey: z.string().min(1).max(20),
    type: z.enum(["BLOCKS", "DUPLICATE", "RELATES"])
  })
});

ticketRouter.post("/:id/links", requirePermission(permissions.TICKETS_WRITE), validate(createLinkSchema), async (req, res) => {
  const sourceId = String(req.params.id);
  const source = await prisma.ticket.findFirst({ where: { id: sourceId, deletedAt: null } });
  if (!source) throw new AppError(404, "Ticket not found");

  const target = await prisma.ticket.findFirst({ where: { key: req.body.targetKey.trim().toUpperCase(), deletedAt: null } });
  if (!target) throw new AppError(404, `No ticket found with key "${req.body.targetKey}"`);
  if (target.id === sourceId) throw new AppError(422, "A ticket cannot link to itself");

  const existing = await prisma.ticketLink.findFirst({
    where: { sourceTicketId: sourceId, targetTicketId: target.id, type: req.body.type }
  });
  if (existing) throw new AppError(422, `Already linked as "${req.body.type}"`);

  const created = await prisma.ticketLink.create({
    data: { sourceTicketId: sourceId, targetTicketId: target.id, type: req.body.type },
    include: { targetTicket: { select: TICKET_LINK_SUMMARY } }
  });
  await audit(req.user!.id, "ticket.link_added", "Ticket", sourceId, { targetTicketId: target.id, type: req.body.type });
  res.status(201).json({ id: created.id, type: created.type, label: linkLabel(created.type, "outgoing"), ticket: created.targetTicket });
});

ticketRouter.delete("/:id/links/:linkId", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const ticketId = String(req.params.id);
  const linkId = String(req.params.linkId);
  const link = await prisma.ticketLink.findFirst({
    where: { id: linkId, OR: [{ sourceTicketId: ticketId }, { targetTicketId: ticketId }] }
  });
  if (!link) throw new AppError(404, "Link not found");
  await prisma.ticketLink.delete({ where: { id: linkId } });
  await audit(req.user!.id, "ticket.link_removed", "Ticket", ticketId, { linkId });
  res.status(204).send();
});

/* ---------- Checklist ---------- */

const createChecklistSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ label: z.string().min(1).max(255) })
});

ticketRouter.post("/:id/checklist", requirePermission(permissions.TICKETS_WRITE), validate(createChecklistSchema), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null } });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const last = await prisma.ticketChecklistItem.findFirst({ where: { ticketId }, orderBy: { position: "desc" } });
  const created = await prisma.ticketChecklistItem.create({
    data: { ticketId, label: req.body.label.trim(), position: (last?.position ?? -1) + 1 }
  });
  await audit(req.user!.id, "ticket.checklist_item_added", "Ticket", ticketId, { itemId: created.id });
  res.status(201).json(created);
});

const patchChecklistSchema = z.object({
  params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
  body: z
    .object({
      label: z.string().min(1).max(255).optional(),
      done: z.boolean().optional()
    })
    .strict()
});

ticketRouter.patch("/:id/checklist/:itemId", requirePermission(permissions.TICKETS_WRITE), validate(patchChecklistSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.label === "string") data.label = req.body.label.trim();
  if (typeof req.body.done === "boolean") data.done = req.body.done;

  const updated = await prisma.ticketChecklistItem.update({
    where: { id: String(req.params.itemId) },
    data
  });
  res.json(updated);
});

ticketRouter.delete("/:id/checklist/:itemId", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  await prisma.ticketChecklistItem.delete({ where: { id: String(req.params.itemId) } });
  res.status(204).send();
});

const reorderChecklistSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ itemIds: z.array(z.string().uuid()).min(1) })
});

ticketRouter.patch("/:id/checklist-reorder", requirePermission(permissions.TICKETS_WRITE), validate(reorderChecklistSchema), async (req, res) => {
  const ticketId = String(req.params.id);
  const itemIds = req.body.itemIds as string[];

  const owned = await prisma.ticketChecklistItem.findMany({ where: { ticketId, id: { in: itemIds } }, select: { id: true } });
  if (owned.length !== itemIds.length) throw new AppError(422, "One or more items do not belong to this ticket");

  await prisma.$transaction(
    itemIds.map((itemId, index) => prisma.ticketChecklistItem.update({ where: { id: itemId }, data: { position: index } }))
  );
  const items = await prisma.ticketChecklistItem.findMany({ where: { ticketId }, orderBy: { position: "asc" } });
  res.json(items);
});

/* ---------- Comments ---------- */

ticketRouter.get("/:id/comments", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const comments = await prisma.ticketComment.findMany({
    where: { ticketId: String(req.params.id) },
    include: { author: { select: USER_SUMMARY } },
    orderBy: { createdAt: "asc" }
  });
  res.json(comments);
});

const commentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ body: z.string().min(1).max(10000) })
});

ticketRouter.post("/:id/comments", requirePermission(permissions.TICKETS_WRITE), validate(commentSchema), async (req, res) => {
  const ticket = await prisma.ticket.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    include: { watchers: true }
  });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const cleanBody = sanitizeRichText(req.body.body);
  const comment = await prisma.ticketComment.create({
    data: { ticketId: ticket.id, authorId: req.user!.id, body: cleanBody },
    include: { author: { select: USER_SUMMARY } }
  });
  await audit(req.user!.id, "ticket.commented", "Ticket", ticket.id);

  const recipients = new Set<string>();
  if (ticket.reporterId !== req.user!.id) recipients.add(ticket.reporterId);
  if (ticket.assigneeId && ticket.assigneeId !== req.user!.id) recipients.add(ticket.assigneeId);
  for (const watcher of ticket.watchers) if (watcher.userId !== req.user!.id) recipients.add(watcher.userId);

  for (const userId of recipients) {
    await dispatchNotification({
      userId,
      category: "ticket.commented",
      title: `New comment on ${ticket.key}`,
      body: `${req.user!.name} commented on "${ticket.title}".`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.commented",
        vars: { ticketKey: ticket.key, title: ticket.title, author: req.user!.name },
        fallback: {
          subject: `New comment on ${ticket.key}`,
          html: templates.ticketCommented({ ticketKey: ticket.key, title: ticket.title, author: req.user!.name })
        }
      }
    });
  }

  res.status(201).json(comment);
});

/* ---------- Attachments ---------- */

ticketRouter.post(
  "/:id/attachments",
  requirePermission(permissions.TICKETS_WRITE),
  upload.array("attachments"),
  async (req, res) => {
    const ticket = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
    if (!ticket) throw new AppError(404, "Ticket not found");

    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) throw new AppError(422, "No files uploaded");

    const created = await Promise.all(
      files.map((file) =>
        prisma.ticketAttachment.create({
          data: {
            ticketId: ticket.id,
            fileName: file.originalname,
            mimeType: file.mimetype || "application/octet-stream",
            url: `/uploads/${file.filename}`,
            sizeBytes: file.size,
            uploadedById: req.user!.id
          }
        })
      )
    );
    await audit(req.user!.id, "ticket.attachment_added", "Ticket", ticket.id, { count: created.length });
    res.status(201).json(created);
  }
);

ticketRouter.delete("/:id/attachments/:attachmentId", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const attachment = await prisma.ticketAttachment.findFirst({
    where: { id: String(req.params.attachmentId), ticketId: String(req.params.id) }
  });
  if (!attachment) throw new AppError(404, "Attachment not found");
  if (attachment.uploadedById !== req.user!.id && !req.user!.permissions.includes(permissions.TICKETS_MANAGE)) {
    throw new AppError(403, "Forbidden");
  }
  await prisma.ticketAttachment.delete({ where: { id: attachment.id } });
  await audit(req.user!.id, "ticket.attachment_removed", "Ticket", String(req.params.id), { attachmentId: attachment.id });
  res.status(204).send();
});
