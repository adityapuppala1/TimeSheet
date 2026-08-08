/**
 * WHAT: expands a saved blueprint into a reviewable change set against a chosen project and start
 * date — the producer for `BLUEPRINT_SUGGESTION`, the last of the declared ProposalKinds to gain
 * one.
 *
 * WHY A PROPOSAL RATHER THAN THE DIRECT INSTANTIATION the blueprint controller already does: the
 * direct path creates everything or nothing. Through the envelope, every item and dependency is a
 * row a person accepts or rejects individually — "stamp the template but skip the two items we
 * don't need this quarter" becomes review instead of post-hoc cleanup, and the whole set is
 * undoable afterwards. The expansion itself is `expandBlueprint`, unchanged: same offsets, same
 * working-day arithmetic, same validation.
 *
 * HOW INDEXES LINE UP, because this is the one subtle part: `applyProposal` resolves
 * `parentIndex`/`fromIndex`/`toIndex` through `createdByOrder`, which is keyed by CHANGE ORDER.
 * The CREATE rows are emitted first and in blueprint item order, so a blueprint item's index IS
 * its change order, and the dependency rows that follow can reference blueprint indexes verbatim.
 *
 * WHO CALLS THIS: `controllers/ai-proposal.controller.ts`.
 */
import { createProposalAndMaybeApply, type DraftChange } from "./ai-proposal.service.js";
import { expandBlueprint, type BlueprintPayload } from "./blueprint.service.js";
import { readWorkingDays } from "./plan-schedule.service.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

export interface BlueprintProposeOutcome {
  proposalId: string;
  heldForReview: string | null;
  items: number;
  dependencies: number;
}

export async function proposeBlueprintInstantiation(params: {
  blueprintId: string;
  projectId: string;
  startDate: string;
  requestedById: string;
}): Promise<BlueprintProposeOutcome> {
  const [blueprint, project] = await Promise.all([
    prisma.blueprint.findFirst({ where: { id: params.blueprintId, isActive: true } }),
    prisma.project.findFirst({ where: { id: params.projectId, deletedAt: null }, select: { id: true, name: true } })
  ]);
  if (!blueprint) throw new AppError(404, "Blueprint not found");
  if (!project) throw new AppError(404, "Project not found");

  const payload = blueprint.payload as unknown as BlueprintPayload;
  const workingDays = await readWorkingDays();
  const expanded = expandBlueprint(payload, params.startDate, workingDays);

  // createProposal's own reviewability ceiling is 200 changes; refuse before building rather than
  // after, with the number that matters. Items plus dependency rows both count.
  const dependencyCount = payload.items.reduce((sum, item) => sum + (item.dependsOn?.length ?? 0), 0);
  if (expanded.items.length + dependencyCount > 200) {
    throw new AppError(422, `"${blueprint.name}" expands to ${expanded.items.length + dependencyCount} rows — too large to review as one proposal.`);
  }

  // CREATE rows first, in item order, so blueprint indexes and change orders coincide — see the
  // file header for why that alignment is what makes parentIndex/fromIndex resolvable at apply.
  const changes: DraftChange[] = expanded.items.map((item) => ({
    targetType: "TICKET",
    op: "CREATE",
    after: {
      title: item.title,
      description: item.description ?? null,
      type: item.type ?? "TASK",
      priority: item.priority ?? "MEDIUM",
      estimatedHours: item.estimatedHours ?? null,
      startDate: item.startDate,
      endDate: item.endDate,
      ...(item.parentIndex !== undefined ? { parentIndex: item.parentIndex } : {})
    },
    summary: item.isMilestone
      ? `Milestone "${item.title}"${item.startDate ? ` on ${item.startDate}` : ""}`
      : `Create "${item.title}"${item.startDate ? ` (${item.startDate} – ${item.endDate})` : " (unscheduled)"}`
  }));

  for (const item of expanded.items) {
    for (const dep of item.dependsOn ?? []) {
      changes.push({
        targetType: "LINK",
        op: "LINK",
        after: { fromIndex: dep, toIndex: item.index, type: "FINISH_TO_START", lagDays: 0 },
        summary: `"${payload.items[dep]?.title ?? `item ${dep + 1}`}" must finish before "${item.title}" starts`
      });
    }
  }

  const outcome = await createProposalAndMaybeApply({
    capability: "blueprint_instantiate",
    kind: "BLUEPRINT_SUGGESTION",
    title: `Instantiate "${blueprint.name}" into ${project.name}`,
    rationale:
      `Expands the saved blueprint "${blueprint.name}" from ${params.startDate}: ` +
      `${expanded.items.length} item${expanded.items.length === 1 ? "" : "s"}` +
      `${dependencyCount > 0 ? ` and ${dependencyCount} dependenc${dependencyCount === 1 ? "y" : "ies"}` : ""}` +
      `${expanded.start ? `, running ${expanded.start} to ${expanded.end}` : ""}. ` +
      `Every row is the blueprint's own arithmetic against your chosen start date — accept the ones you want.`,
    scopeProjectId: project.id,
    requestedById: params.requestedById,
    changes
  });

  return {
    proposalId: outcome.proposalId,
    heldForReview: outcome.heldForReview,
    items: expanded.items.length,
    dependencies: dependencyCount
  };
}
