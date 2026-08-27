/**
 * WHAT: the AI Requirements Studio's surface — creating a document, running its interview one
 * turn at a time, generating the structured PRD/BRD, exporting it, and materializing it into real
 * tickets/goals.
 *
 * WHY THERE IS NO "CREATE PROJECT" ROUTE HERE: the frontend prefills the app's EXISTING New
 * Project form from `GET /:id` and submits through the existing `POST /projects` — a document is
 * a draft an idea starts from, not a second way to create a project. See
 * requirements-doc.service.ts's header for the full materialization design.
 *
 * WHY TICKETS GO THROUGH `createProposal`, NOT A DIRECT WRITE: same reason `/plan-breakdown` does
 * — freshly-AI-generated content gets per-item accept/reject through the Proposals UI a person
 * already trusts, never a bulk write. `materialize-tickets` below is `plan-breakdown`'s exact
 * shape with a different source of `DraftChange[]`.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { aiRateLimit } from "../middleware/ai-rate-limit.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { preserveTenantContext, requirementsImportUpload } from "../middleware/upload.js";
import { assertGoalsEnabled, assertPlanningEnabled } from "../services/planning.service.js";
import { getPlanningEntitlements } from "../services/plan-limits.service.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { audit } from "../services/audit.service.js";
import { createProposal, type DraftChange } from "../services/ai-proposal.service.js";
import {
  analyzeImportedDocument,
  applyImportedAnswers,
  buildTicketMaterializationChanges,
  clearSourceDocument,
  createRequirementsDocument,
  generateDocument,
  getRequirementsDocument,
  getSourceDocumentText,
  getSourceDocumentView,
  listRequirementsDocuments,
  materializeGoals,
  recordInterviewTurn,
  regenerateFromStoredDocument,
  storeSourceFile,
  updateRequirementsDocument
} from "../services/requirements-doc.service.js";
import { renderRequirementsDocPdf } from "../services/requirements-doc-pdf.service.js";
import { renderRequirementsDocMarkdown } from "../services/requirements-doc-markdown.service.js";
import { renderRequirementsDocTemplate } from "../services/requirements-doc-template.service.js";
import { contentTypeFor, readSourceFile } from "../services/requirements-doc-viewer.service.js";
import { REQUIREMENTS_SECTIONS, type RequirementsDocSections } from "../services/ai.service.js";

export const requirementsDocRouter = Router();
requirementsDocRouter.use(requireAuth);
// Interview turns and generation both reach a model — same per-user bucket as /plan-breakdown.
requirementsDocRouter.use(aiRateLimit);

/** The copilot family is tier-gated as a whole — same check `ai-proposal.controller.ts` makes for
 *  every AI planning route, duplicated locally rather than shared for one extra caller. */
async function assertCopilotAllowed() {
  const entitlements = await getPlanningEntitlements(requireTenantContext().orgId);
  if (!entitlements.aiPmCopilotEnabled) {
    throw new AppError(403, "The AI planning copilot is an Enterprise feature.");
  }
}

const DOC_TYPE = z.enum(["PRD", "BRD", "BOTH"]);

requirementsDocRouter.post(
  "/",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ body: z.object({ title: z.string().min(3).max(200), docType: DOC_TYPE }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const doc = await createRequirementsDocument({ title: req.body.title, docType: req.body.docType }, req.user!.id);
    res.status(201).json(doc);
  }
);

requirementsDocRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  await assertPlanningEnabled();
  res.json(await listRequirementsDocuments());
});

// A fill-in-the-blank starting point for someone with no PRD/BRD to upload yet — plain text so it
// round-trips reliably through this app's own import path (see the template service's header for
// why not PDF/Word). Registered before "/:id" so "template.txt" is never matched as an id.
requirementsDocRouter.get("/template.txt", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  await assertPlanningEnabled();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="prd-brd-template.txt"');
  res.send(renderRequirementsDocTemplate());
});

requirementsDocRouter.get(
  "/:id",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    res.json(await getRequirementsDocument(String(req.params.id)));
  }
);

requirementsDocRouter.patch(
  "/:id",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z
        .object({
          title: z.string().min(3).max(200).optional(),
          docType: DOC_TYPE.optional(),
          sections: z.record(z.unknown()).optional(),
          status: z.enum(["DRAFTING", "READY", "ARCHIVED"]).optional()
        })
        .strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    const updated = await updateRequirementsDocument(
      String(req.params.id),
      { ...req.body, sections: req.body.sections as RequirementsDocSections | undefined },
      req.user!.id
    );
    res.json(updated);
  }
);

requirementsDocRouter.post(
  "/:id/interview/turn",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ answer: z.string().min(1).max(4000).optional(), skip: z.boolean().optional() }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const result = await recordInterviewTurn(String(req.params.id), req.body, req.user!.id);
    res.json(result);
  }
);

requirementsDocRouter.post(
  "/:id/generate",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({}).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const doc = await generateDocument(String(req.params.id), req.user!.id);
    res.json(doc);
  }
);

// Optional import: read an existing PRD/BRD and propose which interview areas it already answers.
// Writes nothing — see requirements-doc.service.ts's analyzeImportedDocument.
requirementsDocRouter.post(
  "/:id/import/analyze",
  requirePermission(permissions.PLAN_WRITE),
  // preserveTenantContext MUST wrap the multer middleware: multer parses off the request stream
  // in a context where the tenant AsyncLocalStorage store does not reliably propagate, and the
  // failure is size-dependent (see middleware/upload.ts's own comment on preserveTenantContext —
  // a previously-shipped bug, do not repeat it). validate() below only declares a `params`
  // schema, so running it after multer is safe: req.params comes from Express's router, not from
  // anything multer parses.
  preserveTenantContext(requirementsImportUpload.single("file")),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const file = req.file;
    if (!file?.buffer) throw new AppError(422, "No file provided");
    const result = await analyzeImportedDocument(String(req.params.id), file, req.user!.id);
    res.json(result);
  }
);

// The human-in-the-loop gate: writes a person-reviewed set of imported answers onto the
// document's transcript. Nothing from /import/analyze above is ever treated as a real answer
// until it comes back through here.
requirementsDocRouter.post(
  "/:id/import/apply",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z
        .object({
          turns: z
            .array(
              z.object({
                question: z.string().min(1).max(400),
                answer: z.string().min(1).max(4000),
                sectionTag: z.enum(REQUIREMENTS_SECTIONS)
              })
            )
            .min(1)
            .max(40),
          // Present only for a genuine (re-)upload — persists the file's provenance. Omitted for a
          // regenerate-from-stored-text or a plain edit of the reviewed answers.
          sourceDocument: z
            .object({
              fileName: z.string().min(1).max(255),
              fileSize: z.number().int().min(0),
              text: z.string().min(1)
            })
            .optional()
        })
        .strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const doc = await applyImportedAnswers(String(req.params.id), req.body, req.user!.id);
    res.json(doc);
  }
);

// The extracted text of the supporting document, for the in-app viewer. Its own route rather than
// a field on GET /:id — see the service function's header for why.
requirementsDocRouter.get(
  "/:id/source-text",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    res.json(await getSourceDocumentText(String(req.params.id)));
  }
);

// The original bytes, uploaded right after the reviewed answers are applied. Separate from
// /import/apply because that route takes JSON — see storeSourceFile's own header.
requirementsDocRouter.post(
  "/:id/source-file",
  requirePermission(permissions.PLAN_WRITE),
  // Same preserveTenantContext wrap every multer route in this app needs — multer parses off the
  // request stream where the tenant AsyncLocalStorage store does not reliably propagate.
  preserveTenantContext(requirementsImportUpload.single("file")),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const file = req.file;
    if (!file?.buffer) throw new AppError(422, "No file provided");
    res.json(await storeSourceFile(String(req.params.id), file, req.user!.id));
  }
);

// The type-aware preview: says WHICH viewer suits this file (a PDF gets the browser's own viewer,
// a .docx gets converted to HTML, text/markdown render as themselves) and carries the content for
// everything except the PDF, whose bytes stream from the sibling route below.
requirementsDocRouter.get(
  "/:id/source-view",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    res.json(await getSourceDocumentView(String(req.params.id)));
  }
);

// The original bytes, for the PDF viewer. `inline` rather than `attachment` so the browser renders
// it in place instead of downloading; the filename is still the one the uploader chose.
requirementsDocRouter.get(
  "/:id/source-file",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const doc = await getRequirementsDocument(String(req.params.id));
    if (!doc.sourceDocumentPath) throw new AppError(404, "This document has no stored file.");

    const bytes = await readSourceFile(doc.sourceDocumentPath);
    const safeName = (doc.sourceDocumentName ?? "document").replace(/[^\w. -]/g, "").slice(0, 100);
    res.setHeader("Content-Type", contentTypeFor(doc.sourceDocumentName ?? ""));
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    // Belt-and-braces for a file somebody else authored: never let a browser second-guess the type
    // we just declared, and never let it run as a document in this origin.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.send(bytes);
  }
);

// Re-runs the AI analysis against the document's already-stored extracted text — no new upload.
// Same preview-only contract as /import/analyze: writes nothing until /import/apply is called.
requirementsDocRouter.post(
  "/:id/import/regenerate",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({}).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const result = await regenerateFromStoredDocument(String(req.params.id), req.user!.id);
    res.json(result);
  }
);

// Un-links the supporting document (filename/size/text/uploader/date) without touching the
// transcript — "forget where this came from" is a different action from "discard my answers".
requirementsDocRouter.post(
  "/:id/import/clear-source",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({}).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    const doc = await clearSourceDocument(String(req.params.id), req.user!.id);
    res.json(doc);
  }
);

/**
 * POST rather than GET because of the diagram: PDFKit cannot render Mermaid, but the browser
 * already has the diagram on screen, so the frontend rasterises it and posts the PNG along. A
 * caller that doesn't (a direct API call, or a diagram Mermaid couldn't parse) still gets a
 * complete PDF — the renderer falls back to the Mermaid source. See the PDF service's header.
 */
requirementsDocRouter.post(
  "/:id/export.pdf",
  requirePermission(permissions.TICKETS_VIEW),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      // ~4MB of base64 ≈ a 3MB PNG: comfortably more than any flowchart needs, and a bound so a
      // caller can't push arbitrary megabytes through an authenticated endpoint.
      body: z.object({ diagramPng: z.string().max(4_000_000).optional() }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    const doc = await getRequirementsDocument(String(req.params.id));
    if (!doc.sections) throw new AppError(422, "Generate the document before exporting it.");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.title.replace(/[^\w -]/g, "").slice(0, 80) || "requirements"}.pdf"`);

    const pdf = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
    pdf.pipe(res);
    renderRequirementsDocPdf(pdf, {
      title: doc.title,
      docType: doc.docType,
      createdAt: doc.createdAt,
      sections: doc.sections as unknown as RequirementsDocSections,
      diagramPng: req.body.diagramPng ?? null,
      preparedBy: doc.sourceDocumentUploadedBy?.name ?? null,
      status: doc.status === "READY" ? "Final" : "Draft"
    });
    pdf.end();
  }
);

requirementsDocRouter.get(
  "/:id/export.md",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const doc = await getRequirementsDocument(String(req.params.id));
    if (!doc.sections) throw new AppError(422, "Generate the document before exporting it.");

    const markdown = renderRequirementsDocMarkdown({ title: doc.title, docType: doc.docType, createdAt: doc.createdAt, sections: doc.sections as unknown as RequirementsDocSections });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.title.replace(/[^\w -]/g, "").slice(0, 80) || "requirements"}.md"`);
    res.send(markdown);
  }
);

requirementsDocRouter.post(
  "/:id/materialize-tickets",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ projectId: z.string().uuid(), moduleIndexes: z.array(z.number().int().min(0)).max(40).optional() }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertCopilotAllowed();
    const doc = await getRequirementsDocument(String(req.params.id));

    const project = await prisma.project.findFirst({ where: { id: req.body.projectId, deletedAt: null }, select: { id: true } });
    if (!project) throw new AppError(404, "Project not found");

    const changes: DraftChange[] = buildTicketMaterializationChanges(
      { sections: doc.sections as unknown as RequirementsDocSections | null },
      project.id,
      req.body.moduleIndexes
    );

    const proposal = await createProposal({
      kind: "REQUIREMENTS_DOC",
      title: `Requirements: ${doc.title}`,
      scopeProjectId: project.id,
      requestedById: req.user!.id,
      changes
    });

    await audit(req.user!.id, "ai_proposal.created", "AiProposal", proposal.id, {
      kind: "REQUIREMENTS_DOC",
      requirementsDocumentId: doc.id,
      changes: changes.length
    });
    res.status(201).json(proposal);
  }
);

requirementsDocRouter.post(
  "/:id/materialize-goals",
  requirePermission(permissions.GOALS_MANAGE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z
        .object({
          projectId: z.string().uuid().optional(),
          items: z
            .array(
              z
                .object({
                  title: z.string().min(1).max(200),
                  description: z.string().max(2000).optional(),
                  targetValue: z.number().optional(),
                  unit: z.string().max(20).optional(),
                  startDate: z.string().optional(),
                  endDate: z.string().optional()
                })
                .strict()
            )
            .min(1)
            .max(50)
        })
        .strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    await assertGoalsEnabled();
    const created = await materializeGoals(String(req.params.id), req.body, req.user!.id);
    res.status(201).json({ created });
  }
);
