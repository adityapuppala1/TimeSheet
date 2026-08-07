/**
 * WHAT: approval chains on work items, plus the proofing annotations that usually accompany a
 * review — and the ONE unauthenticated route in this file, where an external reviewer decides.
 *
 * WHY BOTH LIVE HERE: an approval and a pin dropped on the attached mock-up are the same act from
 * the reviewer's point of view. Splitting them would mean two controllers with identical guest
 * handling, and guest handling is the part worth having in exactly one place.
 *
 * THE GUEST ROUTE'S POSTURE (`/shared/approvals/:token`):
 * - The token is 256 bits, minted per STEP, and is the only authority it carries. It authorises
 *   one decision on one step — not the ticket, not the project, not anything else.
 * - A bad, spent or revoked token returns an identical generic 404, so nothing is enumerable and
 *   a probe cannot learn that a token was once real.
 * - The payload a guest sees is deliberately narrow: the title, the description, the attachments
 *   they are being asked about. Never the assignee, the SLA, the project's other work, or who
 *   else is in the chain.
 * - No session is created, ever. Approving does not log anybody in.
 *
 * WHO MOUNTS THIS: `app.ts` — the authenticated router after `resolveTenant`, and the public one
 * at `/api/shared/approvals` with its own tighter rate limit.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import {
  applyDecision,
  GUEST_TOKEN_TTL_MS,
  hashGuestToken,
  issueGuestToken,
  validateChain,
  type ApprovalStepState
} from "../services/approval.service.js";
import { audit } from "../services/audit.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { assertPlanningCapability } from "../services/planning.service.js";
import { assertTicketVisible } from "../services/ticket.service.js";
import { env } from "../config/env.js";

export const approvalRouter = Router();
export const approvalPublicRouter = Router();
approvalRouter.use(requireAuth);

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

const assertApprovalsEnabled = () =>
  assertPlanningCapability("enableApprovals", "approvalsEnabled", "Approvals");

const toState = (steps: any[]): ApprovalStepState[] =>
  steps.map((s) => ({ id: s.id, order: s.order, approverId: s.approverId, guestEmail: s.guestEmail, decision: s.decision }));

/** Guest tokens are never returned to the browser in bulk — a manager reading the approval panel
 *  has no need for a capability that lets them decide as someone else. */
const serializeStep = (s: any) => ({
  id: s.id,
  order: s.order,
  decision: s.decision,
  comment: s.comment,
  decidedAt: s.decidedAt,
  approver: s.approver ?? null,
  guestEmail: s.guestEmail,
  hasGuestLink: Boolean(s.guestTokenHash ?? s.guestToken)
});

/* ---------- Reading ---------- */

approvalRouter.get(
  "/ticket/:ticketId",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ ticketId: z.string().uuid() }) })),
  async (req, res) => {
    await assertApprovalsEnabled();
    const ticket = await prisma.ticket.findFirst({
      where: { id: String(req.params.ticketId), deletedAt: null },
      select: { id: true, projectId: true }
    });
    if (!ticket) throw new AppError(404, "Ticket not found");
    await assertTicketVisible(req, ticket.projectId);

    const requests = await prisma.approvalRequest.findMany({
      where: { ticketId: ticket.id },
      include: {
        requestedBy: { select: USER_SUMMARY },
        steps: { include: { approver: { select: USER_SUMMARY } }, orderBy: { order: "asc" } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json(requests.map((r) => ({ ...r, steps: r.steps.map(serializeStep) })));
  }
);

/* ---------- Creating a chain ---------- */

const createSchema = z.object({
  body: z
    .object({
      ticketId: z.string().uuid(),
      title: z.string().min(1).max(200),
      description: z.string().max(4000).nullish(),
      dueAt: z.string().datetime({ offset: true }).nullish(),
      isSequential: z.boolean().optional(),
      steps: z
        .array(
          z.object({
            approverId: z.string().uuid().nullish(),
            guestEmail: z.string().email().max(255).nullish(),
            order: z.number().int().min(0).max(100).optional()
          })
        )
        .min(1)
        .max(20)
    })
    .strict()
});

approvalRouter.post("/", requirePermission(permissions.APPROVALS_MANAGE), validate(createSchema), async (req, res) => {
  await assertApprovalsEnabled();
  validateChain(req.body.steps);

  const ticket = await prisma.ticket.findFirst({
    where: { id: req.body.ticketId, deletedAt: null },
    select: { id: true, key: true, title: true, projectId: true }
  });
  if (!ticket) throw new AppError(404, "Ticket not found");
  await assertTicketVisible(req, ticket.projectId);

  const created = await prisma.approvalRequest.create({
    data: {
      ticketId: ticket.id,
      title: req.body.title,
      description: req.body.description ?? null,
      dueAt: req.body.dueAt ? new Date(req.body.dueAt) : null,
      isSequential: req.body.isSequential ?? true,
      requestedById: req.user!.id,
      steps: {
        create: req.body.steps.map((step: any, index: number) => {
          // A guest token is minted up front so the link can be sent immediately. It is single-
          // purpose and dies with the step's decision. Only its digest is persisted — the raw
          // value reaches the reviewer through POST /steps/:stepId/resend and nowhere else.
          const token = step.guestEmail ? issueGuestToken() : null;
          return {
            order: step.order ?? index,
            approverId: step.approverId ?? null,
            guestEmail: step.guestEmail?.trim() ?? null,
            guestTokenHash: token ? hashGuestToken(token) : null,
            guestTokenExpiresAt: token ? new Date(Date.now() + GUEST_TOKEN_TTL_MS) : null
          };
        })
      }
    },
    include: { steps: { include: { approver: { select: USER_SUMMARY } }, orderBy: { order: "asc" } } }
  });

  await audit(req.user!.id, "approval.created", "ApprovalRequest", created.id, { ticket: ticket.key, steps: created.steps.length });
  await notifyActiveApprovers(created.id, ticket);

  res.status(201).json({ ...created, steps: created.steps.map(serializeStep) });
});

/** Notifies whoever the chain is currently waiting on. Best-effort: a mail failure must never
 *  leave an approval un-created, and the panel shows the state regardless. */
async function notifyActiveApprovers(requestId: string, ticket: { id: string; key: string; title: string }) {
  try {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: requestId },
      include: { steps: true }
    });
    if (!request) return;
    const { activeSteps } = await import("../services/approval.service.js");
    for (const step of activeSteps(toState(request.steps), request.isSequential)) {
      if (!step.approverId) continue;
      await dispatchNotification({
        userId: step.approverId,
        category: "ticket.assigned",
        title: `Approval needed: ${ticket.key}`,
        body: `${request.title} — ${ticket.title}`,
        link: `/app/tickets?open=${ticket.id}`
      });
    }
  } catch {
    /* ignore */
  }
}

/* ---------- Deciding (internal) ---------- */

const decisionSchema = z.object({
  params: z.object({ stepId: z.string().uuid() }),
  body: z.object({ decision: z.enum(["APPROVED", "REJECTED"]), comment: z.string().max(2000).optional() }).strict()
});

approvalRouter.post("/steps/:stepId/decide", validate(decisionSchema), async (req, res) => {
  await assertApprovalsEnabled();
  const step = await prisma.approvalStep.findUnique({
    where: { id: String(req.params.stepId) },
    include: { request: { include: { steps: true, ticket: { select: { id: true, key: true, title: true, projectId: true } } } } }
  });
  if (!step) throw new AppError(404, "Approval step not found");

  // The decision belongs to the named approver, and to nobody else — not an admin, not the
  // requester. An approval somebody else can click on their behalf is not an approval.
  if (step.approverId !== req.user!.id) {
    throw new AppError(403, "This approval is assigned to someone else.");
  }

  await persistDecision({
    step,
    decision: req.body.decision,
    comment: req.body.comment ?? null,
    actorId: req.user!.id,
    actorLabel: req.user!.id
  });

  res.json({ ok: true });
});

/** Shared by the internal and guest paths so the two can never diverge on ordering or completion. */
async function persistDecision(params: {
  step: any;
  decision: "APPROVED" | "REJECTED";
  comment: string | null;
  actorId: string | undefined;
  actorLabel: string;
}) {
  const { step, decision, comment } = params;
  const request = step.request;

  const outcome = applyDecision({
    steps: toState(request.steps),
    stepId: step.id,
    decision,
    isSequential: request.isSequential
  });

  await prisma.$transaction(async (tx) => {
    await tx.approvalStep.update({
      where: { id: step.id },
      data: {
        decision,
        comment,
        decidedAt: new Date(),
        // Spent. A guest link is single-use by construction, not by convention. Both columns:
        // a legacy row still carries the plaintext, and leaving it would keep the link alive.
        guestToken: null,
        guestTokenHash: null,
        guestTokenExpiresAt: null
      }
    });
    await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        status: outcome.status,
        completedAt: outcome.completed ? new Date() : null
      }
    });
    // A rejection settles the request, so the remaining links are revoked. They are NOT marked
    // decided — nobody decided them, and recording otherwise would misstate the history.
    if (outcome.supersededSteps.length > 0) {
      await tx.approvalStep.updateMany({
        where: { id: { in: outcome.supersededSteps.map((s) => s.id) } },
        data: { guestToken: null, guestTokenHash: null, guestTokenExpiresAt: null }
      });
    }
  });

  await audit(params.actorId, `approval.${decision.toLowerCase()}`, "ApprovalStep", step.id, {
    request: request.id,
    ticket: request.ticket?.key,
    by: params.actorLabel
  });

  try {
    if (outcome.completed) {
      await dispatchNotification({
        userId: request.requestedById,
        category: "ticket.status_changed",
        title: `Approval ${outcome.status.toLowerCase()}: ${request.ticket?.key ?? ""}`,
        body: `${request.title} was ${outcome.status.toLowerCase()}.`,
        link: `/app/tickets?open=${request.ticketId}`
      });
    } else if (request.ticket) {
      await notifyActiveApprovers(request.id, request.ticket);
    }
  } catch {
    /* best effort */
  }

  return outcome;
}

approvalRouter.delete(
  "/:id",
  requirePermission(permissions.APPROVALS_MANAGE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertApprovalsEnabled();
    await prisma.approvalRequest.delete({ where: { id: String(req.params.id) } });
    await audit(req.user!.id, "approval.cancelled", "ApprovalRequest", String(req.params.id));
    res.status(204).end();
  }
);

/**
 * Regenerates a guest link — the previous one dies immediately.
 *
 * This route MINTS a capability and hands it straight back, so it needs the same project-scoping
 * every other route in this file applies, not just the APPROVALS_MANAGE permission: that
 * permission is held by MANAGER and TEAM_LEAD, and without the visibility check any of them could
 * post a bare step id and receive a working link into a ticket on a project they are not on. The
 * step id is a uuid, but this file's own header promises the token authorises "one decision on
 * one step" — an endpoint that issues one for any step in the tenant contradicted that.
 */
approvalRouter.post(
  "/steps/:stepId/resend",
  requirePermission(permissions.APPROVALS_MANAGE),
  validate(z.object({ params: z.object({ stepId: z.string().uuid() }) })),
  async (req, res) => {
    await assertApprovalsEnabled();
    const step = await prisma.approvalStep.findUnique({
      where: { id: String(req.params.stepId) },
      include: { request: { select: { ticket: { select: { projectId: true } } } } }
    });
    if (!step) throw new AppError(404, "Approval step not found");
    // 404, not 403 — the same generic answer for "no such step" and "not your project", so this
    // cannot be used to probe which step ids exist.
    if (!step.request.ticket) throw new AppError(404, "Approval step not found");
    await assertTicketVisible(req, step.request.ticket.projectId);
    if (!step.guestEmail) throw new AppError(400, "That step is assigned to a colleague, not an external reviewer.");
    if (step.decision !== "PENDING") throw new AppError(409, "That step has already been decided.");

    const token = issueGuestToken();
    await prisma.approvalStep.update({
      where: { id: step.id },
      // Storing only the digest is what makes this response the sole copy of the token; the
      // previous link dies because its digest is overwritten (and the legacy plaintext, if this
      // row still has one, is cleared alongside it).
      data: {
        guestToken: null,
        guestTokenHash: hashGuestToken(token),
        guestTokenExpiresAt: new Date(Date.now() + GUEST_TOKEN_TTL_MS)
      }
    });
    await audit(req.user!.id, "approval.guest_link_reissued", "ApprovalStep", step.id);
    res.json({ url: `${env.APP_BASE_URL}/shared/approval/${token}` });
  }
);

/* ================================================================== *
 * The guest route — unauthenticated
 * ================================================================== */

async function loadByToken(token: string) {
  if (!token || token.length < 20 || token.length > 200) throw new AppError(404, "This approval link isn't available.");
  const step = await prisma.approvalStep.findFirst({
    // Digest first; `guestToken` is the transitional fallback for links minted before hashing
    // and is dropped with that column (see prisma/schema.prisma). Both arms return the SAME 404
    // as an expired or spent link, so a probe learns nothing from which one missed.
    where: {
      OR: [{ guestTokenHash: hashGuestToken(token) }, { guestToken: token }],
      decision: "PENDING"
    },
    include: {
      request: {
        include: {
          steps: true,
          ticket: {
            select: {
              id: true,
              key: true,
              title: true,
              description: true,
              attachments: { select: { id: true, fileName: true, mimeType: true, url: true }, take: 20 }
            }
          }
        }
      }
    }
  });
  if (!step) throw new AppError(404, "This approval link isn't available.");
  // NULL = minted before `guestTokenExpiresAt` existed, and those stay open-ended: retro-dating
  // links already sitting in reviewers' inboxes would have killed every outstanding approval.
  if (step.guestTokenExpiresAt && step.guestTokenExpiresAt.getTime() < Date.now()) {
    throw new AppError(404, "This approval link isn't available.");
  }
  return step;
}

approvalPublicRouter.get("/:token", async (req, res) => {
  const step = await loadByToken(String(req.params.token));
  const request = step.request;

  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  // Deliberately narrow. A reviewer needs the thing they are reviewing and nothing else about the
  // workspace — not the assignee, not the SLA, not who else is in the chain.
  res.json({
    title: request.title,
    description: request.description,
    dueAt: request.dueAt,
    reviewerEmail: step.guestEmail,
    item: request.ticket
      ? {
          reference: request.ticket.key,
          title: request.ticket.title,
          description: request.ticket.description,
          attachments: request.ticket.attachments
        }
      : null
  });
});

approvalPublicRouter.post(
  "/:token",
  validate(
    z.object({
      params: z.object({ token: z.string().min(20).max(120) }),
      body: z.object({ decision: z.enum(["APPROVED", "REJECTED"]), comment: z.string().max(2000).optional() }).strict()
    })
  ),
  async (req, res) => {
    const step = await loadByToken(String(req.params.token));
    await persistDecision({
      step,
      decision: req.body.decision,
      comment: req.body.comment ?? null,
      // No actor id: there is no user. The audit row records the email instead — the same
      // no-actor shape the public attestation viewer already uses for outside-the-workspace acts.
      actorId: undefined,
      actorLabel: step.guestEmail ?? "external reviewer"
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, decision: req.body.decision });
  }
);
