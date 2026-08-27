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
  analyzeRequirementsImport,
  conductRequirementsInterviewTurn,
  generateRequirementsDocument,
  type RequirementsDocSections,
  type RequirementsDocType,
  type RequirementsImportAnalysisResult,
  type RequirementsInterviewTurn
} from "./ai.service.js";
import { extractRequirementsImportText } from "./requirements-doc-import.service.js";
import { buildSourceViewerPayload, deleteSourceFile, newSourceFileName, writeSourceFile } from "./requirements-doc-viewer.service.js";
import type { DraftChange } from "./ai-proposal.service.js";

/** ~6k tokens — generous for a real PRD, bounded for prompt cost. */
const MAX_IMPORT_DOC_CHARS = 24_000;
/** Below this, an uploaded PDF is probably a scanned image with no real text layer — better to
 *  say so plainly than hand the AI (and the person reviewing its output) a near-empty document. */
const MIN_IMPORT_DOC_CHARS = 200;

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
  const doc = await prisma.requirementsDocument.findUnique({
    where: { id },
    include: { sourceDocumentUploadedBy: { select: { id: true, name: true } } }
  });
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

/**
 * Extracts text from an uploaded PDF/DOCX/TXT and asks the AI which interview areas it already
 * answers. Writes NOTHING to the document — this is a preview only. Nothing here becomes a real
 * transcript answer until a person reviews it and calls applyImportedAnswers below; that's the
 * human-in-the-loop gate this feature is built around.
 *
 * Available any time the document is still DRAFTING, not just before the interview has started —
 * a re-upload replaces the transcript wholesale (see applyImportedAnswers), so there is no merge
 * case to worry about here.
 */
export async function analyzeImportedDocument(
  id: string,
  file: { buffer: Buffer; originalname: string },
  actorId: string
): Promise<RequirementsImportAnalysisResult & { truncated: boolean; documentText: string }> {
  const doc = await getRequirementsDocument(id);
  if (doc.status === "ARCHIVED") throw new AppError(422, "This document is archived.");

  const extracted = await extractRequirementsImportText(file);
  if (extracted.text.trim().length < MIN_IMPORT_DOC_CHARS) {
    throw new AppError(
      422,
      "Could not find enough readable text in that file — if it's a scanned PDF with no text layer, try pasting the content instead or continue with the blank interview."
    );
  }

  const truncated = extracted.text.length > MAX_IMPORT_DOC_CHARS;
  const documentText = truncated ? extracted.text.slice(0, MAX_IMPORT_DOC_CHARS) : extracted.text;

  const result = await analyzeRequirementsImport({ documentText, truncated, docType: doc.docType, userId: actorId });
  if (!result) throw new AppError(502, "The assistant could not read that document. Try again.");

  await audit(actorId, "requirements_doc.import_analyzed", "RequirementsDocument", id, {
    fileName: file.originalname,
    proposedTurns: result.proposedTurns.length,
    openQuestions: result.openQuestions.length,
    truncated
  });

  return { ...result, truncated, documentText };
}

/**
 * Re-runs the AI analysis against the document's ALREADY-STORED extracted text — no new upload.
 * Same preview-only contract as analyzeImportedDocument: writes nothing.
 */
export async function regenerateFromStoredDocument(id: string, actorId: string): Promise<RequirementsImportAnalysisResult & { truncated: boolean }> {
  const doc = await getRequirementsDocument(id);
  if (doc.status === "ARCHIVED") throw new AppError(422, "This document is archived.");
  if (!doc.sourceDocumentText) throw new AppError(422, "No supporting document to regenerate from.");

  const truncated = doc.sourceDocumentText.length > MAX_IMPORT_DOC_CHARS;
  const documentText = truncated ? doc.sourceDocumentText.slice(0, MAX_IMPORT_DOC_CHARS) : doc.sourceDocumentText;

  const result = await analyzeRequirementsImport({ documentText, truncated, docType: doc.docType, userId: actorId });
  if (!result) throw new AppError(502, "The assistant could not read that document. Try again.");

  await audit(actorId, "requirements_doc.import_regenerated", "RequirementsDocument", id, {
    proposedTurns: result.proposedTurns.length,
    openQuestions: result.openQuestions.length
  });

  return { ...result, truncated };
}

/**
 * Writes a person-reviewed set of imported answers onto the document's transcript — a full
 * REPLACE, not a merge, whether this is the first import or a re-upload/regenerate over existing
 * progress (the frontend confirms with the person before calling this when there's something to
 * lose). This is the ONLY function that turns an import proposal into real interview state —
 * analyzeImportedDocument/regenerateFromStoredDocument above never write anything.
 *
 * `sourceDocument` is provided only for a genuine (re-)upload — it persists the file's provenance
 * (name, size, extracted text, uploader, timestamp). Omitted for a regenerate-from-stored-text or
 * a plain manual edit of the reviewed answers, so those never touch who-uploaded-what-when.
 *
 * Deliberately does not call recordInterviewTurn itself: the caller (the frontend) calls the
 * existing interview-turn endpoint with an empty body right after this succeeds, exactly like
 * starting a fresh interview — so the interview engine (conductRequirementsInterviewTurn) needs
 * no changes at all to pick up wherever the import left off.
 */
export async function applyImportedAnswers(
  id: string,
  input: {
    turns: Array<{ question: string; answer: string; sectionTag: string }>;
    sourceDocument?: { fileName: string; fileSize: number; text: string };
  },
  actorId: string
) {
  const doc = await getRequirementsDocument(id);
  if (doc.status === "ARCHIVED") throw new AppError(422, "This document is archived.");
  if (input.turns.length === 0) throw new AppError(422, "No reviewed answers to save.");

  const seeded: RequirementsInterviewTurn[] = input.turns.map((t) => ({
    question: t.question,
    answer: t.answer,
    skipped: false,
    sectionTag: t.sectionTag
  }));

  await prisma.requirementsDocument.update({
    where: { id },
    data: {
      interviewTranscript: seeded as unknown as Prisma.InputJsonValue,
      // Replacing the transcript makes an already-generated document stale — it no longer reflects
      // its own answers. Reopening the interview is the honest outcome; leaving a READY badge over
      // a document that contradicts its transcript is the worse of the two failures. The frontend
      // warns before confirming, so this is never a surprise.
      ...(doc.status === "READY" ? { status: "DRAFTING" as const } : {}),
      ...(input.sourceDocument
        ? {
            sourceDocumentName: input.sourceDocument.fileName,
            sourceDocumentSize: input.sourceDocument.fileSize,
            sourceDocumentText: input.sourceDocument.text,
            sourceDocumentUploadedById: actorId,
            sourceDocumentUploadedAt: new Date()
          }
        : {})
    }
  });
  await audit(actorId, "requirements_doc.import_applied", "RequirementsDocument", id, {
    turns: seeded.length,
    fromUpload: Boolean(input.sourceDocument),
    reopenedInterview: doc.status === "READY"
  });
  return getRequirementsDocument(id);
}

/**
 * The extracted text of the supporting document, for the in-app viewer. Deliberately its own
 * endpoint rather than a field on `GET /:id`: a long PRD's text is far too much to ship on every
 * page load of a document nobody is inspecting.
 *
 * This is the text the AI actually read — NOT a copy of the original file. The raw bytes were
 * never persisted (see this feature's import service), and the viewer's copy says so plainly
 * rather than implying it's showing the PDF.
 */
/**
 * Stores the ORIGINAL uploaded bytes for a document whose answers have already been applied.
 *
 * Its own call rather than part of `applyImportedAnswers` for a plain reason: that endpoint takes
 * JSON (a reviewed, possibly-edited list of answers), and threading a 15MB file through it would
 * mean base64 in a JSON body. Splitting them also gives the better failure mode — if this fails,
 * the import still succeeded and the document simply previews from its extracted text.
 */
export async function storeSourceFile(id: string, file: { buffer: Buffer; originalname: string }, actorId: string) {
  const doc = await getRequirementsDocument(id);
  const storedPath = newSourceFileName(file.originalname);
  // Written BEFORE the row points at it, so a failed write can never leave a path in the database
  // with nothing behind it.
  await writeSourceFile(storedPath, file.buffer);
  // Replacing a document would otherwise leave the previous file orphaned on disk.
  await deleteSourceFile(doc.sourceDocumentPath);

  const updated = await prisma.requirementsDocument.update({
    where: { id },
    data: { sourceDocumentPath: storedPath },
    include: { sourceDocumentUploadedBy: { select: { id: true, name: true } } }
  });
  await audit(actorId, "requirements_doc.source_file_stored", "RequirementsDocument", id, { fileName: file.originalname });
  return updated;
}

export async function getSourceDocumentView(id: string) {
  const doc = await getRequirementsDocument(id);
  if (!doc.sourceDocumentName) throw new AppError(404, "This document has no supporting document.");
  return buildSourceViewerPayload(doc);
}

export async function getSourceDocumentText(id: string) {
  const doc = await getRequirementsDocument(id);
  if (!doc.sourceDocumentText) throw new AppError(404, "This document has no supporting document.");
  return {
    fileName: doc.sourceDocumentName,
    size: doc.sourceDocumentSize,
    uploadedAt: doc.sourceDocumentUploadedAt,
    uploadedBy: doc.sourceDocumentUploadedBy,
    text: doc.sourceDocumentText
  };
}

/** Un-links the supporting document — clears the five provenance fields only. The transcript
 *  (whatever answers exist) is untouched: "forget where this came from" and "discard my answers"
 *  are different actions, and only the first was asked for. */
export async function clearSourceDocument(id: string, actorId: string) {
  const existing = await getRequirementsDocument(id);
  // The row stops pointing at the file either way; deleting the bytes is what makes "remove"
  // actually remove rather than merely hide.
  await deleteSourceFile(existing.sourceDocumentPath);
  const updated = await prisma.requirementsDocument.update({
    where: { id },
    data: {
      sourceDocumentName: null,
      sourceDocumentSize: null,
      sourceDocumentText: null,
      sourceDocumentUploadedById: null,
      sourceDocumentUploadedAt: null,
      sourceDocumentPath: null
    },
    include: { sourceDocumentUploadedBy: { select: { id: true, name: true } } }
  });
  await audit(actorId, "requirements_doc.source_cleared", "RequirementsDocument", id);
  return updated;
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
