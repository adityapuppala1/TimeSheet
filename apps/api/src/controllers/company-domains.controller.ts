/**
 * WHAT: `GET /api/settings/company-domains` — the email domains that route people to THIS workspace
 * (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.2), for Workspace Settings → Company domains.
 *
 * Read-only on purpose. A claim decides where strangers from a company are sent; moving one is an
 * operator action on the platform console (it can strand a company's people), and verifying a domain
 * by DNS is a later phase. So a workspace can see its claims and nothing more.
 *
 * Its own router, mounted at the settings path ahead of settingsRouter (app.ts), rather than one more
 * route inside settings.controller.ts: the route is three lines, and that file's forty imports would
 * have to be stubbed to test them.
 */
import { Router } from "express";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { claimsForOrg } from "../services/company-domain-claims.service.js";

export const companyDomainsRouter = Router();

companyDomainsRouter.get("/", requireAuth, requireSuperAdmin, async (_req, res) => {
  res.json(await claimsForOrg(requireTenantContext().orgId));
});
