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
  CHANGE_STATE_TO_TICKET_STATUS,
  changeStateTransitions,
  deriveChangeRisk,
  permissions,
  type ChangeBand,
  type ChangeKind,
  type ChangeState
} from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";

const SETTINGS_ID = "global";

/** Workspace switches, upserted on read — same shape as getGlobalTicketSettings. */
export async function getChangeSettings() {
  return prisma.globalChangeSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID, remindHoursBefore: [24, 1] }
  });
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

export function assertLegalChangeTransition(from: ChangeState, to: ChangeState): void {
  if (isNoOpTransition(from, to)) return;
  const legal = changeStateTransitions[from] ?? [];
  if (!legal.includes(to)) {
    throw new AppError(400, `A change cannot move from ${label(from)} to ${label(to)}.`);
  }
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
  return change.riskLevel === "HIGH" || change.changeKind === "MAJOR" || change.dataMigration;
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
  if (change.riskLevel !== "LOW" && !filled(change.testPlan)) missing.push("Test plan");
  if (change.requiresDowntime) {
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

export function assertReadyFor(change: ChangeReadinessInput, target: ChangeState, requiredRiskKeys: string[] = []): void {
  const missing = missingForTransition(change, target, requiredRiskKeys);
  if (missing.length > 0) {
    throw new AppError(422, `Before this change can move to ${label(target)} it needs: ${missing.join(", ")}.`);
  }
}

/**
 * What a change moves to when it is submitted.
 *
 * A STANDARD change is pre-approved by definition — that is what the word means — so it goes
 * straight to APPROVED without troubling anybody. Everything else goes to the board.
 */
export function stateAfterSubmit(kind: ChangeKind): ChangeState {
  return kind === "STANDARD" ? "APPROVED" : "AWAITING_APPROVAL";
}

/** The ticket status that must be written alongside every change state. Never write one without
 *  the other — that pair is what keeps every pre-existing reader of `Ticket.status` correct. */
export function ticketStatusFor(state: ChangeState) {
  return CHANGE_STATE_TO_TICKET_STATUS[state];
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
 * The requester is always excluded. Approving your own change is the one thing an approval gate
 * exists to prevent, and it is better handled here than by hoping nobody is their own manager.
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
 * between a control and an obstacle.
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
  return {
    APPROVAL: judgeSla(change.submittedAt, change.approvedAt, config.APPROVAL, now),
    IMPLEMENTATION: judgeSla(change.actualStart, change.actualEnd, config.IMPLEMENTATION, now),
    VALIDATION: judgeSla(change.actualEnd, change.state === "PIR" || change.state === "CLOSED" ? change.closedAt ?? now : null, config.VALIDATION, now),
    CLOSURE: judgeSla(change.approvedAt, change.closedAt, config.CLOSURE, now)
  };
}
