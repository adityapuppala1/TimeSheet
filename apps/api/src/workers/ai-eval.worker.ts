/**
 * Executes queued evaluation runs.
 *
 * WHY a worker and not an endpoint: a run is N real LLM calls. Doing that inside a request would
 * hold the connection open for minutes and time out well before finishing, and a client that
 * navigated away would leave a half-run with no owner. Queueing makes "start an eval" instant and
 * the run itself resumable-by-design — a restart just leaves the row QUEUED for the next tick.
 *
 * WHY at most one run per org per tick, executed serially: runs spend money against a shared
 * monthly budget. Two concurrent runs would race that gate against each other, and whichever lost
 * would stop halfway through for reasons that look arbitrary to whoever started it.
 *
 * Every minute rather than hourly because an admin is usually sitting on the page watching for the
 * result — a wait measured in minutes reads as broken.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { executeEvalRun } from "../services/ai-eval.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

/** Takes the oldest queued run for the current tenant and runs it to completion. */
export async function processNextEvalRun(): Promise<{ ranId: string | null }> {
  const next = await prisma.aIEvalRun.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!next) return { ranId: null };

  try {
    await executeEvalRun(next.id);
  } catch (error) {
    // A run that dies unexpectedly must not stay QUEUED — it would be retried forever, spending
    // money on the same failure every minute.
    await prisma.aIEvalRun.update({
      where: { id: next.id },
      data: { status: "FAILED", error: String((error as Error).message ?? error).slice(0, 500), finishedAt: new Date() }
    });
  }
  return { ranId: next.id };
}

export function startAIEvalWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", () => {
    // A run can easily outlast a one-minute tick; overlapping ticks would double-spend.
    if (running) return;
    running = true;
    runForEveryOrg("ai-eval", async () => {
      const { ranId } = await processNextEvalRun();
      if (ranId) console.info(`[ai-eval] ${requireTenantContext().orgSlug}: finished run ${ranId}.`);
    })
      .catch((error) => console.error("[ai-eval] tick failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[ai-eval] worker scheduled (every minute).");
}
