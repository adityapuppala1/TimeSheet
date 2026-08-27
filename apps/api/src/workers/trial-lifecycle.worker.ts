/**
 * WHAT: the clock behind a free trial. Warns before it ends, moves the workspace to GRACE when it
 * does, and suspends it when the grace window runs out.
 *
 * WHY IT IS NOT WHAT ENFORCES THE TRIAL. Entitlements lapse the moment `trialEndsAt` passes,
 * because `plan-limits.service.ts#effectiveTier` compares against the clock on every read. This
 * worker changes STATUS and sends MAIL — the two things that need a scheduled moment rather than a
 * comparison. Getting that backwards would mean a trial silently kept Team features until whenever
 * the next tick happened to run.
 *
 * IDEMPOTENCE IS THE WHOLE DESIGN. It runs daily over every workspace on the deployment, so the
 * failure mode to design against is not "it missed a day" — it is "it sent the 7-day warning seven
 * times". Every notice records that it went out in `Organization.trialNoticesSent`, and every
 * transition is guarded on the status it is moving FROM. A tick that runs twice does nothing the
 * second time.
 *
 * IT RUNS AGAINST THE CONTROL PLANE, NOT `runForEveryOrg`. The other workers in this directory
 * iterate tenants to read tenant data; this one reads and writes `Organization` rows, which live in
 * the control plane and are the same rows regardless of which tenant context is active. It enters a
 * tenant context only to send mail, because mail settings are per workspace.
 */
import cron from "node-cron";
import { controlPrisma } from "../config/control-prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { prisma } from "../config/prisma.js";
import { templates } from "../services/mail-templates.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { forgetOrgStatus } from "../services/org-status.service.js";
import { env } from "../config/env.js";

let started = false;
let running = false;

/**
 * Warnings go out this many days before the trial ends. Three is a deliberate ceiling: a fourth
 * would be noise and the third is already the one people act on.
 *
 * ASCENDING, AND THE ORDER IS LOAD-BEARING. The lookup below is "the smallest threshold this trial
 * is now at or under", so the array has to be smallest-first. Written descending — which reads
 * better and was the first version — `find(d => left <= d)` matches 7 for every value of `left`,
 * so a trial with 3 days remaining records the SEVEN-day notice as sent, and the 3-day and 1-day
 * warnings are then skipped forever as already-sent. The customer gets exactly one email, a week
 * out, and silence through the day it expires. Caught by a test, not by reading it.
 */
const NOTICE_DAYS = [1, 3, 7] as const;

/**
 * How long a lapsed workspace stays reachable before it is suspended outright.
 *
 * Fourteen days because the decision it is waiting on usually involves somebody who was not in the
 * room — a manager, a finance approver, a procurement cycle. A shorter window mostly punishes
 * companies with a purchasing process, which are the ones worth keeping.
 */
const GRACE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from now until `date`, rounded UP: a trial ending in six hours is "1 day left", not
 *  "0", because that is what the recipient would call it. */
function daysUntil(date: Date, now: number): number {
  return Math.ceil((date.getTime() - now) / DAY_MS);
}

function noticesAlreadySent(raw: unknown): number[] {
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
}

/** Who hears about billing: the workspace's own super admins. Read inside the tenant context,
 *  because that is where users live. */
async function superAdminEmails(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, isAgent: false, role: { name: "SUPER_ADMIN" } },
    select: { email: true }
  });
  return admins.map((a) => a.email).filter(Boolean);
}

async function mailSuperAdmins(
  slug: string,
  templateKey: string,
  subject: string,
  html: string
): Promise<void> {
  try {
    await withOrgTenant(slug, async () => {
      const to = await superAdminEmails();
      if (to.length === 0) return;
      await dispatchTransactional({
        to: to.join(","),
        templateKey,
        vars: { workspace: slug, billingUrl: `${env.APP_BASE_URL.replace(/\/$/, "")}/app/settings?tab=billing` },
        fallback: { subject, html }
      });
    });
  } catch (error) {
    // One workspace's mail failing must not stop the tick for every other workspace on the
    // deployment — the status transitions matter more than the notification, and they have already
    // happened or are about to for the orgs after this one.
    console.warn(`[trial-lifecycle] could not mail ${slug}: ${(error as Error).message}`);
  }
}

/** Runs one pass. Exported so a test can drive it without waiting for a cron tick. */
export async function runTrialLifecycleTick(now = Date.now()): Promise<{ warned: number; lapsed: number; suspended: number }> {
  let warned = 0;
  let lapsed = 0;
  let suspended = 0;

  // ── Warnings, for trials still running ──────────────────────────────────────────────────────
  const upcoming = await controlPrisma.organization.findMany({
    where: { status: "ACTIVE", trialEndsAt: { gt: new Date(now) } },
    select: { id: true, slug: true, name: true, trialEndsAt: true, trialNoticesSent: true }
  });

  for (const org of upcoming) {
    if (!org.trialEndsAt) continue;
    const left = daysUntil(org.trialEndsAt, now);
    const due = NOTICE_DAYS.find((d) => left <= d);
    if (due === undefined) continue;

    const sent = noticesAlreadySent(org.trialNoticesSent);
    if (sent.includes(due)) continue;

    await mailSuperAdmins(
      org.slug,
      "billing.trial_ending",
      `Your TimeSphere trial ends in ${left} ${left === 1 ? "day" : "days"}`,
      templates.trialEnding(org.name, left, `${env.APP_BASE_URL.replace(/\/$/, "")}/app/settings?tab=billing`)
    );
    // Recorded even when the mail failed. A workspace whose SMTP is broken would otherwise be
    // re-notified on every tick forever, which is the loudest possible way to report a mail problem.
    await controlPrisma.organization.update({ where: { id: org.id }, data: { trialNoticesSent: [...sent, due] } });
    warned += 1;
  }

  // ── Expiry: ACTIVE → GRACE ──────────────────────────────────────────────────────────────────
  const expired = await controlPrisma.organization.findMany({
    where: { status: "ACTIVE", trialEndsAt: { lte: new Date(now) } },
    select: { id: true, slug: true, name: true }
  });

  for (const org of expired) {
    await controlPrisma.organization.update({
      where: { id: org.id },
      data: { status: "GRACE", graceStartedAt: new Date(now), suspendedReason: "Free trial ended without a subscription." }
    });
    forgetOrgStatus(org.id);
    await mailSuperAdmins(
      org.slug,
      "billing.trial_ended",
      "Your TimeSphere trial has ended",
      templates.trialEnded(org.name, GRACE_DAYS, `${env.APP_BASE_URL.replace(/\/$/, "")}/app/settings?tab=billing`)
    );
    lapsed += 1;
  }

  // ── Suspension: GRACE → SUSPENDED, once the window is up ────────────────────────────────────
  const graceDeadline = new Date(now - GRACE_DAYS * DAY_MS);
  const overdue = await controlPrisma.organization.findMany({
    where: { status: "GRACE", graceStartedAt: { lte: graceDeadline } },
    select: { id: true, slug: true }
  });

  for (const org of overdue) {
    await controlPrisma.organization.update({
      where: { id: org.id },
      data: { status: "SUSPENDED", suspendedAt: new Date(now) }
    });
    forgetOrgStatus(org.id);
    suspended += 1;
  }

  return { warned, lapsed, suspended };
}

export function startTrialLifecycleWorker(): void {
  if (started) return;
  started = true;

  // 09:00 daily. Business hours on purpose: "your trial ends tomorrow" arriving at 3am is read at
  // 9am anyway, and arriving at 9am gives the recipient the whole working day to act on it.
  cron.schedule("0 9 * * *", async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTrialLifecycleTick();
      if (result.warned || result.lapsed || result.suspended) {
        console.log(`[trial-lifecycle] ${result.warned} warned, ${result.lapsed} lapsed, ${result.suspended} suspended`);
      }
    } catch (error) {
      console.warn(`[trial-lifecycle] tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
