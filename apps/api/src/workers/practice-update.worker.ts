/**
 * WHAT: sends the Weekly AI/ML Practice Update every Monday morning, when a super admin has asked
 * for that cadence.
 *
 * WHY IT IS OFF BY DEFAULT AND THE BUTTON IS THE PRIMARY PATH: this update goes to a leadership
 * distribution list, and its narrative sections are model-written. The on-demand flow puts a human
 * between the draft and the send. A workspace that switches the cadence on is trading that review
 * for reliability, which is a decision only a super admin can make and only deliberately — which
 * is why `practiceUpdateWeekly` defaults to false.
 *
 * THREE GATES, all of which must be open, and every one of them exists for a reason:
 *   1. `practiceUpdateWeekly`   — somebody asked for a cadence at all.
 *   2. `emailPracticeUpdate`    — the workspace's email category switch, like every other digest.
 *   3. a non-empty recipient list — there is nobody to send it to otherwise, and a digest that
 *      quietly sends to zero people looks exactly like one that worked.
 *
 * The AI gate is deliberately NOT in that list. The figures are counted from the database and go
 * out whether or not a model answers — the correction `weekly-digest.worker.ts` records in its own
 * header, where gating the whole digest on the model meant an unconfigured one sent nothing.
 */
import cron from "node-cron";

import { prisma } from "../config/prisma.js";
import { generatePracticeUpdate, type PracticeUpdateNarrative } from "../services/ai.service.js";
import { templates } from "../services/mail-templates.js";
import { renderEmailTemplate } from "../services/template-store.service.js";
import { sendMail } from "../services/mail.service.js";
import { buildPracticeUpdateData, lastCompleteWeek } from "../services/practice-update.service.js";
import { buildPracticeUpdateEmail, narrativeInputs } from "../services/practice-update-mail.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

function recipientsFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && EMAIL_RE.test(v.trim())).map((v) => v.trim());
}

export interface PracticeUpdateRunResult {
  sent: boolean;
  reason?: "cadence_off" | "email_off" | "no_recipients" | "already_sent" | "nothing_happened";
  recipients?: number;
}

/**
 * Idempotent by re-reading what was already sent, not by keeping state — the same idiom every
 * digest in this app uses, so a restart or a double-fire cannot mail leadership twice.
 */
async function alreadySentFor(periodTo: string): Promise<boolean> {
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const rows = await prisma.emailLog.findMany({
    where: { template: "digest.practice_update", createdAt: { gte: since }, status: { in: ["SENT", "QUEUED"] } },
    select: { metadata: true }
  });
  return rows.some((row) => {
    const meta = row.metadata as { periodTo?: unknown } | null;
    return meta && typeof meta.periodTo === "string" && meta.periodTo === periodTo;
  });
}

export async function runPracticeUpdate(now: Date = new Date()): Promise<PracticeUpdateRunResult> {
  const settings = await prisma.globalNotificationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" }
  });

  if (!settings.practiceUpdateWeekly) return { sent: false, reason: "cadence_off" };
  if (!settings.emailPracticeUpdate) return { sent: false, reason: "email_off" };

  const recipients = recipientsFrom(settings.practiceUpdateRecipients);
  if (recipients.length === 0) return { sent: false, reason: "no_recipients" };

  const period = lastCompleteWeek(now);
  const data = await buildPracticeUpdateData(period.from, period.to, period.label);

  if (await alreadySentFor(data.period.to)) return { sent: false, reason: "already_sent" };
  // A week in which nothing at all was recorded is not worth an executive's attention, and an
  // update full of zeroes trains people to stop opening it.
  if (data.isEmpty) return { sent: false, reason: "nothing_happened" };

  let narrative: PracticeUpdateNarrative | null = null;
  try {
    narrative = await generatePracticeUpdate({ ...narrativeInputs(data), periodLabel: data.period.label });
  } catch (error) {
    console.warn(`[practice-update] narrative unavailable, sending the figures alone: ${(error as Error).message}`);
  }

  const email = buildPracticeUpdateEmail(data, narrative);
  const vars = { periodLabel: data.period.label, headline: email.headline, sectionsHtml: email.sectionsHtml };
  const rendered = await renderEmailTemplate("digest.practice_update", vars, {
    subject: email.subject,
    html: templates.practiceUpdate(vars)
  });

  await sendMail({
    to: recipients.join(","),
    subject: rendered.subject,
    html: rendered.html,
    template: "digest.practice_update",
    preferenceKey: "emailPracticeUpdate",
    metadata: { periodFrom: data.period.from, periodTo: data.period.to, recipients: recipients.length, scheduled: true }
  });

  return { sent: true, recipients: recipients.length };
}

export function startPracticeUpdateWorker() {
  if (started) return;
  started = true;
  // 07:30 Monday — ahead of the 08:00/08:30/08:45/10:00/10:30 slots the other digests already
  // hold, and early enough to be in a leadership inbox before the week's first meeting.
  cron.schedule("30 7 * * 1", () => {
    if (running) return;
    running = true;
    runForEveryOrg("practice-update", async () => {
      const result = await runPracticeUpdate();
      if (result.sent) console.log(`[practice-update] sent to ${result.recipients} recipient(s).`);
    })
      .catch((error) => console.error(`[practice-update] run failed: ${(error as Error).message}`))
      .finally(() => {
        running = false;
      });
  });
}
