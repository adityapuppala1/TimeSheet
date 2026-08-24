/**
 * Outbound webhook delivery — the egress half of docs/ROADMAP.md's "Public REST API + outbound
 * webhooks" theme (the ingress half is controllers/public-api.controller.ts + ApiKey). Callers
 * fire an event (ticket created, status changed, timesheet approved, ...) and this fans it out
 * to every active OutboundWebhook subscribed to that event in the current tenant, HMAC-signing
 * each payload the same way GitHub/Stripe do so receivers can verify authenticity.
 *
 * RELIABILITY: a failed delivery is persisted as a `WebhookDelivery` row (not just a
 * `lastDeliveryStatus` flag) so `workers/webhook-retry.worker.ts` can retry it with backoff, up
 * to a capped attempt count — an org's endpoint having one bad minute no longer silently drops
 * the event forever. Deliberately NOT a general-purpose job queue (no BullMQ/pg-boss dependency
 * added): this is the same cron-sweep pattern every other worker in this codebase already uses,
 * scoped to exactly this one problem.
 */
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";
import { assertPublicEgressTarget } from "../utils/egress.js";

export const WEBHOOK_EVENTS = [
  "ticket.created",
  "ticket.status_changed",
  "ticket.closed",
  "timesheet.submitted",
  "timesheet.approved"
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const DELIVERY_TIMEOUT_MS = 5000;

/** Same signing scheme as Stripe/GitHub: HMAC-SHA256 over the raw JSON body, hex-encoded, sent
 *  as `X-TimeSphere-Signature: sha256=<hex>` — a receiver recomputes it over the raw bytes they
 *  received (not a re-serialized object, which could differ in key order/whitespace) and
 *  compares with a constant-time check. Documented in docs/API.md's "Public API" section. */
function sign(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export interface DeliveryOutcome {
  /** "delivered" | "http_<status>" | "failed" (network error/timeout) | "blocked" (SSRF guard). */
  status: string;
  ok: boolean;
  error?: string;
}

/** The one place an HTTP delivery attempt actually happens — shared by the initial fire-and-
 *  forget dispatch below and the retry worker, so "what counts as success" can never drift
 *  between the two call sites. */
export async function attemptWebhookDelivery(url: string, secret: string, event: string, body: string): Promise<DeliveryOutcome> {
  // SSRF gate, HERE rather than only in the settings schema that saved the URL — this one
  // function is the single choke point every delivery path goes through (initial dispatch, the
  // retry worker, the admin's manual retry, the test button), so a target that was legitimate
  // when saved and now resolves somewhere private is re-checked on every attempt. Validating
  // only on save would trust a DNS record indefinitely.
  //
  // Returned as an OUTCOME, not thrown: this runs inside a detached `Promise.allSettled` for
  // real events, where a throw would be an unhandled rejection, and the admin needs to SEE why
  // nothing is arriving — "blocked" plus the reason lands on the webhook row and the delivery
  // row exactly like any other failure.
  try {
    await assertPublicEgressTarget(url, "This webhook URL");
  } catch (error) {
    return { status: "blocked", ok: false, error: (error as Error).message.slice(0, 500) };
  }

  const signature = sign(secret, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TimeSphere-Event": event,
        "X-TimeSphere-Signature": `sha256=${signature}`
      },
      body,
      signal: controller.signal
    });
    return response.ok ? { status: "delivered", ok: true } : { status: `http_${response.status}`, ok: false };
  } catch (error) {
    return { status: "failed", ok: false, error: (error as Error).message.slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fires `event` at every active webhook in the current tenant subscribed to it. Best-effort —
 *  one endpoint timing out or 500ing never throws back to the caller, since ticket/timesheet
 *  mutations must not fail because an external integration's server is down. Every attempt's
 *  outcome lands on the webhook row (lastDeliveryAt/lastDeliveryStatus) for an at-a-glance
 *  status; a FAILED attempt additionally persists a `WebhookDelivery` row so it can be retried
 *  automatically instead of being lost the moment this function returns. */
export async function dispatchOutboundWebhooks(event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  const webhooks = await prisma.outboundWebhook.findMany({ where: { isActive: true } });
  const subscribed = webhooks.filter((hook) => Array.isArray(hook.events) && (hook.events as string[]).includes(event));
  if (subscribed.length === 0) return;

  const body = JSON.stringify({ event, deliveredAt: new Date().toISOString(), data: payload });

  // Deliveries are DETACHED: this resolves once the fan-out is scheduled, not once external
  // servers have answered. Nothing in any caller's response depends on delivery; the outcome
  // lands on the webhook row (and, on failure, a WebhookDelivery row) either way, and the tenant
  // context carries into the detached work via AsyncLocalStorage.
  void Promise.allSettled(
    subscribed.map(async (hook) => {
      const outcome = await attemptWebhookDelivery(hook.url, hook.secret, event, body);
      await prisma.outboundWebhook
        .update({ where: { id: hook.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: outcome.status } })
        .catch(() => undefined);
      if (!outcome.ok) {
        await prisma.webhookDelivery
          .create({
            data: {
              webhookId: hook.id,
              event,
              payload: JSON.parse(body),
              attempt: 1,
              status: "pending",
              lastError: outcome.error ?? outcome.status,
              nextAttemptAt: nextRetryAt(1)
            }
          })
          .catch(() => undefined);
      }
    })
  );
}

/** Exponential backoff: 1m, 5m, 15m, 60m — the 5th attempt (if it also fails) exhausts the
 *  budget rather than scheduling a 6th. Deliberately short overall (~80 minutes end to end):
 *  this is recovering from a receiver's brief outage, not queuing for a day-long one. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function nextRetryAt(attemptJustMade: number): Date | null {
  const delay = RETRY_DELAYS_MS[attemptJustMade - 1];
  return delay ? new Date(Date.now() + delay) : null;
}

export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
