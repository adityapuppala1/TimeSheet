/**
 * WHAT: one answer to "given a user id, what is this caller allowed to do" — plus the identity an
 * AI agent run borrows in order to have an answer at all.
 *
 * WHY THIS FILE EXISTS: `middleware/auth.ts#requireAuth` builds `req.user` for web callers, and
 * `mcp.service.ts#resolveMcpPrincipal` built the same shape again for MCP callers. Two copies were
 * tolerable. A third, written for the agent runtime, would not be — every authorization helper in
 * this codebase (`requirePermission`, `ticketProjectScope`, `assertTicketVisible`,
 * `canModifyTicket`, team's `managerId` predicate, project's `visibilityScope`) decides from that
 * shape, so a surface that builds it slightly differently is a surface with slightly different
 * authority, and nobody finds out which way until it matters.
 *
 * THE RULE THIS FILE ENCODES, AND THE ONE MOST WORTH NOT GETTING WRONG:
 *
 *   AN AGENT IS A DELEGATION OF A NAMED PERSON, NEVER A PRINCIPAL WITH RIGHTS OF ITS OWN.
 *
 * Every agent run carries the id of the human who is accountable for it, and every permission
 * check runs as that person — refused exactly what they would be refused. `AGENT_SYSTEM_EMAIL`
 * below is NOT an exception to that: it exists only to satisfy required foreign keys like
 * `Ticket.reporterId` and `TicketComment.authorId`, where the honest answer to "who wrote this" is
 * a machine. It is deliberately an ordinary employee-role account with an unusable password, and
 * nothing should ever check permissions against it.
 *
 * The argument is already written in this repo, for the same reason, at `McpCredential.userId`:
 * a credential with no acting user would have to skip the authorization helpers or reimplement
 * them, and both roads end with an integration holding more authority than any human in the
 * workspace. An agent with its own role is that same mistake wearing a different name.
 */
import type { RequestUser } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";

/**
 * Reporter/author of record for rows an AI agent creates.
 *
 * Follows the four accounts that already exist for the same purpose (email intake, chat intake,
 * security ingestion, git integration) — see `prisma/seed.ts`. Like those, it is filtered out of
 * user lists and the org chart by `controllers/team.controller.ts`, because it is not a person.
 *
 * Created by migration rather than by `seed.ts`: the seed is a one-time bootstrap that never runs
 * again on an existing workspace, so an account added there would exist only in databases created
 * after this release.
 */
export const AGENT_SYSTEM_EMAIL = "ai-agent@system.local";

/**
 * Load a user id into the exact `req.user` shape `requireAuth` produces — role name and the full
 * flattened permission key list.
 *
 * Returns null for every reason a caller should not be acting: no such user, soft-deleted, or not
 * ACTIVE. Callers turn that into one indistinguishable refusal; this function deliberately does
 * not say which of the three it was.
 *
 * NOTE what is NOT here: no maintenance-mode check, no session lookup, no token verification.
 * Those belong to the surfaces — `requireAuth` owns sessions, `resolveMcpPrincipal` owns tokens
 * and applies the maintenance gate, the agent runtime applies its own. This function answers one
 * question only, so that the answer cannot drift between them.
 */
export async function loadRequestUser(userId: string): Promise<RequestUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } }
  });
  if (!user || user.deletedAt || user.status !== "ACTIVE") return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions.map((p) => p.permission.key)
  };
}
