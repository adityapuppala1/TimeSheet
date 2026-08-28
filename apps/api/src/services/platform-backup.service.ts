/**
 * WHAT: the snapshots the retention programme takes before it drops a workspace — listing them,
 * reading one back, restoring one, and deleting one.
 *
 * WHY THIS EXISTS. 3.12.0 shipped the snapshot (a best-effort `mysqldump` into
 * `PlatformRetentionSettings.snapshotDir`) and nothing else: no way to see what had been captured,
 * no way to get a file back to a customer who changed their mind, no way to restore, and no policy
 * on the snapshots themselves — so a directory of `.sql` files grew forever and nobody could say
 * what was in it. A backup you cannot list or restore is not a backup; it is a file.
 *
 * THE SAFETY RULES, because this module can both read and write whole databases:
 *
 * 1. THE DIRECTORY IS THE BOUNDARY. Every path is resolved and then checked to be INSIDE the
 *    configured `snapshotDir`. A request naming `../../etc/passwd` resolves outside it and is
 *    refused — the id in the API is a file NAME, never a path, and it is matched against the
 *    listing rather than concatenated.
 * 2. RESTORE NEVER OVERWRITES A LIVE WORKSPACE. It refuses unless the target organisation has no
 *    `OrgDatabase` row — i.e. it was deleted under the policy, or never provisioned. Restoring on
 *    top of a running tenant is the one mistake nobody recovers from, so it is not reachable.
 * 3. THE DUMP IS PIPED, NOT INTERPOLATED. `mysql` reads the file on stdin; nothing from the file
 *    ever becomes part of a shell command, and the database name is validated against `^\w{1,64}$`
 *    before it appears in a `CREATE DATABASE`.
 * 4. CREDENTIALS TRAVEL IN THE ENVIRONMENT (`MYSQL_PWD`), never on the command line, where `ps`
 *    would show them to every user on the host.
 *
 * WHAT IT DOES NOT DO, deliberately: it does not schedule backups of LIVE workspaces. That is a
 * platform-operations job for the database itself (see docs/NEW_ORGANIZATION_SETUP.md § 7), and a
 * per-tenant `mysqldump` loop from inside the app would be a worse version of it that competes with
 * the real one for I/O.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PrismaClient as ControlPrismaClient } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { encryptSecret } from "../utils/encryption.js";
import { getRetentionSettings } from "./retention.service.js";
import { platformAudit } from "./platform-audit.service.js";

const SAFE_DB_NAME = /^\w{1,64}$/;
/** `<slug>-<iso timestamp>.sql`, which is what `snapshotDatabase` writes. */
const SNAPSHOT_NAME = /^(?<slug>[a-z0-9][a-z0-9-]*)-(?<stamp>\d{4}-\d{2}-\d{2}T[\d-]+Z?)\.sql$/i;

export interface SnapshotFile {
  /** The file name. The API's id — never a path. */
  id: string;
  /** The workspace slug parsed out of the name, or null if the file was not written by us. */
  slug: string | null;
  /** Whether an organization with that slug still exists in the control plane. */
  organizationId: string | null;
  organizationName: string | null;
  /** True when that organization currently has NO database — i.e. this snapshot is restorable. */
  restorable: boolean;
  bytes: number;
  createdAt: string;
  modifiedAt: string;
}

export interface SnapshotListing {
  configured: boolean;
  directory: string | null;
  /** Why the listing is empty, when it is empty for a reason worth stating. */
  problem: string | null;
  totalBytes: number;
  files: SnapshotFile[];
  /** Whether the host has the binaries each operation needs, probed once per call. */
  tools: { mysqldump: boolean; mysql: boolean; mysqldumpPath: string; mysqlPath: string };
}

const mysqldumpBinary = () => process.env.MYSQLDUMP_PATH || "mysqldump";
const mysqlBinary = () => process.env.MYSQL_PATH || "mysql";

/** `--version` is the only honest probe: a binary on PATH that cannot run is not present. */
function probe(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function resolveDirectory(): Promise<{ dir: string | null; problem: string | null }> {
  const settings = await getRetentionSettings();
  if (!settings.snapshotDir) return { dir: null, problem: "No snapshot directory is configured — set one under Trial retention → The policy." };
  const dir = path.resolve(settings.snapshotDir);
  if (!fs.existsSync(dir)) return { dir, problem: `${dir} does not exist yet. It is created the first time a snapshot is taken.` };
  return { dir, problem: null };
}

/** Resolve a caller-supplied file NAME inside the snapshot directory, refusing anything that
 *  escapes it. The name is matched against the directory listing, so traversal cannot survive. */
async function resolveFile(id: string): Promise<{ dir: string; full: string }> {
  const { dir, problem } = await resolveDirectory();
  if (!dir) throw new AppError(409, problem ?? "No snapshot directory is configured.");
  if (problem) throw new AppError(404, problem);
  const entries = await fsp.readdir(dir);
  if (!entries.includes(id)) throw new AppError(404, "No snapshot by that name.");
  const full = path.resolve(dir, id);
  // Belt and braces: even after the listing match, prove the resolved path is inside the directory.
  if (path.relative(dir, full).startsWith("..") || path.isAbsolute(path.relative(dir, full))) {
    throw new AppError(400, "That name does not resolve inside the snapshot directory.");
  }
  return { dir, full };
}

export async function listSnapshots(): Promise<SnapshotListing> {
  const [{ dir, problem }, mysqldump, mysql] = await Promise.all([resolveDirectory(), probe(mysqldumpBinary()), probe(mysqlBinary())]);
  const tools = { mysqldump, mysql, mysqldumpPath: mysqldumpBinary(), mysqlPath: mysqlBinary() };
  if (!dir || problem) return { configured: Boolean(dir), directory: dir, problem, totalBytes: 0, files: [], tools };

  const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sql"));
  const slugs = new Set<string>();
  const parsed = entries.map((e) => {
    const slug = SNAPSHOT_NAME.exec(e.name)?.groups?.slug?.toLowerCase() ?? null;
    if (slug) slugs.add(slug);
    return { name: e.name, slug };
  });

  const orgs = slugs.size
    ? await controlPrisma.organization.findMany({ where: { slug: { in: [...slugs] } }, select: { id: true, slug: true, name: true, database: { select: { id: true } } } })
    : [];
  const bySlug = new Map(orgs.map((o) => [o.slug, o]));

  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  for (const p of parsed) {
    const stat = await fsp.stat(path.join(dir, p.name)).catch(() => null);
    if (!stat) continue;
    totalBytes += stat.size;
    const org = p.slug ? bySlug.get(p.slug) : undefined;
    files.push({
      id: p.name,
      slug: p.slug,
      organizationId: org?.id ?? null,
      organizationName: org?.name ?? null,
      // Restorable only into an org that exists and has no database of its own right now.
      restorable: Boolean(org && !org.database),
      bytes: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString()
    });
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { configured: true, directory: dir, problem: null, totalBytes, files, tools };
}

/** The absolute path of one snapshot, for streaming it to the operator. */
export async function snapshotPath(id: string): Promise<{ full: string; bytes: number }> {
  const { full } = await resolveFile(id);
  const stat = await fsp.stat(full);
  return { full, bytes: stat.size };
}

export async function deleteSnapshot(id: string, actorLabel: string): Promise<{ deleted: true; id: string }> {
  const { full } = await resolveFile(id);
  await fsp.rm(full);
  await platformAudit("PLATFORM_ADMIN", actorLabel, "backup.snapshot_deleted", "Snapshot", id);
  return { deleted: true, id };
}

/** Run `mysql < file` against the provisioning server. Resolves with stderr on a non-zero exit. */
function importDump(databaseName: string, file: string, baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const child = spawn(
      mysqlBinary(),
      ["--host", url.hostname, "--port", url.port || "3306", "--user", decodeURIComponent(url.username), "--default-character-set=utf8mb4", databaseName],
      { env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) }, stdio: ["pipe", "ignore", "pipe"] }
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AppError(503, (error as NodeJS.ErrnoException).code === "ENOENT" ? `${mysqlBinary()} was not found on the API host (set MYSQL_PATH).` : error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new AppError(502, `mysql exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
    fs.createReadStream(file).pipe(child.stdin);
  });
}

export interface RestoreResult {
  restored: true;
  organizationId: string;
  slug: string;
  databaseName: string;
  status: string;
}

/**
 * Re-create a deleted workspace's database from a snapshot and re-register it.
 *
 * The organisation row survives deletion as ARCHIVED (that is why the slug is never quietly
 * reissued), so a restore is: make the database again, import the dump, write a fresh `OrgDatabase`
 * with an encrypted DSN, and put the workspace back into GRACE — reachable, billing open, nothing
 * else — with the retention clock HELD so the daily pass cannot delete it again while somebody is
 * still deciding. It is deliberately not returned to ACTIVE: what happens next is a commercial
 * conversation, not a database operation.
 */
export async function restoreSnapshot(id: string, orgId: string, confirmSlug: string, actorLabel: string): Promise<RestoreResult> {
  if (!env.TENANT_DB_PROVISION_BASE_URL) {
    throw new AppError(409, "Restoring needs TENANT_DB_PROVISION_BASE_URL — the same server new tenant databases are created on.");
  }
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, include: { database: { select: { id: true, databaseName: true } } } });
  if (!org) throw new AppError(404, "Organization not found");
  if (org.slug !== confirmSlug.trim().toLowerCase()) throw new AppError(422, "The slug you typed does not match this workspace.");
  // RULE 2. A live workspace is never restored over.
  if (org.database) {
    throw new AppError(409, `"${org.slug}" already has a database (${org.database.databaseName}). Restoring would overwrite live data, so it is refused — archive or delete it first if that is really what you want.`);
  }

  const { full } = await resolveFile(id);
  const databaseName = `tenant_${org.slug.replace(/-/g, "_")}`;
  if (!SAFE_DB_NAME.test(databaseName)) throw new AppError(500, `Refusing to create a database with an unexpected name: ${databaseName}`);

  const base = new URL(env.TENANT_DB_PROVISION_BASE_URL);
  const bootstrap = new URL(base.toString());
  bootstrap.pathname = "/mysql";
  const scratch = new ControlPrismaClient({ datasources: { db: { url: bootstrap.toString() } } });
  try {
    await scratch.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
  } finally {
    await scratch.$disconnect();
  }

  await importDump(databaseName, full, base.toString());

  const dsn = new URL(base.toString());
  dsn.pathname = `/${databaseName}`;
  await controlPrisma.orgDatabase.create({
    data: { organizationId: org.id, encryptedDsn: encryptSecret(dsn.toString()), host: base.hostname, databaseName, migratedAt: new Date() }
  });
  const updated = await controlPrisma.organization.update({
    where: { id: org.id },
    data: {
      status: "GRACE",
      graceStartedAt: new Date(),
      retentionDeletedAt: null,
      // Held, so the daily pass cannot delete what an operator has just spent effort restoring.
      retentionHold: true,
      suspendedAt: null,
      suspendedReason: `Restored from snapshot ${id}.`
    },
    select: { status: true }
  });

  await platformAudit("PLATFORM_ADMIN", actorLabel, "backup.snapshot_restored", "Organization", org.id, { slug: org.slug, snapshot: id, databaseName });
  return { restored: true, organizationId: org.id, slug: org.slug, databaseName, status: updated.status };
}
