/**
 * WHAT: request forms — authoring them, and the inbox of what people submitted.
 *
 * WHY THE PUBLIC SUBMISSION PATH IS A SEPARATE FILE (`request-form-public.controller.ts`): every
 * route here requires a session and `forms:configure`; that one requires neither, by design. Two
 * files with two different postures is far harder to get wrong than one file where a reader has
 * to check each route to see which kind it is. Same split as attestations.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getPlanningQuota } from "../services/plan-limits.service.js";
import { assertPlanningCapability } from "../services/planning.service.js";
import { REQUEST_FIELD_TYPES, validateFormSchema, type RequestFormSchema } from "../services/request-form.service.js";

export const requestFormRouter = Router();
requestFormRouter.use(requireAuth);

/** Request forms have their own workspace toggle but no separate tier gate — intake is the
 *  cheapest way for a small team to get value from the planning layer, so it is not held back. */
const assertFormsEnabled = () =>
  assertPlanningCapability("enableRequestForms", "ganttEnabled", "Request forms");

const fieldSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  type: z.enum(REQUEST_FIELD_TYPES),
  help: z.string().max(300).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(120)).max(60).optional(),
  showWhen: z
    .array(
      z.object({
        field: z.string().min(1).max(60),
        operator: z.enum(["equals", "notEquals", "contains", "isAnswered"]),
        value: z.string().max(200).optional()
      })
    )
    .max(5)
    .optional(),
  mapsTo: z.string().max(80).optional()
});

const bodySchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens."),
  description: z.string().max(2000).nullish(),
  projectId: z.string().uuid(),
  moduleId: z.string().uuid().nullish(),
  ticketType: z.string().min(1).max(60).optional(),
  defaultPriority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  defaultAssigneeId: z.string().uuid().nullish(),
  blueprintId: z.string().uuid().nullish(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  maxSubmissionsPerHour: z.number().int().min(1).max(500).optional(),
  schema: z.object({
    fields: z.array(fieldSchema).min(1).max(60),
    intro: z.string().max(2000).optional(),
    confirmation: z.string().max(2000).optional()
  })
});

/** Never returned to a client that shouldn't have it — the token IS the capability. */
const serialize = (form: any, includeToken: boolean) => ({
  ...form,
  publicToken: includeToken ? form.publicToken : undefined,
  hasPublicLink: Boolean(form.publicToken)
});

requestFormRouter.get("/", requirePermission(permissions.FORMS_CONFIGURE), async (_req, res) => {
  const forms = await prisma.requestForm.findMany({
    include: {
      project: { select: { id: true, code: true, name: true } },
      blueprint: { select: { id: true, name: true } },
      _count: { select: { submissions: true } }
    },
    orderBy: { name: "asc" }
  });
  res.json(forms.map((f) => serialize(f, true)));
});

requestFormRouter.post(
  "/",
  requirePermission(permissions.FORMS_CONFIGURE),
  validate(z.object({ body: bodySchema })),
  async (req, res) => {
    await assertFormsEnabled();
    validateFormSchema(req.body.schema as RequestFormSchema);

    const quota = await getPlanningQuota(requireTenantContext().orgId, "maxRequestForms");
    const used = await prisma.requestForm.count({ where: { isActive: true } });
    if (used >= quota) {
      throw new AppError(
        403,
        quota === 0
          ? "Request forms are not included in this plan."
          : `This plan allows ${quota} active form(s) and ${used} exist. Deactivate one or upgrade.`
      );
    }

    const created = await prisma.requestForm.create({
      data: {
        name: req.body.name,
        slug: req.body.slug,
        description: req.body.description ?? null,
        projectId: req.body.projectId,
        moduleId: req.body.moduleId ?? null,
        ticketType: req.body.ticketType ?? "BUG",
        defaultPriority: req.body.defaultPriority ?? "MEDIUM",
        defaultAssigneeId: req.body.defaultAssigneeId ?? null,
        blueprintId: req.body.blueprintId ?? null,
        isActive: req.body.isActive ?? true,
        // Publishing is a SECOND, deliberate action (POST /:id/publish) — creating a form and
        // exposing it to the open internet are materially different decisions, and the same
        // two-step rule attestation sharing follows.
        isPublic: false,
        maxSubmissionsPerHour: req.body.maxSubmissionsPerHour ?? 20,
        schema: req.body.schema,
        createdById: req.user!.id
      }
    });
    await audit(req.user!.id, "request_form.created", "RequestForm", created.id, { slug: created.slug });
    res.status(201).json(serialize(created, true));
  }
);

requestFormRouter.put(
  "/:id",
  requirePermission(permissions.FORMS_CONFIGURE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: bodySchema })),
  async (req, res) => {
    await assertFormsEnabled();
    validateFormSchema(req.body.schema as RequestFormSchema);

    const updated = await prisma.requestForm.update({
      where: { id: String(req.params.id) },
      data: {
        name: req.body.name,
        slug: req.body.slug,
        description: req.body.description ?? null,
        projectId: req.body.projectId,
        moduleId: req.body.moduleId ?? null,
        ticketType: req.body.ticketType ?? "BUG",
        defaultPriority: req.body.defaultPriority ?? "MEDIUM",
        defaultAssigneeId: req.body.defaultAssigneeId ?? null,
        blueprintId: req.body.blueprintId ?? null,
        isActive: req.body.isActive ?? true,
        maxSubmissionsPerHour: req.body.maxSubmissionsPerHour ?? 20,
        schema: req.body.schema
      }
    });
    await audit(req.user!.id, "request_form.updated", "RequestForm", updated.id);
    res.json(serialize(updated, true));
  }
);

/**
 * Mint or revoke the public link.
 *
 * Revoking CLEARS the token rather than setting a flag, so a revoked URL cannot be resurrected by
 * flipping a boolean back — re-publishing mints a new one and the old link stays dead forever.
 */
requestFormRouter.post(
  "/:id/publish",
  requirePermission(permissions.FORMS_CONFIGURE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ publish: z.boolean() }).strict() })),
  async (req, res) => {
    await assertFormsEnabled();
    const id = String(req.params.id);

    if (!req.body.publish) {
      const revoked = await prisma.requestForm.update({ where: { id }, data: { isPublic: false, publicToken: null } });
      await audit(req.user!.id, "request_form.unpublished", "RequestForm", id);
      return res.json(serialize(revoked, true));
    }

    const published = await prisma.requestForm.update({
      where: { id },
      // 256 bits, base64url. Unguessable and never derived from the form id, which is not secret.
      data: { isPublic: true, publicToken: randomBytes(32).toString("base64url") }
    });
    await audit(req.user!.id, "request_form.published", "RequestForm", id);
    res.json(serialize(published, true));
  }
);

requestFormRouter.delete(
  "/:id",
  requirePermission(permissions.FORMS_CONFIGURE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const id = String(req.params.id);
    const submissions = await prisma.requestFormSubmission.count({ where: { formId: id } });
    if (submissions > 0) {
      // Deactivate rather than delete: the submissions are a record of what people asked for, and
      // cascading them away because a form was retired destroys history nobody meant to lose.
      await prisma.requestForm.update({ where: { id }, data: { isActive: false, isPublic: false, publicToken: null } });
      await audit(req.user!.id, "request_form.deactivated", "RequestForm", id, { submissions });
      return res.json({ deleted: false, submissions });
    }
    await prisma.requestForm.delete({ where: { id } });
    await audit(req.user!.id, "request_form.deleted", "RequestForm", id);
    res.json({ deleted: true });
  }
);

/* ---------- The inbox ---------- */

requestFormRouter.get("/submissions", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const submissions = await prisma.requestFormSubmission.findMany({
    where: {
      ...(status && status !== "all" ? { status } : {}),
      ...(typeof req.query.formId === "string" && req.query.formId ? { formId: req.query.formId } : {})
    },
    include: {
      form: { select: { id: true, name: true, slug: true, schema: true } },
      ticket: { select: { id: true, key: true, title: true, status: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  res.json(submissions);
});

/**
 * Reject a submission without creating a ticket.
 *
 * Accepting is not an endpoint: a submission becomes a ticket at SUBMIT time (see
 * request-form-public.controller.ts), because holding real requests in a queue nobody watches is
 * how intake systems quietly lose work. What review decides is whether the ticket that already
 * exists needs a human's attention — `needsReview` — not whether the request is allowed to exist.
 */
requestFormRouter.post(
  "/submissions/:id/reject",
  requirePermission(permissions.TICKETS_ASSIGN),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().max(500).optional() }).strict() })),
  async (req, res) => {
    const id = String(req.params.id);
    const submission = await prisma.requestFormSubmission.findUnique({ where: { id }, select: { id: true, ticketId: true } });
    if (!submission) throw new AppError(404, "Submission not found");

    await prisma.$transaction(async (tx) => {
      await tx.requestFormSubmission.update({ where: { id }, data: { status: "REJECTED", needsReview: false } });
      // The ticket is soft-deleted, not hard — a rejection that turns out to be wrong has to be
      // recoverable, and the audit trail should still be able to point at what was rejected.
      if (submission.ticketId) {
        await tx.ticket.update({ where: { id: submission.ticketId }, data: { deletedAt: new Date() } });
      }
    });
    await audit(req.user!.id, "request_form.submission_rejected", "RequestFormSubmission", id, { reason: req.body.reason });
    res.json({ ok: true });
  }
);

requestFormRouter.post(
  "/submissions/:id/accept",
  requirePermission(permissions.TICKETS_ASSIGN),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const id = String(req.params.id);
    const updated = await prisma.requestFormSubmission.update({
      where: { id },
      data: { status: "ACCEPTED", needsReview: false },
      include: { ticket: { select: { id: true, key: true } } }
    });
    await audit(req.user!.id, "request_form.submission_accepted", "RequestFormSubmission", id);
    res.json(updated);
  }
);
