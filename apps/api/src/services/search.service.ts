/**
 * WHAT: the deterministic record search behind the command palette — tickets and projects, by
 * key, code, title or name, under the caller's existing visibility rules.
 *
 * WHY DETERMINISTIC AND SEPARATE FROM "ASK AI": the palette already offers a natural-language
 * search over the backlog, and it is the right tool for "what was that ticket about the login
 * loop". It is the wrong tool for "WEB-123" or "PropTech": a person who knows the key wants the
 * record, now, with no model in the loop and no spend. This is that path. It is one query per
 * type with a small cap, ranked by a rule anyone can predict.
 *
 * WHY THE SCOPE IS BORROWED, NOT WRITTEN: `ticketProjectScope` is the rule every ticket route
 * already enforces (own assignments; plus reports' for a manager; everything for an admin), and
 * the project list applies the same assignment-based rule. Search that reached past either would
 * be a data leak with an autocomplete, so both groups here read through that one helper.
 *
 * THE PEOPLE GROUP (V12 6.2) exists only for callers who may manage users, because the only page
 * that can be deep-linked to a person is Administration → Users (`?search=`), and that page is
 * gated on the same permission. Everyone else gets an empty group — never a 403, never a result
 * they could not open. Active people only, no AI agents; name or email prefix.
 */
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { ticketProjectScope } from "./ticket.service.js";

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 80;
/** Per group. The palette is a launcher, not a results page: five is what fits above the fold. */
export const SEARCH_LIMIT = 5;

export interface TicketHit {
  id: string;
  key: string;
  title: string;
  status: string;
  projectName: string;
}
export interface ProjectHit {
  id: string;
  code: string;
  name: string;
}
export interface PersonHit {
  id: string;
  name: string;
  email: string;
}
/** A change IS a ticket (change management), so it carries the ticket's key and title. */
export interface ChangeHit {
  id: string;
  key: string;
  title: string;
  state: string;
}
export interface DocHit {
  id: string;
  title: string;
  status: string;
}
export interface QuickSearchResult {
  tickets: TicketHit[];
  projects: ProjectHit[];
  people: PersonHit[];
  /** V12 8.2: the other two record types a person opens by name. */
  changes: ChangeHit[];
  docs: DocHit[];
}

/**
 * Key-prefix hits first, then title hits, each in the database's recency order. Someone who typed
 * "WEB-1" is looking for WEB-1x, not for a ticket whose title mentions "web-1". Pure, so it is
 * tested directly; the query below over-fetches so the rule has something to rank.
 */
export function rankTickets<T extends { key: string; title: string }>(q: string, rows: T[]): T[] {
  const needle = q.trim().toLowerCase();
  const byKey = rows.filter((r) => r.key.toLowerCase().startsWith(needle));
  const rest = rows.filter((r) => !r.key.toLowerCase().startsWith(needle));
  return [...byKey, ...rest];
}

export async function quickSearch(req: any, rawQuery: string): Promise<QuickSearchResult> {
  const q = rawQuery.trim().slice(0, SEARCH_MAX_LENGTH);
  if (q.length < SEARCH_MIN_LENGTH) return { tickets: [], projects: [], people: [], changes: [], docs: [] };

  const scope = await ticketProjectScope(req);
  const projectWhere = scope.unrestricted ? {} : { id: { in: scope.projectIds } };
  const ticketProjectWhere = scope.unrestricted ? {} : { projectId: { in: scope.projectIds } };
  const canSeeTickets = Boolean(req.user?.permissions?.includes(permissions.TICKETS_VIEW));
  const canManageUsers = Boolean(req.user?.permissions?.includes(permissions.USERS_MANAGE));

  const [projects, tickets, people, changes, docs] = await Promise.all([
    // A restricted caller with no assignments must get nothing, not everything: `in: []` is what
    // Prisma turns into a false predicate, so the empty list is passed through on purpose.
    prisma.project.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        ...projectWhere,
        OR: [{ name: { contains: q } }, { code: { contains: q } }]
      },
      select: { id: true, code: true, name: true, color: true },
      orderBy: { name: "asc" },
      take: SEARCH_LIMIT
    }),
    canSeeTickets
      ? prisma.ticket.findMany({
          where: {
            deletedAt: null,
            ...ticketProjectWhere,
            // A change is a ticket; it is listed under Changes (8.2), not twice.
            changeRequest: { is: null },
            OR: [{ key: { contains: q } }, { title: { contains: q } }]
          },
          select: { id: true, key: true, title: true, status: true, project: { select: { name: true } } },
          orderBy: { updatedAt: "desc" },
          // Over-fetch so a key-prefix hit further down still surfaces after ranking.
          take: SEARCH_LIMIT * 4
        })
      : Promise.resolve([]),
    canManageUsers
      ? prisma.user.findMany({
          where: {
            deletedAt: null,
            status: "ACTIVE",
            isAgent: false,
            OR: [{ name: { contains: q } }, { email: { contains: q } }]
          },
          select: { id: true, name: true, email: true },
          orderBy: { name: "asc" },
          take: SEARCH_LIMIT
        })
      : Promise.resolve([]),
    // Changes read through the SAME ticket scope the change routes enforce — a change is a ticket
    // and can never be more visible than the ticket it wraps.
    prisma.changeRequest.findMany({
      where: {
        ticket: { deletedAt: null, ...ticketProjectWhere, OR: [{ key: { contains: q } }, { title: { contains: q } }] }
      },
      select: { id: true, state: true, ticket: { select: { key: true, title: true } } },
      orderBy: { ticket: { updatedAt: "desc" } },
      take: SEARCH_LIMIT
    }),
    // Requirements documents: the Studio needs tickets:view and lists documents unscoped (they are
    // workspace documents, optionally attached to a project) — the palette mirrors exactly that.
    canSeeTickets
      ? prisma.requirementsDocument.findMany({
          where: { title: { contains: q } },
          select: { id: true, title: true, status: true },
          orderBy: { createdAt: "desc" },
          take: SEARCH_LIMIT
        })
      : Promise.resolve([])
  ]);

  return {
    projects,
    people,
    changes: changes.map((c) => ({ id: c.id, key: c.ticket.key, title: c.ticket.title, state: c.state })),
    docs,
    tickets: rankTickets(q, tickets)
      .slice(0, SEARCH_LIMIT)
      .map((t) => ({ id: t.id, key: t.key, title: t.title, status: t.status, projectName: t.project.name }))
  };
}
