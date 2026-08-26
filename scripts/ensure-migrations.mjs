/**
 * WHAT: brings every database TimeSphere touches — the default tenant (DATABASE_URL), the control
 * plane (CONTROL_DATABASE_URL), and every OTHER registered tenant — to the latest migration before
 * `npm run dev` starts serving requests. Runs automatically ahead of `npm run dev` (the `predev`
 * hook in the root package.json), alongside ensure-deps.mjs.
 *
 * WHY IT EXISTS: a migration applied to the default dev database does NOT reach any other
 * registered tenant database automatically. `RequirementsDocument`'s migration landed on
 * `timesheet_portal` (DATABASE_URL) but left `acme_corp` and `ci_probe` behind — both real
 * registered tenants — and the first anyone heard about it was a "column does not exist" error at
 * runtime, days later. `npm run setup` and `update.ps1` already fan a new migration out to every
 * tenant; `npm run dev` never did. This closes that gap for the loop developers actually run daily.
 *
 * HOW IT STAYS CHEAP: `doctor --heal` is the right tool but a genuinely slow one here — each of its
 * three `npx prisma`/`npx tsx` cold starts costs real seconds on Windows, ~30s total measured on
 * this machine even when nothing is pending. Running that unconditionally before every `npm run
 * dev` would be its own annoyance, exactly the failure mode ensure-deps.mjs's own header warns
 * against. So this compares the newest migration FOLDER NAME on disk against a stamp of the last
 * one we successfully healed — one `readdir`, no DB connection — and only pays for the full heal
 * when a new migration has actually appeared (a fresh `git pull`, or one committed this session).
 * The stamp lives in `node_modules/`, machine-local and gitignored, same as ensure-deps.mjs's own.
 *
 * NEVER blocks `npm run dev` — same resilience contract as ensure-deps.mjs. A database that is
 * briefly unreachable, or one tenant that fails to migrate, must not stop a developer whose OWN
 * default database is fine from starting the app; `doctor --heal` already isolates per-tenant
 * failures internally, and this wrapper additionally isolates the whole health check from `predev`.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API_DIR = join(ROOT, "apps", "api");
const MIGRATIONS_DIR = join(API_DIR, "prisma", "migrations");
const MODULES = join(ROOT, "node_modules");
const STAMP = join(MODULES, ".timesphere-migrations-stamp");

function latestMigrationName() {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return names.length > 0 ? names[names.length - 1] : null;
}

const latest = latestMigrationName();
if (!latest) process.exit(0); // No migrations directory at all — nothing to heal.

let stamped = null;
try {
  stamped = readFileSync(STAMP, "utf8").trim();
} catch {
  // No stamp yet — first run on this machine (or node_modules was just reinstalled). Heal once.
}

if (stamped === latest) {
  // Silent on the happy path — this runs before every `npm run dev`, and "no new migration since
  // last time" is the overwhelmingly common case.
  process.exit(0);
}

console.log(`[migrations] new migration on disk (${latest}) — verifying every database is current before starting.`);
console.log("[migrations] this only happens when a migration was just added; it will be quick again next time.");

try {
  execSync("npm run doctor:heal", { cwd: API_DIR, stdio: "inherit" });
  if (!existsSync(MODULES)) throw new Error("node_modules is missing — nowhere to write the stamp.");
  writeFileSync(STAMP, latest, "utf8");
} catch {
  // Do NOT fail the command — same reasoning as ensure-deps.mjs. A developer whose default
  // database is fine should not be blocked by a control-plane or tenant-fan-out hiccup; they will
  // find out from the real error if their OWN database is the one that's actually broken. The
  // stamp is deliberately NOT written here, so the next `npm run dev` tries the heal again rather
  // than silently accepting a failed one.
  console.warn("[migrations] could not confirm every database is up to date. Continuing anyway — run `npm run doctor:heal -w apps/api` by hand if something looks stale.");
}
