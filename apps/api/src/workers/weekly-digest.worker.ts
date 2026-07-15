/**
 * AI weekly digest worker — fires Monday 08:00 server-local time.
 * WHAT: for every active user with at least one activity signal in the prior week (a ticket
 * created/resolved, an open assignment, or logged hours), computes those stats and has
 * `ai.service.generateWeeklyDigest()` write a short recap, then emails it.
 * WHY skip zero-activity users rather than send everyone a templated "your week" email: an
 * AI-authored recap of nothing reads as spam and erodes trust in the feature; better to say
 * nothing than to say "you did nothing" every Monday.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { generateWeeklyDigest, getGlobalAISettings } from "../services/ai.service.js";
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

async function alreadySentThisRun(userId: string, weekStart: Date): Promise<boolean> {
  const count = await prisma.notification.count({
    where: { userId, category: "digest.weekly", createdAt: { gte: weekStart } }
  });
  return count > 0;
}

/** Runs the AI weekly digest for every active user with at least some activity signal in the past week. */
export async function runWeeklyDigest(now: Date = new Date()): Promise<{ sent: number; skipped: number }> {
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.aiEnabled || !aiSettings.weeklyDigestEnabled) return { sent: 0, skipped: 0 };

  const currentWeekStart = startOfWeekLocal(now);
  const weekStart = new Date(currentWeekStart.getTime() - 7 * DAY_MS);
  const weekEnd = currentWeekStart;
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const weekStartUtcDate = new Date(Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()));
  const weekEndUtcDate = new Date(Date.UTC(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate()));

  const users = await prisma.user.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true, name: true } });

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

    if (ticketsCreated === 0 && resolvedTickets.length === 0 && openAssigned === 0 && hoursLogged === 0) {
      skipped += 1;
      continue;
    }

    const notableTickets = resolvedTickets.length > 0 ? resolvedTickets : openAssignedTickets.slice(0, 3);

    let summary: string;
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
      summary = result.summary;
    } catch (error) {
      console.error(`[weekly-digest] AI generation failed for ${user.name}:`, (error as Error).message);
      continue;
    }
    if (!summary) continue;

    await dispatchNotification({
      userId: user.id,
      category: "digest.weekly",
      title: `Your week in review — ${weekLabel}`,
      body: summary,
      link: "/app",
      email: {
        templateKey: "digest.weekly",
        vars: { name: user.name, weekLabel, summary },
        fallback: {
          subject: `Your week in review — ${weekLabel}`,
          html: `<p>Hi ${user.name},</p><p>${summary}</p>`
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

  // Monday 08:00 server-local time.
  cron.schedule("0 8 * * 1", () => {
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
