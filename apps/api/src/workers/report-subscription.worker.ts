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
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { resolveDashboard } from "../services/dashboard.service.js";
import { sendMail } from "../services/mail.service.js";
import { getPlanningSettings } from "../services/planning.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

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

/** Plain, table-based HTML — the only thing every email client renders the same way. */
function renderHtml(dashboardName: string, widgets: Awaited<ReturnType<typeof resolveDashboard>>, appUrl: string): string {
  const cells = widgets
    .map((w) => {
      if (w.unavailable) {
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0"><strong>${w.title}</strong></td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b">${w.unavailable}</td></tr>`;
      }
      if (w.shape === "STAT") {
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0"><strong>${w.title}</strong></td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${w.value ?? "—"}${w.unit ?? ""}${w.hint ? ` <span style="color:#64748b">(${w.hint})</span>` : ""}</td></tr>`;
      }
      if (w.points) {
        const summary = w.points.map((p) => `${p.label}: ${p.value}${p.secondary !== undefined ? `/${p.secondary}` : ""}`).join(" · ");
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0"><strong>${w.title}</strong></td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${summary || "—"}</td></tr>`;
      }
      if (w.rows) {
        const list = w.rows.slice(0, 5).map((r) => Object.values(r).filter(Boolean).join(" — ")).join("<br>");
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top"><strong>${w.title}</strong></td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${list || "—"}</td></tr>`;
      }
      return "";
    })
    .join("");

  return `<div style="font-family:Inter,Segoe UI,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">${dashboardName}</h2>
    <p style="margin:0 0 16px;color:#64748b;font-size:13px">Scheduled report from TimeSphere.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${cells}</table>
    <p style="margin-top:20px;font-size:12px;color:#64748b">
      <a href="${appUrl}/app/dashboards" style="color:#0e7490">Open the live dashboard</a>
    </p>
  </div>`;
}

async function tickForOneOrg() {
  const planning = await getPlanningSettings();
  if (!planning.enablePlanning) return;

  const now = new Date();
  const subscriptions = await prisma.reportSubscription.findMany({
    where: { isActive: true, hourUtc: now.getUTCHours() },
    include: { dashboard: true, createdBy: { select: { id: true, status: true, deletedAt: true } } }
  });

  for (const sub of subscriptions) {
    if (!isDue(sub, now) || alreadySent(sub, now)) continue;
    // The report is built with the owner's permissions, so a departed owner must stop it rather
    // than have it silently fall back to something broader.
    if (!sub.createdBy || sub.createdBy.deletedAt || sub.createdBy.status !== "ACTIVE") {
      await prisma.reportSubscription.update({
        where: { id: sub.id },
        data: { isActive: false, lastSendError: "The person who set this up no longer has an active account." }
      });
      continue;
    }
    if (!sub.dashboard) continue;

    try {
      // Owner's scope, resolved fresh each send.
      const assignments = await prisma.userProjectAssignment.findMany({
        where: { userId: sub.createdBy.id },
        select: { projectId: true }
      });
      const owner = await prisma.user.findUnique({
        where: { id: sub.createdBy.id },
        select: { role: { select: { name: true } } }
      });
      const privileged = owner?.role?.name === "SUPER_ADMIN" || owner?.role?.name === "ADMIN";
      const projectIds = privileged
        ? (await prisma.project.findMany({ where: { deletedAt: null }, select: { id: true } })).map((p) => p.id)
        : assignments.map((a) => a.projectId);

      const widgets = await resolveDashboard({
        widgets: (sub.dashboard.widgets as unknown as never[]) ?? [],
        projectIds,
        viewerId: sub.createdBy.id
      });

      const recipients = (sub.recipients as unknown as string[]) ?? [];
      // `env.APP_BASE_URL`, never `process.env`: the raw value is allowed to be "auto" or to carry
      // a "{lan-ip}" token, which `config/env.ts` resolves to a real address at boot. Reading the
      // raw one put the literal string "auto" into every emailed dashboard link.
      const html = renderHtml(sub.dashboard.name, widgets, env.APP_BASE_URL);

      for (const to of recipients) {
        // `template` names the send in EmailLog, so a scheduled report is distinguishable from
        // a transactional one when someone asks why an address received mail.
        await sendMail({ to, subject: `${sub.name} — ${sub.dashboard.name}`, html, template: "report.scheduled" });
      }

      await prisma.reportSubscription.update({
        where: { id: sub.id },
        data: { lastSentAt: now, lastSendError: null }
      });
      console.log(`[reports] sent "${sub.name}" to ${recipients.length} recipient(s)`);
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
      await runForEveryOrg("report-subscriptions", tickForOneOrg);
    } finally {
      running = false;
    }
  });

  console.log("[reports] scheduled report worker started (hourly at :05)");
}
