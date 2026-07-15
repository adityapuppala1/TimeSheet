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
import { AppError } from "../middleware/error.js";

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

/** Attribution for webhook-driven writes (TicketBranch upserts, AI PR-review comments) — same
 *  seeded-system-account pattern as EMAIL_INTAKE_SYSTEM_EMAIL/CHAT_INTAKE_SYSTEM_EMAIL/
 *  SECURITY_INGESTION_SYSTEM_EMAIL (see prisma/seed.ts). Kept distinct from those three so the
 *  audit trail / comment "posted by" name clearly reads "GitHub integration", not conflated
 *  with the security-ingestion pipeline's own system account. */
export const GIT_INTEGRATION_SYSTEM_EMAIL = "git-integration@system.local";
