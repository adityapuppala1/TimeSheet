/**
 * Live GitHub OAuth integration — the successor to the manual repo/branch/PR linking on
 * TicketBranch (see docs/ROADMAP.md's "Live git-provider App integration" item). Each org
 * brings its OWN GitHub OAuth App client id/secret (same model OrgSsoConfig uses for Google/
 * Microsoft SSO — see sso.service.ts's header comment for why: no TimeSphere-operated OAuth
 * client ever touches a customer's GitHub data). Once connected, this file's list* functions
 * back the Dev tab's "pick from GitHub" autocomplete instead of typing a branch/PR by hand.
 *
 * WHY a signed `state` param carries org+user identity (mirrors sso.service.ts's
 * signSsoState/verifySsoState exactly): a GitHub OAuth App has exactly ONE registered
 * callback URL, shared across every org on a SaaS deployment — so the callback can't rely on
 * the request's Host header (that's just wherever we told GitHub to redirect to) to know which
 * org's GitConnection row to write the resulting token into.
 *
 * SCOPE for this phase: read-only GitHub REST calls (list repos/branches/PRs) to populate the
 * Dev tab. No webhook receiver for push/PR events yet (that's the natural next slice — auto-
 * creating/updating TicketBranch rows from GitHub's own webhooks — deliberately left for a
 * later pass so this phase stays testable and reviewable on its own).
 */
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";

const STATE_TTL_SECONDS = 10 * 60;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_BASE = "https://api.github.com";

interface GitConnectStatePayload {
  orgId: string;
  userId: string;
}

/** Signed with the same secret as every other short-lived OAuth-redirect state in this app
 *  (see sso.service.ts#signSsoState) — carries no session-granting power on its own, it only
 *  identifies which org/admin resumes after GitHub's redirect back to our fixed callback URL. */
export function signGitConnectState(payload: GitConnectStatePayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: STATE_TTL_SECONDS, issuer: "timesphere-git" });
}

export function verifyGitConnectState(state: string): GitConnectStatePayload {
  try {
    return jwt.verify(state, env.JWT_ACCESS_SECRET, { issuer: "timesphere-git" }) as unknown as GitConnectStatePayload;
  } catch {
    throw new AppError(400, "This GitHub connection link has expired or is invalid — try connecting again from Workspace Settings.");
  }
}

export function gitCallbackUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/git/callback`;
}

export function buildGitHubAuthorizeUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: gitCallbackUrl(),
    scope: "repo read:org",
    state
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeGitHubCode(clientId: string, clientSecret: string, code: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: gitCallbackUrl() })
  });
  const data = (await response.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new AppError(422, `GitHub rejected the connection: ${data.error_description ?? "no access token returned"}`);
  }
  return data.access_token;
}

async function githubGet<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) {
    if (response.status === 401) throw new AppError(401, "GitHub access token is no longer valid — reconnect from Workspace Settings.");
    throw new AppError(response.status, `GitHub API error: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchGitHubLogin(accessToken: string): Promise<string> {
  const user = await githubGet<{ login: string }>(accessToken, "/user");
  return user.login;
}

/** Non-throwing token lookup for callers that can gracefully degrade when GitHub isn't connected
 *  (e.g. suggesting a branch name instead of creating one) — settings.controller.ts's own
 *  `requireGitAccessToken` throws 422 instead, which is correct for its routes (GitHub-picker
 *  autocomplete is useless without a connection) but wrong for a feature that still works, just
 *  less automatically, without one. */
export async function getGitAccessTokenOrNull(): Promise<string | null> {
  const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
  if (!connection?.encryptedAccessToken) return null;
  return decryptSecret(connection.encryptedAccessToken);
}

export interface GitHubRepoSummary {
  fullName: string;
  defaultBranch: string;
}

export async function listGitHubRepos(accessToken: string): Promise<GitHubRepoSummary[]> {
  const repos = await githubGet<Array<{ full_name: string; default_branch: string }>>(
    accessToken,
    "/user/repos?per_page=100&sort=updated"
  );
  return repos.map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch }));
}

export async function listGitHubBranches(accessToken: string, fullName: string): Promise<string[]> {
  const branches = await githubGet<Array<{ name: string }>>(accessToken, `/repos/${fullName}/branches?per_page=100`);
  return branches.map((b) => b.name);
}

/**
 * Creates a real branch in `fullName` (owner/repo) off `baseBranch`'s current tip — the one
 * WRITE path this integration didn't have yet; every other exported function here is read-only.
 * Two REST calls: read the base ref's SHA, then create a new ref pointing at it. Used by ticket
 * -> branch automation (ticket.controller.ts's `POST /:id/branches/auto`); the scope granted at
 * connect time (`buildGitHubAuthorizeUrl`'s "repo" scope, above) already covers ref creation, so
 * no new consent/reconnect is needed for orgs that connected before this existed.
 */
export async function createGitHubBranch(accessToken: string, fullName: string, newBranch: string, baseBranch: string): Promise<void> {
  const baseRef = await githubGet<{ object: { sha: string } }>(
    accessToken,
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(baseBranch)}`
  );

  const response = await fetch(`${GITHUB_API_BASE}/repos/${fullName}/git/refs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: baseRef.object.sha })
  });
  if (response.ok) return;

  const body = (await response.json().catch(() => ({}))) as { message?: string };
  if (response.status === 422 && (body.message ?? "").includes("Reference already exists")) {
    throw new AppError(409, `Branch "${newBranch}" already exists in ${fullName}.`);
  }
  throw new AppError(response.status, `GitHub API error creating branch: ${body.message ?? response.statusText}`);
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url: string;
  status: "OPEN" | "MERGED" | "CLOSED";
  branch: string;
}

export async function listGitHubPullRequests(accessToken: string, fullName: string): Promise<GitHubPullRequestSummary[]> {
  const pulls = await githubGet<
    Array<{ number: number; title: string; html_url: string; state: string; merged_at: string | null; head: { ref: string } }>
  >(accessToken, `/repos/${fullName}/pulls?state=all&per_page=50`);
  return pulls.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.html_url,
    status: p.merged_at ? "MERGED" : p.state === "closed" ? "CLOSED" : "OPEN",
    branch: p.head.ref
  }));
}

/** Feeds ai.service.ts#summarizePullRequest — file paths + truncated per-file patches, not the
 *  full unified diff (GitHub's `/pulls/{n}/files` already caps `patch` at ~1MB per file server-
 *  side, and the AI call itself further truncates, so this is a light proxy, not a diff viewer). */
export async function fetchGitHubPullRequestFiles(
  accessToken: string,
  fullName: string,
  prNumber: number
): Promise<Array<{ path: string; patch?: string }>> {
  const files = await githubGet<Array<{ filename: string; patch?: string }>>(
    accessToken,
    `/repos/${fullName}/pulls/${prNumber}/files?per_page=100`
  );
  return files.map((f) => ({ path: f.filename, patch: f.patch }));
}

/**
 * Posts a GitHub PR review with per-line comments — the write path
 * ai.service.ts#reviewPullRequestDiff's inline-review feature needs. `event: "COMMENT"`
 * deliberately, never `"REQUEST_CHANGES"` or `"APPROVE"` — an AI opinion should read as
 * commentary sitting alongside human review, not as a merge-blocking verdict or an approval.
 * Every `(path, line)` pair reaching this function has already been validated against the PR's
 * actual diff hunks by the caller; GitHub's own API would 422 on an invalid one regardless, so
 * this is defense in depth, not the only check.
 */
export async function postGitHubPullRequestReview(
  accessToken: string,
  fullName: string,
  prNumber: number,
  comments: Array<{ path: string; line: number; body: string }>
): Promise<void> {
  if (comments.length === 0) return;

  const response = await fetch(`${GITHUB_API_BASE}/repos/${fullName}/pulls/${prNumber}/reviews`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      event: "COMMENT",
      body: "AI-suggested review — commentary alongside your own review, not a verdict.",
      comments: comments.map((c) => ({ path: c.path, line: c.line, body: c.body }))
    })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new AppError(response.status, `GitHub API error posting PR review: ${body.message ?? response.statusText}`);
  }
}

/** Fetches a repo file's raw text content at `ref` (branch/SHA, defaults to the repo's default
 *  branch), or `null` if it doesn't exist — used for CODEOWNERS lookup below. GitHub's contents
 *  API base64-encodes file content; `githubGet` can't be reused as-is since a 404 here is an
 *  expected "no CODEOWNERS file" outcome, not an error worth throwing `AppError` for. */
async function fetchGitHubFileContent(accessToken: string, fullName: string, path: string, ref?: string): Promise<string | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await fetch(`${GITHUB_API_BASE}/repos/${fullName}/contents/${path}${query}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (response.status === 404) return null;
  if (!response.ok) return null; // best-effort — a transient GitHub error here shouldn't block the finding-ingestion request that triggered this lookup
  const data = (await response.json()) as { content?: string; encoding?: string };
  if (!data.content || data.encoding !== "base64") return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

/** CODEOWNERS lives in one of three conventional locations (root, `.github/`, `docs/`) — GitHub
 *  checks all three itself for its own native review-assignment feature, so this mirrors that. */
const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export async function fetchGitHubCodeowners(accessToken: string, fullName: string, ref?: string): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    const content = await fetchGitHubFileContent(accessToken, fullName, path, ref);
    if (content) return content;
  }
  return null;
}

/** Parses CODEOWNERS' line format (`pattern owner1 owner2 ...`, `#`-comments, blank lines
 *  ignored) and returns the raw owner tokens (still `@handle` or `team@org` form, un-stripped)
 *  for whichever pattern most specifically matches `filePath` — CODEOWNERS uses "last matching
 *  pattern wins" precedence (same as `.gitignore`), so this scans top-to-bottom and keeps
 *  overwriting the result rather than stopping at the first match. Deliberately a small,
 *  dependency-free glob subset (`*`, `**`, trailing `/`) rather than pulling in a full glob
 *  library — CODEOWNERS files in practice use a handful of simple patterns, not exotic globs. */
export function parseCodeownersOwners(codeownersText: string, filePath: string): string[] {
  const normalizedPath = filePath.replace(/^\/+/, "");
  let matched: string[] = [];
  for (const rawLine of codeownersText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (owners.length === 0) continue;
    if (codeownersPatternMatches(pattern, normalizedPath)) matched = owners;
  }
  return matched;
}

function codeownersPatternMatches(pattern: string, filePath: string): boolean {
  let p = pattern.replace(/^\/+/, "");
  const isDirPattern = p.endsWith("/");
  if (isDirPattern) p = p.slice(0, -1);
  // Translate the CODEOWNERS/gitignore-style glob subset into a regex: `**` = any depth,
  // `*` = any chars except `/`, everything else escaped literally.
  const regexSource =
    "^" +
    p
      .split("**")
      .map((segment) =>
        segment
          .split("*")
          .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*")
      )
      .join(".*") +
    (isDirPattern ? "(/.*)?$" : "$");
  try {
    return new RegExp(regexSource).test(filePath);
  } catch {
    return false; // a malformed pattern shouldn't crash finding ingestion, just fail to match
  }
}

export interface GitHubLastCommitAuthor {
  login: string | null;
  email: string | null;
}

/** Best-effort "who last touched this file" fallback for when CODEOWNERS has no match (or no
 *  file exists) — `author.login` is the GitHub login when the commit author has a linked GitHub
 *  account; falls back to `commit.author.email` (always present) when they don't, which is still
 *  useful for matching against a TimeSphere user's own email as a last resort. */
export async function fetchGitHubLastCommitAuthor(
  accessToken: string,
  fullName: string,
  filePath: string,
  branch?: string
): Promise<GitHubLastCommitAuthor | null> {
  const params = new URLSearchParams({ path: filePath, per_page: "1" });
  if (branch) params.set("sha", branch);
  const commits = await githubGet<Array<{ author: { login: string } | null; commit: { author: { email: string } | null } }>>(
    accessToken,
    `/repos/${fullName}/commits?${params.toString()}`
  ).catch(() => null);
  const first = commits?.[0];
  if (!first) return null;
  return { login: first.author?.login ?? null, email: first.commit.author?.email ?? null };
}

/** Attribution for webhook-driven writes (TicketBranch upserts, AI PR-review comments) — same
 *  seeded-system-account pattern as EMAIL_INTAKE_SYSTEM_EMAIL/CHAT_INTAKE_SYSTEM_EMAIL/
 *  SECURITY_INGESTION_SYSTEM_EMAIL (see prisma/seed.ts). Kept distinct from those three so the
 *  audit trail / comment "posted by" name clearly reads "GitHub integration", not conflated
 *  with the security-ingestion pipeline's own system account. */
export const GIT_INTEGRATION_SYSTEM_EMAIL = "git-integration@system.local";
