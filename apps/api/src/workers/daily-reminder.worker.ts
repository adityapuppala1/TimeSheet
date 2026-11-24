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
import { templates } from "../services/mail-templates.js";
import { runOncePerTick } from "../services/job-claim.service.js";
import { getAttendanceSettings } from "../services/attendance-settings.service.js";
import { findLeaveInRange, isAttendanceOn } from "../services/attendance-punch.service.js";
import { loadHolidays } from "../services/attendance-team.service.js";
import { COUNTED_PEOPLE } from "../services/people-visibility.service.js";
import { resolveDayStatus } from "../services/attendance-day-status.js";
import { getPlanningSettings } from "../services/planning.service.js";

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
      // People only. An AI teammate is an ACTIVE EMPLOYEE row (agent-identity.ts) that never logs a
      // timesheet, so it was reminded every afternoon and its owner was emailed an escalation every
      // morning. The same population as the workforce card (admin-summary.service.ts#WORKFORCE_WHERE).
      isAgent: false,
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
    // even when the server has not reached Monday yet. With weekends worked it is the calendar day
    // before, so each missed day is escalated once rather than Friday three times.
    const missedLabel = previousBusinessDayKey(parts, { weekdaysOnly: settings.remindOnWeekdaysOnly });
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

    // Manager notification — to a person. An agent identity in the manager field has nobody behind
    // it to act on an escalation.
    if (user.manager && !user.manager.isAgent) {
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

/* ===================== 11 AM punch-in reminder (V17 A4) ===================== */

/**
 * "You haven't punched in yet", at GlobalAttendanceSettings.punchInReminderHour in the RECIPIENT's
 * timezone. A separate firing with its own category ("reminder.punch_in") and template, so the two
 * firings above are untouched — none of their queries, copy or idempotency keys change.
 *
 * Fires only when the module is on (workspace toggle + plan), the reminder is enabled and punching
 * in is not OFF. WHO: every active person of ANY role (getPunchInRecipients — not getTargetUsers,
 * which is the timesheet reminder's EMPLOYEE/TEAM_LEAD population). Which roles actually get the
 * EMAIL is the Email channels role matrix (emailRoleMutes.emailPunchInReminder), applied by
 * dispatchNotification like every other category — on for every role unless an admin unticks it.
 * Per person: only when resolveDayStatus says PENDING — so a weekend (per the workspace's working
 * days), a holiday in their calendar, a FULL day of approved leave (Phase B — a half day still
 * owes a punch, so resolveDayStatus keeps it PENDING) or a punch from ANY source (web, API,
 * webhook, MCP, CSV) all stay silent. Idempotent per recipient-day through the Notification table.
 *
 * NO N+1: the people whose local hour matches are found first, then ONE query per fact (holidays,
 * leave, records, earlier reminders) for that whole set — the attendance-team.service shape.
 */
async function getPunchInRecipients() {
  return prisma.user.findMany({
    where: { ...COUNTED_PEOPLE, status: "ACTIVE" },
    select: { id: true, name: true, timezone: true, holidayCalendarId: true }
  });
}

export async function runPunchInReminders(now: Date = new Date()): Promise<{ sent: number }> {
  const settings = await getAttendanceSettings();
  if (!settings?.attendanceEnabled || !settings.punchInReminderEnabled || settings.punchInMode === "OFF") return { sent: 0 };
  if (!(await isAttendanceOn())) return { sent: 0 };

  const planning = await getPlanningSettings();
  const due = (await getPunchInRecipients())
    .map((user) => ({ user, parts: recipientNow(now, user.timezone) }))
    .filter(({ parts }) => parts.hour === settings.punchInReminderHour)
    .map(({ user, parts }) => ({ user, dateKey: parts.dateKey, dayStart: startOfZonedDayUtc(now, user.timezone, workspaceZone()) }));
  if (due.length === 0) return { sent: 0 };

  const ids = due.map((d) => d.user.id);
  const dateKeys = [...new Set(due.map((d) => d.dateKey))].sort((a, b) => a.localeCompare(b));
  const earliest = new Date(Math.min(...due.map((d) => d.dayStart.getTime())));
  const [holidayOf, leaveOf, records, notified] = await Promise.all([
    loadHolidays(due.map((d) => d.user.holidayCalendarId ?? null), dateKeys[0], dateKeys.at(-1)!),
    findLeaveInRange(ids, dateKeys[0], dateKeys.at(-1)!),
    prisma.attendanceRecord.findMany({
      where: { userId: { in: ids }, workDate: { in: dateKeys.map(dateKeyToUtc) } },
      select: { userId: true, workDate: true }
    }),
    prisma.notification.findMany({
      where: { userId: { in: ids }, category: "reminder.punch_in", createdAt: { gte: earliest } },
      select: { userId: true, createdAt: true }
    })
  ]);
  const punched = new Set(records.map((r) => `${r.userId}|${r.workDate.toISOString().slice(0, 10)}`));

  let sent = 0;
  for (const { user, dateKey, dayStart } of due) {
    const day = resolveDayStatus({
      dateKey,
      workingDays: planning.workingDays,
      holiday: holidayOf(user.holidayCalendarId ?? null, dateKey, user.id),
      leave: leaveOf(user.id, dateKey),
      punchedIn: punched.has(`${user.id}|${dateKey}`),
      now,
      timeZone: user.timezone,
      fallbackZone: workspaceZone()
    });
    // PENDING is the only "working day, not in yet" verdict for today (ABSENT needs the day over).
    if (day.status !== "PENDING") continue;
    // Already told today — measured from the start of THEIR day, as alreadyNotifiedToday does.
    if (notified.some((n) => n.userId === user.id && n.createdAt >= dayStart)) continue;

    await dispatchNotification({
      userId: user.id,
      category: "reminder.punch_in",
      title: "You haven't punched in yet",
      body: `No punch-in recorded for ${dateKey} yet. Punch in so today's attendance is recorded.`,
      link: "/app",
      email: {
        templateKey: "reminder.punch_in",
        vars: { name: user.name, date: dateKey },
        fallback: {
          subject: `You haven't punched in yet (${dateKey})`,
          html: templates.punchInReminder({ name: user.name, date: dateKey })
        }
      }
    });
    sent += 1;
  }

  return { sent };
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
    const result = await runPunchInReminders(now);
    if (result.sent > 0) console.info(`[reminder.punch_in] sent ${result.sent}`);
  } catch (error) {
    console.error("[reminder.punch_in] failed:", (error as Error).message);
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
    runOncePerTick("reminder", "minute", () => runForEveryOrg("reminder", () => tick()))
      .catch((error) => console.error("[reminder] tick failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  started = true;
  console.info("[reminder] daily worker scheduled (checks settings every :00 and :30).");
}
