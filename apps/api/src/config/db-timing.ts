/**
 * Per-request database-time accounting — the mechanism behind `ApiRequestSample.dbResponseTime`.
 *
 * WHY ASYNCLOCALSTORAGE RATHER THAN PRISMA'S `query` LOG EVENT: the log event carries a duration
 * but arrives on the client, detached from whichever request caused it. There is no way to
 * attribute it back, so "this request spent 340ms in the database" is unanswerable from it. A
 * client extension (see config/prisma.ts) runs INSIDE the caller's async context, so the store
 * below is the request's own — the same reason tenant-context.ts uses ALS for "which tenant".
 *
 * WHY A SEPARATE MODULE FROM tenant-context.ts: config/prisma.ts imports this, and this must
 * therefore import nothing that leads back to config/prisma.ts. Keeping it to one AsyncLocalStorage
 * and no other imports makes that impossible to get wrong later.
 *
 * A NULL BUCKET IS THE NORMAL CASE. Outside a sampled request — cron workers, boot-time queries,
 * every request when telemetry is off — there is no store and the extension does nothing beyond
 * one `getStore()` call. That is what keeps this affordable in the hot path.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface DbTimingBucket {
  /** Cumulative milliseconds spent inside Prisma operations for this request. */
  ms: number;
  queries: number;
}

export const dbTimingStore = new AsyncLocalStorage<DbTimingBucket>();
