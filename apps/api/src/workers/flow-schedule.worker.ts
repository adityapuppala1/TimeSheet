/**
 * WHAT: fires flows whose trigger is a clock.
 *
 * WHY A ONE-MINUTE SWEEP RATHER THAN A `cron.schedule` PER FLOW: flows are created, edited, switched
 * off and retired at runtime by an administrator, so a registry of live cron handles would have to be
 * torn down and rebuilt on every edit — and a handle leaked by a missed teardown is a flow that keeps
 * firing after somebody switched it off, which is the one failure this whole feature must not have.
 * A sweep reads the current state of the world every minute and cannot disagree with it.
 *
 * WHY THE MATCHER IS WRITTEN HERE: it is five fields and one truth table, and the alternative was a
 * dependency whose timezone behaviour would have to be understood before it could be trusted. It is
 * pure, so `tests/unit/flow-schedule.test.ts` checks it exhaustively without a database.
 *
 * WHY THE MINUTE IS IN THE `triggerKey`: two ticks in the same minute — a slow sweep overlapping the
 * next, a restart at the wrong second — must collapse to one run. The key is what makes that true, and
 * the database is what enforces it.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { startFlowRun } from "../services/automation-dispatch.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

// One cron field against one value. Supports `*`, a step (`*/5`), a range (`a-b`), a list (`a,b`),
// and any combination of those — the subset every scheduling UI in this product already produces.
function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [spec, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isFinite(step) || step < 1) return false;

    if (spec === "*") return value % step === 0;

    const [fromText, toText] = spec.split("-");
    const from = Number(fromText);
    if (!Number.isFinite(from)) return false;
    if (toText === undefined) return step === 1 ? value === from : value >= from && (value - from) % step === 0;

    const to = Number(toText);
    if (!Number.isFinite(to)) return false;
    return value >= from && value <= to && (value - from) % step === 0;
  });
}

/** Whether a standard five-field expression fires at this minute. Anything else is refused rather
 *  than guessed at: a cron nobody can parse must not silently never fire. */
export function cronMatches(expression: string, at: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  // Day-of-month and day-of-week are OR-ed when both are restricted, which is what every crontab
  // implementation does and what "0 9 1 * 1" (the 1st, and every Monday) is written expecting.
  const domRestricted = dayOfMonth !== "*";
  const dowRestricted = dayOfWeek !== "*";
  const dayHit = domRestricted && dowRestricted
    ? fieldMatches(dayOfMonth, at.getDate()) || fieldMatches(dayOfWeek, at.getDay())
    : fieldMatches(dayOfMonth, at.getDate()) && fieldMatches(dayOfWeek, at.getDay());

  return fieldMatches(minute, at.getMinutes()) && fieldMatches(hour, at.getHours()) && fieldMatches(month, at.getMonth() + 1) && dayHit;
}

/** Stable to the minute, so a doubled tick finds the run rather than making another. */
const minuteKey = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

export async function dispatchScheduledFlows(at: Date = new Date()): Promise<number> {
  const flows = await prisma.automationFlow.findMany({
    where: { enabled: true, deletedAt: null, trigger: "SCHEDULE" },
    select: { id: true, triggerConfig: true }
  });

  let fired = 0;
  for (const flow of flows) {
    const expression = String((flow.triggerConfig as Record<string, unknown>)?.cron ?? "");
    if (!expression || !cronMatches(expression, at)) continue;
    try {
      const { created } = await startFlowRun({
        flowId: flow.id,
        trigger: "cron",
        // A schedule has no subject — it fires on a clock. Said plainly rather than inventing one,
        // which is also why a scheduled flow cannot use a condition about a ticket.
        subject: { type: "workspace", id: null, label: `the schedule at ${minuteKey(at)}` },
        triggerKey: `flow:${flow.id}:cron:${minuteKey(at)}`
      });
      if (created) fired += 1;
    } catch (error) {
      console.warn(`[flow-schedule] flow ${flow.id} failed: ${(error as Error).message}`);
    }
  }
  return fired;
}

export function startFlowScheduleWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("flow-schedule", async () => {
        await dispatchScheduledFlows();
      });
    } catch (error) {
      console.warn(`[flow-schedule] tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
