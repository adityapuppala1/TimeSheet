/**
 * HTTP surface for the on-demand AI capabilities (auto-triage suggestion, duplicate check,
 * writing assistant, comment summary, workspace Q&A). Each route just fetches the DB context
 * a capability needs and delegates the actual model call to `ai.service.ts` — the toggle/
 * budget gating lives there, not here, so these routes stay thin.
 * WHY a tighter 20/min rate limit than the global 120/min: AI calls cost money and take
 * longer than a normal request, so this router gets its own stricter cap.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { aiRateLimit } from "../middleware/ai-rate-limit.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import {
  answerWorkspaceQuestion,
  classifyTicket,
  findDuplicateTickets,
  getTextRefineAvailability,
  improveText,
  refineText,
  summarizeComments,
  type RefineField
} from "../services/ai.service.js";
import {
  addDatasetItemFromInteraction,
  createDataset,
  deleteDatasetItem,
  getDataset,
  listDatasets,
  listPromotableInteractions
} from "../services/ai-dataset.service.js";
import {
  activatePromptVersion,
  getPromptTemplate,
  listPromptTemplates,
  previewPrompt,
  savePromptVersion
} from "../services/ai-prompt.service.js";
import { enqueueEvalRun, getEvalRun, isReplayable, listEvalRuns } from "../services/ai-eval.service.js";
import { setInteractionFeedback } from "../services/ai-quality.service.js";
import { computeTimesheetCost } from "../services/billing-rate.service.js";
import { assertTicketVisible, ticketProjectScope } from "../services/ticket.service.js";

export const aiRouter = Router();
aiRouter.use(requireAuth);

/**
 * "Can I offer the Refine button, and if not, what do I tell the user?" — registered ABOVE the
 * rate limiter on purpose: it makes no model call and costs nothing, and every form carrying the
 * affordance asks on mount. Counting it against the 20/min AI budget would mean opening the
 * timesheet form twenty times locks a user out of the actual refinements.
 */
aiRouter.get("/text/refine/availability", async (_req, res) => {
  res.json(await getTextRefineAvailability());
});

// AI calls cost real money and take longer than a normal request — a tighter cap
// than the global limiter in app.ts, and keyed per USER rather than per IP so a shared office
// address isn't one allowance for everyone in it. See middleware/ai-rate-limit.ts.
aiRouter.use(aiRateLimit);

const triageSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    title: z.string().min(3).max(255),
    description: z.string().max(20000).optional()
  })
});

/**
 * `tickets:write` is held tenant-wide, so it says whether you may create tickets AT ALL, not which
 * projects you may create them in — the same distinction `POST /tickets/:id/summarize` below and
 * `GET /ai-proposals` already draw. Without `assertTicketVisible` this route (and `/duplicates`)
 * accepted any project id in the workspace, spending the workspace's AI budget on a project the
 * caller cannot open and, for duplicates, answering with its ticket keys and titles.
 */
aiRouter.post("/tickets/suggest-triage", requirePermission(permissions.TICKETS_WRITE), validate(triageSchema), async (req, res) => {
  await assertTicketVisible(req, req.body.projectId);

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
  await assertTicketVisible(req, req.body.projectId);

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

const refineSchema = z.object({
  body: z.object({
    text: z.string().min(1).max(20000),
    field: z.enum(["ticket_title", "ticket_description", "ticket_comment", "timesheet_description", "timesheet_notes"])
  })
});

/**
 * Which permission each refinable field needs. The rest of this router is ticket work, so it can
 * hang one `requirePermission(TICKETS_WRITE)` off each route; refine also covers timesheet fields,
 * and an EMPLOYEE who fills in a timesheet has no reason to hold tickets:write. Gating on the
 * field keeps "can you edit this text at all" and "can you have the AI tidy it" the same answer.
 */
const REFINE_FIELD_PERMISSION: Record<RefineField, string> = {
  ticket_title: permissions.TICKETS_WRITE,
  ticket_description: permissions.TICKETS_WRITE,
  ticket_comment: permissions.TICKETS_WRITE,
  timesheet_description: permissions.TIMESHEETS_WRITE,
  timesheet_notes: permissions.TIMESHEETS_WRITE
};

// `validate` runs first so `field` is a known value by the time the permission is looked up.
aiRouter.post("/text/refine", validate(refineSchema), async (req, res) => {
  const field = req.body.field as RefineField;
  if (!req.user!.permissions.includes(REFINE_FIELD_PERMISSION[field])) throw new AppError(403, "Forbidden");

  const result = await refineText({ text: req.body.text, field, userId: req.user!.id });
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
    // Same basis and same shared formula as GET /reports/cost-insights — approved, billable hours
    // only, snapshot rate preferred over live. This used to be a duplicated inline reduce that
    // counted DRAFT/REJECTED hours too, so "Ask AI" could quote a different (higher) total than
    // the Insights page for the same workspace.
    const timesheets = await prisma.timesheet.findMany({
      where: {
        deletedAt: null,
        ticketId: { not: null },
        status: "APPROVED",
        billable: true,
        ...(scope.unrestricted ? {} : { ticket: { projectId: { in: scope.projectIds } } })
      },
      select: { totalHours: true, billable: true, billedAmount: true, billedRate: true, user: { select: { hourlyRate: true } } }
    });
    const { amount, unratedHours } = computeTimesheetCost(
      timesheets.map((t) => ({
        totalHours: t.totalHours,
        billable: t.billable,
        billedAmount: t.billedAmount,
        billedRate: t.billedRate,
        liveFallbackRate: t.user.hourlyRate
      }))
    );
    lines.push(
      `Total approved billable cost across tickets: $${amount.toFixed(2)}` +
        (unratedHours > 0 ? ` (excludes ${unratedHours.toFixed(2)}h with no rate on record)` : "")
    );
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

/**
 * Rate ONE captured AI interaction.
 *
 * Distinct from the pre-existing `PATCH /tickets/:id/ai-feedback`, which sets a single flag on the
 * whole ticket. That endpoint predates interaction capture and is deliberately left working
 * byte-for-byte — but it can't express "the triage was good, the duplicate detection was wrong"
 * about the same ticket, and it isn't attached to anything replayable. This is.
 */
const interactionFeedbackSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    feedback: z.enum(["up", "down"]).nullable(),
    note: z.string().max(500).optional()
  })
});

aiRouter.patch(
  "/interactions/:id/feedback",
  requirePermission(permissions.TICKETS_ASSIGN),
  validate(interactionFeedbackSchema),
  async (req, res) => {
    const existing = await prisma.aIInteraction.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
    if (!existing) throw new AppError(404, "Interaction not found");

    await setInteractionFeedback({
      interactionId: existing.id,
      feedback: req.body.feedback,
      userId: req.user!.id,
      note: req.body.note
    });
    await audit(req.user!.id, "ai.interaction_feedback", "AIInteraction", existing.id, { feedback: req.body.feedback });
    res.json({ id: existing.id, feedback: req.body.feedback });
  }
);

/* ---------- Golden datasets ---------- */
// See services/ai-dataset.service.ts. SUPER_ADMIN-only: a golden set defines what "correct" means
// for a workspace's AI, and eval runs are built on it — that's configuration, not day-to-day work.

const createDatasetSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    feature: z.string().min(1).max(60),
    description: z.string().max(500).optional()
  })
});

aiRouter.get("/datasets", requireSuperAdmin, async (_req, res) => {
  res.json(await listDatasets());
});

aiRouter.post("/datasets", requireSuperAdmin, validate(createDatasetSchema), async (req, res) => {
  const created = await createDataset({
    name: req.body.name,
    feature: req.body.feature,
    description: req.body.description,
    userId: req.user!.id
  });
  await audit(req.user!.id, "ai.dataset_created", "AIDataset", created.id, { name: created.name, feature: created.feature });
  res.status(201).json(created);
});

aiRouter.get("/datasets/:id", requireSuperAdmin, async (req, res) => {
  const dataset = await getDataset(String(req.params.id));
  // Told up front so the UI can explain why "Run evaluation" is unavailable, instead of offering
  // a button that 422s. Not every captured capability has a replayer yet.
  res.json({ ...dataset, replayable: isReplayable(dataset.feature) });
});

/** Candidate interactions to promote. Defaults to problems only — the ones worth correcting. */
aiRouter.get("/datasets/:id/candidates", requireSuperAdmin, async (req, res) => {
  const dataset = await getDataset(String(req.params.id));
  res.json(
    await listPromotableInteractions({
      feature: dataset.feature,
      onlyProblems: req.query.all === "true" ? false : true,
      limit: Number(req.query.limit) || 25
    })
  );
});

const addItemSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    interactionId: z.string().uuid(),
    expectedOutput: z.string().min(1).max(20000),
    expectedKind: z.enum(["EXACT_FIELDS", "CONTAINS", "JUDGE"]).optional(),
    notes: z.string().max(500).optional()
  })
});

aiRouter.post("/datasets/:id/items", requireSuperAdmin, validate(addItemSchema), async (req, res) => {
  const item = await addDatasetItemFromInteraction({
    datasetId: String(req.params.id),
    interactionId: req.body.interactionId,
    expectedOutput: req.body.expectedOutput,
    expectedKind: req.body.expectedKind,
    notes: req.body.notes,
    userId: req.user!.id
  });
  await audit(req.user!.id, "ai.dataset_item_added", "AIDatasetItem", item.id, { datasetId: item.datasetId });
  res.status(201).json(item);
});

aiRouter.delete("/datasets/:id/items/:itemId", requireSuperAdmin, async (req, res) => {
  await deleteDatasetItem(String(req.params.id), String(req.params.itemId));
  await audit(req.user!.id, "ai.dataset_item_removed", "AIDatasetItem", String(req.params.itemId), {});
  res.status(204).send();
});

/* ---------- Eval runs ---------- */
// See services/ai-eval.service.ts for the three budget layers. Enqueue only — the run itself is
// executed by workers/ai-eval.worker.ts, because it's N real LLM calls and would time out here.

aiRouter.get("/evals", requireSuperAdmin, async (req, res) => {
  res.json(await listEvalRuns(req.query.datasetId ? String(req.query.datasetId) : undefined));
});

aiRouter.get("/evals/:id", requireSuperAdmin, async (req, res) => {
  res.json(await getEvalRun(String(req.params.id)));
});

const enqueueEvalSchema = z.object({
  body: z.object({
    datasetId: z.string().uuid(),
    /** Which prompt version to measure. Null/absent means the built-in prompt — the baseline. */
    promptVersionId: z.string().uuid().nullish()
  })
});

aiRouter.post("/evals", requireSuperAdmin, validate(enqueueEvalSchema), async (req, res) => {
  const run = await enqueueEvalRun({
    datasetId: req.body.datasetId,
    promptVersionId: req.body.promptVersionId,
    userId: req.user!.id
  });
  await audit(req.user!.id, "ai.eval_enqueued", "AIEvalRun", run.id, {
    datasetId: run.datasetId,
    itemCount: run.itemCount,
    estimatedCostUsd: run.estimatedCostUsd
  });
  res.status(201).json(run);
});

/* ---------- Prompt versioning ---------- */
// See services/ai-prompt.service.ts for the allowlist and the never-throw guarantee. SUPER_ADMIN
// only: editing a prompt changes what every user of that capability gets, workspace-wide.

aiRouter.get("/prompts", requireSuperAdmin, async (_req, res) => {
  res.json(await listPromptTemplates());
});

aiRouter.get("/prompts/:feature", requireSuperAdmin, async (req, res) => {
  res.json(await getPromptTemplate(String(req.params.feature)));
});

const promptBodySchema = z.object({
  params: z.object({ feature: z.string().min(1).max(60) }),
  body: z.object({ body: z.string().max(20000), note: z.string().max(300).optional(), activate: z.boolean().optional() })
});

/** Dry run against the capability's sample values — nothing is saved, nothing is charged. */
aiRouter.post("/prompts/:feature/preview", requireSuperAdmin, validate(promptBodySchema), async (req, res) => {
  res.json(previewPrompt(String(req.params.feature), req.body.body));
});

aiRouter.post("/prompts/:feature/versions", requireSuperAdmin, validate(promptBodySchema), async (req, res) => {
  const version = await savePromptVersion({
    feature: String(req.params.feature),
    body: req.body.body,
    note: req.body.note,
    activate: req.body.activate,
    userId: req.user!.id
  });
  await audit(req.user!.id, "ai.prompt_version_saved", "AIPromptVersion", version.id, {
    feature: req.params.feature,
    version: version.version,
    activated: req.body.activate !== false
  });
  res.status(201).json(version);
});

const activateSchema = z.object({
  params: z.object({ feature: z.string().min(1).max(60) }),
  /** null is revert-to-built-in, which is a first-class state rather than a missing value. */
  body: z.object({ versionId: z.string().uuid().nullable() })
});

aiRouter.post("/prompts/:feature/activate", requireSuperAdmin, validate(activateSchema), async (req, res) => {
  await activatePromptVersion(String(req.params.feature), req.body.versionId);
  await audit(req.user!.id, "ai.prompt_version_activated", "AIPromptTemplate", String(req.params.feature), {
    versionId: req.body.versionId
  });
  res.status(204).send();
});
