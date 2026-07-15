/**
 * Outbound webhook delivery — the egress half of docs/ROADMAP.md's "Public REST API + outbound
 * webhooks" theme (the ingress half is controllers/public-api.controller.ts + ApiKey). Callers
 * fire an event (ticket created, status changed, timesheet approved, ...) and this fans it out
 * to every active OutboundWebhook subscribed to that event in the current tenant, HMAC-signing
 * each payload the same way GitHub/Stripe do so receivers can verify authenticity.
 *
 * WHY fire-and-forget per delivery rather than a queue/retry system: this is a first phase (see
 * roadmap) — an org's own endpoint being briefly down loses that one event's webhook call, not
 * anything TimeSphere itself depends on (the in-app data is already committed before this runs).
 * A durable retry queue is future work if/when a customer actually needs delivery guarantees.
 */
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";

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

/** Fires `event` at every active webhook in the current tenant subscribed to it. Best-effort —
 *  one endpoint timing out or 500ing never throws back to the caller, since ticket/timesheet
 *  mutations must not fail because an external integration's server is down. Each delivery's
 *  outcome is recorded on the webhook row (lastDeliveryAt/lastDeliveryStatus) so an admin can
 *  see "last call failed" from Workspace Settings without needing a separate delivery log. */
export async function dispatchOutboundWebhooks(event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  const webhooks = await prisma.outboundWebhook.findMany({ where: { isActive: true } });
  const subscribed = webhooks.filter((hook) => Array.isArray(hook.events) && (hook.events as string[]).includes(event));
  if (subscribed.length === 0) return;

  const body = JSON.stringify({ event, deliveredAt: new Date().toISOString(), data: payload });

  await Promise.allSettled(
    subscribed.map(async (hook) => {
      const signature = sign(hook.secret, body);
      let status = "failed";
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
        try {
          const response = await fetch(hook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-TimeSphere-Event": event,
              "X-TimeSphere-Signature": `sha256=${signature}`
            },
            body,
            signal: controller.signal
          });
          status = response.ok ? "delivered" : `http_${response.status}`;
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        status = "failed";
      }
      await prisma.outboundWebhook
        .update({ where: { id: hook.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: status } })
        .catch(() => undefined);
    })
  );
}
