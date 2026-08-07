/**
 * WHAT: verification + payload normalization for the multi-provider git webhook receiver —
 * GitLab, Bitbucket Cloud, Gitea, Forgejo, and Azure DevOps, alongside the original GitHub
 * route. Each provider speaks its own dialect (different auth scheme, different event header,
 * different payload shape); this module translates all of them into ONE normalized event that
 * the receiver syncs the same way GitHub events are synced: find a ticket-key-shaped token in
 * the branch name, upsert a `TicketBranch`.
 *
 * WHY ONE SHARED SECRET across providers: the workspace already has a git webhook secret
 * (Workspace Settings → Security & DevOps → rotate). Provider-specific secrets would mean a
 * secrets-management UI per provider for zero security gain — the secret's job is "prove this
 * request came from a repo my admin configured", and one high-entropy value does that for all
 * of them. The trade-off, stated: rotating it means updating every webhook on every provider.
 *
 * WHY AZURE DEVOPS IS VERIFIED DIFFERENTLY: its service hooks sign nothing. The options it
 * offers are basic auth or a query parameter, so this accepts the shared secret as either the
 * basic-auth password or `?token=`. That is weaker than an HMAC (the secret transits with every
 * request instead of proving possession) — https and the secret's entropy are the mitigation,
 * and the docs say so rather than pretending parity.
 *
 * Deliberately NOT here:
 * - AWS CodeCommit — AWS closed it to new customers in July 2024 and steers existing ones to
 *   migrate off; building an SNS-based receiver for a sunsetting product is effort pointed
 *   backwards. Manual branch/PR links on the Dev tab work for it today.
 * - SourceForge — no usable webhook/API story for this purpose. Manual links likewise.
 */
import crypto from "node:crypto";

import { constantTimeEqual } from "../utils/security.js";

export const GIT_WEBHOOK_PROVIDERS = ["gitlab", "bitbucket", "gitea", "forgejo", "azure-devops"] as const;
export type GitWebhookProvider = (typeof GIT_WEBHOOK_PROVIDERS)[number];

export type NormalizedGitEvent =
  | { kind: "push"; repository: string; branch: string }
  | {
      kind: "pr";
      repository: string;
      branch: string;
      prUrl: string | null;
      prStatus: "OPEN" | "MERGED" | "CLOSED";
    }
  /** A real, authenticated delivery of an event type this feature doesn't act on (tag pushes,
   *  comments, pipeline events…). 200-and-ignore, never an error — providers disable webhooks
   *  that keep failing. */
  | { kind: "ignored"; reason: string };

const header = (headers: Record<string, unknown>, name: string): string | null => {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
};

const hmacHex = (secret: string, rawBody: Buffer): string =>
  crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

/**
 * Verifies a delivery against the workspace's shared webhook secret, per provider scheme:
 *   gitlab        `X-Gitlab-Token` — the secret verbatim (GitLab sends it, never signs).
 *   gitea/forgejo `X-Gitea-Signature`/`X-Forgejo-Signature` — HMAC-SHA256 hex over the raw
 *                 body (they also send GitHub's `X-Hub-Signature-256`; either is accepted).
 *   bitbucket     `X-Hub-Signature` — `sha256=<hex>` HMAC over the raw body.
 *   azure-devops  basic-auth password OR `?token=` — see the header comment for why.
 */
export function verifyGitWebhook(params: {
  provider: GitWebhookProvider;
  secret: string;
  rawBody: Buffer;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): boolean {
  const { provider, secret, rawBody, headers, query } = params;

  switch (provider) {
    case "gitlab": {
      const token = header(headers, "x-gitlab-token");
      return Boolean(token) && constantTimeEqual(token as string, secret);
    }
    case "gitea":
    case "forgejo": {
      const sig =
        header(headers, `x-${provider}-signature`) ??
        header(headers, "x-gitea-signature") ??
        header(headers, "x-hub-signature-256")?.replace(/^sha256=/, "") ??
        null;
      return Boolean(sig) && constantTimeEqual(sig as string, hmacHex(secret, rawBody));
    }
    case "bitbucket": {
      const sig = header(headers, "x-hub-signature")?.replace(/^sha256=/, "") ?? null;
      return Boolean(sig) && constantTimeEqual(sig as string, hmacHex(secret, rawBody));
    }
    case "azure-devops": {
      const auth = header(headers, "authorization");
      if (auth?.startsWith("Basic ")) {
        const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
        const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
        if (constantTimeEqual(password, secret)) return true;
      }
      const token = typeof query.token === "string" ? query.token : null;
      return Boolean(token) && constantTimeEqual(token as string, secret);
    }
  }
}

/**
 * The per-delivery unique id each provider stamps on a request, for services/webhook-replay.ts.
 * Kept here with the rest of the per-provider dialect knowledge so the receiver stays
 * provider-blind.
 *
 * Azure DevOps has no delivery header — its service hooks put a notification GUID in the body
 * instead, and even that is not documented as guaranteed.
 */
export function gitWebhookDeliveryId(params: {
  provider: GitWebhookProvider;
  headers: Record<string, unknown>;
  body: Record<string, any>;
}): string | null {
  const { provider, headers, body } = params;
  switch (provider) {
    case "gitlab":
      return header(headers, "x-gitlab-event-uuid");
    case "gitea":
    case "forgejo":
      return header(headers, `x-${provider}-delivery`) ?? header(headers, "x-gitea-delivery");
    case "bitbucket":
      return header(headers, "x-request-uuid");
    case "azure-devops":
      return typeof body.id === "string" && body.id ? body.id : null;
  }
}

/**
 * Providers that ALWAYS send a delivery id, so a delivery arriving without one is a stripped
 * header rather than an old server — treat it as unauthenticated instead of as "cannot dedupe",
 * otherwise the replay check is defeated by deleting one header.
 *
 * GitLab is deliberately absent: `X-Gitlab-Event-UUID` is comparatively recent, and GitLab's
 * scheme puts the shared secret in the request anyway, so a replay guard there is not the
 * control doing the work (see services/webhook-replay.ts).
 */
export const GIT_PROVIDERS_WITH_GUARANTEED_DELIVERY_ID: ReadonlySet<GitWebhookProvider> = new Set([
  "gitea",
  "forgejo",
  "bitbucket"
]);

const stripRef = (ref: string | undefined | null): string | null =>
  ref ? ref.replace(/^refs\/heads\//, "") : null;

/** Translates a verified delivery into the one shape the receiver acts on. Unknown or
 *  non-branch events normalize to `ignored`, never to an error. */
export function normalizeGitWebhook(params: {
  provider: GitWebhookProvider;
  headers: Record<string, unknown>;
  body: Record<string, any>;
}): NormalizedGitEvent {
  const { provider, headers, body } = params;

  switch (provider) {
    case "gitlab": {
      const event = header(headers, "x-gitlab-event");
      if (event === "Push Hook") {
        const branch = stripRef(body.ref);
        const repository = body.project?.path_with_namespace;
        if (!branch || !repository) return { kind: "ignored", reason: "not a branch push" };
        return { kind: "push", repository, branch };
      }
      if (event === "Merge Request Hook") {
        const attrs = body.object_attributes ?? {};
        const repository = body.project?.path_with_namespace;
        const branch = attrs.source_branch;
        if (!branch || !repository) return { kind: "ignored", reason: "merge request without source branch" };
        const prStatus = attrs.state === "merged" ? "MERGED" : attrs.state === "closed" ? "CLOSED" : "OPEN";
        return { kind: "pr", repository, branch, prUrl: attrs.url ?? null, prStatus };
      }
      return { kind: "ignored", reason: `unhandled GitLab event ${event ?? "(none)"}` };
    }

    case "gitea":
    case "forgejo": {
      // Payloads are deliberately GitHub-shaped upstream — both projects document the
      // compatibility, which is why this arm reads like the GitHub route.
      const event = header(headers, `x-${provider}-event`) ?? header(headers, "x-gitea-event");
      if (event === "push") {
        const branch = stripRef(body.ref);
        const repository = body.repository?.full_name;
        if (!branch || !repository) return { kind: "ignored", reason: "not a branch push" };
        return { kind: "push", repository, branch };
      }
      if (event === "pull_request") {
        const pr = body.pull_request ?? {};
        const repository = body.repository?.full_name;
        const branch = pr.head?.ref;
        if (!branch || !repository) return { kind: "ignored", reason: "pull request without head ref" };
        const prStatus = pr.merged ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";
        return { kind: "pr", repository, branch, prUrl: pr.html_url ?? null, prStatus };
      }
      return { kind: "ignored", reason: `unhandled ${provider} event ${event ?? "(none)"}` };
    }

    case "bitbucket": {
      const event = header(headers, "x-event-key");
      const repository = body.repository?.full_name;
      if (event === "repo:push") {
        // A push payload carries a list of ref changes; only branch heads matter here (tags and
        // branch DELETIONS — new: null — are not something to link a ticket to).
        const change = (body.push?.changes ?? []).find(
          (c: any) => c?.new?.type === "branch" && typeof c?.new?.name === "string"
        );
        if (!change || !repository) return { kind: "ignored", reason: "no branch head in push" };
        return { kind: "push", repository, branch: change.new.name };
      }
      if (typeof event === "string" && event.startsWith("pullrequest:")) {
        const pr = body.pullrequest ?? {};
        const branch = pr.source?.branch?.name;
        if (!branch || !repository) return { kind: "ignored", reason: "pull request without source branch" };
        const prStatus = pr.state === "MERGED" ? "MERGED" : pr.state === "OPEN" ? "OPEN" : "CLOSED";
        return { kind: "pr", repository, branch, prUrl: pr.links?.html?.href ?? null, prStatus };
      }
      return { kind: "ignored", reason: `unhandled Bitbucket event ${event ?? "(none)"}` };
    }

    case "azure-devops": {
      const eventType = body.eventType;
      if (eventType === "git.push") {
        const branch = stripRef(body.resource?.refUpdates?.[0]?.name);
        const repoName = body.resource?.repository?.name;
        const project = body.resource?.repository?.project?.name;
        if (!branch || !repoName) return { kind: "ignored", reason: "push without branch ref" };
        return { kind: "push", repository: project ? `${project}/${repoName}` : repoName, branch };
      }
      if (typeof eventType === "string" && eventType.startsWith("git.pullrequest.")) {
        const pr = body.resource ?? {};
        const branch = stripRef(pr.sourceRefName);
        const repoName = pr.repository?.name;
        const project = pr.repository?.project?.name;
        if (!branch || !repoName) return { kind: "ignored", reason: "pull request without source ref" };
        const prStatus = pr.status === "completed" ? "MERGED" : pr.status === "abandoned" ? "CLOSED" : "OPEN";
        const prUrl =
          pr._links?.web?.href ??
          (pr.repository?.webUrl && pr.pullRequestId ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}` : null);
        return { kind: "pr", repository: project ? `${project}/${repoName}` : repoName, branch, prUrl, prStatus };
      }
      return { kind: "ignored", reason: `unhandled Azure DevOps event ${eventType ?? "(none)"}` };
    }
  }
}
