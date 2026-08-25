import cron from "node-cron";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { dispatchNotification, getGlobalNotificationSettings } from "../services/notify.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";
import {
  dateKeyToUtc,
  isWeekendDay,
  previousBusinessDayKey,
  startOfZonedDayUtc,
  zonedParts,
  type ZonedParts
} from "../utils/recipient-time.js";
import { serverTimezone } from "../config/env.js";

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
 *
 * ── EVERY CLOCK QUESTION HERE IS ASKED IN THE RECIPIENT'S TIMEZONE ────────────────────────────
 *
 * "Is it a weekday?" and "is it their reminder hour?" used to be answered with `now.getDay()` and
 * `now.getHours()` — the SERVER's answers. The server defaults to Asia/Kolkata (config/env.ts)
 * while `User.timezone` is populated per person, so for anyone west of the server the two
 * disagree by enough to matter:
 *
 *     New York Fri 15:00  ->  IST Sat 00:30
 *
 * From about 2:30pm on Friday, a New York user's reminder was dropped by a weekend check about
 * somebody else's weekend — and the next tick that is not a weekend on the server is MONDAY. That
 * is the "no mail on Friday, it arrives Monday morning" report, and it is why the hour/weekday
 * gate now lives INSIDE the per-user loop instead of guarding the whole tick.
 *
 * See utils/recipient-time.ts. If you add a scheduled email: the recipient's clock is the one
 * that decides.
 */

let started = false;
// See workers/escalation.worker.ts's comment on the equivalent flag. `tick()` also has its
// own per-hour idempotency check (lastFiredHour / alreadyNotifiedToday), but that guards
// against double-*sending*, not against two ticks' user-iteration loops running concurrently
// if one is still mid-flight when the next :00/:30 fires — this flag is the belt to that
// suspenders.
let running = false;

/**
 * The workspace's own zone, used when a person has not set one. Falls back to the server's, which
 * reproduces the historical behaviour exactly for a single-timezone deployment.
 */
function workspaceZone(): string {
  return serverTimezone;
}

/** Where this person's clock currently stands. */
function recipientNow(now: Date, timezone: string | null | undefined): ZonedParts {
  return zonedParts(now, timezone, workspaceZone());
}

/**
 * Should this person hear from us at all right now?
 *
 * Returns the reason when not, because "nothing was sent" is the hardest state to diagnose in a
 * scheduled job and the caller logs a per-reason tally.
 */
function reminderWindow(
  parts: ZonedParts,
  targetHour: number,
  weekdaysOnly: boolean
): { send: true } | { send: false; reason: "weekend" | "wrong-hour" } {
  if (weekdaysOnly && isWeekendDay(parts.weekday)) return { send: false, reason: "weekend" };
  if (parts.hour !== targetHour) return { send: false, reason: "wrong-hour" };
  return { send: true };
}

async function getTargetUsers() {
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      role: { name: { in: ["EMPLOYEE", "TEAM_LEAD"] } }
    },
    // `timezone` is the whole point of this worker's scheduling — see the header. It is nullable,
    // and a null follows the workspace zone rather than being skipped.
    include: { manager: true }
  });
}

async function userLoggedOn(userId: string, dateUtc: Date): Promise<boolean> {
  const count = await prisma.timesheet.count({
    where: { userId, workDate: dateUtc, deletedAt: null }
  });
  return count > 0;
}

/**
 * "Have we already told this person today?", where TODAY is their own calendar day.
 *
 * Measured from the start of the recipient's local day, not the server's. A recipient far enough
 * west otherwise shares one server-day with two of their own, and the second is silently swallowed
 * as a duplicate.
 */
async function alreadyNotifiedToday(userId: string, category: string, since: Date): Promise<boolean> {
  const count = await prisma.notification.count({
    where: { userId, category, createdAt: { gte: since } }
  });
  return count > 0;
}

/* ============================== 4 PM reminder ============================== */

export async function runDailyReminders(now: Date = new Date()): Promise<{ sent: number }> {
  const settings = await getGlobalNotificationSettings();
  const deadlineHour = String(Math.max(0, Math.min(23, settings.dailyReminderHour + 1)));

  const users = await getTargetUsers();
  let sent = 0;

  for (const user of users) {
    // Their clock, not ours. A user whose local Friday is already the server's Saturday used to be
    // dropped here for the next three days — see the file header.
    const parts = recipientNow(now, user.timezone);
    if (!reminderWindow(parts, settings.dailyReminderHour, settings.remindOnWeekdaysOnly).send) continue;

    // "Today" is the recipient's today, which is the day their timesheet is actually about.
    const dateLabel = parts.dateKey;
    const todayUtc = dateKeyToUtc(dateLabel);

    if (await userLoggedOn(user.id, todayUtc)) continue;
    if (await alreadyNotifiedToday(user.id, "reminder.daily", startOfZonedDayUtc(now, user.timezone, workspaceZone()))) continue;

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
  const settings = await getGlobalNotificationSettings();
  const users = await getTargetUsers();
  let employees = 0;
  let managers = 0;

  for (const user of users) {
    const parts = recipientNow(now, user.timezone);
    if (!reminderWindow(parts, settings.escalationReminderHour, settings.remindOnWeekdaysOnly).send) continue;

    // The business day BEFORE theirs — so a Monday-morning escalation asks about their Friday,
    // even when the server has not reached Monday yet.
    const missedLabel = previousBusinessDayKey(parts);
    const missedUtc = dateKeyToUtc(missedLabel);
    const dayStart = startOfZonedDayUtc(now, user.timezone, workspaceZone());

    if (await userLoggedOn(user.id, missedUtc)) continue;
    if (await alreadyNotifiedToday(user.id, "reminder.escalation", dayStart)) continue;

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
          // Same recipient-day window as the employee check above, so the two cannot disagree
          // about which day it is for a report in another timezone.
          createdAt: { gte: dayStart },
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

/**
 * WHY THERE IS NO LONGER A MODULE-LEVEL "already fired this hour" FLAG.
 *
 * There was one, and it was a second bug sitting on top of the timezone one. `tick()` is invoked
 * through `runForEveryOrg`, which loops the tenants SEQUENTIALLY in one process — so the first
 * org's tick set the flag and every org after it returned immediately. In a multi-tenant
 * deployment exactly one workspace received daily reminders and the rest silently received none.
 *
 * It is safe to delete rather than make per-org because the real guard was always the database:
 * `alreadyNotifiedToday` counts Notification rows for that user, that category, since the start of
 * that user's own day. That is per-recipient, survives a restart, and cannot be confused by two
 * tenants sharing a process — none of which was true of the in-memory flag.
 */
async function tick(now: Date = new Date()) {
  // No global hour or weekday gate: both are per-recipient questions now, asked inside the loops
  // below. This runs every :00 and :30 and is a no-op for anyone whose local hour does not match.
  try {
    const result = await runDailyReminders(now);
    if (result.sent > 0) console.info(`[reminder.daily] sent ${result.sent}`);
  } catch (error) {
    console.error("[reminder.daily] failed:", (error as Error).message);
  }

  try {
    const result = await runEscalationReminders(now);
    if (result.employees > 0 || result.managers > 0) {
      console.info(`[reminder.escalation] ${result.employees} employees, ${result.managers} managers`);
    }
  } catch (error) {
    console.error("[reminder.escalation] failed:", (error as Error).message);
  }
}

/** Manual trigger — useful from a dev console or test script. */
export async function runRemindersNow(now: Date = new Date()) {
  await tick(now);
}

/**
 * Kept as a no-op for callers that still invoke it. There is no in-memory fired-flag any more —
 * idempotency is the Notification table, per recipient per local day. See `tick`.
 */
export function resetReminderFlags() {
  /* intentionally empty — see the note above */
}

export function startDailyReminderWorker() {
  if (started) return;
  if (!env.SLA_ENABLED) {
    console.info("[reminder] worker disabled via SLA_ENABLED=false");
    return;
  }

  // Every hour at :00, plus :30 as a safety net.
  cron.schedule("0,30 * * * *", () => {
    if (running) return;
    running = true;
    runForEveryOrg("reminder", () => tick())
      .catch((error) => console.error("[reminder] tick failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  started = true;
  console.info("[reminder] daily worker scheduled (checks settings every :00 and :30).");
}
