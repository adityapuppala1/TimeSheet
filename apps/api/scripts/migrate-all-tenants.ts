/**
 * Fans out a schema migration across every tenant database — the SaaS multi-org counterpart
 * to docker-compose.yml's single `prisma migrate deploy` (which only ever migrates the one
 * on-prem/single-org DATABASE_URL; see that file's comment near the `api` service's `command`).
 *
 * Run after committing a new migration under prisma/migrations/, from apps/api:
 *   npm run migrate:tenants
 *
 * Per-org failure isolation: one tenant's migration failing (bad connection, a hand-edited
 * schema drift, whatever) is logged and skipped rather than aborting every other tenant's
 * migration — the same principle as workers/run-for-every-org.ts, just for a one-off admin
 * script instead of a recurring cron tick.
 */
import { controlPrisma } from "../src/config/control-prisma.js";
import { decryptSecret } from "../src/utils/encryption.js";
import { getLatestMigrationName, runMigrateDeploy } from "../src/services/provisioning.service.js";

async function main() {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
    include: { database: true },
    orderBy: { slug: "asc" }
  });

  const latest = getLatestMigrationName();
  console.log(`Latest migration: ${latest}`);
  console.log(`Found ${orgs.length} org(s) to check.\n`);

  const results: { slug: string; outcome: "migrated" | "up-to-date" | "skipped" | "failed"; detail?: string }[] = [];

  for (const org of orgs) {
    if (!org.database) {
      console.warn(`[${org.slug}] no OrgDatabase row — skipping.`);
      results.push({ slug: org.slug, outcome: "skipped", detail: "no database registered" });
      continue;
    }
    if (org.database.schemaVersion === latest) {
      console.log(`[${org.slug}] already at ${latest} — skipping.`);
      results.push({ slug: org.slug, outcome: "up-to-date" });
      continue;
    }

    try {
      const dsn = decryptSecret(org.database.encryptedDsn);
      console.log(`[${org.slug}] migrating (was ${org.database.schemaVersion ?? "never migrated"})...`);
      runMigrateDeploy(dsn);
      await controlPrisma.orgDatabase.update({
        where: { organizationId: org.id },
        data: { schemaVersion: latest, migratedAt: new Date() }
      });
      console.log(`[${org.slug}] migrated to ${latest}.`);
      results.push({ slug: org.slug, outcome: "migrated" });
    } catch (error) {
      const detail = (error as Error).message;
      console.error(`[${org.slug}] FAILED:`, detail);
      results.push({ slug: org.slug, outcome: "failed", detail });
    }
  }

  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.slug}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  }

  const failed = results.filter((r) => r.outcome === "failed");
  if (failed.length > 0) {
    console.error(`\n${failed.length} organization(s) failed to migrate — see above.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => controlPrisma.$disconnect());
