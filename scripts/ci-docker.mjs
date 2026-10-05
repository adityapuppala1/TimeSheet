#!/usr/bin/env node
/**
 * The FULL CI job, run in local Docker — `npm run ci:docker` (add `-- --e2e` for the browser suite).
 *
 * WHY. `npm run ci:local` (the pre-push hook) covers lint, the audit and both unit suites on this
 * machine. What it cannot cover is the half of CI that needs Linux and a real MySQL: the production
 * build, migrations against an empty database, the seeds, the integration suite and e2e. Those used to
 * be discovered on GitHub, at billed minutes per attempt. This runs them the way CI does — same MySQL
 * 8.4, same env values as `.github/workflows/ci.yml` → build-test-ubuntu, inside the Playwright Linux
 * image — so a Linux-only or database-only failure is found here, for free, before anything is pushed.
 *
 * What is tested is the COMMITTED tree plus your uncommitted tracked edits (`git stash create`), copied
 * into the container — never this machine's node_modules, which hold Windows binaries.
 *
 * Usage:  npm run ci:docker            build, unit, migrate, seed, integration
 *         npm run ci:docker -- --e2e   …then the e2e suite (desktop + phone, the CI branch tier)
 *         npm run ci:docker -- --keep  leave the containers up afterwards for poking at
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);

const docker = (a, opts = {}) => spawnSync("docker", a, { stdio: "inherit", ...opts });
const dockerOut = (a) => spawnSync("docker", a, { encoding: "utf8" });
const fail = (msg) => {
  console.error(`\n[ci-docker] ✗ ${msg}`);
  if (!args.has("--keep")) cleanup();
  process.exit(1);
};

const DB = "tsci-mysql";
const RUNNER = "tsci-runner";
const pwVersion = JSON.parse(fs.readFileSync("node_modules/@playwright/test/package.json", "utf8")).version;
const IMAGE = `mcr.microsoft.com/playwright:v${pwVersion}-noble`;

function cleanup() {
  dockerOut(["rm", "-f", RUNNER, DB]);
}

if (dockerOut(["info"]).status !== 0) fail("Docker isn't running. Start Docker Desktop and re-run.");
cleanup();

// 1. MySQL exactly as CI's service container.
console.log("[ci-docker] ▶ MySQL 8.4");
if (docker(["run", "-d", "--name", DB, "-e", "MYSQL_ROOT_PASSWORD=root_ci_password", "-e", "MYSQL_DATABASE=ci_placeholder", "mysql:8.4"], { stdio: "ignore" }).status !== 0) {
  fail("could not start mysql:8.4");
}
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = dockerOut(["exec", DB, "mysql", "-uroot", "-proot_ci_password", "-e", "SELECT 1"]).status === 0;
  if (!ready) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},2000)"]);
}
if (!ready) fail("MySQL never became ready");
dockerOut(["exec", DB, "mysql", "-uroot", "-proot_ci_password", "-e", "CREATE DATABASE IF NOT EXISTS ci_tenant; CREATE DATABASE IF NOT EXISTS ci_control;"]);

// 2. The tree under test: committed HEAD plus uncommitted tracked edits.
const ref = git("stash", "create") || "HEAD";
const tarball = path.join(os.tmpdir(), `tsci-${Date.now()}.tar`);
execFileSync("git", ["archive", "--format=tar", "-o", tarball, ref]);
console.log(`[ci-docker] ▶ testing ${ref === "HEAD" ? git("rev-parse", "--short", "HEAD") : "HEAD + your uncommitted edits"} in ${IMAGE}`);

// 3. The runner shares MySQL's network namespace, so 127.0.0.1:3306 is the database — as in CI.
const env = {
  NODE_ENV: "test",
  CI: "true",
  DATABASE_URL: "mysql://root:root_ci_password@127.0.0.1:3306/ci_tenant",
  CONTROL_DATABASE_URL: "mysql://root:root_ci_password@127.0.0.1:3306/ci_control",
  JWT_ACCESS_SECRET: "ci-only-access-secret-not-for-real-use-0123456789",
  JWT_REFRESH_SECRET: "ci-only-refresh-secret-not-for-real-use-0123456789",
  PLATFORM_ADMIN_JWT_SECRET: "ci-only-platform-admin-secret-not-for-real-use-0123456789",
  PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: `local-console-${Date.now()}`,
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  WEB_ORIGIN: "http://localhost:5173",
  APP_BASE_URL: "http://localhost:5173",
  DEFAULT_ORG_SLUG: "default"
};
const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
if (docker(["run", "-d", "--name", RUNNER, "--network", `container:${DB}`, ...envArgs, "-w", "/src", IMAGE, "sleep", "infinity"], { stdio: "ignore" }).status !== 0) {
  fail(`could not start ${IMAGE} (first run downloads ~2 GB)`);
}
docker(["cp", tarball, `${RUNNER}:/tmp/src.tar`], { stdio: "ignore" });
fs.rmSync(tarball, { force: true });

const steps = [
  ["Unpack", "mkdir -p /src && tar -xf /tmp/src.tar -C /src"],
  ["Install dependencies", "npm ci --no-audit --no-fund"],
  ["Generate Prisma clients", "cd apps/api && npx prisma generate --schema=prisma/schema.prisma && npx prisma generate --schema=prisma/control/schema.prisma"],
  ["Lint (typecheck + Sonar rules)", "npm run lint"],
  ["Audit production dependencies", "node scripts/audit-gate.mjs"],
  ["Build (shared + api + web)", "npm run build"],
  ["API unit tests", "npm run test -w apps/api"],
  ["Web unit tests", "npm run test -w apps/web"],
  ["Migrate both schemas", "cd apps/api && npx prisma migrate deploy --schema=prisma/schema.prisma && npx prisma migrate deploy --schema=prisma/control/schema.prisma"],
  ["Seed tenant + control plane", "cd apps/api && npx tsx prisma/seed.ts && npx tsx prisma/control/seed.ts"],
  ["Integration tests (real MySQL)", "npm run test:integration -w apps/api"]
];
if (args.has("--e2e")) steps.push(["e2e (desktop + phone)", "npm run test:e2e -- --project=desktop --project=responsive-phone"]);

const started = Date.now();
for (const [name, cmd] of steps) {
  const t = Date.now();
  console.log(`\n[ci-docker] ▶ ${name}`);
  if (docker(["exec", RUNNER, "bash", "-lc", `cd /src && ${cmd}`]).status !== 0) fail(`${name} failed — the same failure CI would report.`);
  console.log(`[ci-docker] ✓ ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
}
console.log(`\n[ci-docker] all green in ${Math.round((Date.now() - started) / 60000)} min.`);
if (args.has("--keep")) console.log(`[ci-docker] left running: docker exec -it ${RUNNER} bash   (remove: docker rm -f ${RUNNER} ${DB})`);
else cleanup();
