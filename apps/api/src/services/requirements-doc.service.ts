/**
 * WHAT: CRUD, interview orchestration and materialization for `RequirementsDocument` — the
 * AI-guided PRD/BRD an idea gets interviewed into (Workspace "Requirements Studio", V10).
 *
 * WHY A SEPARATE FILE FROM `ai.service.ts`: that file holds the AI CALLS themselves
 * (`conductRequirementsInterviewTurn`, `generateRequirementsDocument`) — this file is the CRUD and
 * orchestration layer around them, the same split `ai-provider-config.service.ts` draws between
 * "what a capability does" and "who is allowed to configure/drive it."
 *
 * WHY MATERIALIZATION IS THREE SEPARATE FUNCTIONS, NOT ONE: turning a document into a Project, a
 * batch of Tickets and some Goals are three different trust levels. A Project is created directly
 * through the app's normal project form (not here at all — the frontend just prefills it from
 * `GET /:id`). Tickets go through the SAME `AiProposal` review pipeline `plan_breakdown` already
 * uses (`buildTicketMaterializationChanges` below produces the same `DraftChange[]` shape that
 * pipeline expects) — freshly-AI-generated content gets per-item accept/reject, not a bulk write.
 * Goals get a small direct create (no `Goal` `ChangeTarget` exists in the proposal engine, and
 * extending that shared engine for one new target type is more machinery than a couple of rows
 * are worth) — still reviewed, just via a purpose-built confirm step instead of the generic one.
 */
import type { Prisma, RequirementsDocStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import {
  conductRequirementsInterviewTurn,
  generateRequirementsDocument,
  type RequirementsDocSections,
  type RequirementsDocType,
  type RequirementsInterviewTurn
} from "./ai.service.js";
import type { DraftChange } from "./ai-proposal.service.js";

export async function createRequirementsDocument(input: { title: string; docType: RequirementsDocType }, actorId: string) {
  const doc = await prisma.requirementsDocument.create({
    data: {
      title: input.title,
      docType: input.docType,
      status: "DRAFTING",
      interviewTranscript: [] as unknown as Prisma.InputJsonValue,
      createdById: actorId
    }
  });
  await audit(actorId, "requirements_doc.created", "RequirementsDocument", doc.id, { docType: input.docType });
  return doc;
}

export async function listRequirementsDocuments() {
  return prisma.requirementsDocument.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
}

export async function getRequirementsDocument(id: string) {
  const doc = await prisma.requirementsDocument.findUnique({ where: { id } });
  if (!doc) throw new AppError(404, "That requirements document no longer exists — refresh and retry.");
  return doc;
}

export async function updateRequirementsDocument(
  id: string,
  patch: { title?: string; docType?: RequirementsDocType; sections?: RequirementsDocSections; status?: RequirementsDocStatus },
  actorId: string
) {
  await getRequirementsDocument(id);
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.docType !== undefined) data.docType = patch.docType;
  if (patch.sections !== undefined) data.sections = patch.sections as unknown as Prisma.InputJsonValue;
  if (patch.status !== undefined) data.status = patch.status;

  const updated = await prisma.requirementsDocument.update({ where: { id }, data });
  await audit(actorId, "requirements_doc.updated", "RequirementsDocument", id, { fields: Object.keys(patch) });
  return updated;
}

/** Applies an answer (or skip) to whatever turn is currently open, in place. Throws when the
 *  request doesn't match the transcript's actual state — answering with nothing open, or asking
 *  for a question while one is already open and unanswered. */
function applyAnswerToOpenTurn(transcript: RequirementsInterviewTurn[], input: { answer?: string; skip?: boolean }): void {
  const answering = input.answer !== undefined || input.skip;
  const pending = transcript.length > 0 ? transcript[transcript.length - 1] : null;
  const isOpen = pending !== null && pending.answer === null && !pending.skipped;

  if (!isOpen) {
    if (answering) {
      throw new AppError(422, transcript.length === 0 ? "Start the interview first — call this with no answer to get the opening question." : "There is no open question to answer.");
    }
    return;
  }
  if (!answering) throw new AppError(422, "Answer or skip the open question before asking for another.");
  pending.answer = input.skip ? null : input.answer ?? null;
  pending.skipped = Boolean(input.skip);
}

/**
 * One turn of the interview: records the answer (or skip) to whatever question is currently open,
 * asks the AI for the next one, and appends it as the new open question. The transcript itself —
 * not a separate session table — is the interview's entire state (see this file's header).
 */
export async function recordInterviewTurn(id: string, input: { answer?: string; skip?: boolean }, actorId: string) {
  const doc = await getRequirementsDocument(id);
  if (doc.status !== "DRAFTING") throw new AppError(422, "This document's interview is already finished.");

  const transcript = ((doc.interviewTranscript as unknown as RequirementsInterviewTurn[]) ?? []).slice();
  applyAnswerToOpenTurn(transcript, input);

  const result = await conductRequirementsInterviewTurn({ transcript, docType: doc.docType, userId: actorId });
  if (!result) throw new AppError(502, "The assistant did not return a usable question. Try again.");

  if (!result.done) {
    transcript.push({ question: result.question!, answer: null, skipped: false, sectionTag: result.sectionTag ?? null });
  }

  await prisma.requirementsDocument.update({
    where: { id },
    data: { interviewTranscript: transcript as unknown as Prisma.InputJsonValue }
  });

  return result;
}

export async function generateDocument(id: string, actorId: string) {
  const doc = await getRequirementsDocument(id);
  const transcript = (doc.interviewTranscript as unknown as RequirementsInterviewTurn[]) ?? [];
  if (transcript.length === 0) throw new AppError(422, "Answer at least one interview question before generating the document.");

  const result = await generateRequirementsDocument({ transcript, docType: doc.docType, userId: actorId });
  if (!result) throw new AppError(502, "The assistant did not return a usable document. Try again.");

  const updated = await prisma.requirementsDocument.update({
    where: { id },
    data: { sections: result.sections as unknown as Prisma.InputJsonValue, status: "READY" }
  });
  await audit(actorId, "requirements_doc.generated", "RequirementsDocument", id, { model: result.model });
  return updated;
}

/**
 * Maps a generated document's features into the `DraftChange[]` shape `createProposal` expects —
 * one CREATE TICKET per feature, one LINK per same-document dependency — mirroring exactly how
 * `ai-proposal.controller.ts`'s `/plan-breakdown` route builds its own change set. Pure: the
 * caller is responsible for actually calling `createProposal`.
 *
 * `moduleIndexes` (indexes into `sections.modules`) narrows which features get proposed — omitted
 * means every feature. Dependency indexes are re-mapped to the DENSE range of the SELECTED
 * features (in the same order they're pushed as CREATE rows), because `applyProposal` resolves a
 * LINK's `fromIndex`/`toIndex` against the position a CREATE row was given in this same array, not
 * against the feature's original position in the full document.
 */
export function buildTicketMaterializationChanges(
  doc: { sections: RequirementsDocSections | null },
  projectId: string,
  moduleIndexes?: number[]
): DraftChange[] {
  if (!doc.sections) throw new AppError(422, "Generate the document before materializing tickets.");
  const { features, modules } = doc.sections;

  const allowedModuleNames = moduleIndexes?.length
    ? new Set(moduleIndexes.map((i) => modules[i]?.name).filter((name): name is string => Boolean(name)))
    : null;

  const selectedIndexes = features
    .map((_, index) => index)
    .filter((index) => {
      if (!allowedModuleNames) return true;
      const moduleName = features[index].moduleName;
      return moduleName ? allowedModuleNames.has(moduleName) : false;
    });
  if (selectedIndexes.length === 0) throw new AppError(422, "No features to create tickets from.");

  const oldToNew = new Map<number, number>();
  selectedIndexes.forEach((oldIndex, newIndex) => oldToNew.set(oldIndex, newIndex));

  const changes: DraftChange[] = selectedIndexes.map((oldIndex) => {
    const feature = features[oldIndex];
    return {
      targetType: "TICKET",
      op: "CREATE",
      after: {
        projectId,
        title: feature.moduleName ? `[${feature.moduleName}] ${feature.title}`.slice(0, 255) : feature.title,
        description: feature.description || null,
        estimatedHours: feature.estimatedHours,
        priority: feature.priority,
        type: "TASK"
      },
      summary: feature.estimatedHours ? `Create "${feature.title}" (${feature.estimatedHours}h)` : `Create "${feature.title}"`
    };
  });

  selectedIndexes.forEach((oldIndex, newIndex) => {
    const feature = features[oldIndex];
    if (feature.dependsOnIndex < 0) return;
    const mappedDependsOn = oldToNew.get(feature.dependsOnIndex);
    if (mappedDependsOn === undefined) return; // that dependency's feature wasn't included in this selection
    changes.push({
      targetType: "LINK",
      op: "LINK",
      after: { fromIndex: mappedDependsOn, toIndex: newIndex },
      summary: `"${features[feature.dependsOnIndex].title}" must finish before "${feature.title}"`
    });
  });

  return changes;
}

export interface MaterializeGoalInput {
  title: string;
  description?: string;
  targetValue?: number;
  unit?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Direct create, not a proposal — see this file's header for why. Still one reviewed batch: the
 * caller (the frontend's confirm step) has already shown the person exactly these rows before
 * this runs, and the whole batch either lands together or not at all.
 */
export async function materializeGoals(id: string, input: { projectId?: string; items: MaterializeGoalInput[] }, actorId: string) {
  await getRequirementsDocument(id);
  if (input.items.length === 0) throw new AppError(422, "No goals to create.");
  if (input.items.length > 50) throw new AppError(422, "That is too many goals to create at once.");

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const item of input.items) {
      const goal = await tx.goal.create({
        data: {
          title: item.title.slice(0, 200),
          description: item.description ?? null,
          targetValue: item.targetValue ?? null,
          unit: item.unit ?? null,
          startDate: item.startDate ? new Date(item.startDate) : null,
          endDate: item.endDate ? new Date(item.endDate) : null,
          progressSource: "MANUAL",
          createdById: actorId
        }
      });
      if (input.projectId) {
        await tx.goalLink.create({ data: { goalId: goal.id, targetType: "PROJECT", targetId: input.projectId } });
      }
      rows.push(goal);
    }
    return rows;
  });

  await audit(actorId, "requirements_doc.goals_materialized", "RequirementsDocument", id, {
    projectId: input.projectId ?? null,
    count: created.length
  });
  return created;
}
