/**
 * The cron-worker half of Phase B1's tenant conversion. A scheduled job has no HTTP request
 * to hang tenant resolution off of (see middleware/tenant.ts for the request-path half), so
 * instead it loops over every ACTIVE organization from the control plane and runs its
 * existing body — completely unchanged — once per org, each wrapped in that org's own tenant
 * context. One org's failure is caught and logged rather than aborting the rest, so a single
 * tenant's bad data or a transient connection issue can't silently skip every other tenant's
 * reminders/escalations/digest for that tick.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { decryptSecret } from "../utils/encryption.js";

export async function runForEveryOrg(label: string, fn: () => Promise<void>): Promise<void> {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: "ACTIVE" },
    include: { database: true }
  });

  for (const org of orgs) {
    if (!org.database) {
      console.warn(`[${label}] org "${org.slug}" has no database record — skipping.`);
      continue;
    }
    try {
      const dsn = decryptSecret(org.database.encryptedDsn);
      const client = await getTenantClient(org.id, dsn);
      await tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, fn);
    } catch (error) {
      console.error(`[${label}] failed for org "${org.slug}":`, (error as Error).message);
    }
  }
}
