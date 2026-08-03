/**
 * WHAT: the human-in-the-loop envelope every AI planning feature writes through — building a
 * proposal, and applying the rows a reviewer accepted.
 *
 * WHY NO AI FEATURE WRITES DIRECTLY: the planning copilots propose MANY changes at once (break
 * this epic into 14 tasks; shift 40 dates; move 6 tickets between people). A yes/no dialog over a
 * change set that size is not review, it is a rubber stamp — and there is no undo for "the AI
 * moved every date in Q3". Storing the diff row by row means a reviewer accepts the 11 rows that
 * are right and rejects the 3 that are not, the before-state is recorded for audit, and a
 * proposal nobody reviews expires having changed nothing.
 *
 * THE RULE THAT MAKES IT SAFE RATHER THAN JUST CAREFUL — stale-state detection. A proposal is
 * computed against the plan as it was, then sits in someone's queue. If a row moved in the
 * meantime, applying the proposal would silently clobber whoever moved it, and that person would
 * have no idea their edit had been reverted by a machine. So every UPDATE row carries the
 * before-state it was computed from, and application refuses any row whose current value no
 * longer matches. The refusal is recorded on the row, so a partially-applied proposal explains
 * itself instead of looking like a bug.
 *
 * WHY ACCEPT/REJECT IS ALSO THE QUALITY SIGNAL: per-row decisions are far richer than the
 * thumbs-up/down on `AIInteraction`, and they are produced as a by-product of people doing their
 * normal work rather than as a favour to the model.
 *
 * WHO CALLS THIS: `controllers/ai-proposal.controller.ts`.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { assertNoParentCycle, toDay } from "./plan-schedule.service.js";

export type ProposalKind = "PLAN_BREAKDOWN" | "SCHEDULE_ADJUSTMENT" | "ASSIGNMENT_REBALANCE" | "RISK_MITIGATION" | "BLUEPRINT_SUGGESTION";
export type ChangeOp = "CREATE" | "UPDATE" | "LINK";
export type ChangeTarget = "TICKET" | "PROJECT" | "BOOKING" | "LINK";

export interface DraftChange {
  targetType: ChangeTarget;
  /** Null for CREATE — the row does not exist yet. */
  targetId?: string | null;
  op: ChangeOp;
  /** REQUIRED for UPDATE. The values this change was computed against; application refuses if
   *  the row has moved since. */
  before?: Record<string, unknown> | null;
  after: Record<string, unknown>;
  /** One human-readable line ("Move TCK-14 from Ana to Ben") so a reviewer reads intent, not JSON. */
  summary: string;
}

/** How long an unreviewed proposal stays applicable. A schedule proposal computed against last
 *  week's plan is worse than no proposal, so they expire rather than lingering. */
const PROPOSAL_TTL_HOURS = 72;

export async function createProposal(params: {
  kind: ProposalKind;
  title: string;
  rationale?: string | null;
  confidence?: number | null;
  model?: string | null;
  promptVersionId?: string | null;
  scopeProjectId?: string | null;
  scopeTicketId?: string | null;
  requestedById: string;
  changes: DraftChange[];
}) {
  if (params.changes.length === 0) throw new AppError(422, "The assistant did not propose any changes.");
  if (params.changes.length > 200) throw new AppError(422, "That proposal is too large to review safely.");

  for (const change of params.changes) {
    // An UPDATE with no before-state cannot be checked for staleness, which is the one guarantee
    // this whole design rests on. Refused at construction rather than discovered at apply time.
    if (change.op === "UPDATE" && (!change.before || Object.keys(change.before).length === 0)) {
      throw new AppError(500, `Proposed change "${change.summary}" is missing the state it was computed from.`);
    }
  }

  return prisma.aiProposal.create({
    data: {
      kind: params.kind,
      title: params.title,
      rationale: params.rationale ?? null,
      confidence: params.confidence ?? null,
      model: params.model ?? null,
      promptVersionId: params.promptVersionId ?? null,
      scopeProjectId: params.scopeProjectId ?? null,
      scopeTicketId: params.scopeTicketId ?? null,
      requestedById: params.requestedById,
      status: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_HOURS * 3_600_000),
      changes: {
        create: params.changes.map((change, index) => ({
          targetType: change.targetType,
          targetId: change.targetId ?? null,
          op: change.op,
          before: (change.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: change.after as Prisma.InputJsonValue,
          summary: change.summary.slice(0, 300),
          order: index
        }))
      }
    },
    include: { changes: { orderBy: { order: "asc" } } }
  });
}

/** Fields a proposal is allowed to touch on a ticket. An allowlist, not a denylist: a model that
 *  proposed `{ reporterId: ... }` or `{ status: "CLOSED" }` must be unable to have it applied,
 *  and enumerating what IS permitted is the only version of that which stays correct as the
 *  schema grows. */
const TICKET_WRITABLE = new Set(["startDate", "endDate", "assigneeId", "estimatedHours", "parentId", "priority", "progressPct", "isMilestone", "sortOrder"]);
const DATE_FIELDS = new Set(["startDate", "endDate"]);

function projectTicketData(after: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!TICKET_WRITABLE.has(key)) continue;
    data[key] = DATE_FIELDS.has(key) && value ? toDay(String(value)) : value;
  }
  return data;
}

/** Normalises for comparison so a Date and its ISO string, or 5 and "5", are not treated as a
 *  conflict. Over-strict staleness detection would block legitimate applications constantly. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    const da = a instanceof Date ? a : new Date(String(a));
    const db = b instanceof Date ? b : new Date(String(b));
    return da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
  }
  return String(a) === String(b);
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  failed: Array<{ id: string; summary: string; reason: string }>;
  status: "APPLIED" | "PARTIALLY_APPLIED" | "REJECTED";
}

/**
 * Applies the rows a reviewer accepted.
 *
 * Each row is applied INDEPENDENTLY rather than in one all-or-nothing transaction. That is
 * deliberate: the rows are individually reviewed decisions, so one row failing its staleness
 * check is not a reason to discard the eleven a person explicitly approved. Every failure is
 * recorded on its own row with the reason.
 */
export async function applyProposal(params: {
  proposalId: string;
  /** `{ changeId: accepted }`. Rows absent from the map keep whatever they already had. */
  decisions: Record<string, boolean>;
  actorId: string;
}): Promise<ApplyResult> {
  const proposal = await prisma.aiProposal.findUnique({
    where: { id: params.proposalId },
    include: { changes: { orderBy: { order: "asc" } } }
  });
  if (!proposal) throw new AppError(404, "Proposal not found");
  if (proposal.status === "APPLIED" || proposal.status === "REJECTED") {
    throw new AppError(409, "This proposal has already been reviewed.");
  }
  if (proposal.expiresAt && proposal.expiresAt < new Date()) {
    await prisma.aiProposal.update({ where: { id: proposal.id }, data: { status: "EXPIRED" } });
    throw new AppError(409, "This proposal was computed against an older version of the plan and has expired. Ask for a fresh one.");
  }

  const failed: ApplyResult["failed"] = [];
  let applied = 0;
  let skipped = 0;

  // CREATE rows first: a later row may reference one by index, and a parent has to exist before
  // its children can point at it.
  const ordered = [...proposal.changes].sort((a, b) => (a.op === "CREATE" ? -1 : 1) - (b.op === "CREATE" ? -1 : 1) || a.order - b.order);
  const createdByOrder = new Map<number, string>();

  for (const change of ordered) {
    const accepted = params.decisions[change.id] ?? change.accepted ?? false;
    if (!accepted) {
      skipped++;
      await prisma.aiProposalChange.update({ where: { id: change.id }, data: { accepted: false } });
      continue;
    }

    try {
      const after = change.after as Record<string, unknown>;

      if (change.op === "UPDATE" && change.targetType === "TICKET" && change.targetId) {
        const current = await prisma.ticket.findFirst({ where: { id: change.targetId, deletedAt: null } });
        if (!current) throw new Error("that work item no longer exists");

        // THE staleness check. If any field moved since the proposal was computed, refuse —
        // applying would silently revert whoever moved it, and they would never know.
        const before = (change.before ?? {}) as Record<string, unknown>;
        for (const [key, expected] of Object.entries(before)) {
          if (!sameValue((current as Record<string, unknown>)[key], expected)) {
            throw new Error(`"${key}" has changed since this was suggested`);
          }
        }

        if (after.parentId) {
          const all = await prisma.ticket.findMany({
            where: { projectId: current.projectId, deletedAt: null },
            select: { id: true, parentId: true }
          });
          assertNoParentCycle(current.id, String(after.parentId), new Map(all.map((t) => [t.id, t.parentId])));
        }

        const data = projectTicketData(after);
        if (Object.keys(data).length === 0) throw new Error("nothing in this change is applicable");
        await prisma.ticket.update({ where: { id: current.id }, data });
      } else if (change.op === "CREATE" && change.targetType === "TICKET") {
        const { issueTicketKey, computeTicketDueDate, getGlobalTicketSettings } = await import("./ticket.service.js");
        const settings = await getGlobalTicketSettings();
        const projectId = String(after.projectId ?? proposal.scopeProjectId ?? "");
        if (!projectId) throw new Error("no project to create this in");

        // A parent referenced by the index of an earlier CREATE row in this same proposal.
        const parentId =
          typeof after.parentIndex === "number"
            ? createdByOrder.get(after.parentIndex) ?? null
            : (after.parentId as string | null) ?? proposal.scopeTicketId ?? null;

        const created = await prisma.$transaction(async (tx) => {
          const key = await issueTicketKey(tx, projectId);
          return tx.ticket.create({
            data: {
              key,
              projectId,
              title: String(after.title ?? "Untitled").slice(0, 255),
              description: after.description ? String(after.description) : null,
              type: String(after.type ?? "TASK"),
              priority: (after.priority as never) ?? "MEDIUM",
              reporterId: params.actorId,
              parentId,
              estimatedHours: typeof after.estimatedHours === "number" ? after.estimatedHours : null,
              startDate: after.startDate ? toDay(String(after.startDate)) : null,
              endDate: after.endDate ? toDay(String(after.endDate)) : null,
              dueAt: computeTicketDueDate(new Date(), ((after.priority as never) ?? "MEDIUM"), settings)
            }
          });
        });
        createdByOrder.set(change.order, created.id);
        await prisma.aiProposalChange.update({ where: { id: change.id }, data: { targetId: created.id } });
      } else if (change.op === "LINK") {
        const fromId = typeof after.fromIndex === "number" ? createdByOrder.get(after.fromIndex) : String(after.fromId ?? "");
        const toId = typeof after.toIndex === "number" ? createdByOrder.get(after.toIndex) : String(after.toId ?? "");
        if (!fromId || !toId) throw new Error("one end of this dependency was not created");
        await prisma.ticketLink.upsert({
          where: { sourceTicketId_targetTicketId_type: { sourceTicketId: fromId, targetTicketId: toId, type: "FINISH_TO_START" } },
          update: {},
          create: { sourceTicketId: fromId, targetTicketId: toId, type: "FINISH_TO_START", lagDays: 0 }
        });
      } else {
        throw new Error("unsupported change type");
      }

      applied++;
      await prisma.aiProposalChange.update({
        where: { id: change.id },
        data: { accepted: true, appliedAt: new Date(), applyError: null }
      });
    } catch (error) {
      const reason = (error as Error).message;
      failed.push({ id: change.id, summary: change.summary, reason });
      await prisma.aiProposalChange.update({
        where: { id: change.id },
        data: { accepted: true, applyError: reason.slice(0, 500) }
      });
    }
  }

  const status: ApplyResult["status"] = applied === 0 ? "REJECTED" : failed.length > 0 || skipped > 0 ? "PARTIALLY_APPLIED" : "APPLIED";

  await prisma.aiProposal.update({
    where: { id: proposal.id },
    data: {
      status,
      reviewedById: params.actorId,
      reviewedAt: new Date(),
      appliedAt: applied > 0 ? new Date() : null
    }
  });

  await audit(params.actorId, "ai_proposal.applied", "AiProposal", proposal.id, {
    kind: proposal.kind,
    applied,
    skipped,
    failed: failed.length
  });

  return { applied, skipped, failed, status };
}

/** Marks unreviewed proposals past their TTL. Called by the risk worker's tick so it needs no
 *  cron of its own — an expired proposal must not be applicable, and that is all this enforces. */
export async function expireStaleProposals(): Promise<number> {
  const { count } = await prisma.aiProposal.updateMany({
    where: { status: "PENDING_REVIEW", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" }
  });
  return count;
}
