/**
 * WHAT: daily (09:00 server time) cron worker — reminds employees a project's monthly
 * submission deadline (`Project.submissionDeadlineDayOfMonth`) is 3 or 1 days away, if they
 * haven't logged any time against it yet this month.
 * WHY: distinct from `daily-reminder.worker.ts` (a per-day "log today's time" nudge) — this is
 * specifically about the monthly cutoff, and only fires for projects that opted into one.
 * WHO calls this: started once from `server.ts`; fans out per-org via `run-for-every-org.ts`.
 */
import cron from "node-cron";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { runForEveryOrg } from "./run-for-every-org.js";

const REMINDER_OFFSET_DAYS = [3, 1] as const;

let started = false;
// See workers/escalation.worker.ts's comment on the equivalent flag — same overlap hazard,
// same fix.
let running = false;

/**
 * Send "submission deadline is approaching" reminders.
 *
 * Logic: for each project with `submissionDeadlineDayOfMonth` set, when today is within
 * REMINDER_OFFSET_DAYS of that day, find every active user who hasn't logged time so far
 * this month and notify them once per offset.
 */
export async function processDeadlineReminders(now: Date = new Date()) {
  const today = now.getUTCDate();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const projects = await prisma.project.findMany({
    where: { submissionDeadlineDayOfMonth: { not: null }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true, code: true, submissionDeadlineDayOfMonth: true }
  });

  let sent = 0;
  for (const project of projects) {
    const deadlineDay = project.submissionDeadlineDayOfMonth!;
    const daysLeft = deadlineDay - today;
    if (!REMINDER_OFFSET_DAYS.includes(daysLeft as (typeof REMINDER_OFFSET_DAYS)[number])) continue;

    // Users who haven't logged for this project this month.
    const recentEntries = await prisma.timesheet.findMany({
      where: { projectId: project.id, workDate: { gte: monthStart }, deletedAt: null },
      select: { userId: true }
    });
    const loggedIds = new Set(recentEntries.map((entry) => entry.userId));

    const assignees = await prisma.userProjectAssignment.findMany({
      where: { projectId: project.id, user: { status: "ACTIVE", deletedAt: null } },
      select: { user: { select: { id: true, name: true } } }
    });

    const targets = assignees.length
      ? assignees.map((row) => row.user).filter((u) => !loggedIds.has(u.id))
      : await prisma.user.findMany({
          where: { status: "ACTIVE", deletedAt: null, role: { name: "EMPLOYEE" } },
          select: { id: true, name: true }
        });

    for (const user of targets) {
      if (loggedIds.has(user.id)) continue;
      await dispatchNotification({
        userId: user.id,
        category: "deadline.reminder",
        title: `Submission deadline approaching`,
        body: `Your timesheets for ${project.name} are due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
        link: "/app/timesheet",
        email: {
          templateKey: "deadline.reminder",
          vars: { name: user.name, daysLeft: String(daysLeft), deadlineDay: String(deadlineDay) },
          fallback: {
            subject: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left to submit timesheets`,
            html: templates.deadlineReminder({ name: user.name, daysLeft, deadlineDay })
          }
        },
        metadata: { projectId: project.id, projectCode: project.code }
      });
      sent += 1;
    }
  }

  return { sent };
}

export function startDeadlineReminderWorker() {
  if (started) return;
  if (!env.SLA_ENABLED) {
    console.info("[deadline] worker disabled via SLA_ENABLED=false");
    return;
  }

  // Run every day at 09:00 server time.
  const schedule = "0 9 * * *";
  if (!cron.validate(schedule)) return;

  cron.schedule(schedule, () => {
    if (running) return;
    running = true;
    runForEveryOrg("deadline", async () => {
      const result = await processDeadlineReminders();
      if (result.sent > 0) console.info(`[deadline] reminders: ${result.sent} sent.`);
    })
      .catch((error) => console.error("[deadline] worker failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  started = true;
  console.info(`[deadline] worker scheduled (${schedule}).`);
}
