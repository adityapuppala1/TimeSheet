/**
 * GitHub OAuth callback — mounted on `app` BEFORE the blanket `app.use("/api", resolveTenant)`
 * in app.ts, same reasoning as controllers/sso.controller.ts: GitHub redirects here using the
 * ONE fixed callback URL registered on the org's OAuth App (services/git-provider.service.ts's
 * header explains why org identity travels through the signed `state` param instead of the
 * Host header). Everything else (connect/status/app-credentials/live repo-branch-PR lookups)
 * is a normal authenticated route in settings.controller.ts, since those are all admin actions
 * taken from inside an already-tenant-resolved, already-logged-in Workspace Settings session.
 */
import { Router } from "express";
import { env } from "../config/env.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { controlPrisma } from "../config/control-prisma.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import { exchangeGitHubCode, fetchGitHubLogin, verifyGitConnectState } from "../services/git-provider.service.js";

export const gitConnectionRouter = Router();

function settingsRedirect(webOrigin: string, query: string): string {
  return `${webOrigin.replace(/\/$/, "")}/app/settings?tab=security-devops&${query}`;
}

gitConnectionRouter.get("/callback", async (req, res) => {
  // WEB_ORIGIN may be a comma-separated CORS allow-list (see app.ts's `allowedOrigins`) — a
  // redirect target needs exactly one URL, so this takes the first configured origin, same as
  // every other multi-origin-aware spot in this codebase treats "the" web origin.
  const webOrigin = env.WEB_ORIGIN.split(",")[0]?.trim() || "http://localhost:5173";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  try {
    const { orgId, userId } = verifyGitConnectState(state);
    const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, include: { database: true } });
    if (!org?.database) throw new Error("Unknown workspace for this GitHub connection.");

    const dsn = decryptSecret(org.database.encryptedDsn);
    const client = await getTenantClient(org.id, dsn);

    await tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, async () => {
      const connection = await client.gitConnection.findUnique({ where: { id: "global" } });
      if (!connection?.clientId || !connection.encryptedClientSecret) {
        throw new Error("This workspace's GitHub OAuth App credentials are missing — save them again in Workspace Settings.");
      }
      const clientSecret = decryptSecret(connection.encryptedClientSecret);
      const accessToken = await exchangeGitHubCode(connection.clientId, clientSecret, code);
      const accountLogin = await fetchGitHubLogin(accessToken);

      await client.gitConnection.update({
        where: { id: "global" },
        data: {
          encryptedAccessToken: encryptSecret(accessToken),
          accountLogin,
          connectedById: userId,
          connectedAt: new Date()
        }
      });
    });

    res.redirect(settingsRedirect(webOrigin, "gitConnected=1"));
  } catch (error) {
    res.redirect(settingsRedirect(webOrigin, `gitConnectError=${encodeURIComponent((error as Error).message)}`));
  }
});
