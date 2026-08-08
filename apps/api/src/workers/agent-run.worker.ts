/**
 * WHAT: picks up queued agent runs and executes them, one per workspace per tick.
 *
 * WHY A WORKER AND NOT A REQUEST: `ai-eval.worker.ts`'s header already makes this argument for
 * evals and it holds identically here — a run is N pieces of real work, doing that inside a request
 * would hold the connection open past any sensible timeout, and a client that navigated away would
 * leave a half-run with nobody owning it.
 *
 * WHY SERIAL, one run per org per tick: the same reason the eval worker is. Concurrent runs race
 * the AI budget gate against itself, and `assertWithinBudget` is a check rather than a reservation
 * — two runs starting together both see the same remaining figure and both spend it.
 *
 * WHY THERE IS NO QUEUE TABLE: the `AgentRun` row IS the queue entry. Its unique `triggerKey` is
 * what makes a doubled tick, a retried webhook or a restart mid-tick collapse to one run, and
 * unlike an in-memory guard it survives the restart — which is the case that matters.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { executeAgentRun, reapOrphanedRuns } from "../services/agent-run.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
/** Overlap guard — the same one every worker in this directory uses. A tick that arrives while the
 *  previous one is still working must do nothing, not queue behind it. */
let running = false;

/** Runs older than this with nothing executing them were orphaned by a restart. */
const ORPHAN_AFTER_MINUTES = 30;

export async function processNextAgentRun(): Promise<boolean> {
  // Orphans first: a run left RUNNING by a crash would otherwise never be picked up again, and
  // would block nothing while looking like work in progress forever.
  const reaped = await reapOrphanedRuns(ORPHAN_AFTER_MINUTES);
  if (reaped > 0) console.warn(`[agent-run] marked ${reaped} run(s) failed after a restart`);

  const next = await prisma.agentRun.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
  if (!next) return false;

  await executeAgentRun(next.id);
  return true;
}

export function startAgentRunWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("agent-run", async () => {
        await processNextAgentRun();
      });
    } catch (error) {
      // Never rethrow out of a tick: an unhandled rejection here would take the process down and
      // stop every other worker with it.
      console.warn("[agent-run] tick failed:", (error as Error).message);
    } finally {
      running = false;
    }
  });
}
