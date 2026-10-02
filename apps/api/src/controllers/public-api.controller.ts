/**
 * Public REST API v1 — docs/ROADMAP.md's "Public REST API + outbound webhooks" theme, the
 * single biggest structural gap flagged there ("nothing external can react to a ticket/
 * timesheet event"). Mounted at /api/public/v1, AFTER the blanket tenant-resolution middleware
 * in app.ts (see middleware/public-api-auth.ts's header for why, unlike the CI/chat webhook
 * receivers, this one doesn't need path-param org resolution).
 *
 * Scope for this phase (see docs/API.md's "Public API" section for the full contract):
 *   - Read: list/get tickets, list timesheets.
 *   - Write: create a ticket, change a ticket's status (through the same
 *     services/ticket-transition.service.ts the app's own route, MCP and the security auto-reopen
 *     use — it used to be a copy here, and the copy had lost the notifications, the findings gate,
 *     the close digest and the audit action every ticket metric replays), and
 *     add a ticket comment. Timesheet writes remain unbuilt — creating one legitimately needs the
 *     same overlap-detection/SLA-deadline logic `timesheet.controller.ts#saveTimesheet` already
 *     owns, and duplicating that here risked exactly the kind of two-copies-drift-apart bug
 *     this app's "controllers stay thin, services own the logic" convention exists to prevent;
 *     it's a `saveTimesheet` extraction, not a new-code task, and deliberately left for that
 *     follow-up rather than rushed into this pass.
 * Every write here is attributed (audit log + `req.apiKey`) to the API key used, and every
 * mutation fires the same `dispatchOutboundWebhooks` call its authenticated-route equivalent
 * does, so an external integration driving the ticket lifecycle through this API looks
 * identical, from every other part of the app's perspective, to a human doing it from the UI.
 * Every API key is org-wide (same trust level as the CI ingestion token in
 * devops-webhook.controller.ts), not scoped to a subset of projects — see
 * middleware/public-api-auth.ts's header for why req.user-based ticketProjectScope() doesn't
 * apply here.
 */
import { Router } from "express";
import { z } from "zod";
import type { TicketStatus } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { publicApiAuth, requireWriteScope, type PublicApiRequest } from "../middleware/public-api-auth.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { emitDomainEvent } from "../services/domain-events.js";
import { transitionTicketStatus } from "../services/ticket-transition.service.js";
import { postTicketComment } from "../services/ticket-comment.service.js";
import {
  assertValidTicketType,
  computeTicketDueDate,
  getGlobalTicketSettings,
  issueTicketKey
} from "../services/ticket.service.js";
import { sanitizeRichText } from "../utils/sanitize.js";

export const publicApiRouter = Router();
publicApiRouter.use(publicApiAuth);

const PUBLIC_TICKET_SELECT = {
  id: true,
  key: true,
  type: true,
  title: true,
  description: true,
  priority: true,
  status: true,
  source: true,
  dueAt: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, code: true, name: true } },
  module: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, email: true } }
} as const;

publicApiRouter.get("/tickets", async (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
  const projectCode = typeof req.query.projectCode === "string" && req.query.projectCode ? req.query.projectCode : undefined;
  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  const tickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      ...(status ? { status: status as any } : {}),
      ...(projectCode ? { project: { code: projectCode } } : {})
    },
    select: PUBLIC_TICKET_SELECT,
    orderBy: { createdAt: "desc" },
    take
  });
  res.json({ items: tickets });
});

publicApiRouter.get("/tickets/:key", async (req, res) => {
  const ticket = await prisma.ticket.findFirst({
    where: { key: String(req.params.key), deletedAt: null },
    select: PUBLIC_TICKET_SELECT
  });
  if (!ticket) throw new AppError(404, "Ticket not found");
  res.json(ticket);
});

const createTicketSchema = z.object({
  body: z.object({
    projectCode: z.string().min(1).max(20),
    type: z.string().min(1).max(60).default("BUG"),
    title: z.string().min(3).max(255),
    description: z.string().max(20000).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM")
  })
});

publicApiRouter.post("/tickets", requireWriteScope, validate(createTicketSchema), async (req: PublicApiRequest, res) => {
  const project = await prisma.project.findFirst({ where: { code: req.body.projectCode, deletedAt: null } });
  if (!project) throw new AppError(422, `No project with code "${req.body.projectCode}"`);
  await assertValidTicketType(req.body.type);

  const apiKey = await prisma.apiKey.findUnique({ where: { id: req.apiKey!.id } });
  const reporterId = apiKey?.createdById;
  if (!reporterId) throw new AppError(500, "This API key has no attributable creator — regenerate it from Workspace Settings.");

  const cleanDescription = req.body.description ? sanitizeRichText(req.body.description) : null;
  const createdAt = new Date();
  const slaSettings = await getGlobalTicketSettings();

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, project.id);
    return tx.ticket.create({
      data: {
        key,
        projectId: project.id,
        type: req.body.type,
        title: req.body.title,
        description: cleanDescription,
        priority: req.body.priority,
        source: "API",
        reporterId,
        dueAt: computeTicketDueDate(createdAt, req.body.priority, slaSettings)
      },
      select: PUBLIC_TICKET_SELECT
    });
  });

  await audit(reporterId, "ticket.created_via_api", "Ticket", ticket.id, { apiKeyId: req.apiKey!.id });
  emitDomainEvent("ticket.created", { ticket });

  res.status(201).json(ticket);
});

const updateStatusSchema = z.object({
  body: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]) })
});

/**
 * The person an API key's writes are attributed to: whoever created it. Loaded with the name and
 * email the transition's notifications and close digest need, not just the id.
 */
async function apiKeyActor(req: PublicApiRequest): Promise<{ id: string; name: string; email: string }> {
  const apiKey = await prisma.apiKey.findUnique({ where: { id: req.apiKey!.id } });
  const creator = apiKey?.createdById
    ? await prisma.user.findUnique({ where: { id: apiKey.createdById }, select: { id: true, name: true, email: true } })
    : null;
  if (!creator) throw new AppError(500, "This API key has no attributable creator — regenerate it from Workspace Settings.");
  return creator;
}

publicApiRouter.patch(
  "/tickets/:key/status",
  requireWriteScope,
  validate(updateStatusSchema),
  async (req: PublicApiRequest, res) => {
    const existing = await prisma.ticket.findFirst({ where: { key: String(req.params.key), deletedAt: null }, select: { id: true } });
    if (!existing) throw new AppError(404, "Ticket not found");
    const actor = await apiKeyActor(req);

    // The same transition every other surface makes — legality, the change-ownership guard, the CI
    // and quality gates, the SLA clock on a reopen, the `ticket.status_changed` audit row (marked
    // `via: "api"`), the participants' notifications, the findings gate and the close digest. See
    // services/ticket-transition.service.ts for why there is exactly one.
    await transitionTicketStatus(existing.id, req.body.status as TicketStatus, { via: "api", user: actor, apiKeyId: req.apiKey!.id });

    // Re-read in this API's own published shape rather than returning the app's richer row.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: existing.id }, select: PUBLIC_TICKET_SELECT });
    res.json(ticket);
  }
);

const addCommentSchema = z.object({
  body: z.object({ body: z.string().min(1).max(20000) })
});

publicApiRouter.post(
  "/tickets/:key/comments",
  requireWriteScope,
  validate(addCommentSchema),
  async (req: PublicApiRequest, res) => {
    const ticket = await prisma.ticket.findFirst({ where: { key: String(req.params.key), deletedAt: null }, select: { id: true } });
    if (!ticket) throw new AppError(404, "Ticket not found");
    const author = await apiKeyActor(req);

    // The one comment path (services/ticket-comment.service.ts): sanitised, audited as
    // `ticket.commented` marked `via: "api"`, @mentions honoured, and the people on the ticket told.
    // This used to write the row and a `ticket.commented_via_api` audit entry, and tell nobody.
    const comment = await postTicketComment({ ticketId: ticket.id, author, body: req.body.body, via: "api", apiKeyId: req.apiKey!.id });

    res.status(201).json(comment);
  }
);

publicApiRouter.get("/timesheets", async (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
  const from = typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : undefined;
  const to = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : undefined;
  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  const timesheets = await prisma.timesheet.findMany({
    where: {
      deletedAt: null,
      ...(status ? { status: status as any } : {}),
      ...(from || to ? { workDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {})
    },
    select: {
      id: true,
      workDate: true,
      totalHours: true,
      status: true,
      taskDescription: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, code: true, name: true } }
    },
    orderBy: { workDate: "desc" },
    take
  });
  res.json({ items: timesheets });
});
