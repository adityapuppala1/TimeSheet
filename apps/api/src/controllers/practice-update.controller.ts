/**
 * WHAT: the Weekly AI/ML Practice Update — draft it, review it, send it, and decide who gets it.
 *
 * WHY THE WHOLE ROUTER IS SUPER_ADMIN: the update aggregates every project, every person's hours
 * and every open security finding into one document, and then mails it to an arbitrary address
 * list. Both halves of that are privileged. The recipient list especially — "only the super admin
 * decides who this goes to" is the requirement, and the cheapest way to keep that true is for
 * nobody else to be able to reach any of these routes at all.
 *
 * WHY DRAFT AND SEND ARE SEPARATE CALLS: the draft is reviewable and editable before it leaves.
 * The narrative sections are model-written from counted figures, and a CEO is the wrong person to
 * discover that a model mis-read a week. `POST /send` takes the REVIEWED sections back, rather
 * than regenerating them — otherwise the edits would be silently discarded and the thing that went
 * out would be a document nobody had read.
 */
import { Router } from "express";
import { z } from "zod";

import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { isPlanningCapabilityAllowed } from "./../services/plan-limits.service.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { generatePracticeUpdate, type PracticeUpdateNarrative } from "../services/ai.service.js";
import { getGlobalNotificationSettings } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { renderEmailTemplate } from "../services/template-store.service.js";
import { sendMail } from "../services/mail.service.js";
import { buildPracticeUpdateData, lastCompleteWeek, type PracticeUpdateData } from "../services/practice-update.service.js";
import { buildPracticeUpdateEmail, narrativeInputs } from "../services/practice-update-mail.service.js";

export const practiceUpdateRouter = Router();
practiceUpdateRouter.use(requireAuth, requireSuperAdmin);

/**
 * The plan gate, on the whole router.
 *
 * FAILS CLOSED, like every other planning capability — and losing it is recoverable: the figures
 * stay visible on the pages they come from, what a downgrade removes is the packaged, mailable
 * roll-up. The message says "plan" rather than "setting" on purpose: an admin of this workspace
 * cannot fix this one, so pointing them at a toggle would send them somewhere that cannot help.
 */
practiceUpdateRouter.use(async (_req, _res, next) => {
  const allowed = await isPlanningCapabilityAllowed(requireTenantContext().orgId, "practiceUpdateEnabled");
  if (!allowed) {
    return next(new AppError(403, "The weekly practice update is not included in this plan."));
  }
  next();
});

/** At most this many addresses on one update. A distribution list, not a mailshot. */
const MAX_RECIPIENTS = 50;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

/** The stored list, normalised. Anything unparseable in the column is treated as "not set yet"
 *  rather than throwing — a hand-edited settings row must not take the page down. */
function storedRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && EMAIL_RE.test(value.trim())).map((v) => v.trim());
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The period to report on: an explicit range, or last complete Monday-to-Sunday week. */
function resolvePeriod(query: { from?: unknown; to?: unknown }): { from: Date; to: Date; label: string } {
  const from = typeof query.from === "string" && ISO_DAY.test(query.from) ? new Date(`${query.from}T00:00:00`) : null;
  const to = typeof query.to === "string" && ISO_DAY.test(query.to) ? new Date(`${query.to}T00:00:00`) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return lastCompleteWeek(new Date());
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return { from, to, label: `${fmt(from)} – ${fmt(to)} ${to.getFullYear()}` };
}

/**
 * GET /practice-update/settings — the distribution list, the cadence, and whether either gate is on.
 *
 * The two gates are reported separately and named, because "nothing happened when I clicked send"
 * has two very different causes and the page should be able to say which.
 */
practiceUpdateRouter.get("/settings", async (_req, res) => {
  const [settings, ai] = await Promise.all([
    getGlobalNotificationSettings(),
    prisma.globalAISettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } })
  ]);

  res.json({
    recipients: storedRecipients(settings.practiceUpdateRecipients),
    /** Null means nobody has ever chosen — distinct from an empty list saved deliberately. */
    configured: settings.practiceUpdateRecipients !== null,
    weekly: settings.practiceUpdateWeekly,
    emailEnabled: settings.emailPracticeUpdate,
    aiNarrativeEnabled: ai.practiceUpdateEnabled,
    maxRecipients: MAX_RECIPIENTS
  });
});

practiceUpdateRouter.put(
  "/settings",
  validate(
    z.object({
      body: z.object({
        recipients: z.array(z.string().trim().min(3).max(255)).max(MAX_RECIPIENTS),
        weekly: z.boolean().optional()
      })
    })
  ),
  async (req, res) => {
    const body = req.body as { recipients: string[]; weekly?: boolean };

    // Validated here rather than by a zod `.email()`: a bad address in a leadership distribution
    // list should name itself, not fail the whole save with a field path.
    const invalid = body.recipients.filter((value) => !EMAIL_RE.test(value.trim()));
    if (invalid.length > 0) throw new AppError(422, `Not a valid email address: ${invalid.slice(0, 3).join(", ")}`);

    const recipients = [...new Set(body.recipients.map((value) => value.trim().toLowerCase()))];
    const patch = {
      practiceUpdateRecipients: recipients,
      ...(body.weekly === undefined ? {} : { practiceUpdateWeekly: body.weekly })
    };
    const settings = await prisma.globalNotificationSettings.upsert({
      where: { id: "global" },
      update: patch,
      create: { id: "global", ...patch }
    });

    await audit(req.user!.id, "practice_update.recipients_updated", "GlobalNotificationSettings", "global", {
      count: recipients.length,
      weekly: body.weekly ?? settings.practiceUpdateWeekly
    });

    res.json({ recipients, weekly: body.weekly ?? settings.practiceUpdateWeekly });
  }
);

/**
 * POST /practice-update/draft — assemble the figures and, when the AI gate is on, the narrative.
 *
 * The narrative is best-effort by design. A model that is off, slow or wrong must not stop an
 * update whose numbers are all counted from the database — the caller is told `aiFailed` so the
 * page can say the prose is missing instead of pretending it was never wanted.
 */
const narrativeSchema = z.object({
  executiveSummary: z.string().max(8_000).default(""),
  risks: z.array(z.string().max(1_000)).max(50).default([]),
  nextWeekPriorities: z.array(z.string().max(1_000)).max(50).default([]),
  decisionsRequired: z.array(z.string().max(1_000)).max(50).default([]),
  nextSteps: z.array(z.object({ id: z.string(), text: z.string().max(500) })).max(200).default([])
});

practiceUpdateRouter.post("/draft", async (req, res) => {
  const period = resolvePeriod(req.body ?? {});
  const data = await buildPracticeUpdateData(period.from, period.to, period.label);

  let narrative: PracticeUpdateNarrative | null = null;
  let aiFailed: string | null = null;
  try {
    const inputs = narrativeInputs(data);
    narrative = await generatePracticeUpdate({ ...inputs, periodLabel: data.period.label, userId: req.user!.id });
  } catch (error) {
    aiFailed = error instanceof Error ? error.message : "The narrative could not be drafted.";
  }
  // Three outcomes, not two. "switched off", "answered in the wrong shape" and "wrote the prose"
  // are different things to tell a reviewer, and collapsing the first two into a silent null left
  // the page unable to say which had happened.
  if (!narrative && !aiFailed) {
    aiFailed = "The model answered, but not in the format this update needs. The figures below are complete — the written sections are yours to fill in.";
  }

  const email = buildPracticeUpdateEmail(data, narrative);

  /*
   * STORED, NOT JUST RETURNED. This document costs a full model run to produce, and it used to live
   * only in React state — so a refresh, a tab close, or a walk to another screen threw it away and
   * the only way back was to spend those tokens again.
   *
   * Delete-then-create in ONE transaction, because "at most one draft" is a real constraint rather
   * than a convention: two concurrent generates must not leave a workspace with two documents each
   * claiming to be the current one. MySQL has no partial unique index to lean on, so the atomicity
   * has to come from here.
   */
  const record = await prisma.$transaction(async (tx) => {
    await tx.practiceUpdateRecord.deleteMany({ where: { status: "DRAFT" } });
    return tx.practiceUpdateRecord.create({
      data: {
        status: "DRAFT",
        periodFrom: period.from,
        periodTo: period.to,
        periodLabel: period.label,
        data: data as unknown as object,
        narrative: (narrative ?? undefined) as unknown as object | undefined,
        aiFailed,
        generatedById: req.user!.id
      }
    });
  });

  res.json({ id: record.id, data, narrative, aiFailed, preview: email, generatedAt: record.createdAt });
});

/**
 * GET /practice-update/draft — the stored draft, rebuilt into the shape the page renders.
 *
 * Answers `{ draft: null }` rather than 404 when there is none: "you have nothing in progress" is a
 * normal state of this screen, not a failure, and a 404 makes every page load log an error.
 *
 * The email preview is REBUILT from the stored figures rather than stored alongside them. A draft
 * has not been sent, so there is nothing historic to preserve — and rebuilding means an improvement
 * to the template shows up in a draft written before it.
 */
practiceUpdateRouter.get("/draft", async (_req, res) => {
  const record = await prisma.practiceUpdateRecord.findFirst({
    where: { status: "DRAFT" },
    orderBy: { createdAt: "desc" },
    include: { generatedBy: { select: { name: true } } }
  });
  if (!record) return res.json({ draft: null });

  const data = record.data as unknown as PracticeUpdateData;
  const narrative = (record.narrative ?? null) as PracticeUpdateNarrative | null;
  res.json({
    draft: {
      id: record.id,
      data,
      narrative,
      aiFailed: record.aiFailed,
      preview: buildPracticeUpdateEmail(data, narrative),
      generatedAt: record.createdAt,
      generatedByName: record.generatedBy?.name ?? null
    }
  });
});

/**
 * PATCH /practice-update/draft — save the edited prose.
 *
 * ONLY the narrative. The figures are never accepted from the client, here or at send: a caller who
 * could post arbitrary numbers into a document that looks like it came from this workspace's own
 * records could make it say anything, which is the same reason /send rebuilds them server-side.
 */
practiceUpdateRouter.patch(
  "/draft",
  validate(z.object({ body: z.object({ narrative: narrativeSchema }) })),
  async (req, res) => {
    const existing = await prisma.practiceUpdateRecord.findFirst({ where: { status: "DRAFT" }, select: { id: true } });
    if (!existing) throw new AppError(409, "There's no draft to save — generate one first.");
    await prisma.practiceUpdateRecord.update({
      where: { id: existing.id },
      data: { narrative: req.body.narrative as object }
    });
    res.json({ saved: true });
  }
);

/** DELETE /practice-update/draft — the explicit "discard" the page offers, so a draft is only ever
 *  thrown away on purpose. Idempotent: discarding nothing is a success, not a 404. */
practiceUpdateRouter.delete("/draft", async (req, res) => {
  const removed = await prisma.practiceUpdateRecord.deleteMany({ where: { status: "DRAFT" } });
  if (removed.count > 0) await audit(req.user!.id, "practice_update.draft_discarded", "PracticeUpdateRecord", "draft", {});
  res.json({ discarded: removed.count });
});

/**
 * GET /practice-update/history — the updates that were actually sent.
 *
 * Deliberately does NOT return the stored HTML in the list: a body is tens of kilobytes and there
 * is no reason to ship twenty of them to render a table of dates. The detail route below serves one.
 */
practiceUpdateRouter.get("/history", async (req, res) => {
  const take = Math.min(Number(req.query.limit) || 25, 100);
  const rows = await prisma.practiceUpdateRecord.findMany({
    where: { status: "SENT" },
    orderBy: { sentAt: "desc" },
    take,
    select: {
      id: true,
      periodLabel: true,
      periodFrom: true,
      periodTo: true,
      sentAt: true,
      sentSubject: true,
      sentTo: true,
      sentBy: { select: { name: true } },
      data: true
    }
  });

  res.json({
    records: rows.map((row) => {
      const data = row.data as unknown as PracticeUpdateData;
      return {
        id: row.id,
        periodLabel: row.periodLabel,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        sentAt: row.sentAt,
        subject: row.sentSubject,
        recipientCount: Array.isArray(row.sentTo) ? row.sentTo.length : 0,
        sentByName: row.sentBy?.name ?? null,
        // Enough for the row to be worth reading without opening it.
        metrics: data?.metrics ?? null,
        initiativeCount: data?.initiatives?.length ?? 0
      };
    })
  });
});

/**
 * GET /practice-update/history/:id — one sent update, exactly as it went out.
 *
 * Serves the STORED html rather than re-rendering from the figures. An archive whose contents
 * change when the email template is improved is not an archive; this is a record of what a named
 * list of people actually received on a given day.
 */
practiceUpdateRouter.get("/history/:id", async (req, res) => {
  const row = await prisma.practiceUpdateRecord.findFirst({
    where: { id: String(req.params.id), status: "SENT" },
    include: { sentBy: { select: { name: true } }, generatedBy: { select: { name: true } } }
  });
  if (!row) throw new AppError(404, "That update isn't in the archive.");
  res.json({
    id: row.id,
    periodLabel: row.periodLabel,
    sentAt: row.sentAt,
    subject: row.sentSubject,
    html: row.sentHtml,
    recipients: Array.isArray(row.sentTo) ? row.sentTo : [],
    sentByName: row.sentBy?.name ?? null,
    generatedByName: row.generatedBy?.name ?? null,
    data: row.data,
    narrative: row.narrative
  });
});


/**
 * POST /practice-update/send — mail the REVIEWED update to the configured list.
 *
 * The figures are rebuilt server-side from the period rather than trusted from the request: the
 * client may edit the prose, and only the prose. A caller who could post arbitrary numbers into a
 * document that looks like it came from this workspace's records would be able to make it say
 * anything.
 */
practiceUpdateRouter.post(
  "/send",
  validate(z.object({ body: z.object({ from: z.string().optional(), to: z.string().optional(), narrative: narrativeSchema.optional() }) })),
  async (req, res) => {
    const settings = await getGlobalNotificationSettings();
    const recipients = storedRecipients(settings.practiceUpdateRecipients);
    if (recipients.length === 0) {
      throw new AppError(422, "Add at least one recipient before sending. Only a super admin can change this list.");
    }
    if (!settings.emailPracticeUpdate) {
      throw new AppError(
        422,
        "The weekly practice update email is switched off for this workspace. Turn it on under Workspace Settings → Notifications → Digests."
      );
    }

    const period = resolvePeriod(req.body ?? {});
    const data = await buildPracticeUpdateData(period.from, period.to, period.label);
    const email = buildPracticeUpdateEmail(data, (req.body.narrative as PracticeUpdateNarrative | undefined) ?? null);

    const rendered = await renderEmailTemplate(
      "digest.practice_update",
      { periodLabel: data.period.label, headline: email.headline, sectionsHtml: email.sectionsHtml },
      {
        subject: email.subject,
        html: templates.practiceUpdate({ periodLabel: data.period.label, headline: email.headline, sectionsHtml: email.sectionsHtml })
      }
    );

    // One send with everyone on it, not one per address: this is a circulated update, and the
    // recipients are a named distribution list who are meant to see that they share it.
    const result = await sendMail({
      to: recipients.join(","),
      subject: rendered.subject,
      html: rendered.html,
      template: "digest.practice_update",
      preferenceKey: "emailPracticeUpdate",
      metadata: { periodFrom: data.period.from, periodTo: data.period.to, recipients: recipients.length }
    });

    /*
     * THE DRAFT BECOMES THE ARCHIVE ENTRY. Same row, `status` flipped — a sent update is a draft
     * that was mailed, and copying it into a second table would mean keeping two shapes in step.
     *
     * The rendered subject and body are stored AS SENT rather than re-derived later: an archive
     * whose contents change when the email template is improved is not an archive. Same for the
     * recipient list, which is captured as it was rather than read from settings at display time —
     * editing the distribution list must not rewrite who a past update says it reached.
     *
     * Only on a real send. A FAILED result throws below, and marking a document "sent" that nobody
     * received would be the one lie this archive must never tell.
     */
    if (result.status !== "FAILED") {
      const draft = await prisma.practiceUpdateRecord.findFirst({ where: { status: "DRAFT" }, select: { id: true } });
      const archived = {
        status: "SENT" as const,
        periodFrom: period.from,
        periodTo: period.to,
        periodLabel: data.period.label,
        data: data as unknown as object,
        narrative: (req.body.narrative ?? undefined) as unknown as object | undefined,
        sentSubject: rendered.subject,
        sentHtml: rendered.html,
        sentAt: new Date(),
        sentTo: recipients as unknown as object,
        sentById: req.user!.id
      };
      if (draft) await prisma.practiceUpdateRecord.update({ where: { id: draft.id }, data: archived });
      // No draft to promote — somebody sent straight from a scheduled run or a second tab. The
      // archive should still record it, or the history would have a hole in it.
      else await prisma.practiceUpdateRecord.create({ data: { ...archived, generatedById: req.user!.id } });
    }

    await audit(req.user!.id, "practice_update.sent", "GlobalNotificationSettings", "global", {
      period: data.period.label,
      recipients: recipients.length,
      status: result.status
    });

    if (!result.ok && result.status === "FAILED") {
      throw new AppError(502, result.errorMessage ?? "The update could not be sent. Check Workspace Settings → Mail server.");
    }
    res.json({ status: result.status, recipients: recipients.length, subject: rendered.subject, emailLogId: result.emailLogId });
  }
);
