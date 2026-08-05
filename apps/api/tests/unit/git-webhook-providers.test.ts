/**
 * The multi-provider webhook translators are pure functions over (headers, body, secret) — the
 * exact kind of logic that must be tested without a server, because a provider dialect mistake
 * (wrong header name, wrong state mapping) fails silently in production: the provider just sees
 * a 401 or an "ignored" and eventually disables the webhook.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeGitWebhook, verifyGitWebhook } from "../../src/services/git-webhook-providers.js";

const SECRET = "s3cret-of-considerable-entropy";
const raw = (body: unknown): Buffer => Buffer.from(JSON.stringify(body), "utf8");
const hmac = (b: Buffer): string => crypto.createHmac("sha256", SECRET).update(b).digest("hex");

describe("verifyGitWebhook", () => {
  it("gitlab: accepts the exact token, rejects a wrong one", () => {
    const body = raw({});
    const ok = verifyGitWebhook({ provider: "gitlab", secret: SECRET, rawBody: body, headers: { "x-gitlab-token": SECRET }, query: {} });
    const bad = verifyGitWebhook({ provider: "gitlab", secret: SECRET, rawBody: body, headers: { "x-gitlab-token": "nope" }, query: {} });
    expect(ok).toBe(true);
    expect(bad).toBe(false);
  });

  it("gitea/forgejo: accepts its own HMAC header and GitHub-style x-hub-signature-256", () => {
    const body = raw({ ref: "refs/heads/x" });
    expect(
      verifyGitWebhook({ provider: "gitea", secret: SECRET, rawBody: body, headers: { "x-gitea-signature": hmac(body) }, query: {} })
    ).toBe(true);
    expect(
      verifyGitWebhook({
        provider: "forgejo",
        secret: SECRET,
        rawBody: body,
        headers: { "x-hub-signature-256": `sha256=${hmac(body)}` },
        query: {}
      })
    ).toBe(true);
    expect(
      verifyGitWebhook({ provider: "gitea", secret: SECRET, rawBody: raw({ tampered: true }), headers: { "x-gitea-signature": hmac(body) }, query: {} })
    ).toBe(false);
  });

  it("bitbucket: verifies sha256= HMAC over the raw body", () => {
    const body = raw({ push: {} });
    expect(
      verifyGitWebhook({ provider: "bitbucket", secret: SECRET, rawBody: body, headers: { "x-hub-signature": `sha256=${hmac(body)}` }, query: {} })
    ).toBe(true);
  });

  it("azure-devops: accepts the secret as basic-auth password or ?token=, and nothing else", () => {
    const body = raw({});
    const basic = `Basic ${Buffer.from(`hook:${SECRET}`).toString("base64")}`;
    expect(verifyGitWebhook({ provider: "azure-devops", secret: SECRET, rawBody: body, headers: { authorization: basic }, query: {} })).toBe(true);
    expect(verifyGitWebhook({ provider: "azure-devops", secret: SECRET, rawBody: body, headers: {}, query: { token: SECRET } })).toBe(true);
    expect(verifyGitWebhook({ provider: "azure-devops", secret: SECRET, rawBody: body, headers: {}, query: {} })).toBe(false);
  });
});

describe("normalizeGitWebhook", () => {
  it("gitlab: push and merge-request events, with GitLab's own state names mapped", () => {
    const push = normalizeGitWebhook({
      provider: "gitlab",
      headers: { "x-gitlab-event": "Push Hook" },
      body: { ref: "refs/heads/WEB-12-fix", project: { path_with_namespace: "acme/app" } }
    });
    expect(push).toEqual({ kind: "push", repository: "acme/app", branch: "WEB-12-fix" });

    const merged = normalizeGitWebhook({
      provider: "gitlab",
      headers: { "x-gitlab-event": "Merge Request Hook" },
      body: {
        project: { path_with_namespace: "acme/app" },
        object_attributes: { source_branch: "WEB-12-fix", state: "merged", url: "https://gitlab.example/mr/1" }
      }
    });
    expect(merged).toMatchObject({ kind: "pr", prStatus: "MERGED", prUrl: "https://gitlab.example/mr/1" });
  });

  it("bitbucket: takes the first branch head from a push, ignores tag-only pushes", () => {
    const push = normalizeGitWebhook({
      provider: "bitbucket",
      headers: { "x-event-key": "repo:push" },
      body: {
        repository: { full_name: "acme/app" },
        push: { changes: [{ new: { type: "tag", name: "v1" } }, { new: { type: "branch", name: "OPS-3-hotfix" } }] }
      }
    });
    expect(push).toEqual({ kind: "push", repository: "acme/app", branch: "OPS-3-hotfix" });

    const declined = normalizeGitWebhook({
      provider: "bitbucket",
      headers: { "x-event-key": "pullrequest:rejected" },
      body: {
        repository: { full_name: "acme/app" },
        pullrequest: { state: "DECLINED", source: { branch: { name: "OPS-3-hotfix" } }, links: { html: { href: "https://bb/pr/9" } } }
      }
    });
    expect(declined).toMatchObject({ kind: "pr", prStatus: "CLOSED" });
  });

  it("gitea: reads the GitHub-shaped payload", () => {
    const pr = normalizeGitWebhook({
      provider: "gitea",
      headers: { "x-gitea-event": "pull_request" },
      body: {
        repository: { full_name: "acme/app" },
        pull_request: { merged: false, state: "open", html_url: "https://gitea/pr/2", head: { ref: "HICS-OPS-150-thing" } }
      }
    });
    expect(pr).toMatchObject({ kind: "pr", branch: "HICS-OPS-150-thing", prStatus: "OPEN" });
  });

  it("azure-devops: maps status names and builds the repository from project/name", () => {
    const push = normalizeGitWebhook({
      provider: "azure-devops",
      headers: {},
      body: {
        eventType: "git.push",
        resource: { refUpdates: [{ name: "refs/heads/WEB-7-task" }], repository: { name: "app", project: { name: "Acme" } } }
      }
    });
    expect(push).toEqual({ kind: "push", repository: "Acme/app", branch: "WEB-7-task" });

    const completed = normalizeGitWebhook({
      provider: "azure-devops",
      headers: {},
      body: {
        eventType: "git.pullrequest.updated",
        resource: {
          status: "completed",
          pullRequestId: 42,
          sourceRefName: "refs/heads/WEB-7-task",
          repository: { name: "app", project: { name: "Acme" }, webUrl: "https://dev.azure.com/acme/_git/app" }
        }
      }
    });
    expect(completed).toMatchObject({ kind: "pr", prStatus: "MERGED", prUrl: "https://dev.azure.com/acme/_git/app/pullrequest/42" });
  });

  it("unknown events normalize to ignored, never to an error", () => {
    const out = normalizeGitWebhook({ provider: "gitlab", headers: { "x-gitlab-event": "Pipeline Hook" }, body: {} });
    expect(out.kind).toBe("ignored");
  });
});
