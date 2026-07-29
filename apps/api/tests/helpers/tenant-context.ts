import type { PrismaClient } from "@prisma/client";
import { tenantContext } from "../../src/config/tenant-context.js";

/** Runs `fn` inside a real `tenantContext.run(...)` with a caller-supplied (usually fake) client
 *  — every `prisma.*` call inside `fn`'s call tree resolves to `client`, since `config/prisma.ts`'s
 *  exported `prisma` is a Proxy over `requireTenantContext().client`. */
export function runInTenant<T>(client: PrismaClient, fn: () => Promise<T>, orgId = "org-1", orgSlug = "test-org"): Promise<T> {
  return tenantContext.run({ orgId, orgSlug, client }, fn);
}
