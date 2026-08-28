/**
 * WHAT: per-tenant observability for the platform console — one workspace's server health, service
 * status, incident history, API performance and, the part that did not exist anywhere before, its
 * DATABASE: size, growth, the tables that dominate it, and how the server it sits on is behaving.
 *
 * IT COMPOSES THE TENANT SERVICES RATHER THAN RE-QUERYING THEM. `getSystemHealth`, `getStatusPage`
 * and `getApiPerformanceOverview` already answer three of the four questions for the workspace you
 * are inside; entering that workspace's context with `withOrgTenant` and calling them is what makes
 * the platform view and the customer's own Maintenance tab show the SAME numbers. A second set of
 * queries here would drift, and the first person to notice would be a customer disagreeing with us
 * about their own uptime.
 *
 * THE DATABASE METRICS ARE NEW, AND THEIR HONESTY MATTERS:
 *  - PER-SCHEMA figures (size, rows, table count, index share, the biggest tables) come from
 *    `information_schema.TABLES` for that workspace's schema alone. Row counts there are InnoDB's
 *    ESTIMATES, not exact counts, and the response says so rather than presenting them as truth.
 *  - SERVER-WIDE figures (connections, slow queries, buffer-pool hit rate, uptime) come from
 *    `SHOW GLOBAL STATUS`. They describe the MySQL server, which several workspaces share. They are
 *    labelled `scope: "server"` for exactly that reason — attributing a server-wide slow-query
 *    count to one tenant would be a lie a dashboard makes very easy to tell.
 *
 * NOTHING HERE WRITES. Every query is a read, and a failure on any one section degrades that
 * section to `null` with its error rather than failing the page: a workspace whose database is down
 * is precisely when an operator needs the other four panels to still render.
 */
import { PrismaClient as ControlPrismaClient } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { getSystemHealth } from "./system-health.service.js";
import { getStatusPage } from "./service-health.service.js";
import { getApiPerformanceOverview } from "./api-performance.service.js";

/* ------------------------------------------------------------------------------------------ */
/* Database metrics                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface TableRow {
  name: string;
  /** InnoDB's ESTIMATE. Exact counts need a full scan, which is not worth doing to draw a chart. */
  estimatedRows: number;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
}

export interface DatabaseMetrics {
  databaseName: string;
  host: string;
  /** The MySQL server version, so an operator can see a tenant on an older box. */
  serverVersion: string | null;
  schema: {
    tableCount: number;
    estimatedRows: number;
    dataBytes: number;
    indexBytes: number;
    totalBytes: number;
    /** index / (data + index). A very low share on a large schema is a missing-index smell. */
    indexShare: number | null;
    largestTables: TableRow[];
  };
  /** Everything below describes the SERVER, which other workspaces may share. */
  server: {
    scope: "server";
    uptimeSec: number | null;
    threadsConnected: number | null;
    threadsRunning: number | null;
    maxConnections: number | null;
    connectionUsePercent: number | null;
    slowQueries: number | null;
    questions: number | null;
    /** Reads served from memory, as a percentage of all reads. Below ~99% is worth a look. */
    bufferPoolHitRate: number | null;
    abortedConnects: number | null;
  };
  /** How long the metrics query itself took — a slow answer here IS a finding. */
  queryMs: number;
}

const bigintToNumber = (value: unknown): number => (typeof value === "bigint" ? Number(value) : Number(value ?? 0));

/**
 * Read one workspace's database metrics through its OWN connection string.
 *
 * A dedicated short-lived client rather than the cached tenant client: this runs from an operator
 * screen, not the request path, and `information_schema` queries against a large server are exactly
 * the kind of thing that should not sit in a pool other requests are waiting on.
 */
export async function getDatabaseMetrics(orgId: string): Promise<DatabaseMetrics> {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, include: { database: true } });
  if (!org) throw new AppError(404, "Organization not found");
  if (!org.database) throw new AppError(409, "This workspace has no database registered.");

  const dsn = decryptSecret(org.database.encryptedDsn);
  const client = new ControlPrismaClient({ datasources: { db: { url: dsn } } });
  const started = Date.now();

  try {
    const [tables, status, variables] = await Promise.all([
      client.$queryRawUnsafe<Array<{ TABLE_NAME: string; TABLE_ROWS: bigint | null; DATA_LENGTH: bigint | null; INDEX_LENGTH: bigint | null }>>(
        `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
        org.database.databaseName
      ),
      // One round trip for every counter this screen reads. `SHOW GLOBAL STATUS` is cheap and the
      // alternative — one query per counter — multiplies latency for no benefit.
      client
        .$queryRawUnsafe<Array<{ Variable_name: string; Value: string }>>(
          `SHOW GLOBAL STATUS WHERE Variable_name IN
           ('Uptime','Threads_connected','Threads_running','Slow_queries','Questions','Aborted_connects',
            'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads')`
        )
        .catch(() => []),
      client.$queryRawUnsafe<Array<{ Variable_name: string; Value: string }>>(`SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','version')`).catch(() => [])
    ]);

    const statusOf = (name: string) => {
      const row = status.find((r) => r.Variable_name === name);
      return row ? Number(row.Value) : null;
    };
    const variableOf = (name: string) => variables.find((r) => r.Variable_name === name)?.Value ?? null;

    const rows: TableRow[] = tables.map((t) => {
      const dataBytes = bigintToNumber(t.DATA_LENGTH);
      const indexBytes = bigintToNumber(t.INDEX_LENGTH);
      return { name: t.TABLE_NAME, estimatedRows: bigintToNumber(t.TABLE_ROWS), dataBytes, indexBytes, totalBytes: dataBytes + indexBytes };
    });

    const dataBytes = rows.reduce((sum, r) => sum + r.dataBytes, 0);
    const indexBytes = rows.reduce((sum, r) => sum + r.indexBytes, 0);
    const readRequests = statusOf("Innodb_buffer_pool_read_requests");
    const diskReads = statusOf("Innodb_buffer_pool_reads");
    const maxConnections = Number(variableOf("max_connections")) || null;
    const threadsConnected = statusOf("Threads_connected");

    return {
      databaseName: org.database.databaseName,
      host: org.database.host,
      serverVersion: variableOf("version"),
      schema: {
        tableCount: rows.length,
        estimatedRows: rows.reduce((sum, r) => sum + r.estimatedRows, 0),
        dataBytes,
        indexBytes,
        totalBytes: dataBytes + indexBytes,
        indexShare: dataBytes + indexBytes > 0 ? indexBytes / (dataBytes + indexBytes) : null,
        largestTables: [...rows].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 12)
      },
      server: {
        scope: "server",
        uptimeSec: statusOf("Uptime"),
        threadsConnected,
        threadsRunning: statusOf("Threads_running"),
        maxConnections,
        connectionUsePercent: maxConnections && threadsConnected !== null ? (threadsConnected / maxConnections) * 100 : null,
        slowQueries: statusOf("Slow_queries"),
        questions: statusOf("Questions"),
        bufferPoolHitRate: readRequests && readRequests > 0 && diskReads !== null ? ((readRequests - diskReads) / readRequests) * 100 : null,
        abortedConnects: statusOf("Aborted_connects")
      },
      queryMs: Date.now() - started
    };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Derived alerts                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface HealthAlert {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  /** Which panel to look at, so an alert is a destination rather than only a statement. */
  area: "database" | "services" | "api" | "server" | "maintenance";
}

/**
 * Alerts are DERIVED from the numbers on the page, not stored as configured rules.
 *
 * Deliberately so, for now: a rules engine with per-tenant thresholds is a product of its own, and
 * an operator's first question is not "which rule fired" but "is anything wrong with this
 * workspace". Every threshold below is stated in the alert text, so nothing is a black box — and
 * when these need to become editable, they are already one pure function.
 */
export function deriveAlerts(input: {
  database: DatabaseMetrics | null;
  openIncidents: number;
  downServices: string[];
  degradedServices: string[];
  apiErrorRate: number | null;
  apiP95Ms: number | null;
  maintenancePhase: string | null;
}): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  if (input.downServices.length) {
    alerts.push({ severity: "critical", title: `${input.downServices.length} service down`, detail: input.downServices.join(", "), area: "services" });
  }
  if (input.degradedServices.length) {
    alerts.push({ severity: "warning", title: `${input.degradedServices.length} service degraded`, detail: input.degradedServices.join(", "), area: "services" });
  }
  if (input.openIncidents > 0) {
    alerts.push({ severity: "warning", title: `${input.openIncidents} open incident${input.openIncidents === 1 ? "" : "s"}`, detail: "Still unresolved on this workspace's status page.", area: "services" });
  }

  const db = input.database;
  if (db) {
    if (db.server.connectionUsePercent !== null && db.server.connectionUsePercent >= 80) {
      alerts.push({
        severity: db.server.connectionUsePercent >= 90 ? "critical" : "warning",
        title: `Database connections at ${db.server.connectionUsePercent.toFixed(0)}%`,
        detail: `${db.server.threadsConnected} of ${db.server.maxConnections} on ${db.host}. Server-wide — every workspace on this box shares it. Threshold: 80%.`,
        area: "database"
      });
    }
    if (db.server.bufferPoolHitRate !== null && db.server.bufferPoolHitRate < 99) {
      alerts.push({
        severity: db.server.bufferPoolHitRate < 95 ? "warning" : "info",
        title: `Buffer pool hit rate ${db.server.bufferPoolHitRate.toFixed(2)}%`,
        detail: "Reads are going to disk more than they should. Server-wide. Threshold: 99%.",
        area: "database"
      });
    }
    if (db.schema.totalBytes > 20 * 1024 ** 3) {
      alerts.push({ severity: "info", title: "Large workspace database", detail: `${(db.schema.totalBytes / 1024 ** 3).toFixed(1)} GB across ${db.schema.tableCount} tables. Threshold: 20 GB.`, area: "database" });
    }
    if (db.queryMs > 2000) {
      alerts.push({ severity: "warning", title: "Slow metadata query", detail: `information_schema took ${db.queryMs} ms to answer — the server is busy or the schema is very large. Threshold: 2000 ms.`, area: "database" });
    }
  }

  if (input.apiErrorRate !== null && input.apiErrorRate >= 2) {
    alerts.push({
      severity: input.apiErrorRate >= 5 ? "critical" : "warning",
      title: `API error rate ${input.apiErrorRate.toFixed(1)}%`,
      detail: "Share of sampled requests answering 5xx. Threshold: 2%.",
      area: "api"
    });
  }
  if (input.apiP95Ms !== null && input.apiP95Ms >= 1500) {
    alerts.push({ severity: "warning", title: `API p95 ${Math.round(input.apiP95Ms)} ms`, detail: "Slowest 5% of sampled requests. Threshold: 1500 ms.", area: "api" });
  }

  if (input.maintenancePhase === "active") {
    alerts.push({ severity: "info", title: "In maintenance", detail: "Everyone below super admin is locked out of this workspace right now.", area: "maintenance" });
  }

  return alerts;
}

/* ------------------------------------------------------------------------------------------ */
/* The per-tenant page                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** A section that can fail without taking the page with it. */
type Section<T> = { data: T | null; error: string | null };

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { data: await load(), error: null };
  } catch (error) {
    return { data: null, error: (error as Error).message.slice(0, 300) };
  }
}

export async function getTenantHealth(orgId: string, days = 30): Promise<{
  organization: { id: string; name: string; slug: string; status: string; planTier: string; databaseName: string | null };
  maintenance: Section<{ enabled: boolean; phase: string; scheduledStartAt: Date | null; scheduledEndAt: Date | null; message: string | null }>;
  system: Section<Awaited<ReturnType<typeof getSystemHealth>>>;
  status: Section<Awaited<ReturnType<typeof getStatusPage>>>;
  api: Section<Awaited<ReturnType<typeof getApiPerformanceOverview>>>;
  database: Section<DatabaseMetrics>;
  alerts: HealthAlert[];
}> {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, include: { database: { select: { databaseName: true } } } });
  if (!org) throw new AppError(404, "Organization not found");

  // The three tenant-scoped reads share ONE tenant context: three separate `withOrgTenant` calls
  // would resolve the org, decrypt its DSN and open a client three times for one screen.
  const inTenant = await section(async () =>
    withOrgTenant(org.slug, async () => {
      const { getMaintenanceSettings, phaseOf } = await import("./maintenance.service.js");
      const settings = await getMaintenanceSettings();
      const [system, status, api] = await Promise.all([
        section(() => getSystemHealth()),
        section(() => getStatusPage(days)),
        // HOURS, not days — the tenant panel takes a window in hours, and passing 30 here would
        // silently narrow a month to a day and a quarter.
        section(() => getApiPerformanceOverview(days * 24))
      ]);
      return {
        maintenance: { enabled: settings.enabled, phase: phaseOf(settings), scheduledStartAt: settings.scheduledStartAt, scheduledEndAt: settings.scheduledEndAt, message: settings.message },
        system,
        status,
        api
      };
    })
  );

  const database = org.database ? await section(() => getDatabaseMetrics(orgId)) : { data: null, error: "No database registered for this workspace." };

  const statusData = inTenant.data?.status.data;
  const apiTotals = inTenant.data?.api.data?.totals as { errorRate?: number; p95Ms?: number } | undefined;

  const alerts = deriveAlerts({
    database: database.data,
    openIncidents: statusData?.incidents?.filter((i: { endedAt: Date | string | null }) => !i.endedAt).length ?? 0,
    downServices: (statusData?.services ?? []).filter((s: { current: string | null }) => s.current === "DOWN").map((s: { label: string }) => s.label),
    degradedServices: (statusData?.services ?? []).filter((s: { current: string | null }) => s.current === "DEGRADED").map((s: { label: string }) => s.label),
    apiErrorRate: apiTotals?.errorRate ?? null,
    apiP95Ms: apiTotals?.p95Ms ?? null,
    maintenancePhase: inTenant.data?.maintenance.phase ?? null
  });

  return {
    organization: { id: org.id, name: org.name, slug: org.slug, status: org.status, planTier: org.planTier, databaseName: org.database?.databaseName ?? null },
    maintenance: inTenant.data ? { data: inTenant.data.maintenance, error: null } : { data: null, error: inTenant.error },
    system: inTenant.data?.system ?? { data: null, error: inTenant.error },
    status: inTenant.data?.status ?? { data: null, error: inTenant.error },
    api: inTenant.data?.api ?? { data: null, error: inTenant.error },
    database,
    alerts
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The fleet view                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface FleetRow {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  planTier: string;
  databaseName: string | null;
  reachable: boolean;
  error: string | null;
  totalBytes: number | null;
  tableCount: number | null;
  estimatedRows: number | null;
  queryMs: number | null;
  maintenancePhase: string | null;
  alerts: HealthAlert[];
}

/**
 * Every workspace's database at a glance.
 *
 * SEQUENTIAL, NOT PARALLEL, and that is the point: this opens a fresh connection per workspace, and
 * forty at once against one MySQL server is a self-inflicted connection storm on the box the whole
 * platform runs on. A screen an operator opens occasionally can afford to take a few seconds.
 */
export async function getFleetHealth(): Promise<{ rows: FleetRow[]; totals: { databases: number; reachable: number; totalBytes: number; alerts: number } }> {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: { in: ["ACTIVE", "GRACE", "SUSPENDED"] } },
    orderBy: { name: "asc" },
    include: { database: { select: { databaseName: true } } }
  });

  const rows: FleetRow[] = [];
  for (const org of orgs) {
    const base = {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      planTier: org.planTier,
      databaseName: org.database?.databaseName ?? null
    };
    if (!org.database) {
      rows.push({ ...base, reachable: false, error: "No database registered.", totalBytes: null, tableCount: null, estimatedRows: null, queryMs: null, maintenancePhase: null, alerts: [] });
      continue;
    }
    try {
      const metrics = await getDatabaseMetrics(org.id);
      let phase: string | null = null;
      try {
        phase = await withOrgTenant(org.slug, async () => {
          const { getMaintenanceSettings, phaseOf } = await import("./maintenance.service.js");
          return phaseOf(await getMaintenanceSettings());
        });
      } catch {
        phase = null;
      }
      rows.push({
        ...base,
        reachable: true,
        error: null,
        totalBytes: metrics.schema.totalBytes,
        tableCount: metrics.schema.tableCount,
        estimatedRows: metrics.schema.estimatedRows,
        queryMs: metrics.queryMs,
        maintenancePhase: phase,
        alerts: deriveAlerts({ database: metrics, openIncidents: 0, downServices: [], degradedServices: [], apiErrorRate: null, apiP95Ms: null, maintenancePhase: phase })
      });
    } catch (error) {
      rows.push({ ...base, reachable: false, error: (error as Error).message.slice(0, 200), totalBytes: null, tableCount: null, estimatedRows: null, queryMs: null, maintenancePhase: null, alerts: [] });
    }
  }

  return {
    rows,
    totals: {
      databases: rows.length,
      reachable: rows.filter((r) => r.reachable).length,
      totalBytes: rows.reduce((sum, r) => sum + (r.totalBytes ?? 0), 0),
      alerts: rows.reduce((sum, r) => sum + r.alerts.length, 0)
    }
  };
}
