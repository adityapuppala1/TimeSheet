/**
 * What routing actually changes: where an auto-created security ticket opens, what key it gets, and
 * who it lands on.
 *
 * WHY THIS IS SEPARATE FROM finding-routing.test.ts. That file proves the RESOLUTION is right.
 * This one proves the resolution is USED — a correct answer that `maybeAutoCreateTicketForFinding`
 * quietly ignored would leave every ticket in the fallback project and every test in that file
 * still green.
 *
 * THE KEY PREFIX IS AN ASSERTION AND NOT A DETAIL. `issueTicketKey` is per-project, so a ticket
 * created in the resolved project takes that project's own prefix. If a refactor ever issued the key
 * against the fallback project and then created the ticket somewhere else, nothing would throw and
 * the ticket would simply be named after the wrong product forever. The stand-in below derives the
 * key from whichever project id it is handed, so that mistake shows up here as a wrong string.
 *
 * AND THE CI-FAILURE PATH, since 5.0.0. It shipped the deleted behaviour for a release longer than
 * the finding path did — the arbitrary "first module with an assignee rule" lookup lived on in
 * `maybeAutoCreateTicketForCiFailure`, so the same product answered one question two ways. The last
 * block below holds both halves of the correction: a CI failure routes by the repository its PR URL
 * names, and it is assigned to nobody.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  [key: string]: any;
}

const projects: Row[] = [];
const tickets: Row[] = [];
const findings: Row[] = [];
const users: Row[] = [];
const moduleAssigneeRules: Row[] = [];
const repositoryMaps: Row[] = [];
const modulePathRules: Row[] = [];
const ticketComments: Row[] = [];
let ingestionSettings: Row = {
  id: "global",
  fallbackProjectId: "project-fallback",
  codeownersAssignEnabled: false,
  autoCreateTicketOnCiFailureEnabled: true
};
let seq = 0;

function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return value !== (c.not ?? null);
      return false;
    }
    return value === (condition ?? null);
  });
}

function table(rows: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matchWhere(r, where))),
    findFirst: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.find((r) => matchWhere(r, where)) ?? null),
    findUnique: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.find((r) => matchWhere(r, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Row }) => {
      seq += 1;
      const row = { id: `row-${seq}`, ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = rows.find((r) => matchWhere(r, where))!;
      Object.assign(row, data);
      return row;
    })
  };
}

/** Ordered like the real query asks for it — see finding-routing.test.ts's header for why the
 *  stand-in has to sort rather than hand back insertion order. */
function ruleTable(rows: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {}, orderBy = [] }: { where?: Record<string, unknown>; orderBy?: any } = {}) => {
      const filtered = rows.filter((r) => matchWhere(r, where));
      const clauses: Array<Record<string, "asc" | "desc">> = Array.isArray(orderBy) ? orderBy : [orderBy];
      return [...filtered].sort((a, b) => {
        for (const clause of clauses) {
          const [key, direction] = Object.entries(clause)[0];
          if (a[key] === b[key]) continue;
          const compared = a[key] < b[key] ? -1 : 1;
          return direction === "desc" ? -compared : compared;
        }
        return 0;
      });
    })
  };
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    get ingestionSettings() {
      return { findUnique: vi.fn(async () => ingestionSettings) };
    },
    get repositoryMap() {
      return ruleTable(repositoryMaps);
    },
    get modulePathRule() {
      return ruleTable(modulePathRules);
    },
    project: table(projects),
    ticket: table(tickets),
    securityFinding: table(findings),
    user: table(users),
    moduleAssigneeRule: table(moduleAssigneeRules),
    ticketComment: table(ticketComments),
    ticketType: { findFirst: vi.fn(async () => null) },
    gitConnection: { findUnique: vi.fn(async () => ({ id: "global", encryptedAccessToken: "token" })) },
    // The auto-created ticket is written inside a transaction; the stand-in simply runs the callback
    // against the same tables, which is all this test needs from it.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ ticket: table(tickets) }))
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const dispatchNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: (...a: unknown[]) => dispatchNotification(...a),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }),
  getGlobalNotificationSettings: vi.fn().mockResolvedValue({}),
  templates: new Proxy({}, { get: () => () => "<html>body</html>" })
}));
vi.mock("../../src/services/ai.service.js", () => ({ classifyCiFailure: vi.fn(), classifySecurityFinding: vi.fn() }));

const fetchGitHubCodeowners = vi.fn();
const fetchGitHubLastCommitAuthor = vi.fn();
vi.mock("../../src/services/git-provider.service.js", () => ({
  fetchGitHubCodeowners: (...a: unknown[]) => fetchGitHubCodeowners(...a),
  fetchGitHubLastCommitAuthor: (...a: unknown[]) => fetchGitHubLastCommitAuthor(...a),
  parseCodeownersOwners: () => ["@octo-dev"]
}));

vi.mock("../../src/services/ticket.service.js", () => ({
  computeTicketDueDate: vi.fn(() => new Date("2026-09-15T12:00:00Z")),
  getGlobalTicketSettings: vi.fn().mockResolvedValue({}),
  // Derives the key from the project it is HANDED — the whole point of the prefix assertions below.
  issueTicketKey: vi.fn(async (_tx: unknown, projectId: string) => `${projects.find((p) => p.id === projectId)?.code ?? "???"}-1`)
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (v: string) => v }));

const { maybeAutoCreateTicketForFinding, maybeAutoCreateTicketForCiFailure, SECURITY_INGESTION_SYSTEM_EMAIL } = await import(
  "../../src/services/security-report.service.js"
);

const FINDING = {
  id: "finding-1",
  type: "SAST" as const,
  tool: "semgrep",
  severity: "CRITICAL" as const,
  title: "SQL injection in the invoice query",
  description: null,
  filePath: "apps/api/src/services/billing-rate.service.ts",
  lineNumber: 42,
  repository: "acme/billing-api",
  branch: "main",
  prUrl: null
};

beforeEach(() => {
  projects.length = 0;
  tickets.length = 0;
  findings.length = 0;
  users.length = 0;
  moduleAssigneeRules.length = 0;
  repositoryMaps.length = 0;
  modulePathRules.length = 0;
  ticketComments.length = 0;
  seq = 0;
  ingestionSettings = {
    id: "global",
    fallbackProjectId: "project-fallback",
    codeownersAssignEnabled: false,
    autoCreateTicketOnCiFailureEnabled: true
  };
  dispatchNotification.mockClear();
  fetchGitHubCodeowners.mockReset();
  fetchGitHubLastCommitAuthor.mockReset();

  projects.push({ id: "project-fallback", code: "WEB", name: "Web", deletedAt: null });
  projects.push({ id: "project-billing", code: "BILLING", name: "Billing", deletedAt: null });
  users.push({ id: "user-system", email: SECURITY_INGESTION_SYSTEM_EMAIL, name: "Security Ingestion", status: "ACTIVE", deletedAt: null });
  users.push({ id: "user-priya", email: "priya@acme.test", name: "Priya", githubUsername: "octo-dev", status: "ACTIVE", deletedAt: null });
  users.push({ id: "user-sam", email: "sam@acme.test", name: "Sam", status: "ACTIVE", deletedAt: null });
  findings.push({ ...FINDING, ticketId: null });
});

describe("a finding whose repository and path are both mapped", () => {
  beforeEach(() => {
    repositoryMaps.push({ id: "repo-billing", pattern: "acme/billing-*", projectId: "project-billing", isActive: true, order: 1, createdAt: new Date(2026, 0, 1) });
    modulePathRules.push({
      id: "path-rates",
      projectId: "project-billing",
      pattern: "apps/api/src/services/billing-",
      moduleId: "module-rates",
      submoduleId: "submodule-invoicing",
      isActive: true,
      order: 1,
      createdAt: new Date(2026, 0, 1)
    });
  });

  it("opens the ticket in the resolved project, with that project's own key prefix", async () => {
    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets).toHaveLength(1);
    expect(tickets[0].projectId).toBe("project-billing");
    // Not "WEB-1". The key says which product the work belongs to, and it is issued against the
    // project the ticket is actually created in.
    expect(tickets[0].key).toBe("BILLING-1");
  });

  it("records the module on the ticket, and the finding is attached to it", async () => {
    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets[0].moduleId).toBe("module-rates");
    expect(findings[0].ticketId).toBe(tickets[0].id);
  });

  it("assigns via THAT module's assignee rule, in preference to CODEOWNERS", async () => {
    // Both are configured and both would resolve somebody. The module rule has to win, or the
    // routing decided who owns the code and then handed the ticket to somebody else.
    moduleAssigneeRules.push({ id: "rule-1", moduleId: "module-rates", defaultAssigneeId: "user-sam" });
    ingestionSettings.codeownersAssignEnabled = true;
    fetchGitHubCodeowners.mockResolvedValue("apps/api/** @octo-dev");

    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets[0].assigneeId).toBe("user-sam");
    // CODEOWNERS was never consulted — this is a live GitHub call per finding, so "the module rule
    // won" and "we did not pay for a lookup we did not need" are the same assertion.
    expect(fetchGitHubCodeowners).not.toHaveBeenCalled();
    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-sam", category: "ticket.assigned" }));
  });

  it("falls through to CODEOWNERS when the resolved module has no assignee rule", async () => {
    ingestionSettings.codeownersAssignEnabled = true;
    fetchGitHubCodeowners.mockResolvedValue("apps/api/** @octo-dev");

    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets[0].assigneeId).toBe("user-priya");
  });

  it("does not borrow an assignee rule belonging to some other module", async () => {
    // The bug this whole block replaces: "the first module on the project that happens to have a
    // rule". A rule on an unrelated module must now resolve nobody.
    moduleAssigneeRules.push({ id: "rule-elsewhere", moduleId: "module-something-else", defaultAssigneeId: "user-sam" });

    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets[0].assigneeId ?? null).toBeNull();
  });
});

describe("a workspace with ZERO routing rules", () => {
  it("behaves exactly as it did before routing existed", async () => {
    // THE REGRESSION TEST THAT PROTECTS EXISTING CUSTOMERS. No repository map, no path rule: the
    // ticket opens in the fallback project, with the fallback project's key prefix, carrying no
    // module — which is what every workspace sees today.
    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets).toHaveLength(1);
    expect(tickets[0].projectId).toBe("project-fallback");
    expect(tickets[0].key).toBe("WEB-1");
    expect(tickets[0].moduleId).toBeNull();
    expect(tickets[0].assigneeId ?? null).toBeNull();
  });

  it("still reaches the CODEOWNERS chain, which is the assignment such a workspace relies on", async () => {
    ingestionSettings.codeownersAssignEnabled = true;
    fetchGitHubCodeowners.mockResolvedValue("apps/api/** @octo-dev");

    await maybeAutoCreateTicketForFinding(FINDING);

    expect(tickets[0].assigneeId).toBe("user-priya");
  });

  it("creates nothing at all when no fallback project is configured", async () => {
    ingestionSettings.fallbackProjectId = null;
    await maybeAutoCreateTicketForFinding(FINDING);
    expect(tickets).toHaveLength(0);
  });
});

describe("severity gating is unchanged", () => {
  it("ignores a MEDIUM finding however well it is routed", async () => {
    repositoryMaps.push({ id: "repo-billing", pattern: "acme/**", projectId: "project-billing", isActive: true, order: 1, createdAt: new Date(2026, 0, 1) });
    await maybeAutoCreateTicketForFinding({ ...FINDING, severity: "MEDIUM" });
    expect(tickets).toHaveLength(0);
  });
});

/**
 * A CI failure has no repository column and no file path. What it has is a PR URL, and that names
 * the repository for every provider this app receives webhooks from — so the project step is
 * answerable, the module step is not, and nobody is assigned.
 */
describe("a CI failure", () => {
  const CI_RUN = { provider: "github-actions", branch: "main", prUrl: "https://github.com/acme/billing-api/pull/12", logUrl: null };

  beforeEach(() => {
    repositoryMaps.push({ id: "repo-billing", pattern: "acme/billing-*", projectId: "project-billing", isActive: true, order: 1, createdAt: new Date(2026, 0, 1) });
  });

  it("opens in the project its PR's repository is mapped to, with that project's key prefix", async () => {
    await maybeAutoCreateTicketForCiFailure(CI_RUN);

    expect(tickets).toHaveLength(1);
    expect(tickets[0].projectId).toBe("project-billing");
    // Same claim the finding path makes, for the same reason: the key says which product broke.
    expect(tickets[0].key).toBe("BILLING-1");
  });

  it("leaves the module null, because a failed run names no file for a path rule to match", async () => {
    modulePathRules.push({
      id: "path-rates",
      projectId: "project-billing",
      pattern: "**",
      moduleId: "module-rates",
      submoduleId: null,
      isActive: true,
      order: 1,
      createdAt: new Date(2026, 0, 1)
    });

    await maybeAutoCreateTicketForCiFailure(CI_RUN);

    expect(tickets[0].moduleId ?? null).toBeNull();
  });

  it("assigns nobody, even when the project has a module that owns an assignee rule", async () => {
    // THE DELETED BEHAVIOUR. This used to find "the first module on the project with a rule" and
    // hand the ticket to its owner — a queue entry that looks handled, for somebody who has no idea
    // why it is there. It now goes to triage instead, unassigned and unannounced.
    moduleAssigneeRules.push({ id: "rule-1", moduleId: "module-rates", defaultAssigneeId: "user-sam" });

    await maybeAutoCreateTicketForCiFailure(CI_RUN);

    expect(tickets[0].assigneeId ?? null).toBeNull();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("falls back to the fallback project when no rule matches the PR's repository", async () => {
    await maybeAutoCreateTicketForCiFailure({ ...CI_RUN, prUrl: "https://github.com/other-co/marketing-site/pull/7" });

    expect(tickets[0].projectId).toBe("project-fallback");
    expect(tickets[0].key).toBe("WEB-1");
  });

  it("falls back when there is no PR URL at all, which is most CI runs", async () => {
    await maybeAutoCreateTicketForCiFailure({ ...CI_RUN, prUrl: null });

    expect(tickets[0].projectId).toBe("project-fallback");
    expect(tickets[0].key).toBe("WEB-1");
  });

  it("behaves exactly as the fallback path always did in a workspace with zero rules", async () => {
    // THE REGRESSION TEST THAT PROTECTS EXISTING CUSTOMERS, the CI-failure half. Nothing configured
    // but the fallback project: one ticket, fallback prefix, no module, no assignee.
    repositoryMaps.length = 0;

    await maybeAutoCreateTicketForCiFailure(CI_RUN);

    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ projectId: "project-fallback", key: "WEB-1", type: "BUG" });
    expect(tickets[0].moduleId ?? null).toBeNull();
    expect(tickets[0].assigneeId ?? null).toBeNull();
  });

  it("creates nothing when the toggle is off, and nothing when there is nowhere to put it", async () => {
    ingestionSettings.autoCreateTicketOnCiFailureEnabled = false;
    await maybeAutoCreateTicketForCiFailure(CI_RUN);
    expect(tickets).toHaveLength(0);

    ingestionSettings.autoCreateTicketOnCiFailureEnabled = true;
    ingestionSettings.fallbackProjectId = null;
    repositoryMaps.length = 0;
    await maybeAutoCreateTicketForCiFailure(CI_RUN);
    expect(tickets).toHaveLength(0);
  });
});
