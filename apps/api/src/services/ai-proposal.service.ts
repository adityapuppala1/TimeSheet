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
import { assertLevelAtLeast } from "./ai-autonomy.service.js";
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

/**
 * Every id inside `after` is checked against the database before it is written.
 *
 * The allowlist above decides which FIELDS may move; this decides whether the VALUES name real
 * rows. `after` is a JSON blob authored by whatever produced the proposal — today only
 * `proposePlanBreakdown`, whose output is model text, and an assignment-rebalance kind is already
 * declared in `ProposalKind`. An id that came out of a model is a suggestion, never an
 * authorization decision: a rebalance that names an id is asking for a person, and "does that
 * person exist, are they still active" has to be answered here rather than assumed, or the first
 * feature to emit one silently assigns work to a deactivated account or a foreign uuid.
 *
 * Tenant isolation is NOT what this provides — the `prisma` proxy already scopes every read to the
 * caller's own database, so a foreign id simply finds nothing. This is about a live row.
 */
async function assertReferencedRowsExist(data: Record<string, unknown>, projectId: string): Promise<void> {
  if (data.assigneeId) {
    const assignee = await prisma.user.findFirst({ where: { id: String(data.assigneeId), deletedAt: null, status: "ACTIVE" }, select: { id: true } });
    if (!assignee) throw new Error("the suggested assignee is not an active user");
  }
  if (data.parentId) {
    // Same project, deliberately: a parent in another project would reparent work across a
    // boundary the plan views (and `assertNoParentCycle`, which only walks one project) assume.
    const parent = await prisma.ticket.findFirst({ where: { id: String(data.parentId), projectId, deletedAt: null }, select: { id: true } });
    if (!parent) throw new Error("the suggested parent is not a work item in this project");
  }
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
  /**
   * WHO is doing the applying — a person who read the rows, or a capability acting on its own.
   *
   * Optional and defaulting to HUMAN so every existing call site compiles and behaves untouched.
   *
   * THIS IS THE CHOKEPOINT, and its placement is the whole design. There is exactly one function
   * in this codebase that writes an AI-authored change, and when the applier is an agent that
   * function asks the autonomy policy ITSELF rather than trusting its caller to have asked. A
   * capability added in a hurry that forgets to check gets refused by the only function it can use
   * to act — the same discipline that makes `invokeMcpTool` the one door for tools.
   */
  appliedBy?: { kind: "HUMAN" } | { kind: "AGENT"; capability: string; runId: string };
}): Promise<ApplyResult> {
  const appliedBy = params.appliedBy ?? { kind: "HUMAN" as const };
  if (appliedBy.kind === "AGENT") {
    // Throws 403 unless this capability currently holds AUTO_APPLY or better — after the master
    // latch, the feature toggle and the product's own ceiling have all been applied.
    await assertLevelAtLeast(appliedBy.capability, "AUTO_APPLY");
  }

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
        await assertReferencedRowsExist(data, current.projectId);
        await prisma.ticket.update({ where: { id: current.id }, data });
      } else if (change.op === "CREATE" && change.targetType === "TICKET") {
        const { issueTicketKey, computeTicketDueDate, getGlobalTicketSettings } = await import("./ticket.service.js");
        const settings = await getGlobalTicketSettings();
        // The proposal's own scope WINS over anything in `after` when it has one. The scope is what
        // the caller was authorized against when the proposal was created and again when it was
        // applied; `after.projectId` is part of the change set. Letting the change set choose would
        // mean a row could land in a project neither check ever looked at.
        const projectId = String(proposal.scopeProjectId ?? after.projectId ?? "");
        if (!projectId) throw new Error("no project to create this in");
        const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
        if (!project) throw new Error("that project no longer exists");

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
  }, {
    // `actorId` stays the delegating person either way — that is whose permissions were checked.
    // `actorType` is what records that they did not press anything, which is the distinction the
    // whole provenance change exists to make.
    actorType: appliedBy.kind === "AGENT" ? "AGENT" : "USER",
    ...(appliedBy.kind === "AGENT"
      ? { actorLabel: `agent:${appliedBy.capability}`, agentRunId: appliedBy.runId }
      : {})
  });

  return { applied, skipped, failed, status };
}

export interface UndoResult {
  undone: number;
  /** Rows that could not be put back, each with the reason. */
  refused: Array<{ id: string; summary: string; reason: string }>;
  status: "UNDONE" | "PARTIALLY_UNDONE";
}

/**
 * Put back what a proposal changed.
 *
 * WHY UNDO IS SCOPED TO PROPOSALS AND NOT GENERAL: a general undo would mean capturing before and
 * after on every write in the application — every controller, every service — which is the maximal
 * version of "changing how the product works" in exchange for a feature nobody asks for. Nobody
 * needs to undo a colleague's edit from a machine. "Put back what the assistant just did" is the
 * only undo anyone actually wants, and this is exactly that.
 *
 * WHY IT NEEDS NO NEW DATA: `createProposal` refuses an UPDATE that arrives without a `before`
 * (see its guard), so every applied UPDATE row already carries its own inverse. A CREATE's inverse
 * is a soft delete of the row whose id was written back onto `targetId` at apply time. A LINK's
 * inverse is deleting a row with a natural unique key.
 *
 * THE SYMMETRIC STALENESS CHECK — the property that makes this safe rather than merely reversible.
 * `applyProposal` refuses a row whose current value no longer matches the `before` it was computed
 * against, because applying it would silently revert whoever moved it. Undo faces the identical
 * hazard from the opposite direction: if somebody has edited a field SINCE the assistant set it,
 * putting it back to `before` would clobber that person just as invisibly. So a row is only
 * reverted while it still holds exactly what we wrote. Anything else is refused, with the reason
 * recorded on the row.
 *
 * ORDER IS REVERSED for the same reason apply's is forward: apply creates parents before the
 * children and links that point at them, so undo has to remove the links first and the parents
 * last, or it would be deleting a row somebody still points to.
 */
export async function undoProposal(params: { proposalId: string; actorId: string }): Promise<UndoResult> {
  const proposal = await prisma.aiProposal.findUnique({
    where: { id: params.proposalId },
    include: { changes: { orderBy: { order: "asc" } } }
  });
  if (!proposal) throw new AppError(404, "Proposal not found");
  if (proposal.status !== "APPLIED" && proposal.status !== "PARTIALLY_APPLIED") {
    throw new AppError(409, "Only a proposal that was applied can be undone.");
  }

  // Only rows that actually landed. A row that was skipped or that failed at apply time has
  // nothing to put back, and treating it as an undo failure would be a lie.
  const applied = proposal.changes.filter((c) => c.appliedAt && !c.undoneAt);
  if (applied.length === 0) throw new AppError(409, "Nothing from this proposal is still applied.");

  // LINK → UPDATE → CREATE, then latest first inside each group.
  const rank = (op: string) => (op === "LINK" ? 0 : op === "UPDATE" ? 1 : 2);
  const ordered = [...applied].sort((a, b) => rank(a.op) - rank(b.op) || b.order - a.order);

  const refused: UndoResult["refused"] = [];
  let undone = 0;

  for (const change of ordered) {
    try {
      const after = (change.after ?? {}) as Record<string, unknown>;
      const before = (change.before ?? {}) as Record<string, unknown>;

      if (change.op === "UPDATE" && change.targetType === "TICKET" && change.targetId) {
        const current = await prisma.ticket.findFirst({ where: { id: change.targetId, deletedAt: null } });
        if (!current) throw new Error("that work item no longer exists");

        // The mirror of apply's check: refuse unless the row still holds what we wrote.
        for (const [key, written] of Object.entries(projectTicketData(after))) {
          if (!sameValue((current as Record<string, unknown>)[key], written)) {
            throw new Error(`"${key}" has been changed since, so putting it back would undo somebody else's edit`);
          }
        }

        const restore = projectTicketData(before);
        if (Object.keys(restore).length === 0) throw new Error("there is no recorded previous value for this");
        await prisma.ticket.update({ where: { id: current.id }, data: restore });
      } else if (change.op === "CREATE" && change.targetType === "TICKET" && change.targetId) {
        const current = await prisma.ticket.findFirst({ where: { id: change.targetId, deletedAt: null } });
        // Already gone is the outcome undo wanted, so it is a success and not a refusal.
        if (current) {
          // Soft delete, matching how this product deletes a ticket everywhere else — a hard
          // delete would take its comments and attachments with it, and somebody may have added
          // both since. Children first, so nothing is left pointing at a deleted parent.
          const children = await prisma.ticket.count({ where: { parentId: current.id, deletedAt: null } });
          if (children > 0) throw new Error("work has been filed underneath this since, so removing it would orphan it");
          await prisma.ticket.update({ where: { id: current.id }, data: { deletedAt: new Date() } });
        }
      } else if (change.op === "LINK") {
        const fromId = String(after.fromId ?? "");
        const toId = String(after.toId ?? "");
        // Apply resolves index-based ends at apply time and does not write them back, so a link
        // created from a `fromIndex`/`toIndex` pair cannot be identified now. Refuse rather than
        // guess — deleting the wrong dependency is worse than leaving this one.
        if (!fromId || !toId) throw new Error("this dependency cannot be identified well enough to remove safely");
        await prisma.ticketLink.deleteMany({
          where: { sourceTicketId: fromId, targetTicketId: toId, type: "FINISH_TO_START" }
        });
      } else {
        throw new Error("this kind of change cannot be put back");
      }

      undone++;
      await prisma.aiProposalChange.update({
        where: { id: change.id },
        data: { undoneAt: new Date(), undoError: null }
      });
    } catch (error) {
      const reason = (error as Error).message;
      refused.push({ id: change.id, summary: change.summary, reason });
      await prisma.aiProposalChange.update({ where: { id: change.id }, data: { undoError: reason.slice(0, 500) } });
    }
  }

  const status: UndoResult["status"] = refused.length === 0 ? "UNDONE" : "PARTIALLY_UNDONE";
  await prisma.aiProposal.update({
    where: { id: proposal.id },
    data: { status, undoneById: params.actorId, undoneAt: new Date() }
  });

  await audit(params.actorId, "ai_proposal.undone", "AiProposal", proposal.id, {
    kind: proposal.kind,
    undone,
    refused: refused.length
  }, {
    // A person reversing what a machine did is the single strongest quality signal this system
    // will ever produce, and the row an operator most wants to find. It records the transition.
    before: { status: proposal.status },
    after: { status }
  });

  return { undone, refused, status };
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
