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
  createRequirementsDocument,
  generateDocument,
  getRequirementsDocument,
  listRequirementsDocuments,
  materializeGoals,
  recordInterviewTurn,
  updateRequirementsDocument
} from "../services/requirements-doc.service.js";
import { renderRequirementsDocPdf } from "../services/requirements-doc-pdf.service.js";
import { renderRequirementsDocMarkdown } from "../services/requirements-doc-markdown.service.js";
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
            .max(40)
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

requirementsDocRouter.get(
  "/:id/export.pdf",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await assertPlanningEnabled();
    const doc = await getRequirementsDocument(String(req.params.id));
    if (!doc.sections) throw new AppError(422, "Generate the document before exporting it.");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.title.replace(/[^\w -]/g, "").slice(0, 80) || "requirements"}.pdf"`);

    const pdf = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
    pdf.pipe(res);
    renderRequirementsDocPdf(pdf, { title: doc.title, docType: doc.docType, createdAt: doc.createdAt, sections: doc.sections as unknown as RequirementsDocSections });
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
