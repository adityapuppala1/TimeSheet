/**
 * The Monday digest — fires 10:00 server-local time.
 *
 * WHAT: for every active user with some signal in the prior week, sends last week's numbers beside
 * month-to-date and year-to-date, per person and per project, with an AI-written opening paragraph
 * when a model is available.
 *
 * WHAT CHANGED, AND WHY IT MATTERED: this used to be an AI paragraph and a link to the dashboard.
 * Two consequences. The reader had to leave the email to learn anything, so the digest was a nudge
 * rather than a report. And the whole send was gated on `generateWeeklyDigest` succeeding — if the
 * model was slow, unconfigured, or too small to answer, the worker logged the failure and sent
 * NOTHING. A weekly report that a manager plans around had the availability of an LLM.
 *
 * Now the numbers are counted from the database and always send; the summary is a garnish. That
 * ordering is the same one the rest of this product applies — the Inbox brief counts rather than
 * guesses, and goals report a measurement or say they cannot.
 *
 * WHY THE EMAIL DIFFERS BY RECIPIENT: an employee gets their own week. Somebody who may already read
 * the reports pages also gets the workspace user-by-user and project-by-project. That is an
 * access-control decision, so it is made here and in `weekly-digest-data.service.ts`, never in a
 * template — a digest must not become a way around a permission.
 *
 * WHY skip zero-activity users rather than send everyone a templated "your week" email: a recap of
 * nothing reads as spam and erodes trust in the feature; better to say nothing than to say "you did
 * nothing" every Monday.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { permissions } from "@timesheet/shared";
import { generateWeeklyDigest, getGlobalAISettings } from "../services/ai.service.js";
import { templates } from "../services/mail-templates.js";
import { buildDigestTables, buildPeriods, type DigestScope } from "../services/weekly-digest-data.service.js";
import { loadRequestUser } from "../services/principal.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
// See workers/escalation.worker.ts's comment on the equivalent flag — same overlap hazard,
// same fix (this one runs weekly so the risk window is smaller, but per-user AI generation
// calls make a single run slow enough to be worth guarding anyway).
let running = false;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday 00:00 local time of the week containing `date`. */
function startOfWeekLocal(date: Date): Date {
  const d = startOfLocalDay(date);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

/**
 * How much of the workspace this recipient may see. Resolved from what they HOLD and what they
 * MANAGE, never from a role name — a custom role carrying `reports:view` is an administrator for
 * this purpose, and somebody is a manager because people report to them.
 */
function digestScopeFor(perms: string[], reportCount: number): DigestScope {
  if (perms.includes(permissions.REPORTS_VIEW)) return "WORKSPACE";
  if (reportCount > 0) return "TEAM";
  return "SELF";
}

/**
 * The in-app notification line when no model wrote one. A manager's own week is usually empty, so
 * quoting "0.0h approved, 0 resolved" at them would read as their report rather than as the
 * preamble to the team and workspace tables underneath.
 */
function digestBodyFor(scope: DigestScope, own: { hoursLogged: number; resolved: number; openAssigned: number }): string {
  if (scope === "SELF") {
    return `${own.hoursLogged.toFixed(1)}h approved, ${own.resolved} resolved, ${own.openAssigned} still assigned to you.`;
  }
  const subject = scope === "WORKSPACE" ? "the workspace" : "your team";
  return `Last week's figures for ${subject}, with your own week alongside.`;
}

async function alreadySentThisRun(userId: string, weekStart: Date): Promise<boolean> {
  const count = await prisma.notification.count({
    where: { userId, category: "digest.weekly", createdAt: { gte: weekStart } }
  });
  return count > 0;
}

/** Runs the AI weekly digest for every active user with at least some activity signal in the past week. */
export async function runWeeklyDigest(now: Date = new Date()): Promise<{ sent: number; skipped: number }> {
  // The DIGEST toggle still gates the digest. The AI toggle no longer does: the tables are counted
  // from this workspace's own records, and withholding a report of real numbers because a model is
  // switched off would be the AI feature deciding whether the reporting feature runs.
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.weeklyDigestEnabled) return { sent: 0, skipped: 0 };
  const aiAvailable = Boolean(aiSettings.aiEnabled);

  const currentWeekStart = startOfWeekLocal(now);
  const weekStart = new Date(currentWeekStart.getTime() - 7 * DAY_MS);
  const weekEnd = currentWeekStart;
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const weekStartUtcDate = new Date(Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()));
  const weekEndUtcDate = new Date(Date.UTC(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate()));

  // Month- and year-to-date run alongside last week, because "214 hours" answers nothing on its own:
  // the question a reader has is whether last week was normal, and that is a comparison.
  const periods = buildPeriods(now, weekStart, weekEnd, weekLabel);

  // Agent identities are excluded: an identity with no mailbox cannot read a digest, and its work is
  // reported on the agent ledger rather than as a colleague's week.
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, isAgent: false },
    // `_count.reports` is what promotes somebody to the TEAM scope below. Counting it here is one
    // query for everybody rather than one per candidate inside the loop.
    select: { id: true, name: true, _count: { select: { reports: true } } }
  });

  let sent = 0;
  let skipped = 0;

  for (const user of users) {
    if (await alreadySentThisRun(user.id, currentWeekStart)) continue;

    const [ticketsCreated, resolvedTickets, openAssignedTickets, hoursAgg] = await Promise.all([
      prisma.ticket.count({ where: { reporterId: user.id, deletedAt: null, createdAt: { gte: weekStart, lt: weekEnd } } }),
      prisma.ticket.findMany({
        where: { assigneeId: user.id, deletedAt: null, resolvedAt: { gte: weekStart, lt: weekEnd } },
        select: { key: true, title: true, status: true },
        take: 3
      }),
      prisma.ticket.findMany({
        where: { assigneeId: user.id, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
        select: { key: true, title: true, status: true }
      }),
      prisma.timesheet.aggregate({
        where: { userId: user.id, deletedAt: null, workDate: { gte: weekStartUtcDate, lt: weekEndUtcDate } },
        _sum: { totalHours: true }
      })
    ]);

    const hoursLogged = Number(hoursAgg._sum.totalHours ?? 0);
    const openAssigned = openAssignedTickets.length;

    // Who may see what. Resolved per recipient rather than by role NAME, so a custom role carrying
    // `reports:view` is treated the same as SUPER_ADMIN — and a line manager is recognised by
    // actually having reports rather than by being called one.
    const actor = await loadRequestUser(user.id);
    const scope = digestScopeFor(actor?.permissions ?? [], user._count.reports);

    /**
     * THE GATE THAT WAS EXCLUDING THE PEOPLE WHO MOST NEEDED THIS.
     *
     * Skipping a recipient with no activity is right for an employee: a recap of nothing reads as
     * spam. But it was applied to EVERYBODY, and it only ever looked at the recipient's OWN
     * tickets and hours. A super admin or a line manager who manages rather than logs time has no
     * personal activity by definition — so the digest was filtered out before the workspace and
     * team tables it exists to deliver were ever built. That is the reported symptom: "the weekly
     * dashboard is not going to Super Admin and Manager."
     *
     * So the gate now applies only at SELF scope. Anyone with people or a workspace to report on
     * gets the report, because for them the personal figures were never the point.
     */
    if (scope === "SELF" && ticketsCreated === 0 && resolvedTickets.length === 0 && openAssigned === 0 && hoursLogged === 0) {
      skipped += 1;
      continue;
    }

    const notableTickets = resolvedTickets.length > 0 ? resolvedTickets : openAssignedTickets.slice(0, 3);

    /**
     * The opening paragraph, when a model can write one. A failure here is logged and the digest goes
     * anyway — the numbers below it are the report, and this is the sentence on top of them.
     */
    let summary = "";
    if (aiAvailable) {
      try {
        const result = await generateWeeklyDigest({
          userName: user.name,
          weekLabel,
          ticketsCreated,
          ticketsResolved: resolvedTickets.length,
          openAssigned,
          hoursLogged: Number(hoursLogged.toFixed(1)),
          notableTickets,
          userId: user.id
        });
        summary = result.summary ?? "";
      } catch (error) {
        console.warn(`[weekly-digest] no AI summary for ${user.name} (sending the figures anyway):`, (error as Error).message);
      }
    }

    const tablesHtml = await buildDigestTables({ userId: user.id, periods, scope });

    await dispatchNotification({
      userId: user.id,
      category: "digest.weekly",
      title: `Your week in review — ${weekLabel}`,
      // The in-app row keeps the sentence when there is one, and states the headline figures when
      // there is not — a notification reading "Your week in review" and nothing else is not a summary.
      // A manager whose own week is empty must not be told "0.0h approved, 0 resolved" as though
      // that were their report — theirs is the team and workspace tables underneath.
      body: summary || digestBodyFor(scope, { hoursLogged, resolved: resolvedTickets.length, openAssigned }),
      link: "/app",
      email: {
        templateKey: "digest.weekly",
        vars: { name: user.name, weekLabel, summary, tablesHtml },
        fallback: {
          subject: `Your week in review — ${weekLabel}`,
          // The designed template, not a bare paragraph. This fallback previously emitted
          // `<p>Hi name</p><p>summary</p>`, and since almost nobody overrides a template that stub
          // WAS the weekly digest for every workspace — unstyled, and with none of the figures.
          html: templates.weeklyDigest({ name: user.name, weekLabel, summary, tablesHtml })
        }
      }
    });
    sent += 1;
  }

  return { sent, skipped };
}

export function startWeeklyDigestWorker() {
  if (started) return;
  started = true;

  // Monday 10:00. Moved from 08:00 on request: the digest is read at the start of the working
  // week rather than before it, and 10:00 clears the first-hour inbox rush.
  cron.schedule("0 10 * * 1", () => {
    if (running) return;
    running = true;
    runForEveryOrg("weekly-digest", async () => {
      const result = await runWeeklyDigest();
      if (result.sent > 0) console.info(`[weekly-digest] sent ${result.sent} (${result.skipped} skipped — no activity).`);
    })
      .catch((error) => console.error("[weekly-digest] run failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[weekly-digest] worker scheduled (Monday 08:00).");
}
