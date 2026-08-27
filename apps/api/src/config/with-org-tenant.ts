/**
 * Resolves an org from its slug and runs `fn` inside that org's tenant context.
 *
 * The non-middleware form of `middleware/tenant.ts`'s `resolveTenant`, for the paths that arrive
 * without a Host header naming the tenant: the webhook receivers (which carry the slug in the URL)
 * and workspace discovery (which is cross-tenant by definition and picks its org from a lookup).
 *
 * WHY IT EXISTS AT ALL: this was about to be its third hand-rolled copy — chat-webhook.controller
 * had one, sso.controller's `finishSsoLogin` has the same four lines inline, and the discovery
 * routes needed a fourth. The seat-count service's header makes the general argument: a predicate
 * copied N times means the next change lands in N-1 of them.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN LIVING IN middleware/tenant.ts, which is where it obviously
 * belongs: five unit-test files replace that entire module with `vi.mock(...)` in order to stub
 * `resolveActiveOrgBySlug`. Exporting this from there meant every one of those mocks had to grow a
 * copy of these four lines or the controllers under test crashed on a missing export. Sitting in a
 * separate module, it IMPORTS the mocked `resolveActiveOrgBySlug` and the mocked `getTenantClient`
 * at call time, so all five suites keep testing exactly what they tested before with no scaffolding
 * added. That is a real constraint of the test setup, not a preference — worth stating plainly so
 * nobody "tidies" this back into the middleware and rediscovers it.
 */
import type { Request } from "express";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { decryptSecret } from "../utils/encryption.js";
import { getTenantClient } from "./prisma.js";
import { tenantContext } from "./tenant-context.js";

/** `req` is threaded through to `resolveActiveOrgBySlug` so a caller who can prove they belong to a
 *  suspended workspace still gets the real 403 — see that function for why everyone else gets 404. */
export async function withOrgTenant<T>(orgSlug: string, fn: () => Promise<T>, req?: Request): Promise<T> {
  const org = await resolveActiveOrgBySlug(orgSlug, req);
  const dsn = decryptSecret(org.database!.encryptedDsn);
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, fn);
}
