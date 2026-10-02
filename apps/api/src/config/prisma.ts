import { PrismaClient } from "@prisma/client";
import { dbTimingStore } from "./db-timing.js";
import { requireTenantContext } from "./tenant-context.js";

/**
 * `prisma` is a Proxy, not a real client — every property access forwards to whichever
 * tenant's `PrismaClient` is active for the current request/job (see tenant-context.ts).
 * This is what lets every existing `import { prisma } from "../config/prisma.js"` across the
 * ~30 controllers/services/workers keep working with zero changes to their own code, even
 * though which physical database they end up hitting now varies per tenant.
 *
 * DO NOT reintroduce a real `new PrismaClient()` here — that would silently point every
 * caller back at one fixed database again, defeating the whole point.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = requireTenantContext().client;
    // Deliberately omit `receiver` here (defaults to `client` itself) — passing the Proxy
    // through would make `this` inside any getter on the real client resolve to the Proxy
    // rather than the client, which Prisma's internals were never written to expect.
    const value = Reflect.get(client as object, prop);
    return typeof value === "function" ? value.bind(client) : value;
  }
});

/**
 * Wraps a freshly-constructed client so every operation adds its own duration to the current
 * request's timing bucket (see config/db-timing.ts). This is the ONLY honest way to report
 * `ApiRequestSample.dbResponseTime` — Prisma's `query` log event knows the duration but not which
 * request caused it.
 *
 * WHY IT IS APPLIED UNCONDITIONALLY rather than only when telemetry is enabled: two differently-
 * shaped clients depending on configuration is exactly the kind of divergence that produces a bug
 * reproducible only in production. With no active bucket — every cron tick, every boot query, and
 * every request while telemetry is off — the wrapper is one `getStore()` returning undefined.
 *
 * `$allOperations` (not `$allModels`) so raw queries are counted too; a report endpoint that spends
 * its time in `$queryRaw` would otherwise report zero database time, which is worse than reporting
 * none. The cast is required because `$extends` returns a structurally different (wider) type that
 * TypeScript will not accept as `PrismaClient`; the runtime object is a superset, and confining the
 * cast to this one function keeps the other ~30 importers of `prisma` completely unaffected.
 */
function withDbTiming(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      async $allOperations({ args, query }) {
        const bucket = dbTimingStore.getStore();
        if (!bucket) return query(args);
        const startedAt = performance.now();
        try {
          return await query(args);
        } finally {
          // In `finally` on purpose: a query that THREW still consumed database time, and a slow
          // failing query is precisely what somebody debugging "why was it slow" is hunting.
          bucket.ms += performance.now() - startedAt;
          bucket.queries += 1;
        }
      }
    }
  }) as unknown as PrismaClient;
}

interface CachedClient {
  client: PrismaClient;
  lastUsedAt: number;
}

// Bounds total MySQL connections held open at once: MAX_CACHED_CLIENTS * PER_TENANT_CONNECTION_LIMIT
// must stay comfortably under the MySQL server's max_connections (default 151). This is a
// known scaling ceiling for the database-per-tenant model, not something this phase solves —
// flagged again where it matters, in docs/DEPLOYMENT.md once Track B's later phases land.
const MAX_CACHED_CLIENTS = 50;
/**
 * Connections per tenant client. The default of 5 is the multi-tenant number above — but load
 * testing measured what it costs a SINGLE-ORG deployment: the authed request path runs several
 * queries per request, so at 50 concurrent users throughput pinned at ~90 req/s at every
 * concurrency level while p50 scaled with queue depth alone (51ms @ 5 conns → 480ms @ 50 conns,
 * for an EMPTY list). That is a 5-slot pool queueing, not the database working. Single-org
 * shapes (the Compose stack, the chart's Shape 1) ship TENANT_DB_CONNECTION_LIMIT=20; SaaS
 * deployments with many live tenant databases should leave the default alone — the ceiling
 * arithmetic above is the real constraint there. A `connection_limit` already present in the
 * DSN still wins over this, unchanged.
 */
const PER_TENANT_CONNECTION_LIMIT = (() => {
  const raw = Number(process.env.TENANT_DB_CONNECTION_LIMIT);
  return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 5;
})();
const IDLE_EVICTION_MS = 10 * 60 * 1000;

const clientCache = new Map<string, CachedClient>();

function withConnectionLimit(dsn: string): string {
  const url = new URL(dsn);
  if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", String(PER_TENANT_CONNECTION_LIMIT));
  return url.toString();
}

async function evictLeastRecentlyUsed() {
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, entry] of clientCache) {
    if (entry.lastUsedAt < oldestAt) {
      oldestAt = entry.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = clientCache.get(oldestKey);
    clientCache.delete(oldestKey);
    await entry?.client.$disconnect().catch(() => undefined);
  }
}

/**
 * Returns a cached PrismaClient for the given org, constructing (and initializing) one on
 * first use. `dsn` is the already-decrypted connection string (see middleware/tenant.ts /
 * workers/run-for-every-org.ts, the only two callers) — never logged, never cached in
 * plaintext anywhere but this in-memory map.
 */
export async function getTenantClient(orgId: string, dsn: string): Promise<PrismaClient> {
  const cached = clientCache.get(orgId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.client;
  }

  if (clientCache.size >= MAX_CACHED_CLIENTS) await evictLeastRecentlyUsed();

  const client = withDbTiming(
    new PrismaClient({
      datasources: { db: { url: withConnectionLimit(dsn) } },
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
    })
  );
  clientCache.set(orgId, { client, lastUsedAt: Date.now() });
  await applyDatabaseTimezone(client).catch((error) => {
    console.warn(`[tenant:${orgId}] timezone alignment failed:`, (error as Error).message);
  });
  return client;
}

/** Closes every cached tenant client's connection pool — called during graceful shutdown
 *  (server.ts), since there's no single static `prisma` to disconnect anymore. */
export async function disconnectAllTenantClients(): Promise<void> {
  await Promise.all([...clientCache.values()].map((entry) => entry.client.$disconnect().catch(() => undefined)));
  clientCache.clear();
}

/** Periodically drop tenant clients nobody has used recently, closing their connections. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clientCache) {
    if (now - entry.lastUsedAt > IDLE_EVICTION_MS) {
      clientCache.delete(key);
      entry.client.$disconnect().catch(() => undefined);
    }
  }
}, IDLE_EVICTION_MS).unref();

/**
 * Align MySQL's timezone with the Node process timezone so `@default(now())` columns,
 * `NOW()` calls in raw SQL, and TIMESTAMP-typed columns render in IST (or whatever TZ the API
 * is running in). Runs once per tenant client, the first time that client is constructed
 * (previously ran once globally at boot, back when there was only ever one client).
 *
 * Strategy:
 *  - `SET GLOBAL time_zone`: affects every connection in the pool. Requires SUPER /
 *    SYSTEM_VARIABLES_ADMIN privilege. Root has it; least-privileged deployment users may
 *    not — we tolerate the failure and continue.
 *  - `SET SESSION time_zone`: ensures the connection that ran SET GLOBAL also sees the new
 *    value immediately (GLOBAL only affects *new* connections).
 */
export interface DatabaseTimezoneSnapshot {
  offset: string;
  globalApplied: boolean;
  sessionApplied: boolean;
  sessionTimeZone: string | null;
  globalTimeZone: string | null;
  now: string | null;
  errors: string[];
}

function currentOffsetForMysql(): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const h = Math.floor(Math.abs(offsetMinutes) / 60).toString().padStart(2, "0");
  const m = (Math.abs(offsetMinutes) % 60).toString().padStart(2, "0");
  return `${sign}${h}:${m}`;
}

export async function applyDatabaseTimezone(client: PrismaClient = prisma): Promise<DatabaseTimezoneSnapshot> {
  const offset = currentOffsetForMysql();
  const errors: string[] = [];
  let globalApplied = false;
  let sessionApplied = false;

  try {
    await client.$executeRawUnsafe(`SET GLOBAL time_zone = '${offset}'`);
    globalApplied = true;
  } catch (error) {
    errors.push(`SET GLOBAL failed: ${(error as Error).message}`);
  }

  try {
    await client.$executeRawUnsafe(`SET SESSION time_zone = '${offset}'`);
    sessionApplied = true;
  } catch (error) {
    errors.push(`SET SESSION failed: ${(error as Error).message}`);
  }

  let sessionTimeZone: string | null = null;
  let globalTimeZone: string | null = null;
  let now: string | null = null;
  try {
    const rows = await client.$queryRawUnsafe<Array<{ session_tz: string; global_tz: string; now: Date }>>(
      "SELECT @@session.time_zone AS session_tz, @@global.time_zone AS global_tz, NOW(3) AS now"
    );
    if (rows[0]) {
      sessionTimeZone = rows[0].session_tz;
      globalTimeZone = rows[0].global_tz;
      now = rows[0].now instanceof Date ? rows[0].now.toString() : String(rows[0].now);
    }
  } catch (error) {
    errors.push(`Query timezone state failed: ${(error as Error).message}`);
  }

  return { offset, globalApplied, sessionApplied, sessionTimeZone, globalTimeZone, now, errors };
}
