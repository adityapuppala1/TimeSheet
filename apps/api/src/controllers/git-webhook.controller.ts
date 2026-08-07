/**
 * GitHub repo webhook receiver — push + pull_request events. Auto-syncs `TicketBranch` rows
 * (see docs/ROADMAP.md's "Push/PR-event webhook receiver" item, the successor to the "Pick from
 * GitHub" on-demand REST lookups in Tickets.tsx) and, on a PR opening, optionally posts an
 * AI-authored review summary comment (`aiPrReviewSummaryEnabled`, see ai.service.ts#
 * summarizePullRequest).
 *
 * WHO configures this: a GitHub OAuth App has no org-wide webhook the way a GitHub App does —
 * so this is a PER-REPO webhook the admin adds manually (repo Settings -> Webhooks -> Add
 * webhook) after connecting GitHub, pointed at this URL with the shared secret from Workspace
 * Settings -> Security & DevOps -> Git provider.
 *
 * WHY mounted before tenant resolution, same as devops-webhook.controller.ts: GitHub has no
 * Host-header subdomain to resolve a tenant from, so org is identified from the URL path
 * (`/:orgSlug`) instead, then the shared webhook secret (HMAC over the raw body, GitHub's own
 * `X-Hub-Signature-256` scheme) proves the request is genuinely from that org's configured repo.
 *
 * WHY branch-name matching, not the payload's own linkage: GitHub has no concept of "this
 * branch belongs to ticket WEB-123" — this app infers it the same way most Jira/GitHub
 * conventions do, by looking for a ticket-key-shaped token (e.g. `WEB-123`) anywhere in the
 * branch name. A branch that doesn't match any real ticket key is silently ignored (200, no
 * write) rather than erroring, since most branches on a repo won't be ticket-linked at all.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { getTenantClient, prisma } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { fetchGitHubPullRequestFiles, GIT_INTEGRATION_SYSTEM_EMAIL, postGitHubPullRequestReview } from "../services/git-provider.service.js";
import { reviewPullRequestDiff, summarizePullRequest } from "../services/ai.service.js";
import {
  GIT_PROVIDERS_WITH_GUARANTEED_DELIVERY_ID,
  GIT_WEBHOOK_PROVIDERS,
  gitWebhookDeliveryId,
  normalizeGitWebhook,
  verifyGitWebhook,
  type GitWebhookProvider
} from "../services/git-webhook-providers.js";
import { isReplayedDelivery } from "../services/webhook-replay.js";

export const gitWebhookRouter = Router();

/** Same tenant-resolution-from-URL-path helper as devops-webhook.controller.ts's withOrgTenant —
 *  duplicated rather than imported, same reasoning as that file's own comment on the pattern. */
async function withOrgTenant<T>(orgSlug: string, fn: () => Promise<T>): Promise<T> {
  const org = await resolveActiveOrgBySlug(orgSlug);
  const dsn = decryptSecret(org.database!.encryptedDsn);
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, fn);
}

// Project codes themselves can contain hyphens (e.g. "HICS-OPS", ticket key "HICS-OPS-150"),
// so the middle `(?:-[A-Za-z0-9]+)*` greedily consumes hyphen-segments before backtracking to
// satisfy the mandatory trailing `-\d+` — this is what lets "HICS-OPS-150" match as one token
// instead of the regex incorrectly stopping at "OPS-150". A branch with more than one
// digit-suffixed segment (rare) can still mismatch; this is a best-effort heuristic, same as
// every other "ticket key in branch name" convention (Jira/GitHub/GitLab smart commits included).
const TICKET_KEY_RE = /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+)\b/;

function extractTicketKey(branchName: string): string | null {
  const match = branchName.match(TICKET_KEY_RE);
  return match ? match[1].toUpperCase() : null;
}

// `express.raw()` here, NOT the app-wide `express.json()` — GitHub's signature is computed over
// the exact raw bytes it sent, and Express body parsers only read the request stream once. Same
// reason chat-webhook.controller.ts's Slack route (and this router's mount point in app.ts,
// BEFORE the global json() parser) does the same thing.
gitWebhookRouter.post("/webhook/:orgSlug", express.raw({ type: "application/json" }), async (req, res, next) => {
  try {
    const rawBody = req.body as Buffer;
    const payloadText = rawBody.toString("utf8");
    const parsedBody = JSON.parse(payloadText || "{}") as Record<string, unknown>;
    const signatureHeader = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const githubEvent = req.headers["x-github-event"];
    const event = Array.isArray(githubEvent) ? githubEvent[0] : githubEvent;
    const deliveryHeader = req.headers["x-github-delivery"];
    const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;

    await withOrgTenant(String(req.params.orgSlug), async () => {
      const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
      if (!connection?.encryptedWebhookSecret) {
        throw new AppError(404, "GitHub webhook isn't configured for this workspace.");
      }
      if (!rawBody || !signature) throw new AppError(401, "Missing webhook signature.");

      const secret = decryptSecret(connection.encryptedWebhookSecret);
      const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
      const sigBuf = Buffer.from(signature);
      const expectedBuf = Buffer.from(expected);
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        throw new AppError(401, "Invalid webhook signature.");
      }

      // The signature says the body came from the configured repo; it does not say WHEN, and
      // there is no timestamp in GitHub's scheme to bound it. Without this, one captured
      // `pull_request:opened` delivery re-runs the AI summary and posts another GitHub review
      // every time it is resent, indefinitely. `X-GitHub-Delivery` is always present on a real
      // delivery, so a MISSING one is a stripped header, not an old sender — rejecting it is
      // what stops the check being bypassed by deleting a header. Deliberately AFTER the
      // signature check: an unauthenticated caller must not be able to write into the store and
      // evict genuine ids. See services/webhook-replay.ts for the per-process caveat.
      if (!deliveryId) throw new AppError(401, "Missing webhook delivery id.");
      if (isReplayedDelivery(`github:${req.params.orgSlug}`, deliveryId)) {
        throw new AppError(409, "This webhook delivery has already been processed.");
      }

      const systemUser = await prisma.user.findUnique({ where: { email: GIT_INTEGRATION_SYSTEM_EMAIL } });
      if (!systemUser) throw new AppError(500, "Git integration system account is missing — run the seed script.");

      if (event === "push") {
        const payload = parsedBody as { ref: string; repository: { full_name: string } };
        const branch = payload.ref?.replace(/^refs\/heads\//, "");
        const ticketKey = branch ? extractTicketKey(branch) : null;
        if (!ticketKey) return res.status(200).json({ ok: true, matched: false });

        const ticket = await prisma.ticket.findFirst({ where: { key: ticketKey, deletedAt: null } });
        if (!ticket) return res.status(200).json({ ok: true, matched: false });

        const existing = await prisma.ticketBranch.findFirst({
          where: { ticketId: ticket.id, repository: payload.repository.full_name, branch }
        });
        if (!existing) {
          await prisma.ticketBranch.create({
            data: { ticketId: ticket.id, repository: payload.repository.full_name, branch, addedById: systemUser.id }
          });
        }
        return res.status(200).json({ ok: true, matched: true });
      }

      if (event === "pull_request") {
        const payload = parsedBody as {
          action: string;
          repository: { full_name: string };
          pull_request: {
            number: number;
            title: string;
            body: string | null;
            html_url: string;
            merged: boolean;
            state: string;
            head: { ref: string };
          };
        };
        const branch = payload.pull_request.head.ref;
        const ticketKey = extractTicketKey(branch);
        if (!ticketKey) return res.status(200).json({ ok: true, matched: false });

        const ticket = await prisma.ticket.findFirst({ where: { key: ticketKey, deletedAt: null } });
        if (!ticket) return res.status(200).json({ ok: true, matched: false });

        const prStatus = payload.pull_request.merged ? "MERGED" : payload.pull_request.state === "closed" ? "CLOSED" : "OPEN";
        const existing = await prisma.ticketBranch.findFirst({
          where: { ticketId: ticket.id, repository: payload.repository.full_name, branch }
        });
        if (existing) {
          await prisma.ticketBranch.update({
            where: { id: existing.id },
            data: { prUrl: payload.pull_request.html_url, prStatus }
          });
        } else {
          await prisma.ticketBranch.create({
            data: {
              ticketId: ticket.id,
              repository: payload.repository.full_name,
              branch,
              prUrl: payload.pull_request.html_url,
              prStatus,
              addedById: systemUser.id
            }
          });
        }

        // AI PR-review summary — opt-in, only on the PR's initial "opened" action (not every
        // edit/sync event, which would spam the ticket thread and burn AI budget for no reason).
        if (payload.action === "opened" && connection.encryptedAccessToken) {
          try {
            const accessToken = decryptSecret(connection.encryptedAccessToken);
            const files = await fetchGitHubPullRequestFiles(accessToken, payload.repository.full_name, payload.pull_request.number);
            const result = await summarizePullRequest({
              title: payload.pull_request.title,
              body: payload.pull_request.body,
              filesChanged: files,
              ticketKey
            });
            const riskBadge = result.riskLevel === "HIGH" ? "🔴 HIGH" : result.riskLevel === "MEDIUM" ? "🟡 MEDIUM" : "🟢 LOW";
            await prisma.ticketComment.create({
              data: {
                ticketId: ticket.id,
                authorId: systemUser.id,
                body: `<p><strong>AI PR-review summary</strong> (${riskBadge} risk):</p><p>${result.summary}</p><p><em>Review focus: ${result.reviewFocus}</em></p>`
              }
            });

            // Deeper, separately-toggled inline review — its own try/catch so a failure here
            // (disabled, budget cap, diff too large, GitHub API error) never affects whether the
            // summary above already posted.
            try {
              const inlineReview = await reviewPullRequestDiff({
                title: payload.pull_request.title,
                filesChanged: files,
                ticketKey
              });
              if (inlineReview && inlineReview.comments.length > 0) {
                await postGitHubPullRequestReview(accessToken, payload.repository.full_name, payload.pull_request.number, inlineReview.comments);
              }
            } catch (error) {
              console.warn(`[git-webhook] inline AI PR review failed for ${payload.repository.full_name}#${payload.pull_request.number}: ${(error as Error).message}`);
            }
          } catch {
            // Same "log and move on" posture as maybePostCiFailureTriageComment's caller — a
            // disabled toggle, a budget cap, or a transient GitHub API error should never turn
            // a successful branch/PR sync into a failed webhook delivery.
          }
        }

        return res.status(200).json({ ok: true, matched: true });
      }

      res.status(200).json({ ok: true, ignored: true });
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Multi-provider receiver — GitLab, Bitbucket Cloud, Gitea, Forgejo, Azure DevOps.
 *
 * Same job as the GitHub route above (branch/PR → TicketBranch, matched by ticket-key-shaped
 * token in the branch name), same shared webhook secret, but each provider's own auth scheme
 * and payload dialect — both translated by services/git-webhook-providers.ts so this handler
 * stays provider-blind. The AI PR-review summary stays GitHub-only: it needs the provider's
 * API to fetch the diff, and only the GitHub OAuth connection holds a token for that.
 *
 * Express routing note: `/webhook/:orgSlug` above matches exactly one path segment, so this
 * two-segment route never shadows or races it.
 */
gitWebhookRouter.post("/webhook/:orgSlug/:provider", express.raw({ type: "application/json" }), async (req, res, next) => {
  try {
    const provider = String(req.params.provider) as GitWebhookProvider;
    if (!GIT_WEBHOOK_PROVIDERS.includes(provider)) {
      throw new AppError(404, `Unknown git provider "${provider}". Supported: ${GIT_WEBHOOK_PROVIDERS.join(", ")}.`);
    }
    const rawBody = (req.body ?? Buffer.alloc(0)) as Buffer;
    const parsedBody = JSON.parse(rawBody.toString("utf8") || "{}") as Record<string, unknown>;

    await withOrgTenant(String(req.params.orgSlug), async () => {
      const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
      if (!connection?.encryptedWebhookSecret) {
        throw new AppError(404, "The git webhook secret isn't configured for this workspace — generate it in Workspace Settings → Security & DevOps.");
      }
      const secret = decryptSecret(connection.encryptedWebhookSecret);
      if (
        !verifyGitWebhook({
          provider,
          secret,
          rawBody,
          headers: req.headers as Record<string, unknown>,
          query: req.query as Record<string, unknown>
        })
      ) {
        throw new AppError(401, "Invalid webhook credentials.");
      }

      // Same replay guard as the GitHub route above, keyed per tenant AND per provider because
      // one process serves every org and nothing makes two providers' delivery ids disjoint.
      // Only the HMAC providers (gitea/forgejo/bitbucket) are required to carry one — for the
      // rest the shared secret travels with the request, so an id is a nice-to-have rather than
      // the control doing the work. See services/webhook-replay.ts.
      const deliveryId = gitWebhookDeliveryId({ provider, headers: req.headers as Record<string, unknown>, body: parsedBody });
      if (!deliveryId && GIT_PROVIDERS_WITH_GUARANTEED_DELIVERY_ID.has(provider)) {
        throw new AppError(401, "Missing webhook delivery id.");
      }
      if (deliveryId && isReplayedDelivery(`${provider}:${req.params.orgSlug}`, deliveryId)) {
        throw new AppError(409, "This webhook delivery has already been processed.");
      }

      const event = normalizeGitWebhook({ provider, headers: req.headers as Record<string, unknown>, body: parsedBody });
      if (event.kind === "ignored") {
        return res.status(200).json({ ok: true, ignored: true, reason: event.reason });
      }

      const ticketKey = extractTicketKey(event.branch);
      if (!ticketKey) return res.status(200).json({ ok: true, matched: false });
      const ticket = await prisma.ticket.findFirst({ where: { key: ticketKey, deletedAt: null } });
      if (!ticket) return res.status(200).json({ ok: true, matched: false });

      const systemUser = await prisma.user.findUnique({ where: { email: GIT_INTEGRATION_SYSTEM_EMAIL } });
      if (!systemUser) throw new AppError(500, "Git integration system account is missing — run the seed script.");

      const existing = await prisma.ticketBranch.findFirst({
        where: { ticketId: ticket.id, repository: event.repository, branch: event.branch }
      });
      if (event.kind === "push") {
        if (!existing) {
          await prisma.ticketBranch.create({
            data: { ticketId: ticket.id, repository: event.repository, branch: event.branch, addedById: systemUser.id }
          });
        }
      } else if (existing) {
        await prisma.ticketBranch.update({
          where: { id: existing.id },
          data: { prUrl: event.prUrl ?? existing.prUrl, prStatus: event.prStatus }
        });
      } else {
        await prisma.ticketBranch.create({
          data: {
            ticketId: ticket.id,
            repository: event.repository,
            branch: event.branch,
            prUrl: event.prUrl,
            prStatus: event.prStatus,
            addedById: systemUser.id
          }
        });
      }

      return res.status(200).json({ ok: true, matched: true, provider });
    });
  } catch (error) {
    next(error);
  }
});
