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

/**
 * Cheap aggregates for the Insights-dashboard's own top-line numbers (velocity, SLA compliance,
 * workload, cost), scoped the same way the ticket list above is — so "Ask AI" can answer
 * trend/aggregate questions grounded in real numbers, not just the raw ticket list. Deliberately
 * lighter than /reports/ticket-insights (no 8-week history, no cycle-time buckets): this runs
 * synchronously on every question, so it stays a handful of cheap counts, not the full dashboard
 * computation.
 */
async function buildInsightsSnapshotText(scope: Awaited<ReturnType<typeof ticketProjectScope>>): Promise<string> {
  const projectFilter = scope.unrestricted ? {} : { projectId: { in: scope.projectIds } };
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [openCount, resolvedThisWeek, resolvedLastWeek, slaBreaches, byAssignee, costSettings] = await Promise.all([
    prisma.ticket.count({ where: { deletedAt: null, ...projectFilter, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.ticket.count({ where: { deletedAt: null, ...projectFilter, resolvedAt: { gte: weekAgo } } }),
    prisma.ticket.count({ where: { deletedAt: null, ...projectFilter, resolvedAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
    prisma.ticket.count({
      where: { deletedAt: null, ...projectFilter, status: { notIn: ["RESOLVED", "CLOSED"] }, slaBreachAt: { not: null } }
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: { deletedAt: null, ...projectFilter, assigneeId: { not: null }, status: { notIn: ["RESOLVED", "CLOSED"] } },
      _count: true,
      orderBy: { _count: { assigneeId: "desc" } },
      take: 5
    }),
    prisma.globalTicketSettings.findUnique({ where: { id: "global" }, select: { enableCostAnalytics: true } })
  ]);

  const assigneeIds = byAssignee.map((r) => r.assigneeId).filter((id): id is string => Boolean(id));
  const assignees = await prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } });
  const workloadLine = byAssignee
    .map((r) => `${assignees.find((a) => a.id === r.assigneeId)?.name ?? "Unknown"}: ${r._count} open`)
    .join(", ");

  const lines = [
    `Open tickets: ${openCount}`,
    `Resolved this week: ${resolvedThisWeek} (last week: ${resolvedLastWeek})`,
    `Open SLA breaches: ${slaBreaches}`,
    `Top workload (open tickets by assignee): ${workloadLine || "(none assigned)"}`
  ];

  if (costSettings?.enableCostAnalytics) {
    const timesheets = await prisma.timesheet.findMany({
      where: { deletedAt: null, ticketId: { not: null }, ...(scope.unrestricted ? {} : { ticket: { projectId: { in: scope.projectIds } } }) },
      select: { totalHours: true, user: { select: { hourlyRate: true } } }
    });
    const totalCostUsd = timesheets.reduce((sum, t) => sum + Number(t.user.hourlyRate ?? 0) * Number(t.totalHours), 0);
    lines.push(`Total logged cost across tickets: $${totalCostUsd.toFixed(2)}`);
  }

  return lines.join("\n");
}

aiRouter.post("/ask", requirePermission(permissions.TICKETS_VIEW), validate(askSchema), async (req, res) => {
  const scope = await ticketProjectScope(req);
  const [tickets, insightsSnapshot] = await Promise.all([
    prisma.ticket.findMany({
      where: {
        deletedAt: null,
        ...(scope.unrestricted ? {} : { projectId: { in: scope.projectIds } })
      },
      select: { key: true, title: true, status: true, priority: true, description: true },
      orderBy: { updatedAt: "desc" },
      take: 150
    }),
    buildInsightsSnapshotText(scope)
  ]);
  if (tickets.length === 0) {
    return res.json({ answer: "There are no tickets in your accessible projects yet." });
  }

  const result = await answerWorkspaceQuestion({ question: req.body.question, tickets, insightsSnapshot, userId: req.user!.id });
  res.json(result);
});
