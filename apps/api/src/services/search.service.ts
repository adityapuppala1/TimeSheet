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
 * WHY NO PEOPLE GROUP YET: no page can be deep-linked to one person (Team has no `?user=`, Users
 * has no `?search=`). A result you cannot open is noise; the group is added the day a target
 * exists. Recorded in the V12 state file.
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
export interface QuickSearchResult {
  tickets: TicketHit[];
  projects: ProjectHit[];
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
  if (q.length < SEARCH_MIN_LENGTH) return { tickets: [], projects: [] };

  const scope = await ticketProjectScope(req);
  const projectWhere = scope.unrestricted ? {} : { id: { in: scope.projectIds } };
  const ticketProjectWhere = scope.unrestricted ? {} : { projectId: { in: scope.projectIds } };
  const canSeeTickets = Boolean(req.user?.permissions?.includes(permissions.TICKETS_VIEW));

  const [projects, tickets] = await Promise.all([
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
            OR: [{ key: { contains: q } }, { title: { contains: q } }]
          },
          select: { id: true, key: true, title: true, status: true, project: { select: { name: true } } },
          orderBy: { updatedAt: "desc" },
          // Over-fetch so a key-prefix hit further down still surfaces after ranking.
          take: SEARCH_LIMIT * 4
        })
      : Promise.resolve([])
  ]);

  return {
    projects,
    tickets: rankTickets(q, tickets)
      .slice(0, SEARCH_LIMIT)
      .map((t) => ({ id: t.id, key: t.key, title: t.title, status: t.status, projectName: t.project.name }))
  };
}
