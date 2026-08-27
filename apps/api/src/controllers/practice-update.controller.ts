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
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { generatePracticeUpdate, type PracticeUpdateNarrative } from "../services/ai.service.js";
import { getGlobalNotificationSettings } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { renderEmailTemplate } from "../services/template-store.service.js";
import { sendMail } from "../services/mail.service.js";
import { buildPracticeUpdateData, lastCompleteWeek } from "../services/practice-update.service.js";
import { buildPracticeUpdateEmail, narrativeInputs } from "../services/practice-update-mail.service.js";

export const practiceUpdateRouter = Router();
practiceUpdateRouter.use(requireAuth, requireSuperAdmin);

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
  res.json({ data, narrative, aiFailed, preview: email });
});

const narrativeSchema = z.object({
  executiveSummary: z.string().max(8_000).default(""),
  risks: z.array(z.string().max(1_000)).max(50).default([]),
  nextWeekPriorities: z.array(z.string().max(1_000)).max(50).default([]),
  decisionsRequired: z.array(z.string().max(1_000)).max(50).default([]),
  nextSteps: z.array(z.object({ id: z.string(), text: z.string().max(500) })).max(200).default([])
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
