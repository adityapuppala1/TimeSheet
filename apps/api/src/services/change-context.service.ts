/**
 * WHAT: everything about a change that can be DERIVED rather than typed — the repositories and pull
 * requests it ships, whether their CI is green, what security findings are open against them, who
 * did the work and how many hours it took, and how the last few changes to the same application
 * went.
 *
 * WHY IT IS DERIVED AND NOT A FORM: a change links the tickets it delivers, those tickets already
 * carry `TicketBranch` rows (repository, branch, PR and merge state, kept live by
 * `git-webhook.controller.ts`), and CI runs and scanner findings hang off the same tickets. Asking
 * somebody to retype any of that produces a second copy that is wrong the moment a PR merges. A
 * derived value is also auditable in a way a typed one is not: it can be recomputed and checked,
 * and it costs nothing.
 *
 * WHY IT MATTERS EVEN WITH AI SWITCHED OFF, which is the point of building it first: this powers the
 * autofill when tickets are tagged and the Context tab an approver reads before deciding. Neither
 * needs a model. When AI *is* on, this is the context the drafting capabilities are handed — a model
 * asked for a backout plan with no context does markedly worse than one told which service is
 * changing and how its last three deploys went. See docs/AI_AND_AUTOMATION_FOR_CHANGE.md.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: write anything, or decide anything. Every figure here is a
 * reading of rows that already exist. The change's own fields are never updated from it — the raise
 * form offers them as prefilled values a person confirms.
 *
 * WHO CALLS THIS: `change.controller.ts` (`GET /changes/:id/context`).
 */
import { prisma } from "../config/prisma.js";

/** How many prior changes on the same application are worth looking at. Enough to see a pattern,
 *  few enough to read. */
const HISTORY_LIMIT = 5;

export interface ChangeContextRepo {
  repository: string;
  branches: string[];
  pullRequests: Array<{ url: string; status: string; branch: string; ticketKey: string }>;
  /** The most recent ingested CI run touching any of these branches, or null when nothing has been
   *  ingested. Null is not "passing" — it means nobody has told us, which is a different fact and
   *  the one an approver needs. */
  latestCi: { status: string; provider: string; branch: string | null; passCount: number | null; failCount: number | null; at: string } | null;
  openFindings: { critical: number; high: number; medium: number; low: number };
}

export interface ChangeContext {
  /** The tickets this change delivers, with what each carries. */
  tickets: Array<{
    id: string;
    key: string;
    title: string;
    status: string;
    assignee: string | null;
    /** Approved hours only. Draft and rejected time is not a claim anybody has stood behind. */
    approvedHours: number;
  }>;
  repositories: ChangeContextRepo[];
  /** Distinct people who worked the linked tickets, and what they logged. The implementer is often
   *  not the only one, and a change that names one person when four did the work reads wrong in a
   *  review. */
  contributors: Array<{ id: string; name: string; approvedHours: number }>;
  totals: { tickets: number; repositories: number; pullRequests: number; approvedHours: number; openFindings: number };
  /** How the last few changes against the same application went. The single most useful thing an
   *  approver can be shown, and it is pure history. */
  applicationHistory: Array<{ changeKey: string; title: string; state: string; outcome: string | null; closedAt: string | null }>;
  /** Values the raise form can offer. Suggestions a person confirms — never written by this service. */
  suggestions: {
    affectedApplications: string[];
    affectedServices: string[];
    implementerId: string | null;
  };
}

const SEVERITY_KEYS = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" } as const;

/**
 * Assembles the pack for one change.
 *
 * Callers must already have checked that the viewer may see the change — this reads through the
 * change's own linked tickets and adds no scoping of its own, exactly like `CHANGE_INCLUDE` does.
 */
export async function buildChangeContext(changeId: string): Promise<ChangeContext> {
  const change = await prisma.changeRequest.findFirst({
    where: { id: changeId },
    select: {
      id: true,
      applicationId: true,
      ticket: { select: { id: true, projectId: true, assigneeId: true } },
      linkedTickets: { select: { ticketId: true } }
    }
  });
  if (!change) {
    return emptyContext();
  }

  // The change's own ticket counts too: it is where the work of the change itself is recorded, and
  // omitting it means a change with no tagged tickets shows nothing at all.
  const ticketIds = [...new Set([change.ticket.id, ...change.linkedTickets.map((l) => l.ticketId)])];

  const [tickets, branches, testRuns, findings, timesheets, history] = await Promise.all([
    prisma.ticket.findMany({
      where: { id: { in: ticketIds }, deletedAt: null },
      select: { id: true, key: true, title: true, status: true, assignee: { select: { id: true, name: true } } }
    }),
    prisma.ticketBranch.findMany({
      where: { ticketId: { in: ticketIds } },
      select: { repository: true, branch: true, prUrl: true, prStatus: true, ticket: { select: { key: true } } }
    }),
    // Newest first, so the first row per branch IS the latest without a second query.
    prisma.testRun.findMany({
      where: { ticketId: { in: ticketIds } },
      orderBy: { createdAt: "desc" },
      select: { provider: true, branch: true, status: true, passCount: true, failCount: true, createdAt: true }
    }),
    prisma.securityFinding.findMany({
      where: { ticketId: { in: ticketIds }, status: "OPEN" },
      select: { severity: true, repository: true }
    }),
    // Approved only. A draft entry is time somebody typed, not time anybody signed off, and a change
    // record that quotes unapproved hours is quoting a number that can still change.
    prisma.timesheet.findMany({
      where: { ticketId: { in: ticketIds }, status: "APPROVED", deletedAt: null },
      select: { totalHours: true, ticketId: true, user: { select: { id: true, name: true } } }
    }),
    change.applicationId
      ? prisma.changeRequest.findMany({
          where: { applicationId: change.applicationId, id: { not: change.id } },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
          select: { changeKey: true, state: true, outcome: true, closedAt: true, ticket: { select: { title: true } } }
        })
      : Promise.resolve([])
  ]);

  /* -------------------- hours, by ticket and by person -------------------- */
  const hoursByTicket = new Map<string, number>();
  const byContributor = new Map<string, { id: string; name: string; approvedHours: number }>();
  for (const t of timesheets) {
    const hours = Number(t.totalHours ?? 0);
    if (t.ticketId) hoursByTicket.set(t.ticketId, (hoursByTicket.get(t.ticketId) ?? 0) + hours);
    if (t.user) {
      const entry = byContributor.get(t.user.id) ?? { id: t.user.id, name: t.user.name, approvedHours: 0 };
      entry.approvedHours += hours;
      byContributor.set(t.user.id, entry);
    }
  }

  /* -------------------- grouped by repository -------------------- */
  const repos = new Map<string, ChangeContextRepo>();
  for (const b of branches) {
    const repo = repos.get(b.repository) ?? {
      repository: b.repository,
      branches: [],
      pullRequests: [],
      latestCi: null,
      openFindings: { critical: 0, high: 0, medium: 0, low: 0 }
    };
    if (!repo.branches.includes(b.branch)) repo.branches.push(b.branch);
    if (b.prUrl) {
      repo.pullRequests.push({ url: b.prUrl, status: String(b.prStatus), branch: b.branch, ticketKey: b.ticket.key });
    }
    repos.set(b.repository, repo);
  }

  // A CI run carries a branch but not a repository, so it is matched by branch name. Where a run has
  // no branch at all it is attached to every repo on the change rather than dropped — an ingested
  // failure nobody can see is worse than one attributed a little too widely.
  for (const repo of repos.values()) {
    const match = testRuns.find((r) => (r.branch ? repo.branches.includes(r.branch) : true));
    if (match) {
      repo.latestCi = {
        status: String(match.status),
        provider: match.provider,
        branch: match.branch,
        passCount: match.passCount,
        failCount: match.failCount,
        at: match.createdAt.toISOString()
      };
    }
  }

  let openFindingTotal = 0;
  for (const f of findings) {
    openFindingTotal += 1;
    const key = SEVERITY_KEYS[f.severity as keyof typeof SEVERITY_KEYS];
    if (!key) continue;
    // A finding names its repository as free text and may not match any linked branch; those still
    // count toward the total, they just cannot be attributed to one repo.
    const repo = f.repository ? repos.get(f.repository) : undefined;
    if (repo) repo.openFindings[key] += 1;
  }

  const repositories = [...repos.values()].sort((a, b) => a.repository.localeCompare(b.repository));

  return {
    tickets: tickets.map((t) => ({
      id: t.id,
      key: t.key,
      title: t.title,
      status: String(t.status),
      assignee: t.assignee?.name ?? null,
      approvedHours: Number((hoursByTicket.get(t.id) ?? 0).toFixed(2))
    })),
    repositories,
    contributors: [...byContributor.values()]
      .map((c) => ({ ...c, approvedHours: Number(c.approvedHours.toFixed(2)) }))
      .sort((a, b) => b.approvedHours - a.approvedHours),
    totals: {
      tickets: tickets.length,
      repositories: repositories.length,
      pullRequests: repositories.reduce((sum, r) => sum + r.pullRequests.length, 0),
      approvedHours: Number([...hoursByTicket.values()].reduce((sum, h) => sum + h, 0).toFixed(2)),
      openFindings: openFindingTotal
    },
    applicationHistory: history.map((h) => ({
      changeKey: h.changeKey,
      title: h.ticket.title,
      state: String(h.state),
      outcome: h.outcome ? String(h.outcome) : null,
      closedAt: h.closedAt ? h.closedAt.toISOString() : null
    })),
    suggestions: {
      // Repository names are the closest thing to an application list that is actually true, and
      // they are what somebody would otherwise retype into "affected applications".
      affectedApplications: repositories.map((r) => r.repository),
      affectedServices: [],
      // The person who did the most approved work is the obvious implementer, and is right more often
      // than the change's own assignee when the change was raised by a manager.
      implementerId: [...byContributor.values()].sort((a, b) => b.approvedHours - a.approvedHours)[0]?.id ?? change.ticket.assigneeId ?? null
    }
  };
}

function emptyContext(): ChangeContext {
  return {
    tickets: [],
    repositories: [],
    contributors: [],
    totals: { tickets: 0, repositories: 0, pullRequests: 0, approvedHours: 0, openFindings: 0 },
    applicationHistory: [],
    suggestions: { affectedApplications: [], affectedServices: [], implementerId: null }
  };
}
