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
import PDFDocument from "pdfkit";
import { z } from "zod";
import { permissions, ticketStatusTransitions, type TicketStatus } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { preserveTenantContext, upload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { buildTicketSecurityReport, sendTicketClosedDigest } from "../services/security-report.service.js";
import { buildTicketLineage } from "../services/ticket-lineage.service.js";
import { explainAssigneeSuggestion } from "../services/ai.service.js";
import { setInteractionFeedback } from "../services/ai-quality.service.js";
import { dispatchOutboundWebhooks } from "../services/webhook-dispatch.service.js";
import { createGitHubBranch, getGitAccessTokenOrNull, listGitHubRepos } from "../services/git-provider.service.js";
import {
  applyTicketRules,
  assertTicketVisible,
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
import { bindVerificationToRecord, consumeVerification, isFaceVerificationRequired } from "../services/face.service.js";

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
      // Kanban swimlanes group cards by assignee.manager (see TicketKanban.tsx) — the list
      // endpoint is the one this view reads from, so it's the one that needs the extra
      // manager fields; the detail endpoint below (GET /:id) doesn't, so it keeps plain
      // USER_SUMMARY rather than carrying this along everywhere.
      assignee: { select: { ...USER_SUMMARY, managerId: true, manager: { select: { id: true, name: true } } } },
      labels: { include: { label: true } },
      _count: { select: { comments: true, attachments: true } },
      // Kanban's red "CI failing" badge (see docs/ROADMAP.md's "Auto testing on branch/PR
      // push" theme) needs only the single latest run's status, not the full history — `take: 1`
      // keeps this a cheap per-ticket lookup instead of loading every TestRun row.
      testRuns: { select: { status: true }, orderBy: { createdAt: "desc" }, take: 1 }
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  res.json(tickets);
});

/**
 * Workload+expertise-ranked assignee suggestion — a deterministic ranking over data the
 * Insights workload heatmap already aggregates (open ticket count, past resolved tickets in
 * this project/module), NOT an LLM call: "who's free and has done this kind of work before" is
 * a data query, not a language-understanding task, so this skips ai.service.ts's cost/budget
 * pipeline entirely — no AI toggle needed for it to work. Rendered as a dismissible suggestion
 * chip on ticket creation (never a silent auto-assign), same posture as the AI triage suggestion
 * chip it sits next to in the UI. Registered BEFORE `/:id` below — Express matches routes in
 * registration order, so `/:id` would otherwise swallow `/suggest-assignee` as if "id" were the
 * literal string "suggest-assignee".
 */
ticketRouter.get("/suggest-assignee", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  const moduleId = req.query.moduleId ? String(req.query.moduleId) : undefined;
  if (!projectId) throw new AppError(422, "projectId is required");

  const members = await prisma.userProjectAssignment.findMany({
    where: { projectId },
    select: { user: { select: { id: true, name: true, status: true, deletedAt: true } } }
  });
  const candidates = members.map((m) => m.user).filter((u) => u.status === "ACTIVE" && !u.deletedAt);
  if (candidates.length === 0) return res.json({ suggestions: [] });

  const candidateIds = candidates.map((c) => c.id);
  const [openCounts, expertiseCounts] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: { assigneeId: { in: candidateIds }, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
      _count: true
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: {
        assigneeId: { in: candidateIds },
        deletedAt: null,
        status: { in: ["RESOLVED", "CLOSED"] },
        projectId,
        ...(moduleId ? { moduleId } : {})
      },
      _count: true
    })
  ]);
  const openById = new Map(openCounts.map((r) => [r.assigneeId, r._count]));
  const expertiseById = new Map(expertiseCounts.map((r) => [r.assigneeId, r._count]));

  const ranked = candidates
    .map((c) => {
      const openTicketCount = openById.get(c.id) ?? 0;
      const resolvedHereCount = expertiseById.get(c.id) ?? 0;
      // Favor prior experience in this exact project/module, penalize current open load —
      // weighting is deliberately simple (not tuned against real usage data yet) so it's easy
      // to explain in the UI ("2 open, 5 resolved here") rather than an opaque single number.
      const score = resolvedHereCount * 2 - openTicketCount;
      return { userId: c.id, name: c.name, openTicketCount, resolvedHereCount, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Optional AI narration of the ranking above — never re-ranks, only explains. Best-effort:
  // AI off/over budget/unparseable all fall through to `null`, same posture as the face
  // policy-copilot's narrative (the deterministic suggestions above stand alone either way).
  let narrative: string | null = null;
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
  if (ranked.length > 0 && title) {
    try {
      narrative = await explainAssigneeSuggestion({ candidates: ranked, ticketTitle: title });
    } catch (error) {
      console.warn(`[ticket] assignee-suggestion AI narration failed: ${(error as Error).message}`);
      narrative = null;
    }
  }

  res.json({ suggestions: ranked, narrative });
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
      branches: { include: { addedBy: { select: USER_SUMMARY } }, orderBy: { createdAt: "desc" } },
      linksFrom: { include: { targetTicket: { select: TICKET_LINK_SUMMARY } } },
      linksTo: { include: { sourceTicket: { select: TICKET_LINK_SUMMARY } } }
    }
  });
  if (!ticket) throw new AppError(404, "Ticket not found");

  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && !scope.projectIds.includes(ticket.projectId)) throw new AppError(403, "Forbidden");

  // Verified badge: the most recent identity check spent on this ticket (creation or a status
  // transition). Detail-only — the ticket LIST stays undecorated to keep it one query.
  const lastVerification = await prisma.faceVerificationAttempt.findFirst({
    where: { ticketId: ticket.id, outcome: "PASSED", consumedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, userId: true }
  });

  res.json({
    ...serializeTicketLinks(ticket),
    identityVerified: Boolean(lastVerification),
    identityVerifiedAt: lastVerification?.createdAt ?? null
  });
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
    aiConfidence: z.number().min(0).max(1).optional(),
    /// Id of a PASSED, unconsumed face-verification attempt (POST /api/face/verify). Only
    /// required when the workspace's face-verification policy covers this user + action —
    /// services/face.service.ts#isFaceVerificationRequired decides.
    faceVerificationId: z.string().uuid().optional().or(z.literal(""))
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

  // Identity gate — before the transaction below, so a failed check can never leave a
  // partially-created ticket (or burn a ticket key) behind. The consumed attempt is bound to
  // the ticket after creation so the verified badge can join attempt → ticket.
  let consumedVerificationId: string | null = null;
  if (await isFaceVerificationRequired(req.user!.id, "TICKET")) {
    consumedVerificationId = await consumeVerification({
      verificationId: req.body.faceVerificationId,
      userId: req.user!.id,
      context: "TICKET"
    });
  }

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

  if (consumedVerificationId) {
    await bindVerificationToRecord(consumedVerificationId, { ticketId: ticket.id });
  }

  await audit(req.user!.id, "ticket.created", "Ticket", ticket.id, { key: ticket.key });
  await dispatchOutboundWebhooks("ticket.created", { ticket });

  // Rules engine (Workspace Settings → Ticketing → Automation) — only runs when the creator
  // didn't already pick an assignee, so an explicit human choice always wins over an automated
  // default; a rule is a fallback, not an override. Manual-creation-only, same as
  // applyTicketRules's own doc comment explains (email/chat intake keep their existing routing).
  let finalTicket = ticket;
  if (!assigneeId) {
    const appliedRule = await applyTicketRules({
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      projectId: ticket.projectId,
      priority: ticket.priority,
      source: ticket.source,
      externalReporterEmail: ticket.externalReporterEmail
    }).catch((error) => {
      console.warn(`[ticket.controller] rules engine failed for ticket ${ticket.id}: ${(error as Error).message}`);
      return null;
    });
    if (appliedRule) {
      await audit(req.user!.id, "ticket.rule_applied", "Ticket", ticket.id, { ruleId: appliedRule.ruleId, ruleName: appliedRule.ruleName });
      if (appliedRule.assigneeId) {
        finalTicket = await prisma.ticket.findUniqueOrThrow({
          where: { id: ticket.id },
          include: {
            project: { select: { id: true, code: true, name: true } },
            module: { select: { id: true, name: true } },
            reporter: { select: USER_SUMMARY },
            assignee: { select: USER_SUMMARY }
          }
        });
      }
      if (appliedRule.notifyUserId) {
        // In-app only (no email field) — a rule "notify" is a lightweight heads-up, not the
        // same weight as an actual assignment, so it doesn't need its own email template.
        await dispatchNotification({
          userId: appliedRule.notifyUserId,
          category: "ticket.assigned",
          title: `Rule matched on ${ticket.key}`,
          body: `"${appliedRule.ruleName}" matched "${ticket.title}" — flagged for your attention.`,
          link: `/app/tickets?open=${ticket.id}`
        });
      }
    }
  }

  if (finalTicket.assignee && finalTicket.assignee.id !== req.user!.id) {
    await dispatchNotification({
      userId: finalTicket.assignee.id,
      category: "ticket.assigned",
      title: `Ticket assigned: ${finalTicket.key}`,
      body: `${req.user!.name} assigned "${finalTicket.title}" to you.`,
      link: `/app/tickets?open=${finalTicket.id}`,
      email: {
        templateKey: "ticket.assigned",
        vars: {
          assigneeName: finalTicket.assignee.name,
          ticketKey: finalTicket.key,
          title: finalTicket.title,
          priority: finalTicket.priority,
          assignedBy: req.user!.name
        },
        fallback: {
          subject: `Ticket ${finalTicket.key} assigned to you`,
          html: templates.ticketAssigned({
            assigneeName: finalTicket.assignee.name,
            ticketKey: finalTicket.key,
            title: finalTicket.title,
            priority: finalTicket.priority,
            assignedBy: req.user!.name
          })
        }
      }
    });
  }

  res.status(201).json(finalTicket);
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

  // Additionally attach the rating to the most recent triage interaction on this ticket, so the
  // signal reaches the per-call quality metrics (services/ai-quality.service.ts) instead of dying
  // on this one column the way it used to.
  //
  // Strictly additive and best-effort: the response shape, the Ticket.aiFeedback write, and the
  // AI Activity Log UI that calls this are all unchanged. If capture is off there is simply no
  // interaction to attach to, which is not an error.
  try {
    const interaction = await prisma.aIInteraction.findFirst({
      where: { ticketId: updated.id, feature: { in: ["triage", "chat_triage"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true }
    });
    if (interaction) {
      await setInteractionFeedback({
        interactionId: interaction.id,
        feedback: req.body.feedback,
        userId: req.user!.id
      });
    }
  } catch (error) {
    console.warn(`[ticket] could not mirror AI feedback onto an interaction: ${(error as Error).message}`);
  }

  res.json({ id: updated.id, aiFeedback: updated.aiFeedback });
});

const statusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    status: z.enum(["OPEN", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]),
    /// See createSchema.faceVerificationId — status transitions are gated by the same
    /// requireForTicket policy as creation. Comments and field edits deliberately are NOT.
    faceVerificationId: z.string().uuid().optional().or(z.literal(""))
  })
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

  // Identity gate — status transitions are the workflow-authoritative ticket actions ("who
  // actually resolved this?"), so they're covered by the same requireForTicket policy as
  // creation. Before every other write/side effect, and bound to the ticket immediately since
  // it already exists.
  if (await isFaceVerificationRequired(req.user!.id, "TICKET")) {
    await consumeVerification({
      verificationId: req.body.faceVerificationId,
      userId: req.user!.id,
      context: "TICKET",
      ticketId: existing.id
    });
  }

  // CI gate — see docs/ROADMAP.md's "Auto testing on branch/PR push" theme. Off by default
  // (GlobalTicketSettings.blockResolveOnFailingTests) so orgs that don't ingest test runs, or
  // that want this as a warning rather than a hard stop, are unaffected. Only the ticket's
  // single latest TestRun matters — an older passing run doesn't excuse a newer failure.
  if (nextStatus === "RESOLVED") {
    const ticketSettings = await prisma.globalTicketSettings.findUnique({ where: { id: "global" } });
    if (ticketSettings?.blockResolveOnFailingTests) {
      const latestRun = await prisma.testRun.findFirst({
        where: { ticketId: existing.id },
        orderBy: { createdAt: "desc" }
      });
      if (latestRun?.status === "FAILED") {
        throw new AppError(
          422,
          `Cannot resolve ${existing.key} — its latest CI run (${latestRun.provider}) is failing. Fix the build or ask an admin to disable the CI gate in Workspace Settings.`
        );
      }
    }
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
  await dispatchOutboundWebhooks("ticket.status_changed", { ticket, from: currentStatus, to: nextStatus });
  if (nextStatus === "CLOSED") await dispatchOutboundWebhooks("ticket.closed", { ticket });

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

  // Security/test-status digest — see services/security-report.service.ts. Separate from the
  // generic status-changed notification loop above (different recipients: closer + their
  // manager + this org's admins, not reporter/assignee/watchers) and gated on its own toggle,
  // so an org that hasn't connected a scan source never gets an empty digest. Detached: it
  // renders a report and sends real SMTP mail, none of which the close response depends on —
  // awaiting it made closing a ticket hang for seconds.
  if (nextStatus === "CLOSED") {
    void sendTicketClosedDigest(
      { id: ticket.id, key: ticket.key, title: ticket.title },
      { id: req.user!.id, name: req.user!.name, email: req.user!.email }
    ).catch((error) => console.error(`[ticket] closed digest failed for ${ticket.key}:`, (error as Error).message));
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

/* ---------- Security & test-status report ---------- */
// See services/security-report.service.ts's header comment — SecurityFinding/TestRun rows are
// ingest-only (controllers/devops-webhook.controller.ts), this just reads and renders them.

ticketRouter.get("/:id/security-report", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  res.json(await buildTicketSecurityReport(ticketId));
});

/* ---------- Lineage (ticket <-> branch/PR/CI/finding, one timeline) ---------- */
// Pure read-side aggregation over data every other route/ingestion path already writes — see
// services/ticket-lineage.service.ts's header for why this doesn't introduce a new data source.

ticketRouter.get("/:id/lineage", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  res.json(await buildTicketLineage(ticketId));
});

ticketRouter.get("/:id/security-report.pdf", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true, key: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const report = await buildTicketSecurityReport(ticketId);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${ticket.key}-security-report.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.pipe(res);

  doc.fontSize(20).fillColor("#0F9AA8").text("TimeSphere");
  doc.fontSize(10).fillColor("#64748B").text(`Generated ${report.generatedAt.toLocaleString()}`);
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor("#0F172A").text(`${report.ticket.key} — Security & Test Report`);
  doc.fontSize(11).fillColor("#64748B").text(report.ticket.title);
  doc.moveDown(0.5);

  const verdictColor = report.riskVerdict.startsWith("Needs attention") ? "#DC2626" : "#16A34A";
  doc.fontSize(12).fillColor(verdictColor).text(report.riskVerdict);
  doc.fontSize(10).fillColor("#0F172A").text(`Latest test run: ${report.latestTestRun?.status ?? "none recorded"}`);
  doc.moveDown(0.75);

  const SEVERITY_COLOR: Record<string, string> = { CRITICAL: "#DC2626", HIGH: "#D97706", MEDIUM: "#0F9AA8", LOW: "#64748B" };
  const TYPE_LABEL: Record<string, string> = {
    SAST: "Static analysis (SAST)",
    DAST: "Dynamic analysis (DAST)",
    SSAT: "Secrets scanning (SSAT)",
    SSCT: "Supply-chain testing (SSCT)",
    VAPT: "Penetration test (VAPT)"
  };

  if (report.findings.length === 0) {
    doc.fontSize(11).fillColor("#64748B").text("No findings have been ingested for this ticket.");
  }

  for (const type of ["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const) {
    const items = report.findingsByType[type];
    if (items.length === 0) continue;

    if (doc.y > 720) doc.addPage();
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor("#0F172A").text(TYPE_LABEL[type]);
    doc.strokeColor("#E2E8F0").lineWidth(0.5).moveTo(36, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.3);

    for (const finding of items) {
      if (doc.y > 740) doc.addPage();
      const rowY = doc.y;
      doc.fontSize(9).fillColor(SEVERITY_COLOR[finding.severity] ?? "#0F172A").text(finding.severity, 36, rowY, { continued: true, width: 70 });
      doc.fillColor("#0F172A").text(`  ${finding.title}`, { continued: true });
      doc.fillColor("#64748B").text(`  (${finding.tool}${finding.status !== "OPEN" ? `, ${finding.status}` : ""})`);
      if (finding.filePath) {
        doc.fontSize(8).fillColor("#94A3B8").text(`${finding.filePath}${finding.lineNumber ? `:${finding.lineNumber}` : ""}`, 46);
      }
      doc.moveDown(0.25);
    }
  }

  doc.moveDown(1);
  doc.fontSize(8).fillColor("#94A3B8").text("Ingest-only report — findings reflect whatever CI/security tools this workspace has connected.", { align: "center" });
  doc.end();
});

/* ---------- Watchers ---------- */

ticketRouter.post("/:id/watchers", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

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
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

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
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

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
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

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
  await assertTicketVisible(req, source.projectId);

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
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const linkId = String(req.params.linkId);
  const link = await prisma.ticketLink.findFirst({
    where: { id: linkId, OR: [{ sourceTicketId: ticketId }, { targetTicketId: ticketId }] }
  });
  if (!link) throw new AppError(404, "Link not found");
  await prisma.ticketLink.delete({ where: { id: linkId } });
  await audit(req.user!.id, "ticket.link_removed", "Ticket", ticketId, { linkId });
  res.status(204).send();
});

/* ---------- Branches (manual repo/branch/PR linking) ---------- */
// Deliberately manual, not synced live from GitHub/GitLab/etc. — see prisma/schema.prisma's
// TicketBranch model comment and docs/ROADMAP.md's "Git repo & branch mapping" theme for why a
// live git-provider App integration (OAuth, webhook-driven auto-sync) is a separate, larger
// scope of work than this. This is "record which branch/PR is fixing this ticket," typed in by
// whoever's working it — the same trust model as every other ticket field a project member can
// edit, not an integration with an external system's auth.

const createBranchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    repository: z.string().min(1).max(255),
    branch: z.string().min(1).max(255),
    prUrl: z.string().max(500).optional(),
    prStatus: z.enum(["NONE", "OPEN", "MERGED", "CLOSED"]).optional()
  })
});

ticketRouter.post("/:id/branches", requirePermission(permissions.TICKETS_WRITE), validate(createBranchSchema), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const created = await prisma.ticketBranch.create({
    data: {
      ticketId,
      repository: req.body.repository.trim(),
      branch: req.body.branch.trim(),
      prUrl: req.body.prUrl || null,
      prStatus: req.body.prStatus ?? (req.body.prUrl ? "OPEN" : "NONE"),
      addedById: req.user!.id
    },
    include: { addedBy: { select: USER_SUMMARY } }
  });
  await audit(req.user!.id, "ticket.branch_added", "Ticket", ticketId, { branch: created.branch, repository: created.repository });
  res.status(201).json(created);
});

/**
 * `WEB-123` + "Fix login redirect loop" -> "web-123/fix-login-redirect-loop", capped well under
 * GitHub's 250-char ref-name limit.
 *
 * WHY a `/` between the key and the slug rather than another hyphen: git-webhook.controller.ts's
 * TICKET_KEY_RE greedily backtracks to find a trailing `-\d+` — hyphen-joining the key straight
 * into the slug means a title ending in digits (a version, an incident number, a bare id — not
 * rare in bug titles) makes the regex swallow the WHOLE branch name as one "ticket key" instead
 * of stopping at the real one, silently breaking the auto-link. A `/` is a non-word character
 * (unlike `-`, which the pattern already treats as an internal joiner), so it forces the regex's
 * trailing `\b` to land right after the key every time — verified against `WEB-123/…-1785396099`-
 * style titles specifically because that failure mode doesn't show up on hand-picked examples.
 */
function slugBranchName(ticketKey: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${ticketKey.toLowerCase()}${slug ? `/${slug}` : ""}`;
}

const autoBranchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    // Free-text "owner/repo", same convention as the manual route above — no live Repository
    // table exists yet (see TicketBranch's schema comment). Omitting it (or an unconnected
    // GitHub) just returns the suggested name for copy-paste instead of creating anything.
    repository: z.string().max(255).optional(),
    baseBranch: z.string().max(255).optional()
  })
});

/**
 * Suggests (and, when GitHub is connected, actually creates) a branch name for this ticket — the
 * one direction TicketBranch linking didn't have yet (git push -> ticket already auto-links via
 * git-webhook.controller.ts; this is ticket -> git). Reuses the existing read-only GitHub OAuth
 * integration's token rather than adding new auth — see git-provider.service.ts#createGitHubBranch.
 * Degrades gracefully in three ways so a missing connection/repo never turns into a hard error:
 * no GitHub connection -> name only; no `repository` supplied -> name only; `baseBranch` omitted
 * -> resolved from the repo's own default branch.
 */
ticketRouter.post("/:id/branches/auto", requirePermission(permissions.TICKETS_WRITE), validate(autoBranchSchema), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { key: true, title: true, projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const suggestedName = slugBranchName(ticket.key, ticket.title);
  const repository = req.body.repository?.trim();

  const token = repository ? await getGitAccessTokenOrNull() : null;
  if (!token || !repository) {
    return res.json({ created: false, suggestedName });
  }

  let baseBranch = req.body.baseBranch?.trim();
  if (!baseBranch) {
    const repos = await listGitHubRepos(token);
    baseBranch = repos.find((r) => r.fullName === repository)?.defaultBranch;
    if (!baseBranch) throw new AppError(422, `Couldn't find "${repository}" among this connection's GitHub repos — pass baseBranch explicitly, or check the repository name.`);
  }

  await createGitHubBranch(token, repository, suggestedName, baseBranch);

  const created = await prisma.ticketBranch.create({
    data: { ticketId, repository, branch: suggestedName, prStatus: "NONE", addedById: req.user!.id },
    include: { addedBy: { select: USER_SUMMARY } }
  });
  await audit(req.user!.id, "ticket.branch_auto_created", "Ticket", ticketId, { branch: suggestedName, repository });
  res.status(201).json({ created: true, branch: created });
});

const updateBranchSchema = z.object({
  params: z.object({ id: z.string().uuid(), branchId: z.string().uuid() }),
  body: z
    .object({
      prUrl: z.string().max(500).optional().nullable(),
      prStatus: z.enum(["NONE", "OPEN", "MERGED", "CLOSED"]).optional()
    })
    .strict()
});

ticketRouter.patch("/:id/branches/:branchId", requirePermission(permissions.TICKETS_WRITE), validate(updateBranchSchema), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const branch = await prisma.ticketBranch.findFirst({ where: { id: String(req.params.branchId), ticketId } });
  if (!branch) throw new AppError(404, "Branch link not found");

  const data: Record<string, unknown> = {};
  if ("prUrl" in req.body) data.prUrl = req.body.prUrl || null;
  if (typeof req.body.prStatus === "string") data.prStatus = req.body.prStatus;

  const updated = await prisma.ticketBranch.update({
    where: { id: branch.id },
    data,
    include: { addedBy: { select: USER_SUMMARY } }
  });
  res.json(updated);
});

ticketRouter.delete("/:id/branches/:branchId", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const branch = await prisma.ticketBranch.findFirst({ where: { id: String(req.params.branchId), ticketId } });
  if (!branch) throw new AppError(404, "Branch link not found");

  await prisma.ticketBranch.delete({ where: { id: branch.id } });
  await audit(req.user!.id, "ticket.branch_removed", "Ticket", ticketId, { branchId: branch.id });
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
  await assertTicketVisible(req, ticket.projectId);

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
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const item = await prisma.ticketChecklistItem.findFirst({ where: { id: String(req.params.itemId), ticketId } });
  if (!item) throw new AppError(404, "Checklist item not found");

  const data: Record<string, unknown> = {};
  if (typeof req.body.label === "string") data.label = req.body.label.trim();
  if (typeof req.body.done === "boolean") data.done = req.body.done;

  const updated = await prisma.ticketChecklistItem.update({
    where: { id: item.id },
    data
  });
  res.json(updated);
});

ticketRouter.delete("/:id/checklist/:itemId", requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const item = await prisma.ticketChecklistItem.findFirst({ where: { id: String(req.params.itemId), ticketId } });
  if (!item) throw new AppError(404, "Checklist item not found");

  await prisma.ticketChecklistItem.delete({ where: { id: item.id } });
  res.status(204).send();
});

const reorderChecklistSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ itemIds: z.array(z.string().uuid()).min(1) })
});

ticketRouter.patch("/:id/checklist-reorder", requirePermission(permissions.TICKETS_WRITE), validate(reorderChecklistSchema), async (req, res) => {
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

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
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const comments = await prisma.ticketComment.findMany({
    where: { ticketId },
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
  await assertTicketVisible(req, ticket.projectId);

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
  preserveTenantContext(upload.array("attachments")),
  async (req, res) => {
    const ticket = await prisma.ticket.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
    if (!ticket) throw new AppError(404, "Ticket not found");
    await assertTicketVisible(req, ticket.projectId);

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
  const ticketId = String(req.params.id);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { projectId: true } });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const attachment = await prisma.ticketAttachment.findFirst({
    where: { id: String(req.params.attachmentId), ticketId }
  });
  if (!attachment) throw new AppError(404, "Attachment not found");
  if (attachment.uploadedById !== req.user!.id && !req.user!.permissions.includes(permissions.TICKETS_MANAGE)) {
    throw new AppError(403, "Forbidden");
  }
  await prisma.ticketAttachment.delete({ where: { id: attachment.id } });
  await audit(req.user!.id, "ticket.attachment_removed", "Ticket", String(req.params.id), { attachmentId: attachment.id });
  res.status(204).send();
});
