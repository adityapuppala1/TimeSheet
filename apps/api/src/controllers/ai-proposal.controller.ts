/**
 * WHAT: the AI PM copilot's surface — asking for a plan breakdown, reading a project's computed
 * risk, and reviewing/applying proposals row by row.
 *
 * WHY THERE IS NO "APPLY EVERYTHING" SHORTCUT: the whole point of the proposal envelope is that a
 * person decides per row. A one-click apply-all would recreate exactly the rubber stamp the
 * design exists to avoid, and it would be the button everyone pressed. The client sends an
 * explicit decision map; rows it does not mention are left as they were.
 *
 * WHY RISK IS READABLE WITHOUT AI BEING ON AT ALL: the score is arithmetic
 * (`project-risk.service.ts`). Only the narrative needs a model. A workspace with AI switched off
 * still gets the number, the breakdown and the concerns — which is most of the value.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { aiRateLimit } from "../middleware/ai-rate-limit.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { applyProposal, createProposal, undoProposal, type DraftChange } from "../services/ai-proposal.service.js";
import { proposeAssignmentRebalance } from "../services/ai-rebalance.service.js";
import { proposeScheduleAdjustment } from "../services/ai-schedule-adjust.service.js";
import { proposeRiskMitigation } from "../services/ai-risk-mitigation.service.js";
import { proposeBlueprintInstantiation } from "../services/ai-blueprint-propose.service.js";
import { narrateProjectRisk, proposePlanBreakdown } from "../services/ai.service.js";
import { audit } from "../services/audit.service.js";
import { getPlanningEntitlements } from "../services/plan-limits.service.js";
import { assertPlanningEnabled } from "../services/planning.service.js";
import { assessProject, latestSnapshots, saveSnapshot } from "../services/project-risk.service.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { assertTicketVisible, ticketProjectScope } from "../services/ticket.service.js";

export const aiProposalRouter = Router();
aiProposalRouter.use(requireAuth);
// Reaching a model costs money and takes seconds; `POST /plan-breakdown` had only the global
// 900/min limiter until now. Same per-user bucket /api/ai uses — see middleware/ai-rate-limit.ts.
aiProposalRouter.use(aiRateLimit);

/** The copilot family is tier-gated as a whole; spend is still bounded by the existing monthly
 *  AI budget, so this only decides whether the features are offered at all. */
async function assertCopilotAllowed() {
  const entitlements = await getPlanningEntitlements(requireTenantContext().orgId);
  if (!entitlements.aiPmCopilotEnabled) {
    throw new AppError(403, "The AI planning copilot is an Enterprise feature.");
  }
}

/**
 * Loads a proposal and refuses one whose plan the caller cannot see.
 *
 * `plan:write` is a permission, not a boundary — exactly the argument `GET /` below already makes
 * about `tickets:view`, and it applies with more force here because these routes are the human
 * step in "the AI proposes, a person applies". Without this, the review that makes an AI-authored
 * change set safe could be performed by someone who cannot open the project the tickets land in,
 * on a proposal they were never shown, given only its id.
 *
 * A proposal with no `scopeProjectId` is workspace-wide rather than unowned, so it is matched on
 * authorship instead — the same rule the list route uses, so what you can apply is exactly what
 * you could see.
 */
async function loadReviewableProposal(req: Request, id: string) {
  const proposal = await prisma.aiProposal.findUnique({ where: { id }, select: { id: true, scopeProjectId: true, requestedById: true } });
  if (!proposal) throw new AppError(404, "Proposal not found");

  if (proposal.scopeProjectId) {
    await assertTicketVisible(req, proposal.scopeProjectId);
    return proposal;
  }

  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && proposal.requestedById !== req.user!.id) throw new AppError(403, "Forbidden");
  return proposal;
}

/* ---------- Risk ---------- */

/**
 * One project's computed risk. The narrative is attempted only if the workspace has the risk
 * agent switched on, and its failure never costs the caller the score — an AI outage must not
 * take the number with it.
 */
aiProposalRouter.get(
  "/risk/:projectId",
  requirePermission(permissions.REPORTS_VIEW),
  validate(z.object({ params: z.object({ projectId: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const projectId = String(req.params.projectId);
    await assertTicketVisible(req, projectId);

    const assessment = await assessProject(projectId);

    let narrative: string | null = null;
    if (req.query.narrate === "true") {
      try {
        await assertCopilotAllowed();
        narrative = await narrateProjectRisk({
          projectName: assessment.projectName,
          riskScore: assessment.riskScore,
          band: assessment.band,
          topConcerns: assessment.topConcerns,
          facts: assessment.facts,
          userId: req.user!.id
        });
      } catch {
        // Deliberately swallowed. The score is the product; the sentence is a convenience, and
        // losing it must never cost the caller the number they came for.
        narrative = null;
      }
    }

    res.json({ ...assessment, narrative });
  }
);

/** Latest stored snapshot per project — what the portfolio table and badges read. */
aiProposalRouter.get("/risk", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  const scope = await ticketProjectScope(req);
  const projects = await prisma.project.findMany({
    where: { deletedAt: null, ...(scope.unrestricted ? {} : { id: { in: scope.projectIds } }) },
    select: { id: true }
  });
  const snapshots = await latestSnapshots(projects.map((p) => p.id));
  res.json(
    Array.from(snapshots.entries()).map(([projectId, snapshot]) => ({
      projectId,
      riskScore: snapshot.riskScore,
      band: snapshot.band,
      computedAt: snapshot.computedAt,
      narrative: snapshot.aiNarrative
    }))
  );
});

/** Recompute and store now, rather than waiting for the nightly worker. */
aiProposalRouter.post(
  "/risk/:projectId/refresh",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ projectId: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const projectId = String(req.params.projectId);
    await assertTicketVisible(req, projectId);

    const assessment = await assessProject(projectId);
    let narrative: string | null = null;
    try {
      await assertCopilotAllowed();
      narrative = await narrateProjectRisk({
        projectName: assessment.projectName,
        riskScore: assessment.riskScore,
        band: assessment.band,
        topConcerns: assessment.topConcerns,
        facts: assessment.facts,
        userId: req.user!.id
      });
    } catch {
      narrative = null;
    }
    const snapshot = await saveSnapshot(assessment, narrative);
    res.json({ ...assessment, narrative, snapshotId: snapshot.id });
  }
);

/* ---------- Proposals ---------- */

aiProposalRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  await assertPlanningEnabled();
  // `tickets:view` is held tenant-wide by every non-viewer role, so it is a permission and not a
  // boundary — exactly the gap `assertTicketVisible` exists to close on the ticket sub-resources.
  // Without the scope below, any employee listing proposals saw every project's plan changes,
  // including the AI's reasoning text, for projects they cannot open at all. `GET /risk` in this
  // same file already scopes this way; this route simply never did.
  //
  // A proposal with no `scopeProjectId` is workspace-wide rather than unowned, so it is matched on
  // authorship instead: you keep seeing what you asked for, and stop seeing what you didn't.
  const scope = await ticketProjectScope(req);
  const visibility = scope.unrestricted
    ? {}
    : { OR: [{ scopeProjectId: { in: scope.projectIds } }, { requestedById: req.user!.id }] };
  const proposals = await prisma.aiProposal.findMany({
    where: {
      ...visibility,
      ...(req.query.status && req.query.status !== "all" ? { status: String(req.query.status) as never } : {}),
      ...(typeof req.query.projectId === "string" && req.query.projectId ? { scopeProjectId: req.query.projectId } : {})
    },
    include: {
      changes: { orderBy: { order: "asc" } },
      requestedBy: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
      undoneBy: { select: { id: true, name: true } },
      scopeProject: { select: { id: true, code: true, name: true } },
      scopeTicket: { select: { id: true, key: true, title: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  res.json(proposals);
});

/**
 * Ask for a plan breakdown.
 *
 * The model's output becomes an `AiProposal` immediately and is never written to the plan. Note
 * what is NOT here: an option to auto-apply. See ai-proposal.service.ts's header.
 */
aiProposalRouter.post(
  "/plan-breakdown",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      body: z
        .object({
          projectId: z.string().uuid(),
          parentTicketId: z.string().uuid().nullish(),
          goal: z.string().min(5).max(2000),
          context: z.string().max(4000).optional()
        })
        .strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    await assertTicketVisible(req, req.body.projectId);

    const project = await prisma.project.findFirstOrThrow({
      where: { id: req.body.projectId, deletedAt: null },
      select: { id: true, name: true }
    });

    // Existing titles go in as context so the model does not propose work that already exists —
    // a breakdown full of duplicates is worse than none, because someone has to notice.
    const existing = await prisma.ticket.findMany({
      where: { projectId: project.id, deletedAt: null, status: { notIn: ["CLOSED"] } },
      select: { title: true },
      take: 40,
      orderBy: { createdAt: "desc" }
    });

    const breakdown = await proposePlanBreakdown({
      goal: req.body.goal,
      context: req.body.context,
      projectName: project.name,
      existingTitles: existing.map((t) => t.title),
      userId: req.user!.id
    });
    if (!breakdown) throw new AppError(502, "The assistant did not return a usable breakdown. Try rephrasing the goal.");

    // One CREATE row per task, then one LINK row per dependency. Both reference each other by
    // the CREATE row's order index, because none of these rows have ids until they are applied.
    const changes: DraftChange[] = breakdown.items.map((item, index) => ({
      targetType: "TICKET",
      op: "CREATE",
      after: {
        projectId: project.id,
        title: item.title,
        description: item.description || null,
        estimatedHours: item.estimatedHours,
        type: "TASK",
        ...(req.body.parentTicketId ? { parentId: req.body.parentTicketId } : {})
      },
      summary: `Create "${item.title}" (${item.estimatedHours}h)`
    }));

    breakdown.items.forEach((item, index) => {
      if (item.dependsOnIndex < 0) return;
      changes.push({
        targetType: "LINK",
        op: "LINK",
        after: { fromIndex: item.dependsOnIndex, toIndex: index },
        summary: `"${breakdown.items[item.dependsOnIndex].title}" must finish before "${item.title}"`
      });
    });

    const proposal = await createProposal({
      kind: "PLAN_BREAKDOWN",
      title: `Breakdown: ${req.body.goal.slice(0, 120)}`,
      rationale: breakdown.rationale,
      model: breakdown.model,
      // Provenance for the quality loop: a rejected or undone breakdown names the exact captured
      // interaction to promote into a dataset. Null when capture is off, which is fine — the
      // promotion path already explains that absence to the person.
      sourceInteractionId: breakdown.interactionId,
      scopeProjectId: project.id,
      scopeTicketId: req.body.parentTicketId ?? null,
      requestedById: req.user!.id,
      changes
    });

    await audit(req.user!.id, "ai_proposal.created", "AiProposal", proposal.id, {
      kind: "PLAN_BREAKDOWN",
      changes: changes.length
    });
    res.status(201).json(proposal);
  }
);

/** Record per-row decisions without applying — so a long review can be done in sittings. */
aiProposalRouter.patch(
  "/:id/decisions",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ decisions: z.record(z.boolean()) }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    const proposal = await loadReviewableProposal(req, String(req.params.id));

    // The row ids come from the request body, and this route used to update whatever they named:
    // the `:id` in the URL was decorative, so a decision map could pre-accept rows belonging to a
    // DIFFERENT proposal — including one scoped to a project the caller cannot see. Restricting
    // the update to rows of the proposal that was actually authorized makes the URL load-bearing.
    const entries = Object.entries(req.body.decisions as Record<string, boolean>);
    const owned = new Set(
      (await prisma.aiProposalChange.findMany({ where: { proposalId: proposal.id, id: { in: entries.map(([id]) => id) } }, select: { id: true } })).map(
        (c) => c.id
      )
    );
    const applicable = entries.filter(([id]) => owned.has(id));
    await prisma.$transaction(
      applicable.map(([id, accepted]) => prisma.aiProposalChange.update({ where: { id }, data: { accepted } }))
    );
    res.json({ updated: applicable.length });
  }
);

aiProposalRouter.post(
  "/:id/apply",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ decisions: z.record(z.boolean()).optional() }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    const proposal = await loadReviewableProposal(req, String(req.params.id));
    const result = await applyProposal({
      proposalId: proposal.id,
      decisions: (req.body.decisions as Record<string, boolean>) ?? {},
      actorId: req.user!.id
    });
    res.json(result);
  }
);

/**
 * Ask for a rebalance of one project's bookings.
 *
 * No `assertCopilotAllowed` here, unlike plan-breakdown: this reaches no model, spends nothing from
 * the AI budget and works with AI switched off entirely, so tier-gating it as an AI feature would
 * be charging for arithmetic. It is gated on PLAN_WRITE and project visibility like everything else
 * that can change a plan.
 */
aiProposalRouter.post(
  "/rebalance",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      body: z
        .object({
          projectId: z.string().uuid(),
          from: z.coerce.date(),
          to: z.coerce.date()
        })
        .strict()
        .refine((b) => b.to > b.from, { message: "The window must end after it starts." })
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertTicketVisible(req, String(req.body.projectId));

    const outcome = await proposeAssignmentRebalance({
      projectId: String(req.body.projectId),
      from: req.body.from as Date,
      to: req.body.to as Date,
      requestedById: req.user!.id
    });

    if (outcome.proposalId) {
      await audit(req.user!.id, "ai_proposal.created", "AiProposal", outcome.proposalId, {
        kind: "ASSIGNMENT_REBALANCE",
        changes: outcome.moves
      });
    }
    res.json(outcome);
  }
);

/**
 * Fix schedule conflicts: dates that contradict a dependency, corrected to the earliest legal
 * dates by the same solver the timeline uses. No `assertCopilotAllowed`, same as the rebalance —
 * this reaches no model and works with AI switched off entirely.
 */
aiProposalRouter.post(
  "/schedule-adjust",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ body: z.object({ projectId: z.string().uuid() }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertTicketVisible(req, String(req.body.projectId));

    const outcome = await proposeScheduleAdjustment({ projectId: String(req.body.projectId), requestedById: req.user!.id });
    if (outcome.proposalId) {
      await audit(req.user!.id, "ai_proposal.created", "AiProposal", outcome.proposalId, {
        kind: "SCHEDULE_ADJUSTMENT",
        changes: outcome.corrections
      });
    }
    res.json(outcome);
  }
);

/**
 * Risk mitigation: when the schedule provably runs past the committed end date, propose making
 * the commitment match the plan. SUGGEST-capped by the registry — this can never auto-apply.
 */
aiProposalRouter.post(
  "/risk-mitigation",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ body: z.object({ projectId: z.string().uuid() }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertTicketVisible(req, String(req.body.projectId));

    const outcome = await proposeRiskMitigation({ projectId: String(req.body.projectId), requestedById: req.user!.id });
    if (outcome.proposalId) {
      await audit(req.user!.id, "ai_proposal.created", "AiProposal", outcome.proposalId, { kind: "RISK_MITIGATION", changes: 1 });
    }
    res.json(outcome);
  }
);

/**
 * Instantiate a blueprint as a reviewed change set — every item and dependency its own row,
 * against the direct instantiation path's all-or-nothing.
 */
aiProposalRouter.post(
  "/blueprint-instantiate",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      body: z
        .object({
          blueprintId: z.string().uuid(),
          projectId: z.string().uuid(),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
        })
        .strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertTicketVisible(req, String(req.body.projectId));

    const outcome = await proposeBlueprintInstantiation({
      blueprintId: String(req.body.blueprintId),
      projectId: String(req.body.projectId),
      startDate: String(req.body.startDate),
      requestedById: req.user!.id
    });
    await audit(req.user!.id, "ai_proposal.created", "AiProposal", outcome.proposalId, {
      kind: "BLUEPRINT_SUGGESTION",
      changes: outcome.items + outcome.dependencies
    });
    res.status(201).json(outcome);
  }
);

/**
 * Put back what an applied proposal changed.
 *
 * Behind `loadReviewableProposal` and `PLAN_WRITE` exactly like apply, and for the same reason:
 * reversing a change to a project is as much a change to that project as making it was, so it
 * cannot be reachable to anyone who could not have applied it in the first place.
 */
aiProposalRouter.post(
  "/:id/undo",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const proposal = await loadReviewableProposal(req, String(req.params.id));
    res.json(await undoProposal({ proposalId: proposal.id, actorId: req.user!.id }));
  }
);

aiProposalRouter.post(
  "/:id/reject",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const proposal = await loadReviewableProposal(req, String(req.params.id));
    const updated = await prisma.aiProposal.update({
      where: { id: proposal.id },
      data: { status: "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date() }
    });
    await audit(req.user!.id, "ai_proposal.rejected", "AiProposal", updated.id);
    res.json({ ok: true });
  }
);
