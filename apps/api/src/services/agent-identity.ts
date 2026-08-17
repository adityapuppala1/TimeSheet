/**
 * WHAT: the service identity an `AgentProfile` acts as, and the two constants that make its
 * boundaries checkable without a database round trip.
 *
 * WHY A REAL `User` ROW AND NOT A SECOND ACTOR TYPE (decision 2, docs/AGENTIC_WORK_MANAGEMENT.md
 * §7): every existing surface — assignment, workload, comments, `AuditLog.actorId`, attestations —
 * already takes a user id. Threading a parallel "agent" actor through all of them would touch
 * dozens of queries for no user-visible gain, and each missed site would render an agent's action
 * as "system" or as nobody at all.
 *
 * The row is fenced by three invariants, each enforced at a choke point rather than at call sites:
 *   1. NO SEAT — `seat-count.service.ts` excludes `isAgent`.
 *   2. NO LOGIN — `auth.service.ts#establishSession`, the funnel every login method terminates in.
 *   3. NO MAILBOX — `mail.service.ts#sendMail`, via the reserved address domain below.
 *
 * WHO CALLS THIS: `agent-profile.service.ts`.
 */
import { prisma } from "../config/prisma.js";
import { hashPassword, opaqueToken } from "../utils/security.js";

/**
 * `.invalid` is reserved by RFC 2606 precisely so that it can never resolve. Using it makes an
 * agent's address self-describing and lets the mail choke point recognise one with a string
 * comparison instead of a join — a guard that cannot be defeated by forgetting to filter a query.
 */
export const AGENT_MAIL_DOMAIN = "@agents.invalid";

/** Slug for the local part. Bounded and deduplicated by the caller, which owns uniqueness. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "agent"
  );
}

/**
 * Creates the identity row for a new profile.
 *
 * The password hash is random bytes nobody ever learns. That is belt-and-braces rather than the
 * actual control — `establishSession` refuses the row outright — but leaving the column empty or
 * predictable would make the guard the ONLY thing standing in the way, and a single guard is a
 * single point of removal.
 *
 * The role is EMPLOYEE: an agent's authority comes from `AiCapabilityPolicy`, never from a role, so
 * giving it anything higher would create a permission set nothing reads and somebody later trusts.
 */
export async function createAgentIdentity(params: { name: string; emoji: string }): Promise<{ id: string; email: string }> {
  const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "EMPLOYEE" } });

  const base = slugify(params.name);
  // One query rather than a retry loop: the set of agent addresses is tiny, and a collision here
  // would surface as a confusing unique-constraint error on an unrelated column.
  const taken = new Set(
    (
      await prisma.user.findMany({
        where: { isAgent: true, email: { startsWith: base } },
        select: { email: true }
      })
    ).map((u) => u.email)
  );
  let email = `${base}${AGENT_MAIL_DOMAIN}`;
  for (let n = 2; taken.has(email); n += 1) email = `${base}-${n}${AGENT_MAIL_DOMAIN}`;

  const identity = await prisma.user.create({
    data: {
      name: params.name,
      email,
      passwordHash: await hashPassword(opaqueToken()),
      isAgent: true,
      // ACTIVE so it can be an assignee and appear in workload — the entire point of the design.
      // The three invariants above are what keep "active" from meaning "can sign in" or "billable".
      status: "ACTIVE",
      roleId: employeeRole.id,
      emailVerifiedAt: new Date()
    },
    select: { id: true, email: true }
  });
  return identity;
}
