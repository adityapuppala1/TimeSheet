/**
 * WHAT: a pre-flight check you run before `npm run dev`/`db:migrate` on a fresh checkout —
 * validates `apps/api/.env` against the same Zod schema the server boots with, then actually
 * opens a connection to DATABASE_URL and CONTROL_DATABASE_URL (a config value can be
 * well-formed and still point at nothing, e.g. the wrong MySQL port).
 * WHY: the most common first-run failure in this repo is copying `.env.example` and not
 * noticing its DB port/password pair belongs to Docker Compose's MySQL container, not a local
 * XAMPP/native install (or vice versa) — that produces a cryptic "Authentication failed"
 * several steps into setup instead of one clear message up front. Run this first.
 * HOW: `npm run doctor -w apps/api`. Exits non-zero with a specific fix on the first failure
 * (deliberately — printing five confusing errors from one root cause helps no one).
 *
 * `npm run doctor:heal -w apps/api` (or `-- --heal`) additionally auto-fixes the two most common
 * fresh-checkout blockers instead of just diagnosing them: creates the tenant/control databases
 * if the server is reachable but the schema doesn't exist yet, and runs `prisma migrate deploy`
 * for both schemas. It never touches connection settings in .env — only DB-side state.
 */
import { execSync } from "node:child_process";
import net from "node:net";

const HEAL = process.argv.includes("--heal");

function fail(message: string): never {
  console.error(`\n[doctor] FAIL: ${message}\n`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`[doctor] OK: ${message}`);
}

async function checkTcp(host: string, port: number, label: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      ok(`${label} — TCP reachable at ${host}:${port}`);
      resolve();
    });
    socket.once("error", () => {
      fail(
        `${label} — nothing is listening on ${host}:${port}. ` +
          `If you're on a local/no-Docker install, start XAMPP's MySQL (default port 3306). ` +
          `If you're using \`docker compose up\`, that MySQL container listens on 3307. ` +
          `Check DATABASE_URL / CONTROL_DATABASE_URL in apps/api/.env against whichever you're actually running.`
      );
    });
    socket.once("timeout", () => {
      socket.destroy();
      fail(`${label} — connection to ${host}:${port} timed out.`);
    });
  });
}

function parseHostPort(url: string): { host: string; port: number } {
  const match = url.match(/@([^:/]+):(\d+)/);
  if (!match) fail(`Could not parse host:port out of "${url}". Expected mysql://user:pass@host:port/db`);
  return { host: match![1], port: Number(match![2]) };
}

function parseDatabaseName(url: string): string {
  const match = url.match(/\/([^/?]+)(\?.*)?$/);
  if (!match) fail(`Could not parse a database name out of "${url}".`);
  return match![1];
}

const apiCwd = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");

function ensureDatabaseExists(label: string, url: string): void {
  const dbName = parseDatabaseName(url);
  try {
    execSync(`npx prisma db execute --stdin --url="${url.replace(/\/[^/?]+(\?.*)?$/, "/")}"`, {
      input: `CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: apiCwd
    });
    ok(`${label} — database "${dbName}" exists (created if it didn't)`);
  } catch (error) {
    fail(`${label} — could not create database "${dbName}": ${(error as Error).message.split("\n")[0]}`);
  }
}

function runMigrations(label: string, schema: string): void {
  try {
    execSync(`npx prisma migrate deploy --schema=${schema}`, { stdio: ["pipe", "pipe", "pipe"], cwd: apiCwd });
    ok(`${label} — migrations applied (prisma migrate deploy)`);
  } catch (error) {
    fail(`${label} — migration failed: ${(error as Error).message.split("\n")[0]}\nRun manually to see the full error: cd apps/api && npx prisma migrate deploy --schema=${schema}`);
  }
}

async function main(): Promise<void> {
  console.log("[doctor] Checking apps/api/.env ...\n");

  let env: typeof import("../src/config/env.js")["env"];
  try {
    ({ env } = await import("../src/config/env.js"));
  } catch (error) {
    fail(
      `.env failed validation — ${(error as Error).message}\n` +
        `Make sure apps/api/.env exists (copy .env.example there, not to the repo root) and every required field is set.`
    );
  }
  ok(".env present and passes schema validation");

  const db = parseHostPort(env!.DATABASE_URL);
  await checkTcp(db.host, db.port, "DATABASE_URL");

  const control = parseHostPort(env!.CONTROL_DATABASE_URL);
  await checkTcp(control.host, control.port, "CONTROL_DATABASE_URL");

  if (HEAL) {
    ensureDatabaseExists("DATABASE_URL", env!.DATABASE_URL);
    ensureDatabaseExists("CONTROL_DATABASE_URL", env!.CONTROL_DATABASE_URL);
  }

  try {
    execSync("npx prisma db execute --stdin --schema=prisma/schema.prisma", {
      input: "SELECT 1;",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: apiCwd
    });
    ok("DATABASE_URL — credentials accepted, query succeeded");
  } catch (error) {
    fail(
      `DATABASE_URL — the server answered but authentication or the query failed: ${(error as Error).message.split("\n")[0]}\n` +
        `Check the username/password in DATABASE_URL match what your MySQL server actually has configured ` +
        `(XAMPP default: user "root", empty password).`
    );
  }

  if (HEAL) {
    runMigrations("DATABASE_URL", "prisma/schema.prisma");
    runMigrations("CONTROL_DATABASE_URL", "prisma/control/schema.prisma");
    console.log("\n[doctor] Healed — databases created and migrated. Next: `npm run seed -w apps/api` (first run only), then `npm run dev`.\n");
    return;
  }

  console.log("\n[doctor] All checks passed — safe to run `npm run db:migrate` / `npm run dev`.\n");
}

main();
