/**
 * WHAT: answers "which part of the product is this security finding in?" — the repository the
 * scanner named becomes a PROJECT, and the file path becomes a MODULE and optionally a SUBMODULE.
 * WHY IT EXISTS: every auto-created security ticket used to land in
 * `IngestionSettings.fallbackProjectId` and be assigned via whichever module on that project
 * happened to own a `ModuleAssigneeRule` first — "the first module created that has one", which is
 * arbitrary dressed up as a rule. A finding in `services/billing-*.ts` should reach the people who
 * own billing, in the project that owns billing. Nothing in this app mapped a repository to a
 * project or a path to a module; `RepositoryMap` and `ModulePathRule` are that map and this is the
 * code that reads it.
 * WHO calls this: controllers/devops-webhook.controller.ts (once per ingest batch — see below),
 * controllers/settings.controller.ts (the VAPT upload, the other ingest path),
 * services/security-report.service.ts (auto-ticket creation and assignment), and
 * controllers/finding-routing.controller.ts (CRUD plus the admin's dry-run).
 *
 * ── LOAD ONCE, MATCH MANY ─────────────────────────────────────────────────────────────────────
 *
 * `loadFindingRoutingRules` is three queries. `resolveFindingLocation` is pure string work against
 * their result. That split is not tidiness — the findings webhook accepts 500 findings in one HTTP
 * request, and the AI-triage cap in devops-webhook.controller.ts exists precisely because
 * per-finding work on that route is how one request becomes a storm. A per-finding query here would
 * have re-introduced the same shape one layer down. So the rules are read once per batch and every
 * finding is matched against the same in-memory snapshot.
 *
 * The snapshot is also why the matching is deliberately NOT expressed as a SQL filter: MySQL's
 * default collation is case-insensitive and utils/path-pattern.ts is case-sensitive, so a WHERE
 * clause would quietly disagree with the matcher about whether `src/Billing.ts` and
 * `src/billing.ts` are the same file.
 *
 * ── NO ROUTING DECISION IS ALLOWED TO FAIL AN INGEST ──────────────────────────────────────────
 *
 * Every step is optional and every step's failure mode is "no answer", never an exception: no
 * repository map match falls back to `fallbackProjectId` exactly as before this file existed, no
 * path rule match leaves the module null, and a pattern that will not compile is logged once and
 * never matches. A workspace that configures neither model sees precisely the behaviour it had.
 * A database that cannot be read is the one thing that is NOT swallowed here — it is not a routing
 * outcome, and the ingest routes already wrap these calls in the `.catch` that decides to carry on.
 *
 * NOT A FINDING TYPE'S CONCERN. Resolution reads a repository and a file path and nothing else —
 * no `SecurityFindingType` is mentioned anywhere below — so a new kind of finding routes through
 * this without a line changing here.
 *
 * NOT A FINDING'S CONCERN EITHER, since 5.0.0. A CI failure has no repository column and no file
 * path, but its `TestRun` carries a `prUrl` that names the repository — `repositoryFromPrUrl` at
 * the bottom of this file turns one into the other so `maybeAutoCreateTicketForCiFailure` routes
 * through the SAME two steps rather than growing a second, quietly different answer.
 */
import { prisma } from "../config/prisma.js";
import { compilePathPattern, matchCompiledPathPattern, type CompiledPathPattern } from "../utils/path-pattern.js";

/** One rule with its pattern already compiled. A null `compiled` is a rule whose pattern could not
 *  be used — kept in the list rather than dropped so a caller can still report it, and skipped by
 *  every match. */
interface CompiledRule<T> {
  rule: T;
  compiled: CompiledPathPattern | null;
}

export interface RepositoryMapRule {
  id: string;
  pattern: string;
  projectId: string;
}

export interface ModulePathRuleRow {
  id: string;
  projectId: string;
  pattern: string;
  moduleId: string;
  submoduleId: string | null;
}

export interface FindingRoutingRules {
  /** `IngestionSettings.fallbackProjectId` — the else-branch of the repository step, unchanged. */
  fallbackProjectId: string | null;
  /** Ordered: `order` ascending, then `createdAt`. First match wins, so the order IS the rule. */
  repositoryMaps: Array<CompiledRule<RepositoryMapRule>>;
  modulePathRules: Array<CompiledRule<ModulePathRuleRow>>;
}

/** What a workspace with nothing configured, or a workspace whose rules could not be read, routes
 *  with: the fallback project only. Exported so callers degrading on an error degrade to something
 *  named rather than to an object literal that looks like a decision. */
export const NO_FINDING_ROUTING_RULES: FindingRoutingRules = {
  fallbackProjectId: null,
  repositoryMaps: [],
  modulePathRules: []
};

export interface ResolvedFindingLocation {
  /** The project the ticket belongs in — a matched `RepositoryMap`, else `fallbackProjectId`, else
   *  null (auto-ticket-creation is off and there is nowhere to put it). */
  projectId: string | null;
  moduleId: string | null;
  submoduleId: string | null;
  /** Which rules decided it. Null everywhere is a legitimate answer; the dry-run renders these so
   *  an admin can see WHICH of several overlapping rules actually won. */
  matchedRepositoryMapId: string | null;
  matchedModulePathRuleId: string | null;
  /** True when no repository map matched and the fallback project was used — the case that must
   *  keep behaving exactly as it did before any of this existed. */
  usedFallbackProject: boolean;
}

const UNROUTED: ResolvedFindingLocation = {
  projectId: null,
  moduleId: null,
  submoduleId: null,
  matchedRepositoryMapId: null,
  matchedModulePathRuleId: null,
  usedFallbackProject: false
};

function compileAll<T extends { id: string; pattern: string }>(rules: T[], kind: string): Array<CompiledRule<T>> {
  return rules.map((rule) => {
    const compiled = compilePathPattern(rule.pattern);
    if (!compiled) {
      // Said once per load rather than once per finding, and never thrown: a pattern nobody can
      // parse is a rule that does not route, not an ingest that fails.
      console.warn(`[finding-routing] ${kind} ${rule.id} has an unusable pattern ${JSON.stringify(rule.pattern)} — it will never match.`);
    }
    return { rule, compiled };
  });
}

/**
 * Reads every active rule in this tenant, in evaluation order, with its pattern compiled.
 *
 * `order` ascending decides, `createdAt` breaks a tie — the same ordering `TicketRule` documents,
 * so an admin reasons about rule order identically in both places. Note there is no WHERE clause on
 * a pattern anywhere: see this file's header for why that is deliberate rather than lazy.
 */
export async function loadFindingRoutingRules(): Promise<FindingRoutingRules> {
  const [settings, repositoryMaps, modulePathRules] = await Promise.all([
    prisma.ingestionSettings.findUnique({ where: { id: "global" } }),
    prisma.repositoryMap.findMany({
      where: { isActive: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true, pattern: true, projectId: true }
    }),
    prisma.modulePathRule.findMany({
      where: { isActive: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true, projectId: true, pattern: true, moduleId: true, submoduleId: true }
    })
  ]);

  return {
    fallbackProjectId: settings?.fallbackProjectId ?? null,
    repositoryMaps: compileAll(repositoryMaps, "RepositoryMap"),
    modulePathRules: compileAll(modulePathRules, "ModulePathRule")
  };
}

/**
 * The two-step resolution, pure and total.
 *
 *   (a) REPOSITORY → PROJECT. First active `RepositoryMap` whose pattern matches the finding's
 *       repository wins. No match — including a finding that carries no repository at all — falls
 *       back to `IngestionSettings.fallbackProjectId`, which is exactly what happened before this
 *       step existed and is what a workspace with nothing configured keeps doing.
 *   (b) FILE PATH → MODULE (+ SUBMODULE). First active `ModulePathRule` BELONGING TO THAT PROJECT
 *       whose pattern matches the finding's file path wins. Scoping to the project is what lets
 *       `src/api/**` mean two different things in two different projects.
 *
 * Either step may come up empty and that is not a failure. A finding with no module is stored with
 * a null module, counted in every total it was always counted in, and simply left out of the
 * per-module breakdown until somebody writes a rule for it.
 */
export function resolveFindingLocation(
  rules: FindingRoutingRules,
  finding: { repository?: string | null; filePath?: string | null }
): ResolvedFindingLocation {
  // (a) repository → project.
  const repository = finding.repository?.trim();
  const repositoryHit = repository
    ? rules.repositoryMaps.find((entry) => entry.compiled && matchCompiledPathPattern(entry.compiled, repository))
    : undefined;

  const projectId = repositoryHit?.rule.projectId ?? rules.fallbackProjectId;
  if (!projectId) return UNROUTED;

  const base: ResolvedFindingLocation = {
    projectId,
    moduleId: null,
    submoduleId: null,
    matchedRepositoryMapId: repositoryHit?.rule.id ?? null,
    matchedModulePathRuleId: null,
    usedFallbackProject: !repositoryHit
  };

  // (b) file path → module/submodule, within that project only.
  const filePath = finding.filePath?.trim();
  if (!filePath) return base;

  const pathHit = rules.modulePathRules.find(
    (entry) => entry.rule.projectId === projectId && entry.compiled && matchCompiledPathPattern(entry.compiled, filePath)
  );
  if (!pathHit) return base;

  return {
    ...base,
    moduleId: pathHit.rule.moduleId,
    submoduleId: pathHit.rule.submoduleId,
    matchedModulePathRuleId: pathHit.rule.id
  };
}

/**
 * Load-and-resolve for the callers that hold ONE finding rather than a batch — auto-ticket creation
 * (security-report.service.ts) and the admin dry-run. The two ingest paths load the rules
 * themselves and reuse the snapshot across the batch; this is for the callers where that snapshot
 * would be a snapshot of one.
 *
 * Deliberately does NOT swallow a database error: an unreadable rule table is not the same event as
 * an unmatched pattern, and the two call sites want opposite things from it (the dry-run should say
 * it failed; the ingest routes already wrap their calls in the `.catch` that decides to carry on).
 * Hiding it here would take that choice away from both.
 */
export async function resolveFindingLocationLive(finding: {
  repository?: string | null;
  filePath?: string | null;
}): Promise<ResolvedFindingLocation> {
  return resolveFindingLocation(await loadFindingRoutingRules(), finding);
}

/**
 * The path segments that separate a repository from the rest of a pull-request URL, one per
 * provider this app receives webhooks from (git-webhook-providers.ts): GitHub and Gitea/Forgejo
 * `/pull/` or `/pulls/`, Bitbucket `/pull-requests/`, GitLab `/-/merge_requests/`, Azure DevOps
 * `/pullrequest/`. GitLab's `-` is listed because everything before it is the
 * `path_with_namespace` GitLab itself reports as the repository, subgroups included.
 */
const PR_URL_MARKERS = new Set(["pull", "pulls", "pull-requests", "pullrequests", "merge_requests", "pullrequest", "-"]);

/**
 * The repository a pull-request URL names, in the same `owner/name` form every ingest path reports
 * it in — so a `TestRun`, which carries a `prUrl` and no `repository` column, can still be routed
 * by `resolveFindingLocation` instead of always landing on the fallback project.
 *
 * BEST-EFFORT, AND THAT IS THE CONTRACT. Every failure returns null and the caller falls back
 * exactly as it did before: a URL that will not parse, one whose shape names no repository, a
 * provider nobody here has seen. Guessing would be worse than not answering — a wrong repository
 * matches somebody else's `RepositoryMap` and files the ticket against the wrong product, which is
 * harder to notice than a ticket sitting in the fallback project where it always sat.
 *
 * Azure DevOps is the one shape that is not "everything before the marker": its URLs read
 * `…/{org}/{project}/_git/{repo}/pullrequest/{id}`, and the repository this app records for Azure
 * (see `normalizeGitWebhook`) is `{project}/{repo}` — the segments either side of `_git`, not the
 * org that precedes them.
 */
export function repositoryFromPrUrl(prUrl: string | null | undefined): string | null {
  const raw = prUrl?.trim();
  if (!raw) return null;

  let segments: string[];
  try {
    segments = new URL(raw).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // Free text typed into the Dev tab, a relative link, a truncated value — not a URL.
  }

  const gitIndex = segments.indexOf("_git");
  if (gitIndex > 0 && segments[gitIndex + 1]) return `${segments[gitIndex - 1]}/${segments[gitIndex + 1]}`;

  const markerIndex = segments.findIndex((segment) => PR_URL_MARKERS.has(segment));
  // Two segments minimum: one path element before the marker is a provider shape this does not
  // know, and half a repository name matches nothing useful anyway.
  if (markerIndex < 2) return null;
  return segments.slice(0, markerIndex).join("/");
}
