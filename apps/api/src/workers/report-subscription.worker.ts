/**
 * Scheduled report delivery — ticks hourly and sends the subscriptions due this hour.
 *
 * WHY HOURLY RATHER THAN ONE CRON PER SUBSCRIPTION: subscriptions are user data, created and
 * deleted at runtime. Registering a cron entry per row would mean the scheduler's state and the
 * database drifting apart on every edit, and a missed reschedule is silent. One tick that asks
 * "what is due now?" has no state to drift.
 *
 * WHY THE WIDGETS ARE RESOLVED AS THE SUBSCRIPTION'S OWNER: recipients are email addresses, which
 * are not identities this app can scope data by — the whole point is reaching a stakeholder with
 * no account. So the report is built with the permissions of the person who set the delivery up
 * and is accountable for it, which is also what makes "who could see this?" answerable afterwards.
 *
 * WHY `lastSentAt` GUARDS THE SEND: a container restart inside the send hour would otherwise
 * re-send to every recipient. The guard is "not already sent in this cadence period", not "not
 * sent in the last hour", so a restart at 07:59 followed by the 08:00 tick does not double-send.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { resolveDashboard } from "../services/dashboard.service.js";
import { sendMail } from "../services/mail.service.js";
import { getPlanningSettings } from "../services/planning.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";
import { tenantBaseUrl } from "../services/workspace-directory.service.js";
import { runOncePerTick } from "../services/job-claim.service.js";
import { permissions } from "@timesheet/shared";
import type { RequestUser } from "../middleware/auth.js";
import { emailBlocks } from "../services/mail-templates.js";
import { loadRequestUser } from "../services/principal.service.js";
import { dashboardProjectIds } from "../services/dashboard-scope.service.js";

const { escape } = emailBlocks;

let started = false;
let running = false;

/** True when this subscription's slot is the hour we are in now. */
function isDue(sub: { cadence: string; dayOfWeek: number | null; dayOfMonth: number | null; hourUtc: number }, now: Date): boolean {
  if (now.getUTCHours() !== sub.hourUtc) return false;
  if (sub.cadence === "DAILY") return true;
  if (sub.cadence === "WEEKLY") return now.getUTCDay() === (sub.dayOfWeek ?? 1);
  if (sub.cadence === "MONTHLY") return now.getUTCDate() === (sub.dayOfMonth ?? 1);
  return false;
}

/** Has it already gone out for this period? Cadence-aware so a restart cannot double-send. */
function alreadySent(sub: { cadence: string; lastSentAt: Date | null }, now: Date): boolean {
  if (!sub.lastSentAt) return false;
  const elapsedMs = now.getTime() - sub.lastSentAt.getTime();
  const window = sub.cadence === "DAILY" ? 20 : sub.cadence === "WEEKLY" ? 6 * 24 : 27 * 24;
  return elapsedMs < window * 3_600_000;
}

const CELL = "padding:8px 12px;border-bottom:1px solid #e2e8f0";

/** One widget's row. `value` is already-escaped HTML; the title is escaped here. */
const row = (title: string, value: string, labelStyle = "", valueStyle = "") =>
  `<tr><td style="${CELL}${labelStyle}"><strong>${escape(title)}</strong></td>
                <td style="${CELL}${valueStyle}">${value}</td></tr>`;

/** A STAT/SERIES/TABLE widget's value cell, escaped. */
function widgetValue(w: Awaited<ReturnType<typeof resolveDashboard>>[number]): string | null {
  if (w.shape === "STAT") {
    const hint = w.hint ? ` <span style="color:#64748b">(${escape(w.hint)})</span>` : "";
    return `${escape(String(w.value ?? "—"))}${escape(w.unit ?? "")}${hint}`;
  }
  if (w.points) {
    const summary = w.points.map((p) => escape(`${p.label}: ${p.value}${p.secondary === undefined ? "" : `/${p.secondary}`}`)).join(" · ");
    return summary || "—";
  }
  if (w.rows) {
    const list = w.rows
      .slice(0, 5)
      .map((r) => escape(Object.values(r).filter(Boolean).join(" — ")))
      .join("<br>");
    return list || "—";
  }
  return null;
}

/**
 * Plain, table-based HTML — the only thing every email client renders the same way.
 *
 * EVERY interpolated value is escaped. Widget titles, the dashboard's name and table rows are user
 * data — ticket titles in particular can arrive verbatim from an inbound email's subject line — and
 * they went into the mail raw while the weekly digest escaped the same kind of data. The only markup
 * here is the template's own.
 */
function renderHtml(dashboardName: string, widgets: Awaited<ReturnType<typeof resolveDashboard>>, appUrl: string): string {
  const cells = widgets
    .map((w) => {
      if (w.unavailable) return row(w.title, escape(w.unavailable), "", ";color:#64748b");
      const value = widgetValue(w);
      if (value === null) return "";
      return row(w.title, value, w.rows && w.shape !== "STAT" ? ";vertical-align:top" : "");
    })
    .join("");

  return `<div style="font-family:Inter,Segoe UI,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">${escape(dashboardName)}</h2>
    <p style="margin:0 0 16px;color:#64748b;font-size:13px">Scheduled report from TimeSphere.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${cells}</table>
    <p style="margin-top:20px;font-size:12px;color:#64748b">
      <a href="${escape(appUrl)}/app/dashboards" style="color:#0e7490">Open the live dashboard</a>
    </p>
  </div>`;
}

/**
 * Why this owner can no longer send this report, or null when they can. Re-checked EVERY run: the
 * report is built with the owner's authority, so losing that authority has to stop it. The worker
 * used to check only that the owner was ACTIVE — a manager moved to EMPLOYEE kept emailing the
 * dashboard every Monday, while their own Deliveries tab could neither list nor delete it.
 */
function ownerRefusal(owner: RequestUser | null): string | null {
  if (!owner) return "The person who set this up no longer has an active account.";
  if (!owner.permissions.includes(permissions.REPORTS_VIEW)) {
    return "Paused: the person who set this up no longer has permission to view reports (reports:view).";
  }
  return null;
}

/**
 * The recipients to actually mail. An address belonging to a workspace account that is no longer
 * ACTIVE is dropped — a colleague who left kept receiving the report, because recipients are bare
 * addresses. Addresses that match no account at all (the external stakeholders this feature is for)
 * are kept. Compared case-insensitively, as MySQL compares the `email` column.
 */
async function deliverableRecipients(addresses: string[]): Promise<{ kept: string[]; dropped: string[] }> {
  if (addresses.length === 0) return { kept: [], dropped: [] };
  const departed = await prisma.user.findMany({
    where: { email: { in: addresses }, OR: [{ status: { not: "ACTIVE" } }, { deletedAt: { not: null } }] },
    select: { email: true }
  });
  const blocked = new Set(departed.map((u) => u.email.toLowerCase()));
  return {
    kept: addresses.filter((a) => !blocked.has(a.toLowerCase())),
    dropped: addresses.filter((a) => blocked.has(a.toLowerCase()))
  };
}

/** One org's tick. Exported (with `now`) so the delivery rules can be driven directly in tests. */
export async function tickForOneOrg(now: Date = new Date()) {
  const planning = await getPlanningSettings();
  if (!planning.enablePlanning) return;

  const subscriptions = await prisma.reportSubscription.findMany({
    where: { isActive: true, hourUtc: now.getUTCHours() },
    include: { dashboard: true }
  });

  for (const sub of subscriptions) {
    if (!isDue(sub, now) || alreadySent(sub, now)) continue;
    // The owner exactly as `requireAuth` would build them today — active role and current
    // permissions — so the report is never built with authority they no longer hold, and a departed
    // owner stops it rather than letting it fall back to something broader.
    const owner = sub.createdById ? await loadRequestUser(sub.createdById) : null;
    const refusal = ownerRefusal(owner);
    if (refusal || !owner) {
      await prisma.reportSubscription.update({ where: { id: sub.id }, data: { isActive: false, lastSendError: refusal } });
      continue;
    }
    if (!sub.dashboard) continue;

    try {
      await deliver({ ...sub, dashboard: sub.dashboard }, owner, now);
    } catch (error) {
      // Recorded on the row rather than only logged, so the person who set it up can see it
      // failed without reading server logs they have no access to.
      await prisma.reportSubscription.update({
        where: { id: sub.id },
        data: { lastSendError: (error as Error).message.slice(0, 500) }
      });
      console.error(`[reports] "${sub.name}" failed:`, (error as Error).message);
    }
  }
}

async function deliver(
  sub: { id: string; name: string; recipients: unknown; dashboard: { name: string; widgets: unknown } },
  owner: RequestUser,
  now: Date
) {
  // Owner's scope, resolved fresh each send, by the SAME function the live dashboard uses — so a
  // team lead's emailed copy covers their reports' projects exactly as the screen does.
  const projectIds = await dashboardProjectIds(owner);

  const widgets = await resolveDashboard({
    widgets: (sub.dashboard.widgets as unknown as never[]) ?? [],
    projectIds,
    viewerId: owner.id
  });

  const { kept: recipients, dropped } = await deliverableRecipients((sub.recipients as unknown as string[]) ?? []);
  // `tenantBaseUrl()`, never `process.env` and no longer the deployment-wide address either.
  // Two separate traps live on this one line. Reading the RAW environment put the literal string
  // "auto" into every emailed dashboard link, because the configured value is allowed to be
  // "auto" or to carry a "{lan-ip}" token that `config/env.ts` resolves at boot. And reading the
  // deployment-wide value sent every workspace's scheduled report to the DEFAULT workspace's
  // address — this tick runs inside `runForEveryOrg`, so the active tenant is the right answer
  // and is already in scope. See services/workspace-directory.service.ts#tenantBaseUrl.
  const html = renderHtml(sub.dashboard.name, widgets, tenantBaseUrl());

  for (const to of recipients) {
    // `template` names the send in EmailLog, so a scheduled report is distinguishable from
    // a transactional one when someone asks why an address received mail.
    await sendMail({ to, subject: `${sub.name} — ${sub.dashboard.name}`, html, template: "report.scheduled" });
  }

  // A skipped address is said on the row, so the owner can tidy the list rather than wonder why
  // somebody stopped getting it.
  const skippedNote = dropped.length > 0 ? `Not sent to ${dropped.join(", ")}: no longer an active account in this workspace.` : null;
  await prisma.reportSubscription.update({
    where: { id: sub.id },
    data: recipients.length > 0 ? { lastSentAt: now, lastSendError: skippedNote } : { lastSendError: skippedNote }
  });
  console.log(`[reports] sent "${sub.name}" to ${recipients.length} recipient(s)`);
}

export function startReportSubscriptionWorker() {
  if (started) return;
  started = true;

  // Five past the hour: far enough from the top that it never races the risk worker or a
  // backup window for the same database connections.
  cron.schedule("5 * * * *", async () => {
    if (running) {
      console.warn("[reports] previous run still in progress — skipping this tick.");
      return;
    }
    running = true;
    try {
      // Once for the deployment: `lastSentAt` is read before the send and written after it, so two
      // pods ticking at :05 both read "not sent yet" and every recipient got the report twice.
      await runOncePerTick("report-subscriptions", "hour", () => runForEveryOrg("report-subscriptions", () => tickForOneOrg()));
    } finally {
      running = false;
    }
  });

  console.log("[reports] scheduled report worker started (hourly at :05)");
}
