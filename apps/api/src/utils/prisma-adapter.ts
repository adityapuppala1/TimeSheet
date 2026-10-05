/**
 * The Prisma 7 driver adapter for a `mysql://` connection string.
 *
 * Prisma 7 no longer connects by itself: every client is built with an adapter. This turns the
 * connection strings the app already stores (env, encrypted per-workspace DSNs) into the MariaDB
 * driver's pool settings — the official adapter for MySQL — so nothing that produces a URL changes.
 *
 * Carried over from the URL, because Prisma's own engine used to read them:
 *  - credentials, URL-decoded (a password with `@` or `%` is stored percent-encoded);
 *  - `connection_limit` → the pool size (config/prisma.ts sets it per workspace), default 10;
 *  - `connect_timeout` (seconds) → connectTimeout;
 *  - `pool_timeout` (seconds) → acquireTimeout, how long a query waits for a connection (default 10).
 *  - `sslaccept` / `sslmode` → TLS on; `sslaccept=accept_invalid_certs` keeps TLS but skips verification.
 * Without TLS, MySQL 8's default `caching_sha2_password` needs the server's public key, which the old
 * engine fetched for itself — `allowPublicKeyRetrieval` does the same here, and only then.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import mariadb from "mariadb";

/** The driver settings a `mysql://` URL describes — shared by the adapter and `runSql`. */
export function mysqlConnectionConfig(connectionString: string): mariadb.PoolConfig {
  const url = new URL(connectionString);
  const params = url.searchParams;
  const sslAccept = params.get("sslaccept");
  const sslMode = params.get("sslmode");
  const tls = Boolean(sslAccept || (sslMode && sslMode !== "disable"));
  const limit = Number(params.get("connection_limit"));
  const connectTimeout = Number(params.get("connect_timeout"));
  const poolTimeout = Number(params.get("pool_timeout"));
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    connectionLimit: Number.isFinite(limit) && limit > 0 ? limit : 10,
    ...(Number.isFinite(connectTimeout) && connectTimeout > 0 ? { connectTimeout: connectTimeout * 1000 } : {}),
    ...(Number.isFinite(poolTimeout) && poolTimeout > 0 ? { acquireTimeout: poolTimeout * 1000 } : {}),
    ...(tls ? { ssl: sslAccept === "accept_invalid_certs" ? { rejectUnauthorized: false } : true } : { allowPublicKeyRetrieval: true })
  };
}

export function mysqlAdapter(connectionString: string): PrismaMariaDb {
  return new PrismaMariaDb(mysqlConnectionConfig(connectionString));
}

/**
 * Runs SQL statements on one short-lived connection — what `prisma db execute --url` did before
 * Prisma 7 removed that flag (doctor's create-database heal and probe, the integration tier's
 * throwaway databases). `database: false` connects to the server without selecting a database, for
 * CREATE/DROP DATABASE on one that may not exist yet.
 */
export async function runSql(connectionString: string, statements: string[], opts: { database?: boolean } = {}): Promise<void> {
  // One connection, not a pool: the pool-only settings are simply not passed on.
  const { host, port, user, password, database, ssl, allowPublicKeyRetrieval, connectTimeout } = mysqlConnectionConfig(connectionString);
  const conn = await mariadb.createConnection({
    host,
    port,
    user,
    password,
    ssl,
    allowPublicKeyRetrieval,
    database: opts.database === false ? undefined : database,
    connectTimeout: connectTimeout ?? 8000
  });
  try {
    for (const sql of statements) await conn.query(sql);
  } finally {
    await conn.end();
  }
}
