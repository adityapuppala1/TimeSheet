/**
 * WHAT: one boot-time question — is any tenant's database behind the code that just started?
 *
 * WHY IT EXISTS: reaching `DATABASE_URL` is not the same as reaching the workspace. Every
 * organization has its own database, and a migration only lands in the rest of them when somebody
 * runs `npm run migrate:tenants`. Miss that step and the code is fine, the schema is fine, the tests
 * are fine, and one tenant is broken — silently, until a worker tries to read a table that does not
 * exist there and logs the same stack trace once a minute for as long as the process lives.
 *
 * That is exactly what happened after the V8 phases: ten migrations applied to the developer's own
 * `DATABASE_URL` and never fanned out, so the second org threw `The table 'automationflow' does not
 * exist` every minute from the schedule sweep. Nothing said so at boot, and the error itself named a
 * missing table rather than the thing to do about it.
 *
 * WHY IT WARNS RATHER THAN REFUSING TO START: a tenant behind on migrations is a real problem for
 * THAT tenant and not for the others, and a deployment that refuses to boot takes down the orgs that
 * were fine. `migrate-all-tenants.ts` already isolates one org's failure from the rest for the same
 * reason. So this reports, loudly and once, with the command that fixes it.
 *
 * WHY IT READS THE CONTROL PLANE AND NOT EACH DATABASE: `OrgDatabase.schemaVersion` is what the
 * fan-out writes when it finishes, so comparing it to `getLatestMigrationName()` answers the question
 * with one query against one database. Probing each tenant would be slower, would open connections at
 * boot to databases nothing has asked for yet, and would answer a subtly different question.
 *
 * WHO CALLS THIS: `server.ts` at boot, detached — it must never delay or block listening.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { getLatestMigrationName } from "./provisioning.service.js";

export interface TenantSchemaDrift {
  latest: string;
  behind: Array<{ slug: string; databaseName: string; schemaVersion: string | null }>;
}

/**
 * THE RULE, in one place (5.0.0).
 *
 * A null `schemaVersion` counts as behind: it means the fan-out has never completed for that org,
 * which is the case this exists to catch and not a reason to give it the benefit of the doubt.
 *
 * Extracted from `findDrift` when the console grew a page for this, so the boot warning and the
 * screen cannot disagree about what "behind" means — a screen that says a workspace is current
 * while the log says it is behind is worse than either message on its own.
 */
export const isBehind = (latest: string, schemaVersion: string | null): boolean => schemaVersion !== latest;

/** Pure enough to test: the comparison is the whole content, and it is easy to get backwards. */
export function findDrift(
  latest: string,
  orgs: Array<{ slug: string; databaseName: string; schemaVersion: string | null }>
): TenantSchemaDrift {
  return { latest, behind: orgs.filter((o) => isBehind(latest, o.schemaVersion)) };
}

/** The exact command that fixes it, from the repository root. One constant shared by the console
 *  page and the alert digest, because an operator retyping a subtly different command is the
 *  failure this whole check exists to shorten. (The boot warning below quotes the equivalent
 *  `npm run migrate:tenants -w apps/api`, which is the same script — it is written for somebody
 *  already reading a server log, not for somebody who has just clicked a page.) */
export const TENANT_MIGRATE_COMMAND = "npm run db:migrate:tenants";

export interface FleetSchemaRow {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  databaseName: string | null;
  schemaVersion: string | null;
  migratedAt: Date | null;
  behind: boolean;
}

/**
 * The same question the boot warning asks, shaped for a screen: which tenants are on which
 * migration, and which of them are behind the code that is running.
 *
 * WHY IT IS READ-ONLY AND WHY THERE IS NO BUTTON. The fix is a fan-out that opens, migrates and
 * closes every tenant database in turn, and it can fail on any one of them — a table that already
 * exists, a lock it cannot take, a workspace whose credentials have rotated. That needs a terminal
 * with somebody watching the output, not a browser tab that will time out at thirty seconds and
 * leave an operator guessing which half of the fleet moved. The page says so, in those words.
 *
 * INCLUDES THE WORKSPACES THAT ARE FINE, unlike the boot report which is deliberately silent when
 * everything is current. A page that lists only the problems cannot answer "did it work?" after
 * the fan-out, which is the second question every operator asks.
 */
export async function getFleetSchemaDrift(): Promise<{
  latest: string;
  rows: FleetSchemaRow[];
  behind: number;
  unregistered: number;
  command: string;
}> {
  const latest = getLatestMigrationName();
  const orgs = await controlPrisma.organization.findMany({
    // The same exclusion the boot check makes, for the same reason: nothing runs against an
    // ARCHIVED workspace, and listing one as "behind" forever trains people to ignore the column.
    where: { status: { in: ["ACTIVE", "GRACE", "SUSPENDED"] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true, status: true, database: { select: { databaseName: true, schemaVersion: true, migratedAt: true } } }
  });

  const rows: FleetSchemaRow[] = orgs.map((org) => ({
    organizationId: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    databaseName: org.database?.databaseName ?? null,
    schemaVersion: org.database?.schemaVersion ?? null,
    migratedAt: org.database?.migratedAt ?? null,
    // A workspace with no database registered is not BEHIND — there is nothing to migrate, and
    // calling it drift would put a permanent red row on the page for an org that is still
    // PROVISIONING. It is counted separately so it is visible without being alarming.
    behind: Boolean(org.database) && isBehind(latest, org.database!.schemaVersion)
  }));

  return {
    latest,
    rows,
    behind: rows.filter((row) => row.behind).length,
    unregistered: rows.filter((row) => !row.databaseName).length,
    command: TENANT_MIGRATE_COMMAND
  };
}

export async function checkTenantSchemas(): Promise<TenantSchemaDrift> {
  const latest = getLatestMigrationName();
  const orgs = await controlPrisma.organization.findMany({
    // ARCHIVED orgs are deliberately excluded: nothing runs against them, and reporting one as
    // "behind" every boot would train people to ignore this message — which is the only way it can
    // fail at its job.
    where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
    select: { slug: true, database: { select: { databaseName: true, schemaVersion: true } } }
  });

  return findDrift(
    latest,
    orgs
      .filter((o) => o.database)
      .map((o) => ({ slug: o.slug, databaseName: o.database!.databaseName, schemaVersion: o.database!.schemaVersion }))
  );
}

/** Boot-time report. Silent when everything is current — a message that appears every start is a
 *  message nobody reads by the third one. */
export async function reportTenantSchemaDrift(): Promise<void> {
  const { latest, behind } = await checkTenantSchemas();
  if (behind.length === 0) return;

  console.warn(
    `\n[tenant-schema] ${behind.length} organization(s) are BEHIND the code that just started.\n` +
      `[tenant-schema] This build expects: ${latest}\n` +
      behind.map((o) => `[tenant-schema]   - ${o.slug} (${o.databaseName}) is on ${o.schemaVersion ?? "no recorded version"}\n`).join("") +
      `[tenant-schema] Those workspaces will fail on any feature whose tables are missing — a worker\n` +
      `[tenant-schema] will log "table ... does not exist" once per tick until this is fixed.\n` +
      `[tenant-schema] Fix: npm run migrate:tenants -w apps/api    (see docs/DATABASE.md)\n`
  );
}
