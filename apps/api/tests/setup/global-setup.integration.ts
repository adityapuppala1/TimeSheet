import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "../../src/generated/control-client/index.js";
import { seedTenant } from "../../prisma/seed.js";
import { encryptSecret } from "../../src/utils/encryption.js";
import { deriveTestDbUrls } from "./derive-test-db-urls.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Same "strip the trailing /dbname" trick as scripts/doctor.ts#ensureDatabaseExists, so
 *  `prisma db execute` has a valid connection URL to run CREATE/DROP DATABASE against (a bare
 *  server connection, not one already pointed at a specific — possibly not-yet-existing — db). */
function baseUrl(url: string): string {
  return url.replace(/\/[^/?]+(\?.*)?$/, "/");
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

function recreateDatabase(url: string): void {
  const name = dbNameOf(url);
  execSync(`npx prisma db execute --stdin --url="${baseUrl(url)}"`, {
    input: `DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\`;`,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: API_ROOT
  });
}

function migrate(schema: string, envVar: "DATABASE_URL" | "CONTROL_DATABASE_URL", url: string): void {
  execSync(`npx prisma migrate deploy --schema=${schema}`, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: API_ROOT,
    env: { ...process.env, [envVar]: url }
  });
}

function dropDatabase(url: string): void {
  const name = dbNameOf(url);
  execSync(`npx prisma db execute --stdin --url="${baseUrl(url)}"`, {
    input: `DROP DATABASE IF EXISTS \`${name}\`;`,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: API_ROOT
  });
}

/**
 * Vitest `globalSetup` for the integration tier — creates two throwaway `<db>_test` databases
 * (fresh every run: dropped then recreated, so a prior failed run never leaves stale rows),
 * migrates both schemas, and seeds just enough fixture data for the billing + SCIM integration
 * tests. Torn down (dropped) after the run unless `KEEP_TEST_DB=1`, for post-failure debugging.
 */
export async function setup(): Promise<() => Promise<void>> {
  const { tenantUrl, controlUrl } = deriveTestDbUrls();

  recreateDatabase(tenantUrl);
  recreateDatabase(controlUrl);
  migrate("prisma/schema.prisma", "DATABASE_URL", tenantUrl);
  migrate("prisma/control/schema.prisma", "CONTROL_DATABASE_URL", controlUrl);

  const tenantClient = new PrismaClient({ datasources: { db: { url: tenantUrl } } });
  await seedTenant(tenantClient, { includeDemoData: false });
  await tenantClient.$disconnect();

  const controlClient = new ControlPrismaClient({ datasources: { db: { url: controlUrl } } });
  await controlClient.planTierLimit.createMany({
    data: [
      // Generous enough to comfortably exceed seedTenant's own baseline users (the one real
      // admin + the system reporter-of-record accounts it always creates) — the SCIM
      // integration test overrides this per-org via seatLimitOverride for its one seat-limit
      // scenario rather than relying on this tier default being tight.
      { tier: "STARTER", seatLimit: 20, aiMonthlyBudgetCeilingUsd: 0, allowedSsoProviders: [], allowedChatPlatforms: [] },
      { tier: "TEAM", seatLimit: 25, aiMonthlyBudgetCeilingUsd: 50, allowedSsoProviders: ["GOOGLE"], allowedChatPlatforms: [] },
      { tier: "ENTERPRISE", seatLimit: 500, aiMonthlyBudgetCeilingUsd: 500, allowedSsoProviders: ["GOOGLE", "MICROSOFT", "SAML"], allowedChatPlatforms: [] }
    ]
  });
  await controlClient.platformBillingSettings.create({
    data: {
      id: "global",
      encryptedSecretKey: encryptSecret("sk_test_fixture_not_a_real_key"),
      encryptedWebhookSigningSecret: encryptSecret("whsec_test_fixture_secret"),
      priceIdTeam: "price_team_123",
      priceIdEnterprise: "price_enterprise_456"
    }
  });
  await controlClient.organization.create({
    data: {
      id: "org-billing-test",
      name: "Billing Integration Test Org",
      slug: "billing-integration-test-org",
      status: "ACTIVE",
      planTier: "STARTER",
      stripeSubscriptionId: "sub_existing_123"
    }
  });

  // A real Organization + OrgDatabase row pointing at the same throwaway tenant database seeded
  // above — lets the SCIM integration test exercise the real resolveActiveOrgBySlug/getTenantClient
  // chain end-to-end (real seat-limit-from-plan-tier lookup included) instead of mocking org
  // resolution the way the unit tier does.
  await controlClient.organization.create({
    data: {
      id: "org-scim-test",
      name: "SCIM Integration Test Org",
      slug: "scim-integration-test-org",
      status: "ACTIVE",
      planTier: "STARTER",
      database: {
        create: {
          encryptedDsn: encryptSecret(tenantUrl),
          host: new URL(tenantUrl).hostname,
          databaseName: dbNameOf(tenantUrl)
        }
      }
    }
  });
  await controlClient.$disconnect();

  return async () => {
    if (process.env.KEEP_TEST_DB === "1") return;
    dropDatabase(tenantUrl);
    dropDatabase(controlUrl);
  };
}
