/**
 * Per-request/per-job tenant context — the mechanism that lets every existing
 * `import { prisma } from "../config/prisma.js"` keep working completely unchanged while
 * actually resolving to whichever tenant's database is active for the current request or
 * cron-worker tick (see config/prisma.ts's Proxy export and middleware/tenant.ts).
 *
 * WHY AsyncLocalStorage instead of threading a tenant client through every function
 * signature: ~30 existing files import the static `prisma` singleton directly. Threading
 * would mean touching every one of their exported functions' signatures, and every call site
 * calling them, transitively — exactly the kind of mechanical, easy-to-miss-one-call-site
 * change this approach avoids. AsyncLocalStorage instead makes "which tenant" an ambient
 * property of the current async execution, the same way `req.user` is ambient to a request
 * without every function needing an explicit `user` parameter.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "../generated/control-client/index.js";

export interface TenantContext {
  orgId: string;
  orgSlug: string;
  client: import("@prisma/client").PrismaClient;
}

export const tenantContext = new AsyncLocalStorage<TenantContext>();

/** Throws with a clear message rather than silently returning `undefined` — a `prisma` access
 *  outside any resolved tenant context is always a bug (a missing middleware, a cron job that
 *  forgot to wrap its body), never a valid state to proceed in. */
export function requireTenantContext(): TenantContext {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error(
      "No tenant context is active — `prisma` was accessed outside a request that ran through the tenant-resolution middleware, or a cron worker tick that didn't wrap its body in tenantContext.run(). See config/tenant-context.ts."
    );
  }
  return ctx;
}

// Re-exported only so control-prisma-adjacent code can reference the type without a second
// import path; not used to construct a control client here (control-prisma.ts owns that).
export type { PrismaClient as ControlPrismaClient };
