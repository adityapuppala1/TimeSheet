/**
 * Retries outbound-webhook deliveries that failed on their first attempt — see
 * webhook-dispatch.service.ts's header for why this exists (fire-and-forget with no retry meant
 * one bad minute on a customer's endpoint silently dropped the event forever). Fires every 5
 * minutes; `nextRetryAt`'s backoff schedule (1m/5m/15m/60m) means a delivery is naturally never
 * ready before its own next tick, so there's no need for a shorter cron interval than that.
 * WHO calls this: server.ts at boot, alongside every other cron worker.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { attemptWebhookDelivery, MAX_DELIVERY_ATTEMPTS, nextRetryAt } from "../services/webhook-dispatch.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

/** Bounds one tick's work so a large backlog can't hold the tenant loop open for minutes — the
 *  next tick (5 minutes later) picks up whatever's left, same reasoning as face-retention
 *  worker's BATCH_SIZE. */
const BATCH_SIZE = 200;

/** How long a resolved (delivered/exhausted) row is kept around for the settings UI's "recent
 *  deliveries" list before cleanup — this table has no other reason to grow forever. */
const RETENTION_DAYS = 30;

export async function retryPendingWebhookDeliveries(): Promise<{ retried: number; delivered: number; exhausted: number }> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date() }, webhook: { isActive: true } },
    include: { webhook: { select: { id: true, url: true, secret: true } } },
    take: BATCH_SIZE
  });

  let delivered = 0;
  let exhausted = 0;

  for (const delivery of due) {
    const body = JSON.stringify(delivery.payload);
    const outcome = await attemptWebhookDelivery(delivery.webhook.url, delivery.webhook.secret, delivery.event, body);

    await prisma.outboundWebhook
      .update({ where: { id: delivery.webhookId }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: outcome.status } })
      .catch(() => undefined);

    if (outcome.ok) {
      delivered++;
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "delivered", lastError: null } });
      continue;
    }

    const attempt = delivery.attempt + 1;
    const retryAt = attempt < MAX_DELIVERY_ATTEMPTS ? nextRetryAt(attempt) : null;
    if (retryAt) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { attempt, status: "pending", nextAttemptAt: retryAt, lastError: outcome.error ?? outcome.status }
      });
    } else {
      exhausted++;
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { attempt, status: "exhausted", nextAttemptAt: null, lastError: outcome.error ?? outcome.status }
      });
    }
  }

  // Cleanup: resolved rows past their retention window. Bounded the same way for the same reason.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.webhookDelivery.deleteMany({
    where: { status: { in: ["delivered", "exhausted"] }, updatedAt: { lt: cutoff } }
  });

  return { retried: due.length, delivered, exhausted };
}

export function startWebhookRetryWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("*/5 * * * *", () => {
    if (running) return;
    running = true;
    runForEveryOrg("webhook-retry", async () => {
      const result = await retryPendingWebhookDeliveries();
      if (result.retried > 0) {
        console.info(
          `[webhook-retry] ${requireTenantContext().orgSlug}: retried ${result.retried}, delivered ${result.delivered}, exhausted ${result.exhausted}.`
        );
      }
    })
      .catch((error) => console.error("[webhook-retry] sweep failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[webhook-retry] worker scheduled (*/5 * * * *).");
}
