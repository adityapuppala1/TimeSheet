/**
 * WHAT: the managed-backup engine — take a dump of one workspace's database, write it to that
 * workspace's destination, record the run, apply the retention policy, and tell somebody if it
 * failed.
 *
 * THE FOUR RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. THE TIER IS A CEILING, CHECKED AT RUN TIME. A policy stores what an operator ASKED for; every
 *    run re-reads the org's effective tier and clamps to it. That is what makes a downgrade take
 *    effect without anyone editing a policy, and what stops a Team workspace being configured
 *    hourly by a platform admin who meant well.
 *
 * 2. RETENTION IS COMPUTED, THEN APPLIED — never the other way round. `planRetention()` is a pure
 *    function from (runs, policy) to "keep these, delete those", so the console's preview, the
 *    worker's sweep and the tests all ask the same code. A deletion pass that decides as it walks
 *    is one whose behaviour nobody can state.
 *
 * 3. NOTHING IS DELETED BEFORE ITS REPLACEMENT EXISTS. The sweep runs AFTER a successful upload,
 *    never before, and only ever considers runs that succeeded. A failed backup therefore cannot
 *    take the last good one with it, which is the classic way a retention policy destroys data.
 *
 * 4. GFS IS A PROMOTION, NOT A COPY. One object is kept and TAGGED as the daily, weekly, monthly or
 *    yearly it happens to satisfy — the first backup of a month IS the monthly. Uploading four
 *    copies of the same bytes is the naive reading and quadruples the storage bill for nothing.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient as ControlPrismaClient } from "../generated/control-client/index.js";
import { BACKUP_FREQUENCY_RANK, backupFrequencyAllowed, PLAN_TIER_LIMITS, type BackupFrequency, type PlanTier } from "@timesheet/shared";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { adapterFor, type DestinationRecord } from "./backup-destination.service.js";
import { platformAudit } from "./platform-audit.service.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_DB_NAME = /^\w{1,64}$/;
const mysqldumpBinary = () => process.env.MYSQLDUMP_PATH || "mysqldump";
const mysqlBinary = () => process.env.MYSQL_PATH || "mysql";

export type RetentionMode = "COUNT" | "AGE" | "GFS";
export type RunKind = "SCHEDULED" | "MANUAL" | "PRE_DELETE" | "TEST_RESTORE";

/* ------------------------------------------------------------------------------------------ */
/* Entitlement                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * What a workspace is actually allowed, right now. Reads the tier row from the control plane when
 * there is one (a platform admin may have tuned it) and falls back to the shipped constants.
 *
 * The TRIAL tier counts, exactly as it does for every other entitlement: a workspace trialling Team
 * gets Team's backup cadence for the length of the trial and loses it when the trial lapses — no
 * separate code path, because `effectiveTier` is the same idea `plan-limits.service.ts` already
 * applies everywhere else.
 */
export async function backupEntitlement(org: { planTier: PlanTier; trialTier: PlanTier | null; trialEndsAt: Date | null }): Promise<{
  tier: PlanTier;
  frequency: BackupFrequency;
  maxDestinations: number;
  pitrEnabled: boolean;
}> {
  const trialLive = Boolean(org.trialTier && org.trialEndsAt && org.trialEndsAt.getTime() > Date.now());
  const tier = trialLive && org.trialTier ? org.trialTier : org.planTier;
  const row = await controlPrisma.planTierLimit.findUnique({ where: { tier } }).catch(() => null);
  const shipped = PLAN_TIER_LIMITS[tier];
  return {
    tier,
    frequency: (row?.backupFrequency as BackupFrequency | undefined) ?? shipped.backupFrequency,
    maxDestinations: row?.maxBackupDestinations ?? shipped.maxBackupDestinations,
    pitrEnabled: row?.backupPitrEnabled ?? shipped.backupPitrEnabled
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Schedule                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface SchedulePolicy {
  frequency: BackupFrequency;
  hourUtc: number;
  dayOfWeek: number;
}

/**
 * The next moment this policy is due, strictly after `from`. Pure, so the console can show the same
 * answer the worker will act on.
 *
 * ALWAYS STRICTLY AFTER. A boundary-inclusive version re-fires the same slot on the tick that just
 * ran it, which is how a "daily" backup becomes an hourly one for as long as the process is up.
 */
export function nextRunAt(policy: SchedulePolicy, from: Date): Date | null {
  if (policy.frequency === "NONE") return null;
  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);

  if (policy.frequency === "HOURLY") {
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }

  next.setUTCHours(policy.hourUtc);
  if (policy.frequency === "DAILY") {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  // WEEKLY: move to the wanted weekday, then push a week if that moment has already passed.
  const wanted = ((policy.dayOfWeek % 7) + 7) % 7;
  const delta = (wanted - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + delta);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

/* ------------------------------------------------------------------------------------------ */
/* Retention                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface RetainableRun {
  id: string;
  startedAt: Date;
  objectKey: string | null;
}

export interface RetentionRules {
  retentionMode: RetentionMode;
  keepCount: number;
  keepDays: number;
  gfsDaily: number;
  gfsWeekly: number;
  gfsMonthly: number;
  gfsYearly: number;
}

export interface RetentionDecision {
  keep: Array<{ id: string; tag: string | null }>;
  drop: RetainableRun[];
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const yearKey = (d: Date) => d.toISOString().slice(0, 4);
/** ISO-ish week bucket. Exactness does not matter — only that one week maps to one key. */
function weekKey(d: Date): string {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * Decide which successful runs survive. PURE — no I/O, no clock beyond `now`.
 *
 * GFS reads newest-first and hands each backup the FIRST slot it can fill: it is that day's daily,
 * or that week's weekly, and so on. One object can occupy several slots at once (the first backup
 * of January is the daily, the weekly, the monthly and the yearly), which is exactly what makes the
 * scheme cheap — the alternative keeps four copies of identical bytes.
 */
export function planRetention(runs: RetainableRun[], rules: RetentionRules, now = new Date()): RetentionDecision {
  const ordered = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  if (rules.retentionMode === "COUNT") {
    const keep = ordered.slice(0, Math.max(1, rules.keepCount));
    return { keep: keep.map((r) => ({ id: r.id, tag: null })), drop: ordered.slice(keep.length) };
  }

  if (rules.retentionMode === "AGE") {
    const cutoff = now.getTime() - Math.max(1, rules.keepDays) * DAY_MS;
    const keep = ordered.filter((r) => r.startedAt.getTime() >= cutoff);
    const drop = ordered.filter((r) => r.startedAt.getTime() < cutoff);
    // NEVER drop the last one. An age rule on a workspace that has gone quiet would otherwise
    // delete its only backup on a schedule, which is the opposite of what a retention policy is for.
    if (keep.length === 0 && ordered.length > 0) return { keep: [{ id: ordered[0].id, tag: null }], drop: drop.slice(1) };
    return { keep: keep.map((r) => ({ id: r.id, tag: null })), drop };
  }

  const slots: Array<{ tag: string; limit: number; key: (d: Date) => string; seen: Set<string> }> = [
    { tag: "DAILY", limit: Math.max(0, rules.gfsDaily), key: dayKey, seen: new Set() },
    { tag: "WEEKLY", limit: Math.max(0, rules.gfsWeekly), key: weekKey, seen: new Set() },
    { tag: "MONTHLY", limit: Math.max(0, rules.gfsMonthly), key: monthKey, seen: new Set() },
    { tag: "YEARLY", limit: Math.max(0, rules.gfsYearly), key: yearKey, seen: new Set() }
  ];

  const keep: Array<{ id: string; tag: string | null }> = [];
  const drop: RetainableRun[] = [];
  for (const run of ordered) {
    let tag: string | null = null;
    for (const slot of slots) {
      const key = slot.key(run.startedAt);
      if (slot.seen.size >= slot.limit || slot.seen.has(key)) continue;
      slot.seen.add(key);
      tag ??= slot.tag;
    }
    if (tag) keep.push({ id: run.id, tag });
    else drop.push(run);
  }
  // Same floor as AGE: a policy configured to keep nothing still keeps the newest.
  if (keep.length === 0 && ordered.length > 0) return { keep: [{ id: ordered[0].id, tag: "DAILY" }], drop: drop.filter((r) => r.id !== ordered[0].id) };
  return { keep, drop };
}

/* ------------------------------------------------------------------------------------------ */
/* Dump + restore                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Run `mysqldump` to `outFile`. Resolves with the byte count; rejects with the tool's own stderr. */
function dumpDatabase(dsn: string, databaseName: string, outFile: string): Promise<number> {
  const url = new URL(dsn);
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outFile);
    const child = spawn(
      mysqldumpBinary(),
      ["--host", url.hostname, "--port", url.port || "3306", "--user", decodeURIComponent(url.username), "--single-transaction", "--routines", "--triggers", "--default-character-set=utf8mb4", databaseName],
      // The password travels in the environment, never on argv where `ps` shows it to every user.
      { env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 60 * 60 * 1000);
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      out.close();
      reject(
        new AppError(
          503,
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `${mysqldumpBinary()} is not on this host — set MYSQLDUMP_PATH, or install the MySQL client where the API runs.`
            : error.message
        )
      );
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      out.close();
      if (code !== 0) {
        reject(new AppError(502, `mysqldump exited ${code}: ${stderr.trim().slice(0, 400)}`));
        return;
      }
      const stat = await fs.stat(outFile).catch(() => null);
      resolve(stat?.size ?? 0);
    });
  });
}

/** Import a dump into a database that already exists. Used only by the test restore. */
function importDump(dsn: string, databaseName: string, file: string): Promise<void> {
  const url = new URL(dsn);
  return new Promise((resolve, reject) => {
    const child = spawn(
      mysqlBinary(),
      ["--host", url.hostname, "--port", url.port || "3306", "--user", decodeURIComponent(url.username), "--default-character-set=utf8mb4", databaseName],
      { env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) }, stdio: ["pipe", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (e) => reject(new AppError(503, (e as NodeJS.ErrnoException).code === "ENOENT" ? `${mysqlBinary()} is not on this host — set MYSQL_PATH.` : e.message)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new AppError(502, `mysql exited ${code}: ${stderr.trim().slice(0, 400)}`))));
    createReadStream(file).pipe(child.stdin);
  });
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

/* ------------------------------------------------------------------------------------------ */
/* Alerts                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * Tell somebody. Email through the platform relay (the workspace's own SMTP is the wrong sender for
 * "your backup failed", and may be the thing that is broken), plus an optional webhook that speaks
 * both Slack's shape and a plain JSON one.
 *
 * NEVER THROWS. An alert that fails must not turn a successful backup into a failed one, nor a
 * failed backup into an unrecorded one.
 */
async function alert(
  policy: { alertEmails: string | null; encryptedAlertWebhook: string | null },
  vars: { workspace: string; slug: string; outcome: string; destination: string; detail: string },
  orgId: string
): Promise<void> {
  const subject = `Backup ${vars.outcome} — ${vars.workspace}`;
  if (policy.alertEmails) {
    const to = policy.alertEmails
      .split(/[,;\s]+/)
      .filter((a) => a.includes("@"))
      .join(",");
    if (to) {
      // The REGISTERED template, not a hand-built body: that is what makes this email editable,
      // previewable and test-sendable in the console like every other platform message, and what
      // puts its deliveries in the same analytics as the rest.
      await sendPlatformTemplate("backup.alert", { to, vars, organizationId: orgId, metadata: { outcome: vars.outcome } }).catch((error) =>
        console.warn(`[backup] alert email failed: ${(error as Error).message}`)
      );
    }
  }
  if (policy.encryptedAlertWebhook) {
    try {
      const url = decryptSecret(policy.encryptedAlertWebhook);
      // `text` is what Slack reads; the structured fields are for anything else, so one URL field
      // serves both without asking the operator which kind of endpoint they have.
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${subject}*\n${vars.workspace} (${vars.slug}) · ${vars.destination}\n${vars.detail}`, ...vars, organizationId: orgId })
      });
    } catch (error) {
      console.warn(`[backup] alert webhook failed: ${(error as Error).message}`);
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Running one backup                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface RunBackupResult {
  runId: string;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  objectKey?: string;
  bytes?: number;
  checksum?: string;
  message: string;
}

/**
 * Back one workspace up, end to end. Records a RUNNING row first so a crash mid-dump is visible as
 * a stuck run rather than as nothing at all.
 */
export async function runBackup(orgId: string, opts: { kind: RunKind; actorLabel: string; destinationId?: string }): Promise<RunBackupResult> {
  const org = await controlPrisma.organization.findUnique({
    where: { id: orgId },
    include: { database: true, backupPolicy: { include: { destination: true } } }
  });
  if (!org) throw new AppError(404, "Organization not found");

  const policy = org.backupPolicy;
  const destination = (opts.destinationId
    ? await controlPrisma.backupDestination.findUnique({ where: { id: opts.destinationId } })
    : policy?.destination) as DestinationRecord | null;

  const skip = async (message: string) => {
    const row = await controlPrisma.backupRun.create({
      data: { organizationId: orgId, destinationId: destination?.id ?? null, kind: opts.kind, status: "SKIPPED", finishedAt: new Date(), errorMessage: message }
    });
    return { runId: row.id, status: "SKIPPED" as const, message };
  };

  if (!org.database) return skip("This workspace has no database registered — nothing to back up.");
  if (!destination) return skip("No destination is configured for this workspace.");

  const entitlement = await backupEntitlement(org);
  // RULE 1. Manual runs are still bounded by the tier having the module at all; what they bypass is
  // the CADENCE, not the entitlement.
  if (entitlement.frequency === "NONE") return skip(`The ${entitlement.tier} plan does not include managed backups.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const objectKey = `${org.slug}/${org.slug}-${stamp}.sql`;
  const tmp = path.join(os.tmpdir(), `timesphere-backup-${org.slug}-${stamp}.sql`);

  const run = await controlPrisma.backupRun.create({
    data: { organizationId: orgId, destinationId: destination.id, kind: opts.kind, status: "RUNNING", objectKey, metadata: { by: opts.actorLabel } }
  });

  try {
    if (!SAFE_DB_NAME.test(org.database.databaseName)) throw new AppError(500, `Refusing to dump a database with an unexpected name: ${org.database.databaseName}`);
    const dsn = decryptSecret(org.database.encryptedDsn);
    const bytes = await dumpDatabase(dsn, org.database.databaseName, tmp);
    const checksum = await sha256(tmp);

    const adapter = await adapterFor(destination);
    await adapter.put({ key: objectKey, filePath: tmp, bytes });

    const finished = await controlPrisma.backupRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), bytes: BigInt(bytes), checksumSha256: checksum }
    });

    if (policy) {
      await controlPrisma.orgBackupPolicy.update({
        where: { id: policy.id },
        data: { lastRunAt: new Date(), lastStatus: "SUCCEEDED", nextRunAt: nextRunAt(policy, new Date()) }
      });
      // RULE 3. Only after a success, and only over successes.
      await sweepRetention(orgId, policy.id).catch((error) => console.warn(`[backup] retention sweep failed for ${org.slug}: ${(error as Error).message}`));
      if (policy.alertOnSuccess) {
        await alert(
          policy,
          { workspace: org.name, slug: org.slug, outcome: "SUCCEEDED", destination: destination.name, detail: `${(bytes / 1_048_576).toFixed(1)} MB written as ${objectKey}.` },
          orgId
        );
      }
    }
    await platformAudit(opts.kind === "SCHEDULED" ? "SYSTEM" : "PLATFORM_ADMIN", opts.actorLabel, "backup.run_succeeded", "Organization", orgId, { slug: org.slug, bytes, destination: destination.name, objectKey });
    return { runId: finished.id, status: "SUCCEEDED", objectKey, bytes, checksum, message: `Backed up ${(bytes / 1_048_576).toFixed(1)} MB to ${destination.name}.` };
  } catch (error) {
    const message = error instanceof AppError ? error.message : (error as Error).message;
    await controlPrisma.backupRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: message.slice(0, 1000) } });
    if (policy) {
      await controlPrisma.orgBackupPolicy.update({
        where: { id: policy.id },
        data: { lastRunAt: new Date(), lastStatus: "FAILED", nextRunAt: nextRunAt(policy, new Date()) }
      });
      if (policy.alertOnFailure) {
        await alert(policy, { workspace: org.name, slug: org.slug, outcome: "FAILED", destination: destination.name, detail: message }, orgId);
      }
    }
    await platformAudit(opts.kind === "SCHEDULED" ? "SYSTEM" : "PLATFORM_ADMIN", opts.actorLabel, "backup.run_failed", "Organization", orgId, { slug: org.slug, error: message.slice(0, 300) });
    return { runId: run.id, status: "FAILED", message };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Retention sweep                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Apply the policy: tag the survivors, delete the objects the rules do not keep, mark the rows. */
export async function sweepRetention(orgId: string, policyId: string): Promise<{ kept: number; deleted: number; failed: number }> {
  const policy = await controlPrisma.orgBackupPolicy.findUnique({ where: { id: policyId }, include: { destination: true } });
  if (!policy?.destination) return { kept: 0, deleted: 0, failed: 0 };

  const runs = await controlPrisma.backupRun.findMany({
    where: { organizationId: orgId, destinationId: policy.destinationId, status: "SUCCEEDED", kind: { in: ["SCHEDULED", "MANUAL"] }, objectKey: { not: null } },
    select: { id: true, startedAt: true, objectKey: true },
    orderBy: { startedAt: "desc" }
  });

  const decision = planRetention(runs, policy);
  const adapter = await adapterFor(policy.destination as DestinationRecord);

  for (const k of decision.keep) {
    await controlPrisma.backupRun.update({ where: { id: k.id }, data: { retentionTag: k.tag } }).catch(() => undefined);
  }

  let deleted = 0;
  let failed = 0;
  for (const run of decision.drop) {
    try {
      if (run.objectKey) await adapter.remove(run.objectKey);
      // The ROW survives with its object cleared — the monitoring screen should still be able to
      // say a backup happened on that day, and only that its bytes have aged out.
      await controlPrisma.backupRun.update({ where: { id: run.id }, data: { objectKey: null, retentionTag: null, metadata: { prunedAt: new Date().toISOString() } } });
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[backup] could not prune ${run.objectKey}: ${(error as Error).message}`);
    }
  }
  return { kept: decision.keep.length, deleted, failed };
}

/* ------------------------------------------------------------------------------------------ */
/* Test restore                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Prove a backup reads back, by restoring it into a scratch database and then dropping it.
 *
 * IT NEVER TOUCHES THE TENANT. The scratch name is derived from the run id, the import goes there,
 * and the database is dropped in the `finally` whatever happened. A "test" that could write over
 * the workspace it is testing is not a test.
 */
export async function testRestore(runId: string, actorLabel: string): Promise<{ ok: boolean; message: string; tables?: number; bytes?: number }> {
  if (!env.TENANT_DB_PROVISION_BASE_URL) throw new AppError(409, "A test restore needs TENANT_DB_PROVISION_BASE_URL — the server scratch databases are created on.");
  const run = await controlPrisma.backupRun.findUnique({ where: { id: runId }, include: { destination: true, organization: true } });
  if (!run) throw new AppError(404, "No such backup run.");
  if (run.status !== "SUCCEEDED" || !run.objectKey || !run.destination) throw new AppError(409, "That run has no stored object to restore.");

  const entitlement = await backupEntitlement(run.organization);
  if (!entitlement.pitrEnabled) throw new AppError(403, `Test restores are an Enterprise capability; ${run.organization.slug} is on ${entitlement.tier}.`);

  const scratch = `ts_restore_test_${run.id.replace(/-/g, "").slice(0, 24)}`;
  if (!SAFE_DB_NAME.test(scratch)) throw new AppError(500, "Refusing to create a scratch database with an unexpected name.");
  const tmp = path.join(os.tmpdir(), `timesphere-restore-${run.id}.sql`);

  const base = new URL(env.TENANT_DB_PROVISION_BASE_URL);
  const bootstrap = new URL(base.toString());
  bootstrap.pathname = "/mysql";
  const admin = new ControlPrismaClient({ datasources: { db: { url: bootstrap.toString() } } });

  const started = await controlPrisma.backupRun.create({
    data: { organizationId: run.organizationId, destinationId: run.destinationId, kind: "TEST_RESTORE", status: "RUNNING", metadata: { of: run.id, by: actorLabel } }
  });

  try {
    const adapter = await adapterFor(run.destination as DestinationRecord);
    await adapter.download(run.objectKey, tmp);

    // The checksum is the point of storing one: it proves the bytes that came back are the bytes
    // that went out, which a successful import alone does not.
    const checksum = await sha256(tmp);
    if (run.checksumSha256 && checksum !== run.checksumSha256) {
      throw new AppError(502, `Checksum mismatch — the stored object is not the dump that was written (expected ${run.checksumSha256.slice(0, 12)}…, got ${checksum.slice(0, 12)}…).`);
    }

    await admin.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${scratch}\``);
    const dsn = new URL(base.toString());
    dsn.pathname = `/${scratch}`;
    await importDump(dsn.toString(), scratch, tmp);

    const rows = await admin.$queryRawUnsafe<Array<{ n: bigint | number }>>(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?`, scratch);
    const tables = Number(rows[0]?.n ?? 0);
    if (tables === 0) throw new AppError(502, "The dump imported without error but produced no tables.");

    const stat = await fs.stat(tmp).catch(() => null);
    await controlPrisma.backupRun.update({
      where: { id: started.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), bytes: stat ? BigInt(stat.size) : null, checksumSha256: checksum, metadata: { of: run.id, by: actorLabel, tables } }
    });
    await platformAudit("PLATFORM_ADMIN", actorLabel, "backup.test_restore_succeeded", "Organization", run.organizationId, { runId, tables });
    return { ok: true, message: `Restored ${tables} tables into a scratch database and dropped it. Checksum matched.`, tables, bytes: stat?.size };
  } catch (error) {
    const message = error instanceof AppError ? error.message : (error as Error).message;
    await controlPrisma.backupRun.update({ where: { id: started.id }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: message.slice(0, 1000) } });
    await platformAudit("PLATFORM_ADMIN", actorLabel, "backup.test_restore_failed", "Organization", run.organizationId, { runId, error: message.slice(0, 300) });
    return { ok: false, message };
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${scratch}\``).catch(() => undefined);
    await admin.$disconnect().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The scheduler pass                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface BackupTickResult {
  due: number;
  ran: Array<{ slug: string; status: string; message: string }>;
  clamped: Array<{ slug: string; asked: BackupFrequency; allowed: BackupFrequency }>;
  dryRun: boolean;
  now: string;
}

/**
 * One pass of the scheduler. Exported so the console can dry-run it and a test can drive it without
 * waiting for cron.
 */
export async function runBackupTick(now = new Date(), opts: { dryRun?: boolean; actorLabel?: string } = {}): Promise<BackupTickResult> {
  const dryRun = Boolean(opts.dryRun);
  const result: BackupTickResult = { due: 0, ran: [], clamped: [], dryRun, now: now.toISOString() };

  const policies = await controlPrisma.orgBackupPolicy.findMany({
    where: { enabled: true, frequency: { not: "NONE" }, organization: { status: { in: ["ACTIVE", "GRACE"] } } },
    include: { organization: true }
  });

  for (const policy of policies) {
    const entitlement = await backupEntitlement(policy.organization);
    // RULE 1, applied every tick rather than at save time.
    if (!backupFrequencyAllowed(policy.frequency as BackupFrequency, entitlement.frequency)) {
      result.clamped.push({ slug: policy.organization.slug, asked: policy.frequency as BackupFrequency, allowed: entitlement.frequency });
      if (!dryRun && BACKUP_FREQUENCY_RANK[entitlement.frequency] > 0) {
        // Rewrite the policy DOWN to what the tier allows rather than silently not running: a
        // downgraded customer should see their schedule change, not wonder why nothing happens.
        await controlPrisma.orgBackupPolicy.update({
          where: { id: policy.id },
          data: { frequency: entitlement.frequency, nextRunAt: nextRunAt({ ...policy, frequency: entitlement.frequency }, now) }
        });
      } else if (!dryRun) {
        await controlPrisma.orgBackupPolicy.update({ where: { id: policy.id }, data: { enabled: false, frequency: "NONE", nextRunAt: null } });
      }
      continue;
    }

    // A policy that has never run has no nextRunAt; treat it as due so enabling one does something
    // today rather than at the next boundary.
    const due = !policy.nextRunAt || policy.nextRunAt <= now;
    if (!due) continue;
    result.due += 1;

    if (dryRun) {
      result.ran.push({ slug: policy.organization.slug, status: "WOULD_RUN", message: `Due since ${policy.nextRunAt?.toISOString() ?? "never run"}` });
      continue;
    }

    try {
      const outcome = await runBackup(policy.organizationId, { kind: "SCHEDULED", actorLabel: opts.actorLabel ?? "scheduler" });
      result.ran.push({ slug: policy.organization.slug, status: outcome.status, message: outcome.message });
    } catch (error) {
      // One workspace's failure must not stop the pass for the ones after it.
      result.ran.push({ slug: policy.organization.slug, status: "FAILED", message: (error as Error).message });
      await controlPrisma.orgBackupPolicy
        .update({ where: { id: policy.id }, data: { lastRunAt: now, lastStatus: "FAILED", nextRunAt: nextRunAt(policy, now) } })
        .catch(() => undefined);
    }
  }

  return result;
}
