/**
 * WHAT: what the operators hear about self-serve signup (signup Phase 1, decision 1) — one summary a
 * day, and an immediate email when provisioning is failing.
 *
 * THE SUMMARY. Sent by signup-digest.worker.ts each morning when the notify mode is DAILY (the
 * default; EACH mails per signup from platform-signup.service.ts instead, OFF mails nothing). It covers
 * the last 24 hours from the funnel (SignupAttempt) and the Organization rows themselves, and it is
 * sent only on a day with news: a workspace created, a provisioning failure, or a join request.
 * Refusals are counted but are not news on their own — a day of people trying Gmail addresses would
 * otherwise send a daily email about nothing.
 *
 * ONCE, HOWEVER MANY REPLICAS. Every replica runs the same cron at the same minute. The day is
 * claimed by inserting a PlatformJobClaim row whose primary key is (job, day): exactly one insert
 * wins, the others hit the unique key and stand down. No lock to hold, no lock to leak.
 *
 * WHY ALSO AN IMMEDIATE EMAIL. A daily summary is right for news and wrong for an outage: if
 * provisioning breaks at 09:00, every customer who signs up today is turned away, and the summary
 * would say so tomorrow. So the SECOND failure inside an hour mails the alert recipients at once —
 * once per clock hour, through the same claim — in every mode except OFF. Fleet alerts cannot carry
 * it: they are per workspace, and a failed signup has no workspace.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { companyDomainOf } from "../utils/company-domain.js";
import { platformDayKey, platformHourKey } from "../utils/platform-time.js";
import { getAlertSettings, resolveAlertRecipients } from "./platform-alerts.service.js";
import { platformAudit } from "./platform-audit.service.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";
import { getSignupSettings } from "./platform-signup.service.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Failures inside the last hour that make it an outage rather than a bad day for one customer. */
const FAILING_THRESHOLD = 2;
const NONE = "None.";

export interface SignupDigestCounts {
  created: number;
  failed: number;
  joinRequested: number;
  refused: number;
}

export interface SignupDigestResult {
  sent: boolean;
  reason: string;
  recipients: number;
  counts: SignupDigestCounts;
}

/**
 * Claims `periodKey` of `job` for this process. True for exactly one caller per (job, period) across
 * every replica; false for the rest. Any other database error propagates — "I could not tell" must
 * not read as "somebody else has it".
 */
export async function claimJobPeriod(job: string, periodKey: string): Promise<boolean> {
  try {
    await controlPrisma.platformJobClaim.create({ data: { job, periodKey } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
}

/** A day as the platform's zone names it (Asia/Kolkata by default) — never UTC's; see platform-time.ts. */
const day = (value: Date | null | undefined) => (value ? platformDayKey(value) : "—");
const consoleUrl = () => `${env.APP_BASE_URL.replace(/\/$/, "")}/platform-admin/signups`;

async function gatherDay(now: Date) {
  const window = { gte: new Date(now.getTime() - DAY_MS), lt: now };
  const [created, attempts] = await Promise.all([
    controlPrisma.organization.findMany({
      where: { createdVia: "SELF_SERVE", createdAt: window },
      select: { id: true, name: true, slug: true, ownerEmail: true, trialEndsAt: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    }),
    controlPrisma.signupAttempt.findMany({
      where: { stage: { in: ["FAILED", "JOIN_REQUESTED", "REFUSED"] }, createdAt: window },
      select: { stage: true, domain: true, organizationId: true, detail: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    })
  ]);
  const failed = attempts.filter((a) => a.stage === "FAILED");
  const joins = attempts.filter((a) => a.stage === "JOIN_REQUESTED");
  const counts: SignupDigestCounts = {
    created: created.length,
    failed: failed.length,
    joinRequested: joins.length,
    refused: attempts.filter((a) => a.stage === "REFUSED").length
  };
  return { created, failed, joins, counts };
}

/** "Northwind: 3" per workspace, most requested first — which company's people are knocking. */
async function joinLines(joins: Array<{ organizationId: string | null }>): Promise<string> {
  const perOrg = new Map<string, number>();
  for (const join of joins) if (join.organizationId) perOrg.set(join.organizationId, (perOrg.get(join.organizationId) ?? 0) + 1);
  if (perOrg.size === 0) return NONE;
  const names = new Map(
    (await controlPrisma.organization.findMany({ where: { id: { in: [...perOrg.keys()] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name])
  );
  return [...perOrg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${names.get(id) ?? id}: ${count} request${count === 1 ? "" : "s"}`)
    .join("\n");
}

const failureLine = (f: { domain: string | null; detail: string | null }) => `${f.domain ?? "unknown domain"} — ${f.detail ?? "no detail recorded"}`;

export async function runSignupDigest(now = new Date(), options: { dryRun?: boolean } = {}): Promise<SignupDigestResult> {
  const { created, failed, joins, counts } = await gatherDay(now);
  const quiet = (reason: string, recipients = 0): SignupDigestResult => ({ sent: false, reason, recipients, counts });

  const { notifyMode } = await getSignupSettings();
  if (notifyMode !== "DAILY") return quiet(`notify mode is ${notifyMode}, not DAILY`);
  if (counts.created + counts.failed + counts.joinRequested === 0) return quiet("nothing created, failed or requested in the last 24 hours");

  const recipients = await resolveAlertRecipients(await getAlertSettings());
  if (recipients.length === 0) return quiet("no alert recipients are configured");
  if (options.dryRun) return quiet(`dry run — would send to ${recipients.length} recipient(s)`, recipients.length);
  if (!(await claimJobPeriod("signup-digest", day(now)))) return quiet("already sent for this day (another replica, or an earlier run)", recipients.length);

  const vars = {
    day: day(now),
    createdCount: String(counts.created),
    failedCount: String(counts.failed),
    joinCount: String(counts.joinRequested),
    refusedCount: String(counts.refused),
    createdList: created.length
      ? created
          .map((o) => `${o.name} (${o.slug}) — ${(o.ownerEmail && companyDomainOf(o.ownerEmail)) || "no owner address"} — trial ends ${day(o.trialEndsAt)}`)
          .join("\n")
      : NONE,
    failedList: failed.length ? failed.map(failureLine).join("\n") : NONE,
    joinList: await joinLines(joins),
    consoleUrl: consoleUrl()
  };
  for (const to of recipients) {
    await sendPlatformTemplate("platform.signup_digest", { to, vars, metadata: { counts } }).catch((error: Error) =>
      console.warn(`[signup-digest] could not send to ${to}:`, error.message)
    );
  }
  await platformAudit("SYSTEM", "scheduler", "signup.digest_sent", "PlatformSignupSettings", "global", { ...counts });
  return { sent: true, reason: `sent to ${recipients.length} recipient(s)`, recipients: recipients.length, counts };
}

/**
 * Called from the signup failure path right after it records FAILED. Mails the alert recipients when
 * this is at least the second failure in the last hour — once per clock hour. Never throws: the
 * caller is in the middle of telling a person their signup did not work.
 */
export async function alertIfProvisioningFailing(now = new Date()): Promise<boolean> {
  try {
    const { notifyMode } = await getSignupSettings();
    if (notifyMode === "OFF") return false;
    const recent = await controlPrisma.signupAttempt.findMany({
      where: { stage: "FAILED", createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
      select: { domain: true, detail: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    });
    if (recent.length < FAILING_THRESHOLD) return false;
    // Recipients BEFORE the claim: with nobody configured, claiming would spend the hour on an email
    // that never went, and the alert would stay silent after someone is added.
    const recipients = await resolveAlertRecipients(await getAlertSettings());
    if (recipients.length === 0) return false;
    if (!(await claimJobPeriod("signup-failing", platformHourKey(now)))) return false;

    const vars = { failedCount: String(recent.length), recentFailures: recent.slice(0, 10).map(failureLine).join("\n"), consoleUrl: consoleUrl() };
    for (const to of recipients) {
      await sendPlatformTemplate("platform.signup_failing", { to, vars }).catch((error: Error) =>
        console.warn(`[signup-digest] could not send the failing alert to ${to}:`, error.message)
      );
    }
    return true;
  } catch (error) {
    console.warn("[signup-digest] provisioning-failing check skipped:", (error as Error).message);
    return false;
  }
}
