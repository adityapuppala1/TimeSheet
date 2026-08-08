/**
 * WHAT: proposes the one mitigation the risk model can express as a reviewable change — realigning
 * a project's committed end date with what the solved schedule already says — the producer for
 * `RISK_MITIGATION`, and the first writer of `ProjectRiskSnapshot.aiProposalId`, a column migrated
 * with the risk feature and never written since.
 *
 * WHY ONLY THE END DATE, when the assessment names six risk signals: the others have no honest
 * change to propose. A high reopen rate is a quality conversation; over-allocation already has its
 * own producer (the rebalance); blocked work needs a person to decide what unblocks it. Proposing
 * plausible-looking busywork for those would be theatre. The schedule overrun is different: the
 * plan itself states the real end date, the committed one is provably behind it, and "make the
 * commitment match the plan — or reject this and cut scope instead" is a genuine decision, stated
 * honestly, with a person making it.
 *
 * WHY THE CEILING IS SUGGEST (see the registry): a planned end date is a commitment made to people
 * outside the plan. This producer can never auto-apply, whatever the workspace configures — the
 * proposal is the product.
 *
 * WHO CALLS THIS: `controllers/ai-proposal.controller.ts` (the risk panel's "Propose mitigation").
 */
import { createProposalAndMaybeApply } from "./ai-proposal.service.js";
import { assessProject, saveSnapshot } from "./project-risk.service.js";
import { addWorkingDays, dayKey, readWorkingDays, toDay } from "./plan-schedule.service.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

export interface RiskMitigationOutcome {
  proposalId: string | null;
  /** Why nothing was proposed, when nothing was. */
  reason: string | null;
  /** Always null in practice — the SUGGEST ceiling means nothing here ever auto-applies — but the
   *  shape matches the other producers so the callers read identically. */
  heldForReview: string | null;
  riskScore: number;
  band: string;
  snapshotId: string | null;
}

export async function proposeRiskMitigation(params: {
  projectId: string;
  requestedById: string;
}): Promise<RiskMitigationOutcome> {
  const project = await prisma.project.findFirst({
    where: { id: params.projectId, deletedAt: null },
    select: { id: true, name: true, plannedEndDate: true }
  });
  if (!project) throw new AppError(404, "Project not found");

  const assessment = await assessProject(params.projectId);

  if (assessment.band === "GREEN") {
    return {
      proposalId: null,
      reason: `${project.name} is green (${assessment.riskScore}/100) — there is nothing to mitigate.`,
      heldForReview: null,
      riskScore: assessment.riskScore,
      band: assessment.band,
      snapshotId: null
    };
  }

  const slip = assessment.signals.find((s) => s.key === "scheduleSlip");
  const overrunDays = Number(slip?.detail.plannedEndOverrunDays ?? 0);

  if (!project.plannedEndDate || overrunDays <= 0) {
    // The risk is real but its drivers need decisions this producer refuses to fake. Say which.
    return {
      proposalId: null,
      reason:
        `${project.name} is ${assessment.band.toLowerCase()} (${assessment.riskScore}/100), but its drivers — ` +
        `${assessment.topConcerns.slice(0, 2).join(" ")} — need human decisions, not a date change. ` +
        `Nothing here can be proposed honestly as a change set.`,
      heldForReview: null,
      riskScore: assessment.riskScore,
      band: assessment.band,
      snapshotId: null
    };
  }

  const workingDays = await readWorkingDays();
  const currentEnd = dayKey(toDay(project.plannedEndDate));
  // +1 matches how the solver's own day arithmetic counts an inclusive span.
  const realignedEnd = dayKey(addWorkingDays(toDay(project.plannedEndDate), overrunDays + 1, workingDays));

  const outcome = await createProposalAndMaybeApply({
    capability: "risk_mitigation",
    kind: "RISK_MITIGATION",
    title: `Realign ${project.name}'s end date with its schedule`,
    rationale:
      `${project.name} scores ${assessment.riskScore}/100 (${assessment.band}). ` +
      `The solved schedule runs ${overrunDays} working day${overrunDays === 1 ? "" : "s"} past the committed end of ${currentEnd} — ` +
      `the plan and the promise disagree, and only one of them can be right. ` +
      `Accepting moves the commitment to ${realignedEnd}, what the plan already says. ` +
      `Rejecting is also a decision: it means the date holds and scope or staffing has to give instead. ` +
      `Top concerns, worst first: ${assessment.topConcerns.join(" ")}`,
    scopeProjectId: project.id,
    requestedById: params.requestedById,
    changes: [
      {
        targetType: "PROJECT",
        targetId: project.id,
        op: "UPDATE",
        before: { plannedEndDate: currentEnd },
        after: { plannedEndDate: realignedEnd },
        summary: `Move the planned end from ${currentEnd} to ${realignedEnd} (${overrunDays} working day${overrunDays === 1 ? "" : "s"} of measured slip)`
      }
    ]
  });

  // The snapshot ties the score to the proposal it produced — "why did this reopen at 62 last
  // Tuesday, and what was offered about it" becomes answerable from the risk history alone.
  const snapshot = await saveSnapshot(assessment, null, outcome.proposalId);

  return {
    proposalId: outcome.proposalId,
    reason: null,
    heldForReview: outcome.heldForReview,
    riskScore: assessment.riskScore,
    band: assessment.band,
    snapshotId: snapshot.id
  };
}
