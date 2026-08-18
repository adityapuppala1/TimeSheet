/**
 * WHAT: the one definition of "how many seats is this workspace using".
 *
 * WHY IT IS A FUNCTION AND NOT A `where` CLAUSE COPIED FIVE TIMES (it was, until V8 phase 3): the
 * predicate now has to exclude agent identities, and it is asked in five places — the billing
 * panel, SCIM provisioning, manual user creation, bulk user creation, and SSO self-provisioning.
 * Five copies means the next exclusion lands in four of them, and the one it misses is a billing
 * bug nobody notices until a customer is charged for robots.
 *
 * WHY AGENTS DO NOT CONSUME A SEAT (decision 2, docs/AGENTIC_WORK_MANAGEMENT.md §7): an
 * `AgentProfile`'s identity is a real `User` row precisely so that assignment, workload, audit and
 * attestation keep working unchanged. It is not a person, nobody logs in as it, and charging for it
 * would make the roster a per-agent upsell by accident.
 *
 * WHO CALLS THIS: billing.controller, scim.controller, user.controller (x2), auth.service.
 */
import { prisma } from "../config/prisma.js";

/** Active human accounts. `isAgent: false` rather than a truthiness check so the column's default
 *  does the work on every pre-V8 row. */
export async function countActiveSeats(): Promise<number> {
  return prisma.user.count({ where: { status: "ACTIVE", deletedAt: null, isAgent: false } });
}
