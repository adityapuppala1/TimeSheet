/**
 * Turns Phase B2's manual "create a database, migrate it, seed it, register it" dance into one
 * real flow, callable from the platform-admin console (controllers/platform-admin.controller.ts).
 *
 * Every step here is safe to retry: `CREATE DATABASE IF NOT EXISTS`, `prisma migrate deploy`
 * (a no-op against an already-up-to-date schema), `seedTenant()` (every row is an upsert), and
 * the final `OrgDatabase` write (also an upsert). So if this throws partway through — a bad
 * base DSN, a migration failure, a transient connection blip — a platform admin can just call
 * provision again once the underlying problem is fixed, rather than needing to hand-clean up
 * a half-finished org. `Organization.status` only flips to ACTIVE on full success, so a
 * partially-provisioned org stays visibly PROVISIONING (never silently looks ready when it isn't).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { encryptSecret } from "../utils/encryption.js";
import { seedTenant } from "../../prisma/seed.js";

export interface ProvisionOrgInput {
  adminEmail: string;
  adminName: string;
  adminPassword: string;
}

export interface ProvisionOrgResult {
  organizationId: string;
  databaseName: string;
  schemaVersion: string;
}

function assertSafeDatabaseName(name: string) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(name)) {
    throw new AppError(500, `Refusing to provision an unsafe-looking database name: "${name}"`);
  }
}

function databaseNameForSlug(slug: string): string {
  return `tenant_${slug.replace(/-/g, "_")}`;
}

function buildDsn(baseUrl: string, databaseName: string): { dsn: string; host: string } {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return { dsn: url.toString(), host: url.hostname };
}

/** Opens a throwaway connection to the MySQL server's always-present `mysql` system schema
 *  purely to run `CREATE DATABASE` — Prisma's client requires *some* database name in the
 *  connection URL even though this specific call doesn't touch that schema's own tables. */
async function createPhysicalDatabase(baseUrl: string, databaseName: string): Promise<void> {
  assertSafeDatabaseName(databaseName);
  const bootstrapUrl = new URL(baseUrl);
  bootstrapUrl.pathname = "/mysql";
  const scratch = new PrismaClient({ datasources: { db: { url: bootstrapUrl.toString() } } });
  try {
    await scratch.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
  } finally {
    await scratch.$disconnect();
  }
}

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TENANT_SCHEMA_PATH = path.join("prisma", "schema.prisma");
const MIGRATIONS_DIR = path.join(API_ROOT, "prisma", "migrations");

/** The latest migration folder name (timestamp-prefixed, so lexical sort = chronological) —
 *  recorded on OrgDatabase.schemaVersion after every successful deploy so a drifted tenant
 *  (one that missed a later `migrate:tenants` run) is visible from the org list. */
export function getLatestMigrationName(): string {
  const entries = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const latest = entries.at(-1);
  if (!latest) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  return latest;
}

// Invoking prisma's own CLI entry point directly via `node`, rather than shelling out to the
// `npx`/`npx.cmd` wrapper, sidesteps two Windows-specific problems at once: (1) Node's fix for
// CVE-2024-27980 refuses to spawn a .cmd/.bat file at all unless `shell: true` is set, which
// throws EINVAL here; (2) `shell: true` itself is the thing DEP0190 warns against passing an
// args array to. Resolving the CLI's actual .js file and running it with `process.execPath`
// (a real executable, not a shell script) avoids both — every argument here is still a fixed,
// non-user-input string, so there's no injection surface regardless.
const require = createRequire(import.meta.url);
const PRISMA_CLI_ENTRY = require.resolve("prisma/build/index.js");

/** Runs the tenant schema's pending migrations against `dsn` — a synchronous child process
 *  (provisioning is already a rare, admin-initiated, wait-for-it action; no benefit to making
 *  this async) with `DATABASE_URL` overridden for just this one invocation. */
export function runMigrateDeploy(dsn: string): void {
  execFileSync(process.execPath, [PRISMA_CLI_ENTRY, "migrate", "deploy", "--schema", TENANT_SCHEMA_PATH], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: dsn },
    stdio: "pipe"
  });
}

/**
 * The full provisioning flow for one org already registered in the control plane (created via
 * POST /platform-admin/organizations, status PROVISIONING). Physically creates its database,
 * migrates it, seeds baseline data + the one real admin account requested, registers the
 * connection, and flips the org ACTIVE.
 */
export async function provisionOrganization(orgId: string, input: ProvisionOrgInput): Promise<ProvisionOrgResult> {
  if (!env.TENANT_DB_PROVISION_BASE_URL) {
    throw new AppError(400, "TENANT_DB_PROVISION_BASE_URL isn't configured — provision this organization's database manually and register it via its OrgDatabase row instead.");
  }

  const org = await controlPrisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new AppError(404, "Organization not found");
  if (org.status === "ACTIVE") throw new AppError(409, "This organization is already active — re-provisioning an active org isn't supported (use migrate-all-tenants for schema updates).");

  const databaseName = databaseNameForSlug(org.slug);
  const { dsn, host } = buildDsn(env.TENANT_DB_PROVISION_BASE_URL, databaseName);

  await createPhysicalDatabase(env.TENANT_DB_PROVISION_BASE_URL, databaseName);
  runMigrateDeploy(dsn);

  const client = await getTenantClient(org.id, dsn);
  await tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, async () => {
    await seedTenant(client, {
      adminEmail: input.adminEmail,
      adminName: input.adminName,
      adminPassword: input.adminPassword,
      includeDemoData: false
    });
  });

  const schemaVersion = getLatestMigrationName();
  await controlPrisma.orgDatabase.upsert({
    where: { organizationId: org.id },
    update: { encryptedDsn: encryptSecret(dsn), host, databaseName, migratedAt: new Date(), schemaVersion },
    create: { organizationId: org.id, encryptedDsn: encryptSecret(dsn), host, databaseName, migratedAt: new Date(), schemaVersion }
  });
  await controlPrisma.organization.update({ where: { id: org.id }, data: { status: "ACTIVE" } });

  return { organizationId: org.id, databaseName, schemaVersion };
}
