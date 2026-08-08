/**
 * WHAT: `audit()` — writes one row to the tenant `AuditLog` table.
 * WHY: every administrative/approval/AI action in this app should leave a trail, and a
 * per-entity Activity tab (tickets, in particular) is just this same log filtered to one
 * `entityId` — so a single generic write function here backs both the admin audit-log page and
 * every entity's own Activity tab, rather than maintaining two separate logging mechanisms.
 * WHO calls this: dozens of call sites across controllers/services whenever something
 * noteworthy happens (e.g. `settings.sso_updated`, `chat_intake.ticket_created`,
 * `user.profile_updated`).
 *
 * WHY THE SIXTH PARAMETER IS OPTIONAL AND POSITIONAL-LAST: there are ~181 call sites and they all
 * pass positionally. Changing the first five — or moving to an options object — would be a
 * mechanical edit of every one of them, and a mechanical edit of 181 sites is how a subtly wrong
 * `entityId` gets introduced somewhere nobody looks again. So the signature only ever grows at the
 * end, and every existing call keeps its exact meaning.
 *
 * WHY `actorType` EXISTS AT ALL: `actorId` used to be `undefined` for anything without a human in
 * the loop — email intake, chat intake, the SLA sweeps, the security ingest, a guest holding an
 * approval link. All of them collapsed to one indistinguishable NULL, and telling them apart meant
 * string-matching the `action` column. That was survivable while every write ultimately traced to
 * a person. It is not survivable once the product acts on its own: "what did the machine change,
 * and on whose authority" has to be answerable by a query.
 */
import { prisma } from "../config/prisma.js";
import type { AuditActorType, Prisma } from "@prisma/client";

/**
 * Everything about a write that is not "who, what, which row".
 *
 * `actorId` and `actorType` answer different questions and are both worth recording: an agent run
 * writes the DELEGATING PERSON as `actorId` (because that is whose permissions were checked) and
 * `AGENT` as `actorType` (because that person did not press anything). Reading only one of them
 * gives a true but incomplete answer, which is why neither is derived from the other.
 */
export interface AuditProvenance {
  /** Defaults to USER — see the schema comment for why that default is load-bearing. */
  actorType?: AuditActorType;
  /** "email-intake", "agent:schedule_adjustment", "sla-sweep". */
  actorLabel?: string;
  /** The state before and after. Only worth passing where a diff is meaningful. */
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /** Which model call and which agent run caused this. Plain strings, not FKs — the interactions
   *  they name are pruned on the workspace's AI retention schedule and this must outlive them. */
  aiInteractionId?: string;
  agentRunId?: string;
  /** The column has existed since the first migration and has never once been written. Callers
   *  that have a request in hand should pass `req.ip` — an audit row for an administrative change
   *  is exactly where "from where" matters. */
  ipAddress?: string;
}

export async function audit(
  actorId: string | undefined,
  action: string,
  entity: string,
  entityId?: string,
  metadata?: object,
  provenance?: AuditProvenance
) {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      entity,
      entityId,
      metadata,
      // Spread rather than assign field-by-field so an absent provenance writes nothing at all and
      // the row is byte-identical to what this function produced before the parameter existed.
      ...(provenance ?? {})
    }
  });
}
