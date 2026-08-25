/**
 * WHAT: the one place something notable happens, and the place anything wanting to react to it
 * subscribes.
 *
 * WHY IT SITS BESIDE `webhook-dispatch.service.ts` RATHER THAN INSIDE IT: `WEBHOOK_EVENTS`' five
 * strings are a PUBLIC CONTRACT — customers subscribe to them and they are documented in
 * docs/API.md. Putting an internal subscriber registry inside that function leaves two bad
 * options: either every new internal event becomes a customer-visible webhook event, leaking
 * internals into a public API, or one function ends up carrying two vocabularies. One layer of
 * indirection is cheaper than either. Outbound webhooks simply become the first subscriber.
 *
 * WHY IT IS WORTH DOING EVEN WITH ONE SUBSCRIBER: the "a status change also fires ticket.closed"
 * rule was written out three times — in `ticket.controller.ts`, in `public-api.controller.ts`, and
 * again in `mcp-tools.ts` — because those are three separate write paths for the same act. Three
 * copies of a rule is a rule that will eventually be four copies, one of which is wrong. Here it is
 * written once, in `emitTicketStatusChanged`.
 *
 * WHAT THIS IS NOT: a job queue, a broker, or an outbox. `webhook-dispatch.service.ts` already
 * refuses those by name and its reasoning holds — this app runs as a single Node process and its
 * durability needs are met by persisting FAILURES (`WebhookDelivery`) rather than everything.
 * Subscribers here run in-process, detached, and best-effort.
 */
import { dispatchOutboundWebhooks, WEBHOOK_EVENTS, type WebhookEvent } from "./webhook-dispatch.service.js";

/**
 * Everything an in-process subscriber can react to. A SUPERSET of the public webhook vocabulary:
 * an event that is not in `WEBHOOK_EVENTS` simply never reaches the webhook subscriber, so adding
 * one here is not an API change.
 *
 * Almost every entry already has a firing site in this codebase — the SLA sweeps, both intakes,
 * the devops and git webhooks, the approval flow. Naming them is most of the work; wiring the rest
 * of them up is a later phase, and an event nobody emits yet costs nothing to declare.
 */
export const DOMAIN_EVENTS = [
  ...WEBHOOK_EVENTS,
  "ticket.assigned",
  "ticket.commented",
  "ticket.reopened",
  "ticket.sla_breached",
  "ticket.stale",
  "timesheet.rejected",
  "timesheet.sla_breached",
  "approval.requested",
  "approval.decided",
  "project.risk_band_changed",
  "intake.email_received",
  "intake.chat_received",
  "ci.run_failed",
  "git.pr_opened",
  "security.finding_ingested",
  "proposal.created",
  "proposal.applied",
  "proposal.undone",
  "agent.run_finished",
  "agent.run_blocked",
  /* Change management. Internal only for now: promoting any of these to WEBHOOK_EVENTS is a
     promise to customers about the payload shape, and that is worth making once the module has
     been used rather than on the day it ships. */
  "change.submitted",
  "change.awaiting_approval",
  "change.approved",
  "change.rejected",
  "change.scheduled",
  "change.implementing",
  "change.pir",
  "change.closed",
  "change.cancelled"
] as const;

export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

export interface DomainSubscriber {
  readonly name: string;
  readonly events: readonly DomainEvent[];
  readonly handle: (event: DomainEvent, payload: Record<string, unknown>) => Promise<void>;
}

/**
 * The outbound-webhook fan-out, as an ordinary subscriber.
 *
 * It only ever sees the five public events, which is what keeps the internal vocabulary internal.
 */
const webhookSubscriber: DomainSubscriber = {
  name: "outbound-webhooks",
  events: WEBHOOK_EVENTS,
  handle: async (event, payload) => {
    await dispatchOutboundWebhooks(event as WebhookEvent, payload);
  }
};

const SUBSCRIBERS: DomainSubscriber[] = [webhookSubscriber];

/**
 * Register an in-process subscriber. Called at module load, not per request.
 *
 * Kept as a function rather than a static array so a subscriber can live next to the thing it
 * belongs to — the agent trigger will register itself from the agent runtime rather than requiring
 * this file to import it, which would make this the file that knows about everything.
 */
export function registerDomainSubscriber(subscriber: DomainSubscriber): void {
  SUBSCRIBERS.push(subscriber);
}

/**
 * Fire an event.
 *
 * SUBSCRIBERS RUN DETACHED AND BEST-EFFORT, exactly as the webhook fan-out already did: a ticket
 * save must never fail because something listening misbehaved. Tenant context carries through the
 * AsyncLocalStorage the same way, so a subscriber reads the same database the emitter did.
 *
 * Awaiting nothing is deliberate. This returns as soon as the fan-out is scheduled, so a caller in
 * a request path pays nothing for a slow subscriber.
 */
export function emitDomainEvent(event: DomainEvent, payload: Record<string, unknown>): void {
  const listeners = SUBSCRIBERS.filter((s) => s.events.includes(event));
  if (listeners.length === 0) return;

  void Promise.allSettled(
    listeners.map(async (subscriber) => {
      try {
        await subscriber.handle(event, payload);
      } catch (error) {
        // Swallowed on purpose, and logged rather than rethrown: one broken subscriber must not
        // take out the others, and none of them may reach the caller.
        console.warn(`[domain-events] subscriber "${subscriber.name}" failed on ${event}:`, (error as Error).message);
      }
    })
  );
}

/**
 * A ticket's status moved.
 *
 * THE REASON THIS FUNCTION EXISTS rather than two `emitDomainEvent` calls at each site: "a status
 * change to CLOSED also fires ticket.closed" was written out three times, once per write path
 * (the app's own controller, the public REST API, and the MCP tool layer). Each of those was a
 * faithful copy today and a place for a fourth surface to get it wrong tomorrow. The rule now
 * lives here, once, and a new write path gets it by calling this.
 */
export function emitTicketStatusChanged(ticket: unknown, from: string, to: string): void {
  emitDomainEvent("ticket.status_changed", { ticket, from, to });
  if (to === "CLOSED") emitDomainEvent("ticket.closed", { ticket });
  if (from === "CLOSED" && to !== "CLOSED") emitDomainEvent("ticket.reopened", { ticket, to });
}
