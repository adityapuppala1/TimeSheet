/**
 * The multi-provider git webhook receiver, driven end to end through the real HTTP surface:
 * rotate the workspace webhook secret, deliver signed payloads the way each provider actually
 * sends them, and assert the TicketBranch rows LAND — not merely that the endpoint said 200.
 *
 * NOTE: this spec rotates the workspace's git webhook secret (there is no way to read the
 * existing one back — that is the point of storing only ciphertext). In a workspace with real
 * provider webhooks configured, re-paste the new secret afterwards; in CI it's moot.
 *
 * Branch cleanup is asserted, not assumed — the admin-request helper's own lesson.
 */
import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";

test.describe("multi-provider git webhooks", () => {
  test("gitlab push and gitea PR sync a ticket's Dev tab; bad credentials are refused", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const { secret } = await (await ctx.post("/api/settings/git/webhook-secret/rotate", { headers })).json();
      expect(secret, "secret rotation must return the plaintext exactly once").toBeTruthy();

      // Any real ticket will do — the receiver matches by key token in the branch name.
      const list = await (await ctx.get("/api/tickets?pageSize=1", { headers })).json();
      const ticket = (list.items ?? list.rows ?? list)[0];
      expect(ticket?.key, "the workspace needs at least one ticket for this spec").toBeTruthy();
      const branch = `${ticket.key}-e2e-webhook-sync`;
      const orgSlug = "default";

      const cleanupBranchIds: string[] = [];
      try {
        // 1. GitLab push (plain token header) creates the branch row.
        const gitlabPush = await ctx.post(`/api/git/webhook/${orgSlug}/gitlab`, {
          headers: { ...headers, "X-Gitlab-Token": secret, "X-Gitlab-Event": "Push Hook" },
          data: { ref: `refs/heads/${branch}`, project: { path_with_namespace: "acme/e2e-repo" } }
        });
        expect(gitlabPush.status(), await gitlabPush.text()).toBe(200);
        expect((await gitlabPush.json()).matched).toBe(true);

        // 2. Gitea merged-PR (HMAC over raw body) upgrades the same row with a PR URL + status.
        //    The HMAC must cover the EXACT bytes sent, so the body is serialized once by hand.
        const giteaBody = JSON.stringify({
          repository: { full_name: "acme/e2e-repo" },
          pull_request: {
            merged: true,
            state: "closed",
            html_url: "https://gitea.example/acme/e2e-repo/pulls/7",
            head: { ref: branch }
          }
        });
        const signature = crypto.createHmac("sha256", secret).update(Buffer.from(giteaBody, "utf8")).digest("hex");
        const giteaPr = await ctx.post(`/api/git/webhook/${orgSlug}/gitea`, {
          headers: { "Content-Type": "application/json", "X-Gitea-Signature": signature, "X-Gitea-Event": "pull_request" },
          data: giteaBody
        });
        expect(giteaPr.status(), await giteaPr.text()).toBe(200);
        expect((await giteaPr.json()).matched).toBe(true);

        // 3. The rows actually landed on the ticket, in the shape the Dev tab renders.
        const detail = await (await ctx.get(`/api/tickets/${ticket.id}`, { headers })).json();
        const synced = (detail.branches as Array<{ id: string; branch: string; prUrl: string | null; prStatus: string | null }>).filter(
          (b) => b.branch === branch
        );
        cleanupBranchIds.push(...synced.map((b) => b.id));
        expect(synced.length, "push + PR must land on ONE row, not two").toBe(1);
        expect(synced[0].prStatus).toBe("MERGED");
        expect(synced[0].prUrl).toBe("https://gitea.example/acme/e2e-repo/pulls/7");

        // 4. Wrong token → 401; unknown provider → 404. Refusals, not silent acceptance.
        const badToken = await ctx.post(`/api/git/webhook/${orgSlug}/gitlab`, {
          headers: { "X-Gitlab-Token": "wrong", "X-Gitlab-Event": "Push Hook", "Content-Type": "application/json" },
          data: { ref: `refs/heads/${branch}`, project: { path_with_namespace: "acme/e2e-repo" } }
        });
        expect(badToken.status()).toBe(401);
        const unknown = await ctx.post(`/api/git/webhook/${orgSlug}/subversion`, {
          headers: { "Content-Type": "application/json" },
          data: {}
        });
        expect(unknown.status()).toBe(404);

        // 5. Azure DevOps ?token= route works with the same secret.
        const azure = await ctx.post(`/api/git/webhook/${orgSlug}/azure-devops?token=${secret}`, {
          headers: { "Content-Type": "application/json" },
          data: {
            eventType: "git.push",
            resource: { refUpdates: [{ name: `refs/heads/${branch}-az` }], repository: { name: "e2e-repo", project: { name: "Acme" } } }
          }
        });
        expect(azure.status(), await azure.text()).toBe(200);
        const azMatched = (await azure.json()).matched;
        expect(azMatched).toBe(true);
        const detail2 = await (await ctx.get(`/api/tickets/${ticket.id}`, { headers })).json();
        cleanupBranchIds.push(
          ...(detail2.branches as Array<{ id: string; branch: string }>).filter((b) => b.branch === `${branch}-az`).map((b) => b.id)
        );
      } finally {
        for (const id of cleanupBranchIds) {
          const del = await ctx.delete(`/api/tickets/${ticket.id}/branches/${id}`, { headers });
          expect(del.status(), `branch cleanup failed for ${id}`).toBeLessThan(300);
        }
      }
    });
  });
});
