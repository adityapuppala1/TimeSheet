/**
 * The control plane's own Prisma client — a completely separate database from every tenant's
 * own database (see apps/api/prisma/control/schema.prisma). Nothing in the request path reads
 * from this yet (that starts in Phase B1's tenant-resolution middleware); today it's used by
 * provisioning/seed scripts and will grow into the platform-admin console's own data access
 * layer. Never import the tenant `prisma` export (config/prisma.ts) alongside this one inside
 * the same query — they're different databases entirely, and mixing results from both into
 * one response is exactly the kind of mistake the database-per-tenant model exists to make
 * structurally hard: there is no join between them, only two independent clients.
 */
import { PrismaClient } from "../generated/control-client/index.js";

export const controlPrisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});
