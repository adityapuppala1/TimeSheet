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
import type { AiProposalTargetType } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { assertLevelAtLeast, resolveAutonomy } from "./ai-autonomy.service.js";
import { levelRank } from "./ai-capability.registry.js";
import { dispatchNotification } from "./notify.service.js";
import { assertNoParentCycle, toDay } from "./plan-schedule.service.js";

/** The states after which a change's PLAN is frozen. Mirrors `FROZEN_AFTER` in change.controller.ts
 *  — a drafted section applied after approval would rewrite what was agreed. */
const FROZEN_CHANGE_STATES = new Set(["APPROVED", "SCHEDULED", "IMPLEMENTING", "VALIDATION", "PIR", "CLOSED"]);

export type ProposalKind =
  | "PLAN_BREAKDOWN"
  | "SCHEDULE_ADJUSTMENT"
  | "ASSIGNMENT_REBALANCE"
  | "RISK_MITIGATION"
  | "BLUEPRINT_SUGGESTION"
  | "CHANGE_DRAFT"
  | "REQUIREMENTS_DOC";
export type ChangeOp = "CREATE" | "UPDATE" | "LINK";
/** Re-exported rather than redeclared: the list lives in @timesheet/shared so the browser can
 *  import the same one. See the comment there for why it is not a Prisma enum. */
export type ChangeTarget = AiProposalTargetType;

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
  /** The captured AIInteraction this was parsed from — what the quality loop promotes when a
   *  human rejects or undoes the result. Null for arithmetic producers and when capture is off. */
  sourceInteractionId?: string | null;
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
      sourceInteractionId: params.sourceInteractionId ?? null,
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

/**
 * Fields a proposal may touch on a CHANGE REQUEST. Five, and every one of them is prose that BLOCKS
 * submission — the sections `missingForSubmit` demands.
 *
 * WHY THE LIST IS THIS SHORT, and why it is a list at all: everything else on a change is either
 * governance (`state`, `riskScore`, `riskLevel`), schedule, or an outcome. A risk score a model
 * could write would make the rule that decides whether a backout plan is mandatory unreproducible;
 * a state a model could write would walk the change past its own approver. Neither belongs in a
 * drafting assistant, and an allowlist is what makes that true by construction rather than by the
 * prompt asking nicely.
 *
 * `backoutPlan` being here at all is worth stating: it is the single most consequential field in the
 * module, which is exactly why the assistant may only PROPOSE it and a person must accept the row.
 */
const CHANGE_WRITABLE = new Set([
  "justification",
  "implementationPlan",
  "backoutPlan",
  "testPlan",
  "communicationPlan",
  // The post-implementation review. Written by `change_pir_assist` through this same envelope, and
  // deliberately NOT subject to the plan freeze below — a review is written after the change has
  // run, which is exactly when the plan is frozen. See the apply branch.
  "pirNotes"
]);

function projectChangeData(after: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!CHANGE_WRITABLE.has(key)) continue;
    data[key] = value;
  }
  return data;
}

/**
 * Fields a proposal may touch on a PROJECT. Deliberately just the two planning dates.
 *
 * Everything else on a Project is either identity (`code`, `name`), lifecycle (`status` — the
 * archive switch), or money (`budgetAmount`, `defaultHourlyRate`, `billingCurrency`). None of
 * those is a scheduling decision, and a SCHEDULE_ADJUSTMENT proposal that could quietly re-band a
 * project's budget or archive it would be a very different feature than the one being built.
 */
const PROJECT_WRITABLE = new Set(["plannedStartDate", "plannedEndDate"]);

/**
 * Fields a proposal may touch on a RESOURCE BOOKING — the ASSIGNMENT_REBALANCE surface.
 *
 * `userId` IS included, because moving a booking from an overloaded person to someone with room is
 * the entire point of a rebalance. It is also the most consequential field here, so it is
 * validated against a live, active account below rather than trusted.
 *
 * `isTimeOff` is excluded: flipping a booking between "working" and "on leave" is a statement
 * about a person's time off, not a scheduling adjustment, and no model should make it.
 */
const BOOKING_WRITABLE = new Set(["startDate", "endDate", "hoursPerDay", "note", "userId"]);

/** Dependency kinds a proposal may express. Mirrors the TicketLinkType enum; an unrecognised
 *  value falls back to FINISH_TO_START rather than failing the row. */
const LINK_TYPES = new Set(["BLOCKS", "DUPLICATE", "RELATES", "FINISH_TO_START", "START_TO_START", "FINISH_TO_FINISH", "START_TO_FINISH"]);

const PROJECT_DATE_FIELDS = new Set(["plannedStartDate", "plannedEndDate"]);
const BOOKING_DATE_FIELDS = new Set(["startDate", "endDate"]);

function projectTicketData(after: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!TICKET_WRITABLE.has(key)) continue;
    data[key] = DATE_FIELDS.has(key) && value ? toDay(String(value)) : value;
  }
  return data;
}

/** Same shape as projectTicketData, for the other two targets. Kept as three small functions
 *  rather than one parameterised one so each allowlist sits next to the fields it governs. */
function projectProjectData(after: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!PROJECT_WRITABLE.has(key)) continue;
    data[key] = PROJECT_DATE_FIELDS.has(key) && value ? toDay(String(value)) : value;
  }
  return data;
}

function projectBookingData(after: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!BOOKING_WRITABLE.has(key)) continue;
    data[key] = BOOKING_DATE_FIELDS.has(key) && value ? toDay(String(value)) : value;
  }
  return data;
}

/** The one place a booking's own shape is checked, so apply and undo cannot disagree about it. */
async function assertBookingReferencesExist(data: Record<string, unknown>): Promise<void> {
  if (data.userId) {
    const person = await prisma.user.findFirst({
      where: { id: String(data.userId), deletedAt: null, status: "ACTIVE" },
      select: { id: true }
    });
    if (!person) throw new Error("the suggested person is not an active user");
  }
  // A booking that ends before it starts is not a scheduling opinion, it is a broken row, and the
  // database has no constraint that stops one.
  if (data.startDate && data.endDate && new Date(String(data.startDate)) > new Date(String(data.endDate))) {
    throw new Error("that booking would end before it starts");
  }
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

/**
 * THE staleness check. If any field moved since the proposal was computed, refuse — applying would
 * silently revert whoever moved it, and they would never know.
 *
 * Extracted so all three UPDATE targets share one implementation. When it lived inline in the
 * ticket branch, adding the project and booking branches meant copying it twice, and the copy that
 * eventually drifted would be a branch where a machine could quietly overwrite somebody's edit —
 * which is the one thing this envelope exists to prevent.
 */
function assertNotStale(before: unknown, current: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries((before ?? {}) as Record<string, unknown>)) {
    if (!sameValue(current[key], expected)) {
      throw new Error(`"${key}" has changed since this was suggested`);
    }
  }
}

/**
 * The same check, pointed the other way, for undo.
 *
 * Apply asks "does this row still hold what the proposal was computed against?". Undo asks "does
 * it still hold what WE wrote?" — because if somebody has edited it since, putting it back would
 * erase their change exactly as invisibly as applying a stale row would have erased it.
 */
function assertStillOurs(written: Record<string, unknown>, current: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(written)) {
    if (!sameValue(current[key], value)) {
      throw new Error(`"${key}" has been changed since, so putting it back would undo somebody else's edit`);
    }
  }
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

        assertNotStale(change.before, current as unknown as Record<string, unknown>);

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
      } else if (change.op === "UPDATE" && change.targetType === "CHANGE" && change.targetId) {
        const current = await prisma.changeRequest.findFirst({ where: { id: change.targetId } });
        if (!current) throw new Error("that change no longer exists");

        // The plan freezes once a change is approved — scope and risk are what got approved, and a
        // drafted section arriving afterwards would rewrite what was agreed. The API refuses the
        // same edit by hand; refusing it here too is the point of one rule having two callers.
        // The PLAN freezes at approval; the REVIEW does not, because a review is written after the
        // change has run — which is precisely when the plan is frozen. Freezing both would make the
        // PIR assistant unable to write the only field it exists for.
        const touchesPlanOnly = Object.keys(after).some((k) => k !== "pirNotes");
        if (touchesPlanOnly && FROZEN_CHANGE_STATES.has(String(current.state))) {
          throw new Error("this change has been approved, so its plan can no longer be edited");
        }

        assertNotStale(change.before, current as unknown as Record<string, unknown>);

        const data = projectChangeData(after);
        if (Object.keys(data).length === 0) throw new Error("nothing in this change is applicable");
        await prisma.changeRequest.update({ where: { id: current.id }, data });
      } else if (change.op === "UPDATE" && change.targetType === "PROJECT" && change.targetId) {
        // The scope wins over the payload, exactly as it does for a ticket CREATE below: a
        // proposal scoped to one project must not be able to move a different one.
        if (proposal.scopeProjectId && proposal.scopeProjectId !== change.targetId) {
          throw new Error("this change names a different project than the proposal is scoped to");
        }
        const current = await prisma.project.findFirst({ where: { id: change.targetId, deletedAt: null } });
        if (!current) throw new Error("that project no longer exists");

        assertNotStale(change.before, current as unknown as Record<string, unknown>);

        const data = projectProjectData(after);
        if (Object.keys(data).length === 0) throw new Error("nothing in this change is applicable");
        if (data.plannedStartDate && data.plannedEndDate && new Date(String(data.plannedStartDate)) > new Date(String(data.plannedEndDate))) {
          throw new Error("that would end the project before it starts");
        }
        await prisma.project.update({ where: { id: current.id }, data });
      } else if (change.op === "UPDATE" && change.targetType === "BOOKING" && change.targetId) {
        const current = await prisma.resourceBooking.findUnique({ where: { id: change.targetId } });
        if (!current) throw new Error("that booking no longer exists");

        assertNotStale(change.before, current as unknown as Record<string, unknown>);

        const data = projectBookingData(after);
        if (Object.keys(data).length === 0) throw new Error("nothing in this change is applicable");
        // Merged with the current row so a change that moves only the end date is still checked
        // against the start date it will actually sit next to.
        await assertBookingReferencesExist({ ...(current as unknown as Record<string, unknown>), ...data });
        await prisma.resourceBooking.update({ where: { id: current.id }, data });
      } else if (change.op === "CREATE" && change.targetType === "BOOKING") {
        const data = projectBookingData(after);
        if (!data.userId || !data.startDate || !data.endDate) throw new Error("a booking needs a person and a date range");
        await assertBookingReferencesExist(data);
        const created = await prisma.resourceBooking.create({
          data: {
            userId: String(data.userId),
            // The proposal's scope wins over the payload, same rule as a ticket CREATE.
            projectId: proposal.scopeProjectId ?? (after.projectId ? String(after.projectId) : null),
            ticketId: after.ticketId ? String(after.ticketId) : null,
            startDate: data.startDate as Date,
            endDate: data.endDate as Date,
            hoursPerDay: typeof data.hoursPerDay === "number" ? data.hoursPerDay : 8,
            note: data.note ? String(data.note).slice(0, 300) : null,
            createdById: params.actorId
          }
        });
        createdByOrder.set(change.order, created.id);
        await prisma.aiProposalChange.update({ where: { id: change.id }, data: { targetId: created.id } });
      } else if (change.op === "CREATE" && change.targetType === "TICKET_LABEL") {
        /**
         * Adding a label to a ticket, as a reviewable change.
         *
         * WHY IT EXISTS: without it a proposal-only workflow could not propose a label at all — the
         * dispatcher had to record the step as `held` and do nothing, which is honest and useless. A
         * triage flow that reads inbound email is proposal-only BY CONSTRUCTION (the taint clamp), and
         * "read this and label it" is the single most obvious thing such a flow is for.
         *
         * WHY IT IS `CREATE` RATHER THAN `UPDATE`: a label is a row in a join table, not a field on
         * the ticket. There is no before-state to check for staleness because there is no prior value
         * — the row either exists or does not, and the `findFirst` below is the whole check.
         */
        const ticketId = String(after.ticketId ?? "");
        const labelId = String(after.labelId ?? "");
        if (!ticketId || !labelId) throw new Error("a label change needs a ticket and a label");
        const ticketExists = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { id: true } });
        if (!ticketExists) throw new Error("that ticket no longer exists");
        const labelExists = await prisma.label.findUnique({ where: { id: labelId }, select: { id: true } });
        if (!labelExists) throw new Error("that label no longer exists");
        // Already there is the outcome this change wanted, so it is a success rather than a refusal —
        // the same rule the undo path applies to an already-deleted row.
        const already = await prisma.ticketLabel.findFirst({ where: { ticketId, labelId }, select: { id: true } });
        const row = already ?? (await prisma.ticketLabel.create({ data: { ticketId, labelId } }));
        await prisma.aiProposalChange.update({ where: { id: change.id }, data: { targetId: row.id } });
      } else if (change.op === "LINK") {
        const fromId = typeof after.fromIndex === "number" ? createdByOrder.get(after.fromIndex) : String(after.fromId ?? "");
        const toId = typeof after.toIndex === "number" ? createdByOrder.get(after.toIndex) : String(after.toId ?? "");
        if (!fromId || !toId) throw new Error("one end of this dependency was not created");
        // The link TYPE and lag are now taken from the change rather than hardcoded, so a schedule
        // proposal can express "start together" or "finish two days before" and not only
        // finish-to-start. Unrecognised values fall back rather than throwing: a link with the
        // wrong kind is a worse outcome than a link with the default kind, but neither is worth
        // discarding the rest of the proposal over.
        const type = LINK_TYPES.has(String(after.type)) ? (String(after.type) as never) : ("FINISH_TO_START" as never);
        const lagDays = Number.isFinite(Number(after.lagDays)) ? Math.trunc(Number(after.lagDays)) : 0;
        await prisma.ticketLink.upsert({
          where: { sourceTicketId_targetTicketId_type: { sourceTicketId: fromId, targetTicketId: toId, type } },
          update: { lagDays },
          create: { sourceTicketId: fromId, targetTicketId: toId, type, lagDays }
        });
        // Written back so undo can find this exact row later — without it, a link created from
        // index-based ends cannot be identified once the proposal is closed.
        await prisma.aiProposalChange.update({
          where: { id: change.id },
          data: { after: { ...after, fromId, toId, type, lagDays } as Prisma.InputJsonValue }
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

/**
 * Create a proposal and, if the capability is allowed to, apply it immediately.
 *
 * THIS IS THE ONLY PLACE AUTO_APPLY HAPPENS. Producers call this instead of `createProposal` and
 * do not decide anything themselves — a producer that made its own call about whether it may act
 * would be a producer that could get it wrong, and there would be as many chances to get it wrong
 * as there are producers.
 *
 * AND IT IS STILL THE SAME WRITE PATH. AUTO_APPLY is not a second way to change the database; it
 * is `applyProposal` with every row accepted and an agent as the applier. So it inherits, unchanged
 * and untouchable: the per-row staleness refusal, the field allowlist, the referential validation,
 * per-row independence, the audit row — and, because the proposal is a real reviewed artefact
 * rather than a bare write, `undoProposal` works on it exactly as it does on a human's.
 *
 * WHAT DEGRADES RATHER THAN FAILS: every guardrail below leaves the proposal PENDING_REVIEW rather
 * than throwing. A capability that exceeded its change budget has not done anything wrong — it has
 * produced something that needs a person, which is precisely the state the product had before
 * autonomy existed. Falling back to "a human decides" is never an error.
 */
export async function createProposalAndMaybeApply(
  params: Parameters<typeof createProposal>[0] & { capability: string }
): Promise<{ proposalId: string; autoApplied: boolean; applied: number; heldForReview: string | null }> {
  const { capability, ...draft } = params;
  const proposal = await createProposal(draft);

  const autonomy = await resolveAutonomy(capability);
  if (levelRank(autonomy.effectiveLevel) < levelRank("AUTO_APPLY")) {
    return { proposalId: proposal.id, autoApplied: false, applied: 0, heldForReview: null };
  }

  const held = (reason: string) => ({ proposalId: proposal.id, autoApplied: false, applied: 0, heldForReview: reason });

  // A change budget is how an administrator says "act on small things by yourself". A proposal
  // that blows through it is exactly the one a person should look at.
  const maxChanges = autonomy.guardrails.maxChangesPerRun;
  if (maxChanges !== null && proposal.changes.length > maxChanges) {
    return held(`${proposal.changes.length} changes is more than the ${maxChanges} this capability may apply unattended.`);
  }

  // A project allowlist is how an administrator says "act on THIS project by yourself". Absent
  // means every project the acting person can see, which is not the same as everywhere.
  const scopeIds = autonomy.guardrails.scopeProjectIds;
  if (scopeIds && (!proposal.scopeProjectId || !scopeIds.includes(proposal.scopeProjectId))) {
    return held("This capability may only act unattended on specific projects, and this is not one of them.");
  }

  const result = await applyProposal({
    proposalId: proposal.id,
    // Every row accepted. The reviewer's per-row judgement is what an administrator gave up when
    // they raised the level; it is not silently reintroduced here as a partial acceptance.
    decisions: Object.fromEntries(proposal.changes.map((c) => [c.id, true])),
    actorId: params.requestedById,
    appliedBy: { kind: "AGENT", capability, runId: proposal.id }
  });

  await notifyAutoApplied(proposal.id, params.requestedById, capability, result);
  return { proposalId: proposal.id, autoApplied: true, applied: result.applied, heldForReview: null };
}

/**
 * Tell the person whose name is on this that a machine changed things.
 *
 * NOT best-effort by accident — best-effort on purpose, and wrapped: a notification that fails must
 * not roll back a change that already landed, because then the database and the person's inbox
 * would disagree about what happened. But it is also the load-bearing half of AUTO_APPLY, so it is
 * sent for a partial application too. "Six changed, two refused" is more worth reading than six.
 */
async function notifyAutoApplied(proposalId: string, userId: string, capability: string, result: ApplyResult): Promise<void> {
  try {
    const refused = result.failed.length;
    await dispatchNotification({
      userId,
      category: "ai.autonomy_applied",
      title: `The assistant changed ${result.applied} thing${result.applied === 1 ? "" : "s"}`,
      body:
        refused > 0
          ? `${capability} applied ${result.applied} change${result.applied === 1 ? "" : "s"} and left ${refused} alone. Review or undo them.`
          : `${capability} applied ${result.applied} change${result.applied === 1 ? "" : "s"} without waiting. Review or undo them.`,
      link: "/app/proposals"
    });
  } catch {
    // Swallowed deliberately — see above.
  }
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

        assertStillOurs(projectTicketData(after), current as unknown as Record<string, unknown>);

        const restore = projectTicketData(before);
        if (Object.keys(restore).length === 0) throw new Error("there is no recorded previous value for this");
        await prisma.ticket.update({ where: { id: current.id }, data: restore });
      } else if (change.op === "UPDATE" && change.targetType === "CHANGE" && change.targetId) {
        const current = await prisma.changeRequest.findFirst({ where: { id: change.targetId } });
        if (!current) throw new Error("that change no longer exists");
        assertStillOurs(projectChangeData(after), current as unknown as Record<string, unknown>);

        const restore = projectChangeData(before);
        if (Object.keys(restore).length === 0) throw new Error("there is no recorded previous value for this");
        await prisma.changeRequest.update({ where: { id: current.id }, data: restore });
      } else if (change.op === "UPDATE" && change.targetType === "PROJECT" && change.targetId) {
        const current = await prisma.project.findFirst({ where: { id: change.targetId, deletedAt: null } });
        if (!current) throw new Error("that project no longer exists");
        assertStillOurs(projectProjectData(after), current as unknown as Record<string, unknown>);

        const restore = projectProjectData(before);
        if (Object.keys(restore).length === 0) throw new Error("there is no recorded previous value for this");
        await prisma.project.update({ where: { id: current.id }, data: restore });
      } else if (change.op === "UPDATE" && change.targetType === "BOOKING" && change.targetId) {
        const current = await prisma.resourceBooking.findUnique({ where: { id: change.targetId } });
        if (!current) throw new Error("that booking no longer exists");
        assertStillOurs(projectBookingData(after), current as unknown as Record<string, unknown>);

        const restore = projectBookingData(before);
        if (Object.keys(restore).length === 0) throw new Error("there is no recorded previous value for this");
        await prisma.resourceBooking.update({ where: { id: current.id }, data: restore });
      } else if (change.op === "CREATE" && change.targetType === "BOOKING" && change.targetId) {
        // A booking is DELETED, not soft-deleted, because ResourceBooking has no `deletedAt` — a
        // booking is a scheduling row with nothing hanging off it, and this is how the rest of the
        // app removes one. A ticket is the opposite case, which is why it is soft-deleted below.
        await prisma.resourceBooking.deleteMany({ where: { id: change.targetId } });
      } else if (change.op === "CREATE" && change.targetType === "TICKET_LABEL" && change.targetId) {
        // Hard delete, like a booking and for the same reason: a `TicketLabel` is a join row with
        // nothing hanging off it. Already gone is the outcome undo wanted, so `deleteMany` rather than
        // a delete that would throw on a missing row.
        await prisma.ticketLabel.deleteMany({ where: { id: change.targetId } });
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
