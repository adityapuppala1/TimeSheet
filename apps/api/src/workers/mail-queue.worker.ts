/**
 * Drains the outbound email queue — the half that makes a deferred send actually arrive.
 *
 * WHY IT EXISTS: `EmailLog` has carried a QUEUED status since the first migration and nothing
 * ever re-drove a row out of it. `sendMail` wrote QUEUED, hit the SMTP server in the same breath,
 * and wrote SENT or FAILED. So a provider answering "451 too many messages, slow down" — which is
 * what a rate limit looks like on the wire — lost that email permanently, and the only evidence
 * was a FAILED row nobody reads. Meanwhile every notification was dispatched detached
 * (`notify.service.ts` explains why), so a bulk approval or the daily reminder sweep fired N
 * simultaneous sends and earned the 451 in the first place.
 *
 * Two changes fix that between them, and this file is the second:
 *   1. `mail.service.ts` now builds a POOLED, rate-limited transport, so a burst is paced rather
 *      than fired at once. That prevents most rejections.
 *   2. This worker retries the ones that still happen, on the backoff schedule in
 *      `nextSendAttemptAt`, until `MAX_SEND_ATTEMPTS` — at which point the row goes FAILED and
 *      stays there, which is what a dead-letter is.
 *
 * WHY EVERY MINUTE: the shortest backoff step is one minute, so a tick any slower would make the
 * first retry systematically late; a tick any faster would poll a table that cannot have new work
 * that often. `running` guards re-entrancy the same way every other worker here does.
 *
 * WHO calls this: server.ts at boot, alongside every other cron worker.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { attemptEmailDelivery } from "../services/mail.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

/**
 * Bounds one tick's work so a large backlog cannot hold the tenant loop open for minutes — the
 * next tick picks up whatever is left. Same reasoning as webhook-retry.worker.ts's BATCH_SIZE,
 * and the number is lower for a reason: each of these is an SMTP round trip through a pool that
 * is deliberately rate-limited, so a bigger batch would just sit waiting on the token bucket
 * while every other tenant waited behind it.
 */
const BATCH_SIZE = 50;

/**
 * A row that has been QUEUED this long without a `nextAttemptAt` was orphaned — the process died
 * between writing the row and finishing its first attempt. Picking it up is the whole reason the
 * row is written before the send rather than after.
 */
const ORPHAN_AFTER_MS = 5 * 60_000;

export async function drainMailQueue(): Promise<{ attempted: number; sent: number; deferred: number; failed: number }> {
  const now = new Date();
  const due = await prisma.emailLog.findMany({
    where: {
      status: "QUEUED",
      OR: [
        { nextAttemptAt: { lte: now } },
        // The orphan case. `nextAttemptAt` is null on a row that was never deferred, so age is
        // the only signal that its in-flight attempt is never coming back.
        { nextAttemptAt: null, createdAt: { lt: new Date(now.getTime() - ORPHAN_AFTER_MS) } }
      ]
    },
    // Oldest first: a queue that delivers newest-first starves its own backlog under sustained
    // load, and these are notifications whose value decays with age.
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true, to: true, subject: true, attempts: true, metadata: true, payload: true }
  });

  let sent = 0;
  let deferred = 0;
  let failed = 0;

  // Serial, not `Promise.all`. Concurrency here would defeat the pool's rate limiter by handing
  // it the whole batch at once — the transport would queue them internally, but the point of
  // pacing is not to have fifty messages in flight against a provider that already said no.
  for (const row of due) {
    // A row whose body was cleared cannot be re-sent. That should be impossible (the payload is
    // only cleared on a terminal outcome, which also leaves QUEUED), but a half-applied migration
    // or a hand-edited row would otherwise loop forever against an empty message.
    if (!row.payload) {
      await prisma.emailLog.update({
        where: { id: row.id },
        data: { status: "FAILED", nextAttemptAt: null, errorMessage: "Queued with no renderable body — cannot be retried." }
      });
      failed++;
      continue;
    }

    const result = await attemptEmailDelivery(row);
    if (result.status === "SENT") sent++;
    else if (result.status === "QUEUED") deferred++;
    else failed++;
  }

  return { attempted: due.length, sent, deferred, failed };
}

export function startMailQueueWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", () => {
    if (running) return;
    running = true;
    runForEveryOrg("mail-queue", async () => {
      const result = await drainMailQueue();
      // Silent when there is nothing to do — this runs every minute for every tenant, and a log
      // line per idle tick would bury the ones that matter.
      if (result.attempted > 0) {
        console.info(
          `[mail-queue] ${requireTenantContext().orgSlug}: attempted ${result.attempted}, sent ${result.sent}, deferred ${result.deferred}, failed ${result.failed}.`
        );
      }
    })
      .catch((error) => console.error("[mail-queue] tick failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[mail-queue] worker started (every minute).");
}
