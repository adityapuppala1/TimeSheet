/**
 * HTTP surface for the on-demand AI capabilities (auto-triage suggestion, duplicate check,
 * writing assistant, comment summary, workspace Q&A). Each route just fetches the DB context
 * a capability needs and delegates the actual model call to `ai.service.ts` — the toggle/
 * budget gating lives there, not here, so these routes stay thin.
 * WHY a tighter 20/min rate limit than the global 120/min: AI calls cost money and take
 * longer than a normal request, so this router gets its own stricter cap.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import {
  answerWorkspaceQuestion,
  classifyTicket,
  findDuplicateTickets,
  improveText,
  summarizeComments
} from "../services/ai.service.js";
import { ticketProjectScope } from "../services/ticket.service.js";

export const aiRouter = Router();
aiRouter.use(requireAuth);

// AI calls cost real money and take longer than a normal request — a tighter cap
// than the global 120/min limiter in app.ts.
aiRouter.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true }));

const triageSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    title: z.string().min(3).max(255),
    description: z.string().max(20000).optional()
  })
});

aiRouter.post("/tickets/suggest-triage", requirePermission(permissions.TICKETS_WRITE), validate(triageSchema), async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.body.projectId, deletedAt: null },
    include: { modules: { select: { id: true, name: true } } }
  });
  if (!project) throw new AppError(404, "Project not found");

  const types = await prisma.ticketType.findMany({ where: { isActive: true }, select: { name: true } });

  const result = await classifyTicket({
    title: req.body.title,
    description: req.body.description,
    project,
    typeNames: types.map((t) => t.name),
    userId: req.user!.id
  });

  await audit(req.user!.id, "ai.triage_suggested", "Project", project.id, { title: req.body.title, ...result });
  res.json(result);
});

const duplicatesSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    title: z.string().min(3).max(255),
    description: z.string().max(20000).optional(),
    excludeTicketId: z.string().uuid().optional()
  })
});

aiRouter.post("/tickets/duplicates", requirePermission(permissions.TICKETS_WRITE), validate(duplicatesSchema), async (req, res) => {
  const candidates = await prisma.ticket.findMany({
    where: {
      projectId: req.body.projectId,
      deletedAt: null,
      status: { notIn: ["RESOLVED", "CLOSED"] },
      ...(req.body.excludeTicketId ? { id: { not: req.body.excludeTicketId } } : {})
    },
    select: { id: true, key: true, title: true, description: true },
    orderBy: { createdAt: "desc" },
    take: 100
  });

  const matches = await findDuplicateTickets({ title: req.body.title, description: req.body.description, candidates, userId: req.user!.id });
  res.json({ matches });
});

const improveSchema = z.object({
  body: z.object({
    text: z.string().min(1).max(20000),
    context: z.enum(["ticket_description", "comment"]).default("ticket_description")
  })
});

aiRouter.post("/text/improve", requirePermission(permissions.TICKETS_WRITE), validate(improveSchema), async (req, res) => {
  const result = await improveText({ text: req.body.text, context: req.body.context, userId: req.user!.id });
  res.json(result);
});

aiRouter.post("/tickets/:id/summarize", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticket = await prisma.ticket.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    include: { comments: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "asc" } } }
  });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && !scope.projectIds.includes(ticket.projectId)) throw new AppError(403, "Forbidden");
  if (ticket.comments.length === 0) throw new AppError(422, "This ticket has no comments to summarize yet.");

  const result = await summarizeComments({
    ticketTitle: ticket.title,
    comments: ticket.comments.map((c) => ({ authorName: c.author.name, body: c.body, createdAt: c.createdAt })),
    userId: req.user!.id
  });
  res.json(result);
});

const askSchema = z.object({ body: z.object({ question: z.string().min(3).max(500) }) });

aiRouter.post("/ask", requirePermission(permissions.TICKETS_VIEW), validate(askSchema), async (req, res) => {
  const scope = await ticketProjectScope(req);
  const tickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      ...(scope.unrestricted ? {} : { projectId: { in: scope.projectIds } })
    },
    select: { key: true, title: true, status: true, priority: true, description: true },
    orderBy: { updatedAt: "desc" },
    take: 150
  });
  if (tickets.length === 0) {
    return res.json({ answer: "There are no tickets in your accessible projects yet." });
  }

  const result = await answerWorkspaceQuestion({ question: req.body.question, tickets, userId: req.user!.id });
  res.json(result);
});
