/**
 * Prisma 7 configuration — where Migrate gets its connection URL now that schema files may not
 * carry one.
 *
 * TWO SCHEMAS, TWO DATABASES, ONE CONFIG. Every Prisma command in this repo (the installers, the
 * updaters, Compose, Helm, CI, the tenant-migration script — over a hundred call sites) already names
 * the schema it means with `--schema=…`. This config reads that same flag and picks the matching URL:
 * the control plane's CONTROL_DATABASE_URL for `prisma/control/schema.prisma`, the workspace's
 * DATABASE_URL for everything else. The alternative — one config per schema chosen with `--config` —
 * would mean editing every call site, and any one left behind would migrate the control-plane schema
 * into a WORKSPACE database (or the reverse) with no error at all.
 *
 * Environment: Prisma 7 no longer loads `.env` itself, so this does (quietly; a variable already set
 * in the environment — a container's — always wins).
 */
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: path.join(import.meta.dirname, ".env"), quiet: true });

function schemaArg(): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schema") return argv[i + 1];
    if (argv[i].startsWith("--schema=")) return argv[i].slice("--schema=".length);
  }
  return undefined;
}

const requested = schemaArg();
const isControl = Boolean(requested && /[\\/]control[\\/]schema\.prisma$/.test(requested));
const schema = isControl ? "prisma/control/schema.prisma" : "prisma/schema.prisma";

export default defineConfig({
  schema: path.join(import.meta.dirname, schema),
  migrations: { path: path.join(import.meta.dirname, isControl ? "prisma/control/migrations" : "prisma/migrations") },
  datasource: {
    // A function-free read: `prisma generate` needs no URL at all, so an unset variable must not
    // fail it (the Docker build generates before any database exists).
    url: (isControl ? process.env.CONTROL_DATABASE_URL : process.env.DATABASE_URL) ?? ""
  }
});
