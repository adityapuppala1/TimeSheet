/**
 * WHAT: golden datasets — real AI inputs paired with the answer a human says is correct.
 *
 * WHY: this is the piece that turns "I think the new prompt is better" into a measurement. Without
 * ground truth you can only eyeball a handful of outputs; with it you can replay the same inputs
 * against a changed prompt and count what improved and what regressed.
 *
 * THE DESIGN RULE — correct, don't author: items are always promoted from a REAL captured
 * interaction, never typed from scratch. Hand-invented test cases drift toward what someone
 * imagines users do, and then a prompt gets tuned against fiction. Promoting an actual failure
 * keeps the set anchored to what really happened, which is also why this requires content capture
 * to be enabled — without the captured inputs there is nothing to replay.
 */
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { getGlobalAISettings } from "./ai.service.js";

export type ExpectedKind = "EXACT_FIELDS" | "CONTAINS" | "JUDGE";

/** Structured capabilities emit JSON and can be scored field-by-field; everything else is prose
 *  and needs a looser check. Used to pick a sensible default so an admin isn't asked to reason
 *  about scoring strategy just to save an example. */
const STRUCTURED_FEATURES = new Set([
  "triage",
  "chat_triage",
  "ci_failure_triage",
  "security_finding_triage",
  "duplicate_detection",
  "pr_review_summary",
  "pr_inline_review",
  // An agent step's answer is a JSON decision — "call this tool" or "finish" — so field-by-field
  // comparison is the honest default: the eval question is "did it pick the right action".
  "agent_step"
]);

export function defaultExpectedKind(feature: string): ExpectedKind {
  return STRUCTURED_FEATURES.has(feature) ? "EXACT_FIELDS" : "CONTAINS";
}

export async function listDatasets() {
  const rows = await prisma.aIDataset.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } }, createdBy: { select: { id: true, name: true } } }
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    feature: row.feature,
    itemCount: row._count.items,
    createdBy: row.createdBy,
    createdAt: row.createdAt
  }));
}

export async function createDataset(params: { name: string; feature: string; description?: string; userId: string }) {
  return prisma.aIDataset.create({
    data: {
      name: params.name.trim(),
      feature: params.feature,
      description: params.description?.trim() || null,
      createdById: params.userId
    }
  });
}

export async function getDataset(id: string) {
  const dataset = await prisma.aIDataset.findUnique({
    where: { id },
    include: {
      items: { orderBy: { createdAt: "desc" }, include: { createdBy: { select: { id: true, name: true } } } },
      createdBy: { select: { id: true, name: true } }
    }
  });
  if (!dataset) throw new AppError(404, "Dataset not found");
  return dataset;
}

/**
 * Promotes a captured interaction into a dataset item.
 *
 * Copies the inputs onto the item rather than referencing the interaction, deliberately: the
 * retention sweep will delete that interaction in ~30 days, and a golden set that decays is
 * useless. `sourceInteractionId` is kept for provenance only.
 */
export async function addDatasetItemFromInteraction(params: {
  datasetId: string;
  interactionId: string;
  expectedOutput: string;
  expectedKind?: ExpectedKind;
  notes?: string;
  userId: string;
}) {
  const dataset = await prisma.aIDataset.findUnique({ where: { id: params.datasetId } });
  if (!dataset) throw new AppError(404, "Dataset not found");

  const interaction = await prisma.aIInteraction.findUnique({ where: { id: params.interactionId } });
  if (!interaction) throw new AppError(404, "Interaction not found");

  // A cross-feature item would be un-replayable — the capability signature wouldn't match.
  if (interaction.feature !== dataset.feature) {
    throw new AppError(422, `This dataset holds "${dataset.feature}" examples; that interaction is "${interaction.feature}".`);
  }

  // Without captured params there is nothing to replay, so refuse loudly rather than silently
  // creating an item that every future eval run would skip.
  if (interaction.paramsJson == null) {
    const settings = await getGlobalAISettings();
    throw new AppError(
      422,
      settings.aiCaptureContentEnabled
        ? "That interaction was recorded before content capture was enabled, so its inputs weren't kept — it can't be replayed."
        : "Turn on \"Also store prompts and responses\" in AI settings first — without the captured inputs there is nothing to replay."
    );
  }

  return prisma.aIDatasetItem.create({
    data: {
      datasetId: dataset.id,
      sourceInteractionId: interaction.id,
      inputParamsJson: interaction.paramsJson as object,
      actualOutput: interaction.outputText,
      expectedOutput: params.expectedOutput,
      expectedKind: params.expectedKind ?? defaultExpectedKind(dataset.feature),
      notes: params.notes?.trim() || null,
      createdById: params.userId
    }
  });
}

export async function deleteDatasetItem(datasetId: string, itemId: string) {
  const item = await prisma.aIDatasetItem.findFirst({ where: { id: itemId, datasetId } });
  if (!item) throw new AppError(404, "Dataset item not found");
  await prisma.aIDatasetItem.delete({ where: { id: item.id } });
}

/**
 * Interactions whose proposals a human REFUSED — rejected outright, undone after applying, or
 * with individual rows declined. This is the signal ai-proposal.service.ts has called "far richer
 * than the thumbs-up/down" since it was written: produced by people doing their normal work, not
 * as a favour to the model. An undo especially — a human explicitly reversing the machine — is
 * the strongest negative example a golden set will ever get.
 */
async function proposalProblemInteractionIds(): Promise<string[]> {
  const proposals = await prisma.aiProposal.findMany({
    where: {
      sourceInteractionId: { not: null },
      OR: [
        { status: { in: ["REJECTED", "UNDONE", "PARTIALLY_UNDONE"] } },
        { changes: { some: { OR: [{ accepted: false }, { undoneAt: { not: null } }] } } }
      ]
    },
    select: { sourceInteractionId: true },
    take: 200
  });
  return [...new Set(proposals.map((p) => p.sourceInteractionId!))];
}

/**
 * Candidate interactions to promote — defaults to the ones worth looking at: responses that
 * failed to parse, that a human rated down, or whose PROPOSAL a human refused (rejected, undone,
 * or rows declined). Those are where a golden set earns its keep.
 */
export async function listPromotableInteractions(params: { feature: string; onlyProblems?: boolean; limit?: number }) {
  const problemIds = params.onlyProblems === false ? [] : await proposalProblemInteractionIds();
  const rows = await prisma.aIInteraction.findMany({
    where: {
      feature: params.feature,
      ...(params.onlyProblems === false
        ? {}
        : { OR: [{ parseOk: false }, { feedback: "down" }, ...(problemIds.length > 0 ? [{ id: { in: problemIds } }] : [])] })
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(params.limit ?? 25, 100),
    select: {
      id: true,
      feature: true,
      parseOk: true,
      feedback: true,
      outputText: true,
      paramsJson: true,
      createdAt: true
    }
  });
  const problemSet = new Set(problemIds);
  return rows.map((row) => ({
    ...row,
    // Tells the UI up front whether this one can actually be promoted, instead of letting someone
    // fill in an expected answer and only then hit a 422.
    replayable: row.paramsJson != null,
    /** True when a human refused this interaction's proposal — the reason it is on this list. */
    proposalRefused: problemSet.has(row.id)
  }));
}
