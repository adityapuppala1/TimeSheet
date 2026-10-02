/**
 * WHAT: the rules that make a change request a change request — the gate, the risk matrix, what a
 * state demands before you may enter it, which approval chain a change earns, and what happens to
 * the change when that chain settles.
 *
 * WHY THE LIFECYCLE LIVES HERE AND NOT IN A `Workflow`: `resolveWorkflowForTicketType()` falls back
 * to the SYSTEM workflow whenever custom workflows are off, and custom workflows are Enterprise-
 * only. Modelling the change lifecycle as an admin-editable workflow would therefore have collapsed
 * eleven change states into six ticket statuses for every Team-tier workspace — silently, and only
 * in production. A change lifecycle is a governance rule, not a preference, so it is enforced in
 * code and written through to `Ticket.status` via CHANGE_STATE_TO_TICKET_STATUS.
 *
 * WHY THE APPROVAL ENGINE IS REUSED RATHER THAN REBUILT: `approval.service.ts` already models
 * sequential and parallel chains, guest approvers by expiring single-use token, terminal rejection,
 * and per-step comments. All this module adds is which chain a given change earns — the policy
 * evaluation below — plus a quorum, so an emergency change can be signed off by any one of a group
 * instead of waiting for all of them.
 *
 * WHO CALLS THIS: `controllers/change.controller.ts`, and `approval.controller.ts` for the one
 * callback that tells a change its chain has settled.
 */
import {
  changeNeedsBackoutPlan,
  changeNeedsCommunicationPlan,
  changeNeedsTestPlan,
  CHANGE_STATE_TO_TICKET_STATUS,
  changeStateTransitions,
  deriveChangeRisk,
  permissions,
  type ChangeBand,
  type ChangeKind,
  type ChangeState
} from "@timesheet/shared";
import { createHash } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";
import { lazyCreateSettings } from "../utils/lazy-create-settings.js";

const SETTINGS_ID = "global";

/** Workspace switches, upserted on read — same shape as getGlobalTicketSettings. */
export async function getChangeSettings() {
  // Lazily created on first read, so two concurrent reads on a workspace that has no row yet
  // both attempt the INSERT and the loser gets a P2002. See utils/lazy-create-settings.ts.
  return lazyCreateSettings(
    () =>
      prisma.globalChangeSettings.upsert({
        where: { id: SETTINGS_ID },
        update: {},
        create: { id: SETTINGS_ID, remindHoursBefore: [24, 1] }
      }),
    () => prisma.globalChangeSettings.findUnique({ where: { id: SETTINGS_ID } })
  );
}

/**
 * The gate. Two failures, two different messages, because they need different people to act:
 * "ask your admin to switch it on" and "this is a commercial conversation" are not the same
 * sentence, and a single generic 403 sends both to the wrong place. Same split every planning gate
 * uses.
 */
/**
 * The same two conditions as `assertChangeManagementEnabled`, answered rather than thrown.
 *
 * WHY BOTH FORMS EXIST: a change route should refuse with a message naming which condition failed,
 * but a caller that merely wants to know whether to INCLUDE change data — the home dashboard — must
 * not turn "change management is off" into a failed page. Same predicate, two callers, one place.
 */
export async function isChangeManagementOn(): Promise<boolean> {
  const settings = await getChangeSettings();
  if (!settings.enableChangeManagement) return false;
  return isPlanningCapabilityAllowed(requireTenantContext().orgId, "changeManagementEnabled");
}

export async function assertChangeManagementEnabled(): Promise<void> {
  const settings = await getChangeSettings();
  if (!settings.enableChangeManagement) {
    throw new AppError(403, "Change management is off for this workspace. A super admin can enable it in Workspace Settings → Change management.");
  }
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "changeManagementEnabled"))) {
    throw new AppError(403, "Change management is not included in this plan. Upgrade to Team or Enterprise to use it.");
  }
}

/* ------------------------------------------------------------------ *
 * Risk
 * ------------------------------------------------------------------ */

/** The derived level plus the timestamp that proves when it was derived. Never accepts a level. */
export function scoreRisk(impact: ChangeBand, likelihood: ChangeBand) {
  return { riskLevel: deriveChangeRisk(impact, likelihood), riskScoredAt: new Date() };
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/** True when the move is a no-op. Callers must skip their side effects entirely, not just the
 *  write — re-submitting an already-submitted change opened a second approval round and mailed its
 *  approver twice before this was pulled out into its own answer. */
export function isNoOpTransition(from: ChangeState, to: ChangeState): boolean {
  return from === to;
}

/**
 * Moves the API allows on top of the shared table, until the shared table carries them itself.
 *
 * AWAITING_APPROVAL → DRAFT is WITHDRAW. Once submitted, a change's plan, risk, schedule and type
 * are locked (see `MATERIAL_CHANGE_FIELDS`), so withdrawing is how a requester changes them: the
 * pending round is settled as WITHDRAWN — it stays on the record — and resubmitting opens the next.
 * It cannot reach APPROVED or REJECTED, so the rule the shared table exists for is untouched.
 *
 * Kept here rather than in `@timesheet/shared` only because that package is edited separately; the
 * union below makes the entry redundant, not wrong, the day it lands there too.
 */
const API_ONLY_TRANSITIONS: Partial<Record<ChangeState, readonly ChangeState[]>> = {
  AWAITING_APPROVAL: ["DRAFT"]
};

/** Every state a change may move to by hand from `from`. The page renders its buttons from this
 *  (via `GET /changes/:id`), so it can never offer a move the API then refuses. */
export function legalChangeTargets(from: ChangeState): ChangeState[] {
  return [...new Set([...(changeStateTransitions[from] ?? []), ...(API_ONLY_TRANSITIONS[from] ?? [])])];
}

export function assertLegalChangeTransition(from: ChangeState, to: ChangeState): void {
  if (isNoOpTransition(from, to)) return;
  if (!legalChangeTargets(from).includes(to)) {
    throw new AppError(400, `A change cannot move from ${label(from)} to ${label(to)}.`);
  }
}

/* ------------------------------------------------------------------ *
 * What an approval is a decision ON
 * ------------------------------------------------------------------ */

/**
 * The MATERIAL fields: what an approver is shown and what the approval gates read. An approval is a
 * judgement on exactly these, so from submission on they are locked — and a change to one after
 * approval needs approving again.
 *
 *   - Type: MAJOR forces a backout plan and a review; the approver is told the type.
 *   - Environment: where it lands decides what it collides with and what its risk means.
 *   - Risk inputs: the score and band are derived from these, never written directly, and the band
 *     decides whether a backout plan is mandatory.
 *   - Data migration and downtime: they decide which plans are owed (`missingForSubmit`).
 *   - The plans the submission gate demands.
 *   - The schedule.
 *
 * Everything else — title and description wording, the implementer, owners, the business case,
 * release identifiers, affected-thing lists, the override reason — is description or staffing, not
 * the risk somebody accepted, and stays editable.
 */
export const MATERIAL_CHANGE_FIELDS = [
  "changeKind",
  "environment",
  "riskInputs",
  "impact",
  "likelihood",
  "dataMigration",
  "requiresDowntime",
  "downtimeMinutes",
  "downtimeStart",
  "downtimeEnd",
  "justification",
  "implementationPlan",
  "backoutPlan",
  "testPlan",
  "communicationPlan",
  "plannedStart",
  "plannedEnd"
] as const;

/** From submission on, the material fields are what somebody is deciding, or has decided. */
export const PLAN_LOCKED_STATES: readonly ChangeState[] = ["AWAITING_APPROVAL", "APPROVED", "SCHEDULED", "IMPLEMENTING", "VALIDATION", "PIR", "CLOSED"];

/** Approved but not started: a change manager's material edit here re-opens approval rather than
 *  being refused. Once implementation has begun there is no going back to the approver — the plan
 *  that ran is the plan that was approved, and a different plan is a different change. */
export const REAPPROVABLE_STATES: readonly ChangeState[] = ["APPROVED", "SCHEDULED"];

/** Equal for the purpose of "did this save change anything": an ISO string and the Date it names, a
 *  JSON map in any key order, and null/undefined/absent. */
function sameFieldValue(next: unknown, current: unknown): boolean {
  if (next === null || next === undefined || current === null || current === undefined) {
    return (next ?? null) === (current ?? null);
  }
  if (current instanceof Date) return new Date(next as string | Date).getTime() === current.getTime();
  if (typeof current === "object") {
    const sorted = (v: unknown) => JSON.stringify(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    return typeof next === "object" && sorted(next) === sorted(current);
  }
  return next === current;
}

/** The material fields this request would actually CHANGE. A form that saves on blur re-sends values
 *  it did not alter, and that is not an edit to the plan. */
export function materialEdits(body: Record<string, unknown>, current: Record<string, unknown>): string[] {
  return MATERIAL_CHANGE_FIELDS.filter((field) => field in body && !sameFieldValue(body[field], current[field]));
}

/** A change manager: an admin, or anyone holding `changes:manage`. They may edit and move any change
 *  they can see; everybody else only changes they raised or are implementing. */
export function isChangeManager(user: { role: string; permissions: string[] }): boolean {
  return ["SUPER_ADMIN", "ADMIN"].includes(user.role) || user.permissions.includes(permissions.CHANGES_MANAGE);
}

/** May this person edit or move this change at all? The requester, the implementer, or a change
 *  manager — the same three the change page and every write route recognise. */
export function mayWorkOnChange(user: { id: string; role: string; permissions: string[] }, ticket: { reporterId: string; assigneeId: string | null }): boolean {
  return isChangeManager(user) || ticket.reporterId === user.id || ticket.assigneeId === user.id;
}

/** What an edit to a submitted change does: go through, re-open approval, or be refused (and why). */
export type PlanEditVerdict = { kind: "ALLOW" } | { kind: "REAPPROVE" } | { kind: "REFUSE"; message: string };

/**
 * The plan-lock rule, as one pure decision.
 *
 * `editingPlan` is the older, wider freeze for people who are not change managers: once a change is
 * approved they may record outcomes and nothing else. `materialKeys` is the narrower lock that now
 * applies to EVERYONE from submission on. A change manager gets one more door — re-approval —
 * while the change is approved and not yet started.
 */
export function judgePlanEdit(params: { state: ChangeState; privileged: boolean; editingPlan: boolean; materialKeys: string[] }): PlanEditVerdict {
  const { state, privileged, editingPlan, materialKeys } = params;
  const approvedOrLater = PLAN_LOCKED_STATES.includes(state) && state !== "AWAITING_APPROVAL";
  if (!privileged && editingPlan && approvedOrLater) {
    return { kind: "REFUSE", message: "This change has been approved. Its plan can no longer be edited — raise a new change, or ask a change manager." };
  }
  if (materialKeys.length === 0 || !PLAN_LOCKED_STATES.includes(state)) return { kind: "ALLOW" };
  if (state === "AWAITING_APPROVAL") {
    return {
      kind: "REFUSE",
      message: "This change is waiting for approval, so its plan, risk, schedule and type are locked. Withdraw it to draft to change them, then submit it again."
    };
  }
  if (privileged && REAPPROVABLE_STATES.includes(state)) return { kind: "REAPPROVE" };
  return {
    kind: "REFUSE",
    message: "This change has started, so its plan, risk, schedule and type can no longer change. Raise a new change for the new plan."
  };
}

/**
 * What was approved, as the decision recorded it: the risk, the window, and a fingerprint of the
 * plans. Written to the decision's audit row so "was the plan that ran the plan that was approved?"
 * has an answer that does not depend on nobody having edited the change since.
 */
export function approvalSnapshot(change: {
  riskScore: number;
  riskLevel: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  justification?: string | null;
  implementationPlan?: string | null;
  backoutPlan?: string | null;
  testPlan?: string | null;
  communicationPlan?: string | null;
}) {
  const plans = [change.justification, change.implementationPlan, change.backoutPlan, change.testPlan, change.communicationPlan];
  return {
    riskScore: change.riskScore,
    riskLevel: change.riskLevel,
    plannedStart: change.plannedStart?.toISOString() ?? null,
    plannedEnd: change.plannedEnd?.toISOString() ?? null,
    plansSha256: createHash("sha256").update(JSON.stringify(plans.map((p) => p ?? null))).digest("hex")
  };
}

function label(state: ChangeState): string {
  return state.replace(/_/g, " ").toLowerCase();
}

/** The subset of a change the readiness rules read. Keeps this testable without a database. */
export interface ChangeReadinessInput {
  changeKind: ChangeKind;
  riskLevel: ChangeBand;
  dataMigration: boolean;
  requiresDowntime: boolean;
  justification?: string | null;
  implementationPlan?: string | null;
  backoutPlan?: string | null;
  testPlan?: string | null;
  communicationPlan?: string | null;
  downtimeMinutes?: number | null;
  plannedStart?: Date | null;
  plannedEnd?: Date | null;
  outcome?: string | null;
  pirNotes?: string | null;
  riskInputs?: unknown;
}

/**
 * Does this rich-text value actually say anything?
 *
 * A single linear scan rather than a strip-the-tags regex. `<[^>]*>` looks harmless but degrades to
 * O(n²) on pathological input — a 60,000-character run of "<" makes the engine rescan from every
 * position — and these fields accept exactly that much text. Walking the string once has no
 * backtracking to worry about and states the intent more plainly: is there a non-whitespace
 * character that is not inside a tag?
 */
function hasVisibleText(html: string): boolean {
  let depth = 0;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch.trim().length > 0) return true;
  }
  return false;
}

const filled = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return hasVisibleText(v);
  return true;
};

/**
 * What a change owes before it may ENTER `target`. Returns every missing field at once rather than
 * the first — somebody filling a long form deserves the whole list, not four round trips.
 *
 * Enforced at the transition and never on save: a draft you cannot save until it is complete is a
 * draft nobody starts, and the rules that matter (a backout plan for a high-risk change) matter at
 * the moment somebody asks for approval, not while they are still typing.
 */
/** True when this change may not be asked for without a documented way back. */
export function requiresBackoutPlan(change: ChangeReadinessInput): boolean {
  // Delegates to shared: the form marks the field required from the same predicate, and two copies
  // of "when is a backout plan mandatory" is how the form promises what the server then refuses.
  return changeNeedsBackoutPlan(change);
}

/** True when closing owes an explanation as well as an outcome. */
export function requiresReview(change: ChangeReadinessInput): boolean {
  return change.outcome !== "SUCCESSFUL" || change.changeKind === "MAJOR";
}

function missingForSubmit(change: ChangeReadinessInput, requiredRiskKeys: string[] = []): string[] {
  const missing: string[] = [];

  // A COMPLETE risk assessment, and why it is required rather than encouraged.
  //
  // The score normalises across every active parameter, so an unanswered one contributes zero — which
  // is right (a blank is not "low"), but it means a half-filled assessment UNDER-reports. Measured:
  // high business impact plus high data risk, with the other nine left blank, scored 27 and banded
  // LOW — and the band is exactly what decides whether a backout plan is mandatory. Leaving fields
  // empty was therefore a way to skip the module's central rule. Demanding the full set at submit is
  // what closes it; a draft can still be saved with any subset.
  const answered = (change.riskInputs ?? {}) as Record<string, unknown>;
  const unanswered = requiredRiskKeys.filter((key) => !answered[key]);
  if (unanswered.length > 0) {
    const partial = `Risk assessment (${unanswered.length} of ${requiredRiskKeys.length} unanswered)`;
    missing.push(unanswered.length === requiredRiskKeys.length ? "Risk assessment" : partial);
  }

  if (!filled(change.justification)) missing.push("Justification");
  if (!filled(change.implementationPlan)) missing.push("Implementation plan");
  if (!filled(change.plannedStart) || !filled(change.plannedEnd)) missing.push("Planned window");
  // The rule the whole module exists to make non-optional.
  if (requiresBackoutPlan(change) && !filled(change.backoutPlan)) missing.push("Backout plan");
  if (changeNeedsTestPlan(change) && !filled(change.testPlan)) missing.push("Test plan");
  if (changeNeedsCommunicationPlan(change)) {
    if (!filled(change.communicationPlan)) missing.push("Communication plan");
    if (!filled(change.downtimeMinutes)) missing.push("Expected downtime");
  }
  return missing;
}

function missingForClose(change: ChangeReadinessInput): string[] {
  const missing: string[] = [];
  if (!filled(change.outcome)) missing.push("Outcome");
  // A clean routine change closes on its outcome alone. Anything else owes an explanation, because
  // the review is the only record of why it went wrong and what was learned.
  if (requiresReview(change) && !filled(change.pirNotes)) missing.push("Post-implementation review");
  return missing;
}

export function missingForTransition(
  change: ChangeReadinessInput,
  target: ChangeState,
  /** Keys of the active risk parameters. Passed in rather than read here so this stays a pure
   *  function the tests can drive without a database. */
  requiredRiskKeys: string[] = []
): string[] {
  // BOTH doors into the approval queue. Submission goes straight to AWAITING_APPROVAL, and keying
  // this on SUBMITTED alone silently disabled every requirement the module exists for — the backout
  // plan included. Named explicitly rather than inferred, so adding a third route has to come here.
  if (target === "AWAITING_APPROVAL" || target === "SUBMITTED") return missingForSubmit(change, requiredRiskKeys);
  if (target === "PIR") return filled(change.outcome) ? [] : ["Outcome"];
  if (target === "CLOSED") return missingForClose(change);
  return [];
}

/**
 * Implementation is refused while something this change waits on is still open.
 *
 * ONLY `PREDECESSOR` AND `BLOCKS` COUNT. A `SUCCESSOR` is work that follows this change and a
 * `RELATED` is context — blocking on either would make the field unusable for the thing it is for.
 * `WAIVED` is an explicit, recorded decision to proceed anyway, which is why it clears the gate the
 * same way `COMPLETED` does; the row keeps saying which it was.
 *
 * Checked here and not in `missingForTransition` because that function is pure and database-free by
 * design — the tests drive it without a connection.
 *
 * Lives in the service rather than the controller because it is a RULE, and it now has two callers:
 * the transition route and the automation dispatcher's change action. A second copy in the
 * dispatcher is exactly how an automation ends up able to walk a change past a gate the API refuses.
 */
export async function assertDependenciesClear(changeId: string, target: ChangeState): Promise<void> {
  if (target !== "IMPLEMENTING") return;
  const blocking = await prisma.changeDependency.findMany({
    where: { changeId, status: "OPEN", dependencyType: { in: ["PREDECESSOR", "BLOCKS"] } },
    select: { description: true }
  });
  if (blocking.length === 0) return;
  throw new AppError(
    409,
    `This change is still waiting on ${blocking.length} ${blocking.length === 1 ? "dependency" : "dependencies"}: ` +
      `${blocking.map((d) => d.description).join("; ")}. Complete or waive ${blocking.length === 1 ? "it" : "them"} before implementing.`
  );
}

export function assertReadyFor(change: ChangeReadinessInput, target: ChangeState, requiredRiskKeys: string[] = []): void {
  const missing = missingForTransition(change, target, requiredRiskKeys);
  if (missing.length > 0) {
    throw new AppError(422, `Before this change can move to ${label(target)} it needs: ${missing.join(", ")}.`);
  }
}

/** The ticket status that must be written alongside every change state. Never write one without
 *  the other — that pair is what keeps every pre-existing reader of `Ticket.status` correct. */
export function ticketStatusFor(state: ChangeState) {
  return CHANGE_STATE_TO_TICKET_STATUS[state];
}

/**
 * Everything written to the change's TICKET when the change enters `state`: the status, and the
 * two stamps that go with it.
 *
 * WHY THE STAMPS: the ticket routes stamp `closedAt` on CLOSED and clear both stamps when a ticket
 * is live again, and every "done" report, the closed digest and the reopen logic read them. A change
 * that wrote the status alone left a cancelled change's ticket CLOSED with no `closedAt`, and an
 * approved change's ticket IN_PROGRESS with a stale `closedAt` — a ticket that was both open and
 * closed depending on which column you asked.
 */
export function ticketWriteFor(state: ChangeState, now: Date): { status: ReturnType<typeof ticketStatusFor>; closedAt?: Date | null; resolvedAt?: Date | null } {
  const status = ticketStatusFor(state);
  if (status === "CLOSED") return { status, closedAt: now };
  return { status, closedAt: null, resolvedAt: null };
}

/** The four stage timestamps a move can write — the ones the SLA clocks run between. */
export interface ChangeStageStamps {
  submittedAt?: Date | null;
  approvedAt?: Date | null;
  actualStart?: Date | null;
  actualEnd?: Date | null;
}

/**
 * The stage timestamps to write when a change ENTERS `to`.
 *
 * WHY A BACKWARD MOVE CLEARS WHAT IS DOWNSTREAM: these columns are what the stage clocks run
 * between. Written `existing ?? now` and never cleared, the first pass through a stage was the only
 * one that counted — after rework the implementation clock read MET while the rework ran, and after
 * a rejection round 2's approval clock ran from round 1's submission.
 *
 *   - Into AWAITING_APPROVAL: a NEW round, so its clock starts now, and nothing after approval has
 *     happened in it yet.
 *   - Into DRAFT (reopened, withdrawn): nothing is being approved or implemented any more.
 *   - Into IMPLEMENTING: the START is kept — the work began then — but a rework from VALIDATION
 *     clears the hand-over, so implementation is running again and validation has not started.
 *
 * `closedAt` is not here: CLOSED is terminal, so it is only ever written once, by the caller.
 */
export function stageStampsOnEnter(to: ChangeState, current: { actualStart: Date | null }, now: Date): ChangeStageStamps {
  switch (to) {
    case "AWAITING_APPROVAL":
      return { submittedAt: now, approvedAt: null, actualStart: null, actualEnd: null };
    case "DRAFT":
      return { submittedAt: null, approvedAt: null, actualStart: null, actualEnd: null };
    case "IMPLEMENTING":
      return { actualStart: current.actualStart ?? now, actualEnd: null };
    case "VALIDATION":
      return { actualEnd: now };
    default:
      return {};
  }
}

/**
 * Average hours from a round's submission to its approval, over approved rounds.
 *
 * Read off the APPROVAL ROWS, not the change: a row is created the moment its round opens and
 * stamped when it is decided, so the pair is that round's own clock. The change's `submittedAt` and
 * `approvedAt` span every round, and a change rejected on day 1 and approved on day 10 is 24 hours of
 * deciding, not 240. NULL, never 0, when nothing has been approved.
 */
export function averageApprovalHours(rows: Array<{ createdAt: Date; decidedAt: Date | null }>): number | null {
  const decided = rows.filter((r) => r.decidedAt);
  if (decided.length === 0) return null;
  const totalMs = decided.reduce((sum, r) => sum + (r.decidedAt!.getTime() - r.createdAt.getTime()), 0);
  return Math.round((totalMs / decided.length / 3600 / 1000) * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * Approval — who is asked, and who may decide
 * ------------------------------------------------------------------ */

/** Why a person was asked. Recorded on the decision because reporting lines move, and an audit read
 *  a year later must not have to guess why this particular name appears. */
export type ChangeApprovalReason = "MANAGER_OF_REQUESTER" | "SUPER_ADMIN";

export interface ResolvedChangeApprover {
  approverId: string;
  reason: ChangeApprovalReason;
}

/**
 * Who is asked to approve a change.
 *
 * The requester's OWN manager — `User.managerId`, the same relation the org chart, the timesheet
 * approval chain and the ticket authority rules already read. Not the implementer's manager, and not
 * a configurable policy: the person accountable for the work is the person they report to.
 *
 * FALLBACK, and why it is every super admin rather than one: a requester with no manager (a
 * department head, the first account in a workspace) must still be able to raise a change. Asking
 * all super admins together means any one of them can clear it, rather than the request waiting on
 * whichever name a tie-break happened to pick.
 *
 * The requester is always excluded from ROUTING. Nobody is ever ASKED to approve their own change,
 * and that is better handled here than by hoping nobody is their own manager — it is what stops a
 * manager or team lead who raises a change from signing it off. A super admin is the one exception
 * at DECISION time, by policy: see canDecideChange.
 */
export async function resolveChangeApprovers(requesterId: string): Promise<ResolvedChangeApprover[]> {
  const requester = await prisma.user.findFirst({
    where: { id: requesterId, deletedAt: null },
    select: { manager: { select: { id: true, status: true, deletedAt: true } } }
  });

  const manager = requester?.manager;
  if (manager && manager.status === "ACTIVE" && !manager.deletedAt && manager.id !== requesterId) {
    return [{ approverId: manager.id, reason: "MANAGER_OF_REQUESTER" }];
  }

  const superAdmins = await prisma.user.findMany({
    where: { role: { name: "SUPER_ADMIN" }, status: "ACTIVE", deletedAt: null, isAgent: false, id: { not: requesterId } },
    select: { id: true }
  });
  return superAdmins.map((u) => ({ approverId: u.id, reason: "SUPER_ADMIN" as const }));
}

/**
 * May this person decide this change?
 *
 * Two ways in, and no third: the approval row names them, or they are a super admin. A super admin
 * can always decide — that is what the requirement asks for, and it doubles as the escape hatch for
 * a change whose named approver has since left, gone on leave, or been deactivated.
 *
 * THAT INCLUDES A CHANGE THE SUPER ADMIN RAISED THEMSELVES. Confirmed by the product owner on
 * 2026-10-01, after the docs had claimed the opposite: a super admin may raise a change and approve
 * it. Nobody else can approve their own — `resolveChangeApprovers` never names the requester, and
 * without a named row a non-super-admin is refused above. So there is deliberately no requester
 * check here; adding one would lock out the workspace's highest-trust role, and the approval round
 * still records who decided, when, and why.
 *
 * Holding `changes:approve` is necessary but never sufficient. Without the second half of this test,
 * any team lead in the workspace could sign off any change — precisely the flaw the ticket authority
 * rules were tightened to remove.
 */
export function canDecideChange(req: any, approvals: Array<{ approverId: string; status: string }>): boolean {
  if (req.user.role === "SUPER_ADMIN") return true;
  if (!req.user.permissions.includes(permissions.CHANGES_APPROVE)) return false;
  return approvals.some((a) => a.status === "PENDING" && a.approverId === req.user.id);
}

/** Where a change lands once a decision is recorded. */
export function stateAfterDecision(decision: "APPROVED" | "REJECTED"): ChangeState {
  return decision === "APPROVED" ? "APPROVED" : "REJECTED";
}

/* ------------------------------------------------------------------ *
 * Risk scoring (spec 13)
 * ------------------------------------------------------------------ */

/** What each band contributes, as a fraction of a parameter's weight. */
const BAND_FRACTION: Record<ChangeBand, number> = { LOW: 0.2, MEDIUM: 0.6, HIGH: 1 };

/**
 * The 0-100 score, and the band it falls in.
 *
 * NORMALISED against the sum of ACTIVE weights, never a fixed total. Without that, an administrator
 * adding a twelfth risk parameter would silently deflate every score in the workspace — the same
 * change would score lower tomorrow than it did today, and nobody would know why.
 *
 * A parameter the requester did not answer contributes nothing rather than a default. An unanswered
 * question is missing information, and scoring it as "low" would let somebody lower a change's risk
 * by leaving fields blank.
 */
export function computeRiskScore(
  inputs: Record<string, ChangeBand | undefined>,
  parameters: Array<{ key: string; weight: number }>
): { riskScore: number; riskLevel: ChangeBand } {
  const totalWeight = parameters.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  if (totalWeight === 0) return { riskScore: 0, riskLevel: "LOW" };

  let earned = 0;
  for (const p of parameters) {
    const band = inputs[p.key];
    if (band) earned += Math.max(0, p.weight) * BAND_FRACTION[band];
  }

  const riskScore = Math.round((earned / totalWeight) * 100);
  return { riskScore, riskLevel: bandForScore(riskScore) };
}

/**
 * Score to band.
 *
 * MEDIUM starts low on purpose: the band decides whether a backout plan is mandatory, and a change
 * scoring 40 has real exposure. Setting the threshold higher would let the ordinary case skip the
 * one field this module exists to make non-optional.
 */
export function bandForScore(score: number): ChangeBand {
  if (score >= 65) return "HIGH";
  if (score >= 30) return "MEDIUM";
  return "LOW";
}

/* ------------------------------------------------------------------ *
 * Scheduling conflicts (spec 18)
 * ------------------------------------------------------------------ */

export interface ScheduleConflict {
  kind: "BLACKOUT" | "OVERLAPPING_CHANGE";
  message: string;
  reference?: string;
}

/**
 * Everything wrong with a proposed window, reported together.
 *
 * REPORTED, NEVER REFUSED. A conflict is information for the person scheduling — sometimes two
 * changes genuinely do share a window — and a tool that simply says no is one people schedule around
 * by lying to it. Overriding costs a written reason and an audit row, which is the difference
 * between a control and an obstacle: `assertScheduleOverrideRecorded` asks for the reason at the
 * moment the change commits to its window, and the PATCH that records it is audited.
 */
export async function findScheduleConflicts(params: {
  changeId: string;
  environment: string;
  plannedStart: Date;
  plannedEnd: Date;
}): Promise<ScheduleConflict[]> {
  const conflicts: ScheduleConflict[] = [];
  const stamp = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

  const blackouts = await prisma.blackoutPeriod.findMany({
    where: {
      isActive: true,
      startsAt: { lt: params.plannedEnd },
      endsAt: { gt: params.plannedStart },
      // A blackout with no environment applies everywhere — that is how a company-wide freeze is
      // written, and requiring one row per environment would be six rows nobody keeps in step.
      OR: [{ environment: null }, { environment: params.environment as never }]
    },
    select: { name: true, startsAt: true, endsAt: true }
  });
  for (const b of blackouts) {
    conflicts.push({
      kind: "BLACKOUT",
      message: `"${b.name}" runs from ${stamp(b.startsAt)} to ${stamp(b.endsAt)} UTC.`,
      reference: b.name
    });
  }

  // Only changes that are actually going to happen count as a clash. A draft or a rejected change
  // holding a window would produce warnings nobody can act on.
  const overlapping = await prisma.changeRequest.findMany({
    where: {
      id: { not: params.changeId },
      environment: params.environment as never,
      state: { in: ["APPROVED", "SCHEDULED", "IMPLEMENTING"] },
      plannedStart: { lt: params.plannedEnd },
      plannedEnd: { gt: params.plannedStart }
    },
    select: { changeKey: true, ticket: { select: { title: true } } },
    take: 20
  });
  for (const o of overlapping) {
    conflicts.push({
      kind: "OVERLAPPING_CHANGE",
      message: `${o.changeKey} ("${o.ticket.title}") already holds part of this window.`,
      reference: o.changeKey
    });
  }

  return conflicts;
}

/** The moves that commit a change to its window: putting it on the calendar, or starting it. */
const COMMITS_TO_WINDOW: readonly ChangeState[] = ["SCHEDULED", "IMPLEMENTING"];

/**
 * A change may go ahead in a window that collides — but not silently. Moving it to SCHEDULED or
 * IMPLEMENTING while its window overlaps a blackout or another approved change needs the override
 * reason recorded first, and the refusal names what it collides with, so the person knows what they
 * are overriding before they write why.
 *
 * Asked at the move, not on save: saving the window is how somebody finds out it collides at all,
 * and refusing that save would hide the conflict list behind the very error it explains.
 */
export async function assertScheduleOverrideRecorded(
  change: { id: string; environment: string; plannedStart: Date | null; plannedEnd: Date | null; conflictOverrideReason?: string | null },
  to: ChangeState
): Promise<void> {
  if (!COMMITS_TO_WINDOW.includes(to) || !change.plannedStart || !change.plannedEnd) return;
  if (filled(change.conflictOverrideReason)) return;
  const conflicts = await findScheduleConflicts({
    changeId: change.id,
    environment: change.environment,
    plannedStart: change.plannedStart,
    plannedEnd: change.plannedEnd
  });
  if (conflicts.length === 0) return;
  throw new AppError(
    422,
    `This change's window collides with: ${conflicts.map((c) => c.message).join(" ")} ` +
      "Record an override reason on the Schedule tab — why it is going ahead anyway — or move the window."
  );
}

/** The risk parameters a submission must answer. Read once per transition rather than baked into the
 *  pure rules above, so an administrator switching one off takes effect immediately. */
export async function activeRiskParameterKeys(): Promise<string[]> {
  const params = await prisma.changeRiskParameter.findMany({ where: { isActive: true }, select: { key: true } });
  return params.map((p) => p.key);
}

/* ------------------------------------------------------------------ *
 * SLA
 * ------------------------------------------------------------------ */

/** How a stage is doing against its clock. Ordered worst-first, because that is the order the UI
 *  sorts and colours by. */
export type SlaState = "BREACHED" | "WARNING" | "ON_TRACK" | "NOT_STARTED" | "MET";

export interface SlaVerdict {
  state: SlaState;
  /** Whole hours remaining; negative once breached, so the UI can say "9h over" without a second
   *  field to consult. */
  hoursRemaining: number;
  dueAt: Date | null;
  /** 0-100, clamped. What the ring or bar fills to. */
  pctElapsed: number;
}

const NOT_APPLICABLE: SlaVerdict = { state: "NOT_STARTED", hoursRemaining: 0, dueAt: null, pctElapsed: 0 };

/**
 * One stage's clock, judged.
 *
 * WHY `stoppedAt` RATHER THAN "IS IT STILL OPEN": a stage that finished late is a breach that already
 * happened, and reporting it as ON_TRACK the moment it closes is how SLA dashboards come to say
 * everything is fine. A finished stage is therefore judged against the time it actually took, and
 * only an unfinished one is judged against now.
 *
 * Pure, and takes `now` as an argument, so the tests can drive it without freezing the clock.
 */
export function judgeSla(
  startedAt: Date | null | undefined,
  stoppedAt: Date | null | undefined,
  config: { hours: number; warnAtPct: number } | null | undefined,
  now: Date
): SlaVerdict {
  if (!startedAt || !config || config.hours <= 0) return NOT_APPLICABLE;

  const budgetMs = config.hours * 3600 * 1000;
  const dueAt = new Date(startedAt.getTime() + budgetMs);
  const elapsedMs = (stoppedAt ?? now).getTime() - startedAt.getTime();
  const pctElapsed = Math.max(0, Math.min(100, Math.round((elapsedMs / budgetMs) * 100)));
  const hoursRemaining = Math.round((budgetMs - elapsedMs) / 3600 / 1000);

  if (stoppedAt) {
    // Finished: it either made it or it did not. There is no "warning" for a stage that is over.
    return { state: elapsedMs > budgetMs ? "BREACHED" : "MET", hoursRemaining, dueAt, pctElapsed };
  }
  const warnAt = Math.max(1, Math.min(99, config.warnAtPct));
  const state: SlaState = pctElapsed >= 100 ? "BREACHED" : pctElapsed >= warnAt ? "WARNING" : "ON_TRACK";
  return { state, hoursRemaining, dueAt, pctElapsed };
}

/** The configured clocks, keyed by stage, with inactive rows dropped so a disabled stage simply has
 *  no SLA rather than a silently-zero one. */
export async function getSlaConfig(): Promise<Record<string, { hours: number; warnAtPct: number }>> {
  const rows = await prisma.changeSlaConfig.findMany({ where: { isActive: true } });
  const out: Record<string, { hours: number; warnAtPct: number }> = {};
  for (const row of rows) out[row.stage] = { hours: row.hours, warnAtPct: row.warnAtPct };
  return out;
}

/** The timestamps each stage's clock runs between. Kept next to `judgeSla` so adding a stage means
 *  touching one place. */
export interface ChangeSlaInput {
  state: string;
  submittedAt: Date | null;
  approvedAt: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  closedAt: Date | null;
}

/**
 * Every stage clock for one change.
 *
 * A stage that has not started yet returns NOT_STARTED rather than being omitted, so the UI can show
 * the full ladder — "approval met, implementation running, validation not started" is more useful
 * than three rows that appear one at a time.
 */
export function judgeChangeSlas(
  change: ChangeSlaInput,
  config: Record<string, { hours: number; warnAtPct: number }>,
  now: Date
): Record<string, SlaVerdict> {
  // A change that ENDED without finishing (cancelled, or rejected and left there) stops every clock
  // that was still running: its deadline was for work or a decision nobody is going to deliver, and
  // counting against `now` reported it as a breach for ever. A stage that had already finished keeps
  // its verdict. (A rejected change normally returns to DRAFT, which clears its stamps anyway.)
  const ended = change.state === "CANCELLED" || change.state === "REJECTED";
  const clock = (startedAt: Date | null, stoppedAt: Date | null, stage: { hours: number; warnAtPct: number } | undefined) =>
    ended && !stoppedAt ? judgeSla(null, null, stage, now) : judgeSla(startedAt, stoppedAt, stage, now);
  return {
    APPROVAL: clock(change.submittedAt, change.approvedAt, config.APPROVAL),
    IMPLEMENTATION: clock(change.actualStart, change.actualEnd, config.IMPLEMENTATION),
    VALIDATION: clock(change.actualEnd, change.state === "PIR" || change.state === "CLOSED" ? change.closedAt ?? now : null, config.VALIDATION),
    CLOSURE: clock(change.approvedAt, change.closedAt, config.CLOSURE)
  };
}
