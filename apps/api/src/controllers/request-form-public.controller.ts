/**
 * The unauthenticated intake surface: someone outside the workspace opening a request-form link
 * and submitting it.
 *
 * SECURITY POSTURE — this is the only endpoint in the app that lets a stranger WRITE, so the
 * rules below are deliberate rather than incidental:
 * - The URL carries a 256-bit random token. Form ids never appear in it, so nothing is
 *   enumerable by walking ids.
 * - An inactive form, an unpublished form and a bad token all return an identical generic
 *   **404**. Distinguishing them would let a probe learn that a token was once real.
 * - Submissions are rate-limited PER FORM (the author's own `maxSubmissionsPerHour`) on top of
 *   the mount-level per-IP limiter. Per-IP alone is useless against a distributed flood and
 *   punishes a genuine office behind one NAT; per-form bounds the damage to the thing being
 *   abused.
 * - The submitter's IP is stored only as a salted hash — enough to spot a flood, not a stored
 *   identifier for someone who only ever filled in a form.
 * - Every answer is validated against the form's own schema server-side, and answers to
 *   questions that were not visible are dropped (see request-form.service.ts). The browser
 *   decides what to draw; the server decides what counts.
 * - The created ticket's body is PLAIN TEXT. The content is written by an unauthenticated
 *   stranger and the reliable way to stop it becoming stored XSS on a ticket page is never to
 *   treat it as markup at all.
 * - The reporter is the seeded intake system user, exactly as email and chat intake already do —
 *   `Ticket.reporterId` needs a real `User`, and the real sender lives in the external fields.
 * - `needsReview` starts TRUE. An unauthenticated submission never routes itself past a human.
 *
 * MOUNTED AFTER `resolveTenant`: a form URL is handed out on the org's own host, so the tenant
 * resolves the same way every in-app route does. That keeps a token scoped to the tenant it was
 * minted in — it cannot be replayed against another org's database.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { setCustomFieldValues } from "../services/custom-field.service.js";
import {
  hashPublicFormToken,
  normaliseSubmission,
  renderAnswers,
  visibleFields,
  type RequestFormSchema
} from "../services/request-form.service.js";
import { EMAIL_INTAKE_SYSTEM_EMAIL } from "../services/email-intake.service.js";
import { computeTicketDueDate, getGlobalTicketSettings, issueTicketKey } from "../services/ticket.service.js";
import { dispatchNotification } from "../services/notify.service.js";

export const requestFormPublicRouter = Router();

/** Salted so the stored value cannot be reversed to an IP by hashing the whole IPv4 space —
 *  which is trivially cheap without a secret in the mix. */
const hashIp = (ip: string) => crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(ip).digest("hex").slice(0, 64);

/** One generic 404 for every "you may not have this" case. */
const notFound = () => new AppError(404, "This form isn't available.");

async function loadPublishedForm(token: string) {
  if (!token || token.length < 20 || token.length > 200) throw notFound();
  const form = await prisma.requestForm.findFirst({
    // Looked up by digest, so the stored row is not itself a working link — a database read
    // (backup, dump, injected SELECT) no longer hands over the capability. `publicToken` is the
    // transitional fallback for forms published before hashing and goes away with that column.
    where: {
      OR: [{ publicTokenHash: hashPublicFormToken(token) }, { publicToken: token }],
      isPublic: true,
      isActive: true
    },
    include: { project: { select: { id: true, name: true } } }
  });
  if (!form) throw notFound();
  return form;
}

/**
 * The form as a stranger should see it.
 *
 * Deliberately narrow: the schema, a name and an intro. NOT the project id, the default assignee,
 * the routing, the blueprint, or the submission count — none of that is the submitter's business,
 * and each is a small piece of internal structure that a competitor or an attacker would rather
 * have than not.
 */
requestFormPublicRouter.get("/:token", async (req, res) => {
  const form = await loadPublishedForm(String(req.params.token));
  const schema = form.schema as unknown as RequestFormSchema;

  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.json({
    name: form.name,
    description: form.description,
    intro: schema.intro ?? null,
    confirmation: schema.confirmation ?? null,
    fields: schema.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      help: f.help,
      required: f.required ?? false,
      options: f.options ?? undefined,
      showWhen: f.showWhen ?? undefined
    }))
  });
});

const submitSchema = z.object({
  params: z.object({ token: z.string().min(20).max(120) }),
  body: z
    .object({
      submitterName: z.string().max(160).optional(),
      submitterEmail: z.string().email().max(255).optional(),
      answers: z.record(z.unknown())
    })
    .strict()
});

requestFormPublicRouter.post("/:token", validate(submitSchema), async (req, res) => {
  const form = await loadPublishedForm(String(req.params.token));
  const schema = form.schema as unknown as RequestFormSchema;

  // Per-form throttle, on top of the per-IP limiter at the mount point. Counted over the last
  // hour rather than a fixed window so a burst at the top of the hour can't reset itself.
  const since = new Date(Date.now() - 3_600_000);
  const recent = await prisma.requestFormSubmission.count({ where: { formId: form.id, createdAt: { gte: since } } });
  if (recent >= form.maxSubmissionsPerHour) {
    throw new AppError(429, "This form has received a lot of requests recently. Please try again shortly.");
  }

  const normalised = normaliseSubmission(schema, req.body.answers as Record<string, unknown>);

  // The reporter is the seeded intake system account: Ticket.reporterId needs a real User row and
  // the submitter has no account. Their identity lives in the external* fields, exactly as email
  // and chat intake already do.
  const systemUser = await prisma.user.findFirst({ where: { email: EMAIL_INTAKE_SYSTEM_EMAIL }, select: { id: true } });
  if (!systemUser) throw new AppError(500, "Intake is not configured on this workspace.");

  const settings = await getGlobalTicketSettings();
  const createdAt = new Date();

  const body = [
    normalised.description,
    renderAnswers(schema, normalised.answers),
    req.body.submitterName || req.body.submitterEmail
      ? `\nSubmitted by ${req.body.submitterName ?? "someone"}${req.body.submitterEmail ? ` <${req.body.submitterEmail}>` : ""} via the "${form.name}" form.`
      : `\nSubmitted via the "${form.name}" form.`
  ]
    .filter(Boolean)
    .join("\n\n");

  const { ticket, submission } = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, form.projectId);
    const created = await tx.ticket.create({
      data: {
        key,
        projectId: form.projectId,
        moduleId: form.moduleId,
        type: form.ticketType,
        title: normalised.title,
        description: body,
        priority: form.defaultPriority,
        source: "MANUAL",
        reporterId: systemUser.id,
        assigneeId: form.defaultAssigneeId,
        externalReporterEmail: req.body.submitterEmail ?? null,
        externalReporterName: req.body.submitterName ?? null,
        dueAt: computeTicketDueDate(createdAt, form.defaultPriority, settings),
        // TRUE, always. An unauthenticated submission never routes itself past a human — the same
        // posture the email and chat pipelines take, and for the same reason.
        needsReview: true
      }
    });

    const sub = await tx.requestFormSubmission.create({
      data: {
        formId: form.id,
        ticketId: created.id,
        submitterName: req.body.submitterName ?? null,
        submitterEmail: req.body.submitterEmail ?? null,
        answers: normalised.answers as Prisma.InputJsonValue,
        status: "PENDING",
        needsReview: true,
        ipHash: req.ip ? hashIp(req.ip) : null
      }
    });

    return { ticket: created, submission: sub };
  });

  // Custom fields are written outside the transaction on purpose: a mapped field that no longer
  // exists, or a value that fails its type check, must not throw away a genuine request. The
  // ticket is the thing that matters; a missing custom value is recoverable by a human.
  if (Object.keys(normalised.customFields).length > 0) {
    try {
      await setCustomFieldValues({ ticketId: ticket.id }, normalised.customFields, { ticketType: form.ticketType });
    } catch {
      // Swallowed deliberately — see above. The answers are stored verbatim on the submission, so
      // nothing is lost.
    }
  }

  await audit(undefined, "request_form.submitted", "RequestFormSubmission", submission.id, {
    form: form.slug,
    ticket: ticket.key
  }, {
    actorType: "GUEST",
    actorLabel: `request-form:${form.slug}`,
    ipAddress: req.ip
  });

  // Best-effort: an intake that fails because a mailbox is down would be a worse outcome than a
  // notification nobody received.
  try {
    if (form.defaultAssigneeId) {
      await dispatchNotification({
        userId: form.defaultAssigneeId,
        category: "ticket.assigned",
        title: `New request: ${ticket.key}`,
        body: `${normalised.title} — submitted through the "${form.name}" form.`,
        link: `/app/tickets?open=${ticket.id}`
      });
    }
  } catch {
    /* ignore */
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({
    // The reference is useful to a submitter chasing their request; nothing else about the
    // workspace is exposed.
    reference: ticket.key,
    confirmation: schema.confirmation ?? "Thanks — your request has been received."
  });
});

/** Live visibility evaluation, so a long conditional form doesn't have to reimplement the rule
 *  engine in the browser to stay in step with what the server will accept. */
requestFormPublicRouter.post(
  "/:token/visible",
  validate(z.object({ params: z.object({ token: z.string().min(20).max(120) }), body: z.object({ answers: z.record(z.unknown()) }).strict() })),
  async (req, res) => {
    const form = await loadPublishedForm(String(req.params.token));
    const schema = form.schema as unknown as RequestFormSchema;
    res.json({ visible: visibleFields(schema, req.body.answers as Record<string, unknown>).map((f) => f.key) });
  }
);
