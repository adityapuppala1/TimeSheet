/**
 * Where a security finding belongs: repository → project, file path → module.
 *
 * WHY THIS FILE IS NOT A SET OF MOCK-CALL ASSERTIONS. Every claim here is a claim about an ANSWER —
 * which project, which module, which of several overlapping rules won — and a test that checked
 * only which prisma methods were called could not tell a correct first-match from an arbitrary one.
 *
 * THE STAND-IN SORTS. `findMany` below honours the `orderBy` it is handed rather than returning
 * insertion order, and the rules in every ordering test are INSERTED in the opposite order to the
 * one they should evaluate in. Without both of those, "first match wins by `order`" would pass on a
 * service that never asked for an order at all — which is precisely the bug this whole model exists
 * to fix, so it is the one that must not be able to hide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  [key: string]: any;
}

const repositoryMaps: Row[] = [];
const modulePathRules: Row[] = [];
let fallbackProjectId: string | null = null;
let seq = 0;

/** The slice of Prisma this service uses: an equality `where`, and a multi-clause `orderBy`. */
function ruleTable(rows: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {}, orderBy = [] }: { where?: Record<string, unknown>; orderBy?: any } = {}) => {
      const filtered = rows.filter((row) => Object.entries(where).every(([key, value]) => (row[key] ?? null) === (value ?? null)));
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
    ingestionSettings: { findUnique: vi.fn(async () => ({ id: "global", fallbackProjectId })) },
    get repositoryMap() {
      return ruleTable(repositoryMaps);
    },
    get modulePathRule() {
      return ruleTable(modulePathRules);
    }
  }
}));

const { loadFindingRoutingRules, resolveFindingLocation, repositoryFromPrUrl } = await import("../../src/services/finding-routing.service.js");

function addRepositoryMap(overrides: Row = {}): Row {
  seq += 1;
  const rule = { id: `repo-${seq}`, pattern: "acme/**", projectId: "project-web", isActive: true, order: 0, createdAt: new Date(2026, 0, seq), ...overrides };
  repositoryMaps.push(rule);
  return rule;
}

function addPathRule(overrides: Row = {}): Row {
  seq += 1;
  const rule = {
    id: `path-${seq}`,
    projectId: "project-web",
    pattern: "**",
    moduleId: "module-core",
    submoduleId: null,
    isActive: true,
    order: 0,
    createdAt: new Date(2026, 0, seq),
    ...overrides
  };
  modulePathRules.push(rule);
  return rule;
}

async function resolve(finding: { repository?: string | null; filePath?: string | null }) {
  return resolveFindingLocation(await loadFindingRoutingRules(), finding);
}

beforeEach(() => {
  repositoryMaps.length = 0;
  modulePathRules.length = 0;
  fallbackProjectId = "project-fallback";
  seq = 0;
});

describe("a workspace with no rules configured", () => {
  it("routes exactly the way it did before any of this existed", async () => {
    // THE REGRESSION TEST THAT PROTECTS EXISTING CUSTOMERS. Nothing configured means the fallback
    // project and no module — which is the behaviour every workspace has today. If this ever fails,
    // an upgrade changed where somebody's tickets go without them asking for it.
    const location = await resolve({ repository: "acme/web-app", filePath: "apps/api/src/services/billing-rate.service.ts" });

    expect(location).toEqual({
      projectId: "project-fallback",
      moduleId: null,
      submoduleId: null,
      matchedRepositoryMapId: null,
      matchedModulePathRuleId: null,
      usedFallbackProject: true
    });
  });

  it("routes nothing at all when auto-ticket-creation is off too", async () => {
    fallbackProjectId = null;
    expect(await resolve({ repository: "acme/web-app", filePath: "src/db.ts" })).toMatchObject({ projectId: null, moduleId: null });
  });
});

describe("repository → project", () => {
  it("uses the first matching rule in `order`, not the first one created", async () => {
    // Inserted broad-first, on purpose: a service that ignored `order` would return project-web.
    addRepositoryMap({ id: "broad", pattern: "acme/**", projectId: "project-web", order: 10 });
    addRepositoryMap({ id: "specific", pattern: "acme/billing-api", projectId: "project-billing", order: 1 });

    const location = await resolve({ repository: "acme/billing-api" });
    expect(location.projectId).toBe("project-billing");
    expect(location.matchedRepositoryMapId).toBe("specific");
    expect(location.usedFallbackProject).toBe(false);
  });

  it("gives the opposite answer when the order is reversed, which is the whole point of having one", async () => {
    addRepositoryMap({ id: "broad", pattern: "acme/**", projectId: "project-web", order: 1 });
    addRepositoryMap({ id: "specific", pattern: "acme/billing-api", projectId: "project-billing", order: 10 });

    expect((await resolve({ repository: "acme/billing-api" })).matchedRepositoryMapId).toBe("broad");
  });

  it("breaks a tie on equal `order` by creation time, so the winner is never arbitrary", async () => {
    addRepositoryMap({ id: "second", pattern: "acme/**", projectId: "project-late", order: 5, createdAt: new Date(2026, 5, 2) });
    addRepositoryMap({ id: "first", pattern: "acme/**", projectId: "project-early", order: 5, createdAt: new Date(2026, 5, 1) });

    expect((await resolve({ repository: "acme/anything" })).matchedRepositoryMapId).toBe("first");
  });

  it("ignores a deactivated rule", async () => {
    addRepositoryMap({ id: "off", pattern: "acme/**", projectId: "project-web", order: 1, isActive: false });
    expect((await resolve({ repository: "acme/web-app" })).projectId).toBe("project-fallback");
  });

  it("falls back when nothing matches, and says that is what happened", async () => {
    addRepositoryMap({ pattern: "other-org/**", projectId: "project-web" });
    const location = await resolve({ repository: "acme/web-app" });
    expect(location.projectId).toBe("project-fallback");
    expect(location.usedFallbackProject).toBe(true);
  });

  it("falls back for a finding that carries no repository at all", async () => {
    // A DAST or hand-uploaded finding has no repository. That is not an error, it is a finding the
    // repository step has nothing to say about.
    addRepositoryMap({ pattern: "acme/**", projectId: "project-web" });
    expect((await resolve({ filePath: "src/db.ts" })).projectId).toBe("project-fallback");
  });
});

describe("file path → module", () => {
  it("resolves the module and submodule of the first matching rule", async () => {
    addRepositoryMap({ pattern: "acme/**", projectId: "project-web", order: 1 });
    addPathRule({ id: "catch-all", pattern: "**", moduleId: "module-core", order: 99 });
    addPathRule({ id: "billing", pattern: "apps/api/src/services/billing-", moduleId: "module-billing", submoduleId: "submodule-rates", order: 1 });

    const location = await resolve({ repository: "acme/web-app", filePath: "apps/api/src/services/billing-rate.service.ts" });
    expect(location).toMatchObject({
      projectId: "project-web",
      moduleId: "module-billing",
      submoduleId: "submodule-rates",
      matchedModulePathRuleId: "billing"
    });
  });

  it("only considers rules belonging to the project the repository step resolved", async () => {
    // The reason path rules carry a project at all: `src/api/**` means different things in two
    // products, and an admin must not have to disambiguate it in the pattern.
    addRepositoryMap({ pattern: "acme/web-app", projectId: "project-web", order: 1 });
    addPathRule({ id: "other-project", projectId: "project-billing", pattern: "src/**", moduleId: "module-wrong", order: 1 });

    const location = await resolve({ repository: "acme/web-app", filePath: "src/db.ts" });
    expect(location.projectId).toBe("project-web");
    expect(location.moduleId).toBeNull();
  });

  it("leaves the module null when no rule matches, and that is not a failure", async () => {
    addRepositoryMap({ pattern: "acme/**", projectId: "project-web", order: 1 });
    addPathRule({ pattern: "packages/**", moduleId: "module-shared", order: 1 });

    const location = await resolve({ repository: "acme/web-app", filePath: "apps/api/src/db.ts" });
    expect(location).toMatchObject({ projectId: "project-web", moduleId: null, matchedModulePathRuleId: null });
  });

  it("leaves the module null for a finding with no file path", async () => {
    addRepositoryMap({ pattern: "acme/**", projectId: "project-web", order: 1 });
    addPathRule({ pattern: "**", moduleId: "module-core", order: 1 });

    expect((await resolve({ repository: "acme/web-app" })).moduleId).toBeNull();
  });

  it("applies path rules to the FALLBACK project too, so a workspace can route without repository rules", async () => {
    addPathRule({ projectId: "project-fallback", pattern: "apps/api/**", moduleId: "module-api", order: 1 });

    const location = await resolve({ repository: "acme/web-app", filePath: "apps/api/src/db.ts" });
    expect(location).toMatchObject({ projectId: "project-fallback", moduleId: "module-api", usedFallbackProject: true });
  });
});

/**
 * The adapter that lets a CI failure use the repository step at all. A `TestRun` has no repository
 * column — the PR URL is the only place the repository is written down — and the answer has to come
 * out in the SAME `owner/name` form `normalizeGitWebhook` records, or it is compared against
 * `RepositoryMap` patterns that were written for a different string.
 *
 * EVERY UNKNOWN SHAPE MUST ANSWER NULL rather than a guess. A wrong repository does not fail
 * loudly; it matches somebody else's rule and files the ticket against the wrong product.
 */
describe("the repository a pull-request URL names", () => {
  it("reads the provider shapes this app supports", () => {
    expect(repositoryFromPrUrl("https://github.com/acme/web-app/pull/12")).toBe("acme/web-app");
    expect(repositoryFromPrUrl("https://git.acme.test/acme/web-app/pulls/12")).toBe("acme/web-app"); // Gitea / Forgejo
    expect(repositoryFromPrUrl("https://bitbucket.org/acme/web-app/pull-requests/12")).toBe("acme/web-app");
    expect(repositoryFromPrUrl("https://gitlab.com/acme/web-app/-/merge_requests/12")).toBe("acme/web-app");
  });

  it("keeps a GitLab subgroup, because that is what GitLab calls the repository", () => {
    // `path_with_namespace`, which is the string the GitLab webhook reports and therefore the one
    // an admin's RepositoryMap pattern was written against.
    expect(repositoryFromPrUrl("https://gitlab.com/acme/platform/web-app/-/merge_requests/12")).toBe("acme/platform/web-app");
  });

  it("reads Azure DevOps as project/repo rather than everything before the marker", () => {
    // `…/{org}/{project}/_git/{repo}/pullrequest/{id}` — the org is not part of the name this app
    // records, so a naive "cut at the marker" would produce `acme-org/Payments/_git/billing-api`.
    expect(repositoryFromPrUrl("https://dev.azure.com/acme-org/Payments/_git/billing-api/pullrequest/44")).toBe("Payments/billing-api");
    expect(repositoryFromPrUrl("https://acme-org.visualstudio.com/Payments/_git/billing-api/pullrequest/44")).toBe("Payments/billing-api");
  });

  it("answers null rather than guessing, for everything it does not recognise", () => {
    expect(repositoryFromPrUrl(null)).toBeNull();
    expect(repositoryFromPrUrl("   ")).toBeNull();
    expect(repositoryFromPrUrl("see the build log")).toBeNull(); // free text, not a URL
    expect(repositoryFromPrUrl("https://github.com/acme/web-app")).toBeNull(); // a repo link, not a PR
    expect(repositoryFromPrUrl("https://ci.acme.test/job/build/1041/")).toBeNull(); // no PR at all
  });
});

describe("a rule whose pattern cannot be compiled", () => {
  it("is reported once and simply never matches, rather than failing anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    addRepositoryMap({ id: "broken", pattern: "   ", projectId: "project-web", order: 1 });
    addRepositoryMap({ id: "sound", pattern: "acme/**", projectId: "project-web", order: 2 });

    const location = await resolve({ repository: "acme/web-app" });

    expect(location.matchedRepositoryMapId).toBe("sound");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
    warn.mockRestore();
  });
});
