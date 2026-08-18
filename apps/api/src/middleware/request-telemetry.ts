/**
 * WHAT: measures one request and hands the result to the buffer in services/api-telemetry.service.ts.
 * Mounted in app.ts immediately after `resolveTenant`, because the row it produces is written to
 * the TENANT's database and therefore needs a resolved tenant to belong to.
 *
 * THE HOT-PATH CONTRACT. This runs before every `/api` handler in the application, so:
 *  - The disabled path is a single boolean test and `next()`. Nothing else is touched.
 *  - Nothing here awaits. The measurement is arithmetic on `performance.now()`; the row is pushed
 *    onto an array.
 *  - Everything after `next()` is wrapped. A bug in telemetry must be able to lose telemetry, and
 *    must not be able to fail a user's request — so the `finish` handler swallows its own errors
 *    rather than letting them reach the process's `uncaughtException` net.
 *
 * WHY THE ROUTE PATTERN MATTERS MORE THAN IT LOOKS. Recording `/api/tickets/9f2c…` instead of
 * `/api/tickets/:id` makes every GROUP BY in api-performance.service.ts return one row per entity
 * ever touched: the "slowest endpoints" table becomes thousands of single-request rows with
 * meaningless percentiles, and the index on `apiPath` stops helping. `routePattern` below recovers
 * the pattern from Express, and falls back to REDACTING id-shaped segments — never to the raw URL.
 */
import type { NextFunction, Request, Response } from "express";
import { dbTimingStore } from "../config/db-timing.js";
import { env } from "../config/env.js";
import { tenantContext } from "../config/tenant-context.js";
import {
  currentHostSnapshot,
  enqueueApiRequestSample,
  hostIdentity,
  telemetryEnabled
} from "../services/api-telemetry.service.js";

/**
 * Paths that are noise rather than signal. Liveness probes fire every few seconds from the
 * orchestrator AND every 15s from every open browser tab, so leaving them in would make `/health`
 * the highest-volume "endpoint" in the workspace and drag the fleet-wide averages toward a handler
 * that does no work. `/api/maintenance/api-performance*` is excluded for the same reason in
 * reverse: this panel polls itself, and an observer that dominates its own slowest-endpoints table
 * is measuring the wrong thing.
 */
const SKIP_PREFIXES = ["/api/health", "/api/maintenance/api-performance"];

/** Segments that are plainly identifiers rather than route vocabulary: UUIDs, integers, long hex
 *  (tokens/hashes), and cuid-ish keys. Used only when Express could not supply a pattern. */
const ID_SEGMENT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,}|c[a-z0-9]{20,})$/i;

function redactIdSegments(pathname: string): string {
  return (
    pathname
      .split("/")
      .map((segment) => (ID_SEGMENT_RE.test(segment) ? ":id" : segment))
      .join("/") || "/"
  );
}

export function routePattern(req: Request): string {
  const pathname = (req.originalUrl.split("?")[0] || "/").slice(0, 200);
  const raw = (req as Request & { route?: { path?: unknown } }).route?.path;
  const routePath = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;

  if (routePath) {
    const combined = `${req.baseUrl}${routePath === "/" ? "" : routePath}`;
    // `req.baseUrl` is restored to "" as each router unwinds, which happens on the error path — and
    // trusting it then would collapse every ":id" route in the app onto one meaningless key. Every
    // route this middleware sees is mounted under /api, so that prefix is the check that the mount
    // path was still intact when we read it.
    if (combined.startsWith("/api")) return combined.slice(0, 200);
  }
  return redactIdSegments(pathname);
}

/** Deterministically true when the rate is 1, so a full-rate deployment records literally every
 *  request rather than 99.99% of them. */
function shouldSample(): boolean {
  const rate = env.API_TELEMETRY_SAMPLE_RATE;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  // Reviewed: sampling, not secrecy. Nothing is protected by an attacker being unable to predict
  // which requests get recorded, and a CSPRNG draw per request would cost more than the telemetry.
  // eslint-disable-next-line sonarjs/pseudo-random -- non-cryptographic by design
  return Math.random() < rate;
}

export function recordApiRequest(req: Request, res: Response, next: NextFunction): void {
  if (!telemetryEnabled()) return next();
  // CORS preflights carry no user, no handler and no database work — recording them would double
  // the row count of every browser-driven endpoint with rows that answer nothing.
  if (req.method === "OPTIONS") return next();
  if (SKIP_PREFIXES.some((prefix) => req.originalUrl.startsWith(prefix))) return next();
  if (!shouldSample()) return next();

  const ctx = tenantContext.getStore();
  // No tenant means nowhere to write the row. Never a reason to fail the request.
  if (!ctx) return next();

  const apiRequestAt = new Date();
  const startedAt = performance.now();
  const bucket = { ms: 0, queries: 0 };

  // Captured here, synchronously, rather than read inside the handler below: EventEmitter
  // listeners execute in the emitter's async context, not the context they were registered in, so
  // `tenantContext.getStore()` at `finish` time is not reliably this request's tenant.
  const { orgId, client } = ctx;

  res.on("finish", () => {
    try {
      const finishedAt = performance.now();
      const snapshot = currentHostSnapshot();
      const method = req.method.slice(0, 10);
      const apiPath = routePattern(req);
      enqueueApiRequestSample(orgId, client, {
        apiName: `${method} ${apiPath}`.slice(0, 220),
        method,
        apiPath,
        statusCode: res.statusCode,
        // Populated by requireAuth, which runs per-router AFTER this middleware — so it is read
        // here at the end of the request, never at the start where it would always be undefined.
        userId: req.user?.id ?? null,
        apiRequestAt,
        apiResponseAt: new Date(),
        apiResponseTime: Math.round(finishedAt - startedAt),
        // Zero queries means the request genuinely touched no database, which is a real and useful
        // answer; null is reserved for "not measured".
        dbResponseTime: Math.round(bucket.ms),
        dbQueryCount: bucket.queries,
        hostname: hostIdentity.hostname,
        podName: hostIdentity.podName,
        podNamespace: hostIdentity.podNamespace,
        cluster: hostIdentity.cluster,
        osType: hostIdentity.osType,
        cpuPercent: snapshot.cpuPercent,
        memUsedPercent: snapshot.memUsedPercent,
        diskUsedPercent: snapshot.diskUsedPercent,
        eventLoopLagMs: snapshot.eventLoopLagMs
      });
    } catch {
      // Intentionally silent and intentionally total. This callback runs after the response has
      // already been sent, so there is nothing left to tell the client, and a throw from here would
      // surface as an uncaughtException — i.e. a monitoring bug would restart the server.
    }
  });

  // `run` rather than `enterWith`: the bucket must be scoped to this request's async tree and
  // nothing else. Everything downstream — including the Prisma extension in config/prisma.ts —
  // inherits it, which is what makes `dbResponseTime` attributable to a single request.
  dbTimingStore.run(bucket, () => next());
}
