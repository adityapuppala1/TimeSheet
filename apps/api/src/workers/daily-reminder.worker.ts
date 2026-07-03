import cron from "node-cron";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { dispatchNotification, getGlobalNotificationSettings } from "../services/notify.service.js";

/**
 * Daily reminder + next-day escalation worker.
 *
 * Runs a single "every hour at :00" cron job and checks the workspace
 * settings each tick. This lets the SUPER_ADMIN edit the reminder hours
 * at runtime without restarting the API.
 *
 * Two distinct firings per weekday:
 *  - At `dailyReminderHour`: email every active EMPLOYEE / TEAM_LEAD who
 *    has NOT logged a timesheet for *today*.
 *  - At `escalationReminderHour`: for the previous business day, if a
 *    user still hasn't logged, send them a "this has been escalated"
 *    note AND notify their manager.
 *
 * Idempotent: we check the Notification table to avoid double-firing
 * within the same calendar day (even if the worker re-runs).
 */

let started = false;

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfLocalDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function toUtcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/**
 * "Yesterday" in business terms: Mon→Fri, Tue→Mon, ..., Fri→Thu.
 * (Saturday/Sunday don't run; the cron filter handles that upstream.)
 */
function previousBusinessDay(now: Date): Date {
  const day = now.getDay(); // 0 Sun, 1 Mon, ... 6 Sat
  const offset = day === 1 ? 3 : day === 0 ? 2 : 1;
  const result = startOfLocalDay(now);
  result.setDate(result.getDate() - offset);
  return result;
}

async function getTargetUsers() {
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      role: { name: { in: ["EMPLOYEE", "TEAM_LEAD"] } }
    },
    include: { manager: true }
  });
}

async function userLoggedOn(userId: string, dateUtc: Date): Promise<boolean> {
  const count = await prisma.timesheet.count({
    where: { userId, workDate: dateUtc, deletedAt: null }
  });
  return count > 0;
}

async function alreadyNotifiedToday(userId: string, category: string): Promise<boolean> {
  const since = startOfLocalDay(new Date());
  const count = await prisma.notification.count({
    where: { userId, category, createdAt: { gte: since } }
  });
  return count > 0;
}

/* ============================== 4 PM reminder ============================== */

export async function runDailyReminders(now: Date = new Date()): Promise<{ sent: number }> {
  const todayUtc = toUtcDateOnly(now);
  const dateLabel = todayUtc.toISOString().slice(0, 10);
  const settings = await getGlobalNotificationSettings();
  const deadlineHour = String(Math.max(0, Math.min(23, settings.dailyReminderHour + 1)));

  const users = await getTargetUsers();
  let sent = 0;

  for (const user of users) {
    if (await userLoggedOn(user.id, todayUtc)) continue;
    if (await alreadyNotifiedToday(user.id, "reminder.daily")) continue;

    await dispatchNotification({
      userId: user.id,
      category: "reminder.daily",
      title: "Log today's timesheet",
      body: `We haven't seen a timesheet entry for ${dateLabel} yet. Two minutes now saves a tomorrow-morning escalation.`,
      link: "/app/timesheet",
      email: {
        templateKey: "reminder.daily",
        vars: {
          name: user.name,
          date: dateLabel,
          deadlineHour
        },
        fallback: {
          subject: `Don't forget — log today's timesheet (${dateLabel})`,
          html: `<p>Hi ${user.name}, we haven't seen a timesheet for ${dateLabel}. Please log it before ${deadlineHour}:00 to avoid an escalation tomorrow morning.</p>`
        }
      }
    });
    sent += 1;
  }

  return { sent };
}

/* ===================== 9 AM next-day escalation ============================ */

export async function runEscalationReminders(now: Date = new Date()): Promise<{ employees: number; managers: number }> {
  const missedLocalDay = previousBusinessDay(now);
  const missedUtc = toUtcDateOnly(missedLocalDay);
  const missedLabel = missedUtc.toISOString().slice(0, 10);

  const users = await getTargetUsers();
  let employees = 0;
  let managers = 0;

  for (const user of users) {
    if (await userLoggedOn(user.id, missedUtc)) continue;
    if (await alreadyNotifiedToday(user.id, "reminder.escalation")) continue;

    // Employee escalation reminder
    await dispatchNotification({
      userId: user.id,
      category: "reminder.escalation",
      title: "Yesterday's timesheet escalated to your manager",
      body: `You didn't log time for ${missedLabel}. Catch up now and file today's entry before 5 PM.`,
      link: "/app/timesheet",
      metadata: { missedDate: missedLabel },
      email: {
        templateKey: "reminder.escalation.employee",
        vars: {
          name: user.name,
          missedDate: missedLabel,
          managerName: user.manager?.name ?? "your manager"
        },
        fallback: {
          subject: `Action required — ${missedLabel} timesheet escalated`,
          html: `<p>${user.name}, you missed ${missedLabel}'s timesheet. Log it and today's entry before 5 PM.</p>`
        }
      }
    });
    employees += 1;

    // Manager notification
    if (user.manager) {
      // Dedup by the unique (manager, employeeEmail, day) tuple — encoded in the
      // notification body. Email is guaranteed unique in the User table, so two
      // reports sharing a first name (which a `title contains user.name` check
      // would falsely dedup) are still handled individually.
      const employeeMarker = `(${user.email})`;
      const alreadyToldManager = await prisma.notification.count({
        where: {
          userId: user.manager.id,
          category: "reminder.escalation",
          createdAt: { gte: startOfLocalDay(now) },
          body: { contains: employeeMarker }
        }
      });
      if (alreadyToldManager === 0) {
        await dispatchNotification({
          userId: user.manager.id,
          category: "reminder.escalation",
          title: `${user.name} missed yesterday's timesheet`,
          body: `${user.name} (${user.email}) did not log a timesheet for ${missedLabel}. They've been reminded directly.`,
          link: "/app/team",
          metadata: { missedDate: missedLabel, employeeId: user.id },
          email: {
            templateKey: "reminder.escalation.manager",
            vars: {
              managerName: user.manager.name,
              employeeName: user.name,
              employeeEmail: user.email,
              missedDate: missedLabel
            },
            fallback: {
              subject: `${user.name} missed yesterday's timesheet`,
              html: `<p>Hi ${user.manager.name}, ${user.name} did not log a timesheet for ${missedLabel}. They've been reminded.</p>`
            }
          }
        });
        managers += 1;
      }
    }
  }

  return { employees, managers };
}

/* ================================ scheduler =============================== */

let lastFiredHour: { reminder?: string; escalation?: string } = {};

async function tick(now: Date = new Date()) {
  const settings = await getGlobalNotificationSettings();

  // Weekend filter (server-local). 0 = Sunday, 6 = Saturday.
  const day = now.getDay();
  if (settings.remindOnWeekdaysOnly && (day === 0 || day === 6)) return;

  const hour = now.getHours();
  const todayKey = startOfLocalDay(now).toISOString();

  if (hour === settings.dailyReminderHour && lastFiredHour.reminder !== todayKey) {
    lastFiredHour.reminder = todayKey;
    try {
      const result = await runDailyReminders(now);
      if (result.sent > 0) console.info(`[reminder.daily] sent ${result.sent}`);
    } catch (error) {
      console.error("[reminder.daily] failed:", (error as Error).message);
    }
  }

  if (hour === settings.escalationReminderHour && lastFiredHour.escalation !== todayKey) {
    lastFiredHour.escalation = todayKey;
    try {
      const result = await runEscalationReminders(now);
      if (result.employees > 0 || result.managers > 0) {
        console.info(`[reminder.escalation] ${result.employees} employees, ${result.managers} managers`);
      }
    } catch (error) {
      console.error("[reminder.escalation] failed:", (error as Error).message);
    }
  }
}

/** Manual trigger — useful from a dev console or test script. */
export async function runRemindersNow(now: Date = new Date()) {
  await tick(now);
}

/** Reset the in-memory fired-flag so manual triggers don't double-skip. */
export function resetReminderFlags() {
  lastFiredHour = {};
}

export function startDailyReminderWorker() {
  if (started) return;
  if (!env.SLA_ENABLED) {
    console.info("[reminder] worker disabled via SLA_ENABLED=false");
    return;
  }

  // Every hour at :00, plus :30 as a safety net.
  cron.schedule("0,30 * * * *", () => {
    tick().catch((error) => console.error("[reminder] tick failed:", (error as Error).message));
  });

  started = true;
  console.info("[reminder] daily worker scheduled (checks settings every :00 and :30).");
}
