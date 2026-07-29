/**
 * WHAT: a pre-flight check you run before `npm run dev`/`db:migrate` on a fresh checkout —
 * reports what OS/Node this machine is running, validates `apps/api/.env` against the same Zod
 * schema the server boots with, discovers which MySQL servers are actually running on this
 * machine (and on which ports), then opens a real connection to DATABASE_URL and
 * CONTROL_DATABASE_URL (a config value can be well-formed and still point at nothing).
 * WHY: the most common first-run failure in this repo is copying `.env.example` onto a machine
 * whose MySQL lives somewhere else — a different port, a service that isn't started, or Docker
 * Compose's container (3307) vs. a local/XAMPP install (3306). Guessing which produces a cryptic
 * error several steps into setup; this finds the real answer and tells you exactly what to change.
 * HOW: `npm run doctor -w apps/api`. Exits non-zero with a specific fix on the first failure
 * (deliberately — printing five confusing errors from one root cause helps no one).
 *
 * Three modes, each strictly additive:
 *  - `npm run doctor -w apps/api`            diagnose only, never writes anything.
 *  - `npm run doctor:heal -w apps/api`       also creates the two databases if the server is
 *                                            reachable but they don't exist, and runs
 *                                            `prisma migrate deploy` for both schemas. Touches
 *                                            DB-side state only — never `.env`.
 *  - `npm run doctor:heal -w apps/api -- --fix-env`
 *                                            additionally rewrites the host:port inside
 *                                            DATABASE_URL/CONTROL_DATABASE_URL in `.env` when
 *                                            discovery proves MySQL is listening somewhere other
 *                                            than what's configured. Opt-in precisely because
 *                                            every other mode's "never edits your config" promise
 *                                            is worth keeping explicit — credentials and database
 *                                            names are never touched even here, only host:port.
 *
 * WHY the hand-rolled DSN splitting below rather than `new URL()`: a MySQL password very commonly
 * contains characters (`@`, `#`, `%`) that make a DSN ambiguous to a naive parser. `new URL()`
 * actually handles this correctly (it splits userinfo at the LAST `@`, matching what Prisma's own
 * Rust parser does), but it also silently percent-ENCODES the password on the way out — so
 * round-tripping a DSN through it to rewrite the host would corrupt a password containing a
 * literal `%`. Splitting the string manually keeps every other component byte-identical, which
 * matters a lot for `--fix-env`. A previous version of this file used `/@([^:/]+):(\d+)/`, which
 * grabs the FIRST `@` and reported the host of `mysql://root:Hics@161233@localhost:3306/db` as
 * "161233@localhost" — a confusing false failure on a `.env` that was actually correct.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HEAL = process.argv.includes("--heal");
const FIX_ENV = process.argv.includes("--fix-env");

function fail(message: string): never {
  console.error(`\n[doctor] FAIL: ${message}\n`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`[doctor] OK: ${message}`);
}

function info(message: string): void {
  console.log(`[doctor] ${message}`);
}

function warn(message: string): void {
  console.log(`[doctor] WARN: ${message}`);
}

const apiCwd = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const ENV_PATH = path.join(apiCwd, ".env");

// ---------------------------------------------------------------------------------------------
// DSN parsing
// ---------------------------------------------------------------------------------------------

interface ParsedDsn {
  scheme: string; // "mysql://"
  userinfo: string; // "root:Hics@161233" (raw, exactly as written)
  host: string;
  port: number;
  databaseName: string;
  tail: string; // "/timesheet_portal?foo=bar" — everything from the path onward, raw
}

/**
 * Splits a DSN the same way WHATWG/Prisma do — authority ends at the first `/`, `?` or `#`, and
 * within it the userinfo ends at the LAST `@`. Everything is kept as raw substrings so a DSN can
 * be reassembled byte-identically apart from the one component being changed.
 */
function parseDsn(dsn: string, label: string): ParsedDsn {
  const schemeEnd = dsn.indexOf("://");
  if (schemeEnd === -1) fail(`${label} — "${dsn}" doesn't look like a connection URL. Expected mysql://user:password@host:port/database`);
  const scheme = dsn.slice(0, schemeEnd + 3);
  const rest = dsn.slice(schemeEnd + 3);

  const pathStart = rest.search(/[/?#]/);
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const tail = pathStart === -1 ? "" : rest.slice(pathStart);

  const lastAt = authority.lastIndexOf("@");
  const userinfo = lastAt === -1 ? "" : authority.slice(0, lastAt);
  const hostPort = lastAt === -1 ? authority : authority.slice(lastAt + 1);

  // Bracketed IPv6 literal (`[::1]:3306`) — rare for MySQL but cheap to not break on.
  let host: string;
  let portText: string;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close === -1) fail(`${label} — malformed IPv6 host in "${dsn}".`);
    host = hostPort.slice(0, close + 1);
    portText = hostPort.slice(close + 1).replace(/^:/, "");
  } else {
    const colon = hostPort.lastIndexOf(":");
    host = colon === -1 ? hostPort : hostPort.slice(0, colon);
    portText = colon === -1 ? "" : hostPort.slice(colon + 1);
  }

  if (!host) fail(`${label} — no host found in "${dsn}". Expected mysql://user:password@host:port/database`);
  // MySQL's own default, and what Prisma assumes when a DSN omits the port.
  const port = portText ? Number(portText) : 3306;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`${label} — "${portText}" isn't a valid port in "${dsn}".`);

  const databaseName = tail.replace(/^\//, "").split(/[?#]/)[0];
  if (!databaseName) fail(`${label} — no database name found in "${dsn}". Expected mysql://user:password@host:port/database`);

  return { scheme, userinfo, host, port, databaseName, tail };
}

/** Rebuilds a DSN with a different host:port, leaving every other byte (crucially the raw
 *  password, which may contain `%` or `@`) exactly as the user wrote it. */
function withHostPort(parsed: ParsedDsn, host: string, port: number): string {
  const at = parsed.userinfo ? `${parsed.userinfo}@` : "";
  return `${parsed.scheme}${at}${host}:${port}${parsed.tail}`;
}

/** The same DSN pointed at no particular database — used for `CREATE DATABASE`, which obviously
 *  can't connect to the database it's about to create. */
function withoutDatabase(parsed: ParsedDsn): string {
  const at = parsed.userinfo ? `${parsed.userinfo}@` : "";
  return `${parsed.scheme}${at}${parsed.host}:${parsed.port}/`;
}

/** The password as written, for advisory checks only — never logged. */
function rawPassword(parsed: ParsedDsn): string {
  const colon = parsed.userinfo.indexOf(":");
  return colon === -1 ? "" : parsed.userinfo.slice(colon + 1);
}

// ---------------------------------------------------------------------------------------------
// MySQL discovery
// ---------------------------------------------------------------------------------------------

interface PortProbe {
  open: boolean;
  /** Set when the greeting packet parsed as MySQL's — e.g. "8.4.0" or "10.6.12-MariaDB". */
  serverVersion?: string;
  /** Something is listening, but it didn't greet us like a MySQL server would. */
  notMysql?: boolean;
}

/**
 * Connects and reads the server's initial handshake packet. MySQL (and MariaDB) always speak
 * first: a 4-byte header, then protocol version 10, then a NUL-terminated version string. Reading
 * it distinguishes "MySQL is here" from "something else has this port" — worth the few extra
 * lines, because "port 3306 is open" is not the same as "your database is there" (a stale tunnel,
 * another app, or a half-started container all look identical to a plain TCP check).
 */
function probePort(host: string, port: number, timeoutMs = 2000): Promise<PortProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: PortProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      // Connected — now give the server a moment to send its greeting. If it stays silent we
      // still report the port as open, just unidentified.
      setTimeout(() => done({ open: true }), timeoutMs);
    });
    socket.once("data", (buffer) => {
      if (buffer.length > 5 && buffer[4] === 10) {
        const end = buffer.indexOf(0, 5);
        const version = buffer.subarray(5, end === -1 ? Math.min(buffer.length, 40) : end).toString("latin1");
        // A version string is always printable ASCII; anything else means we misread the packet.
        if (/^[\x20-\x7e]+$/.test(version)) return done({ open: true, serverVersion: version });
      }
      done({ open: true, notMysql: true });
    });
    socket.once("error", () => done({ open: false }));
    socket.once("timeout", () => done({ open: false }));
  });
}

/** Ports worth checking on a dev machine: MySQL's default, this repo's Docker Compose mapping,
 *  and the next couple a second local instance typically lands on. */
const CANDIDATE_PORTS = [3306, 3307, 3308, 3309];

async function discoverMysql(host: string): Promise<Array<{ port: number; probe: PortProbe }>> {
  const results = await Promise.all(
    CANDIDATE_PORTS.map(async (port) => ({ port, probe: await probePort(host, port) }))
  );
  return results.filter((r) => r.probe.open);
}

/** Best-effort, never-throws shell probe — used only to enrich the "here's how to start MySQL"
 *  advice, so a missing command or a locked-down shell degrades to silence, never an error. */
function tryCommand(command: string): string | null {
  try {
    return execSync(command, { stdio: ["pipe", "pipe", "pipe"], timeout: 8000 }).toString().trim();
  } catch {
    return null;
  }
}

/** Where MySQL is installed / whether its service is running, per OS. Purely advisory — the TCP
 *  probe above is the source of truth for "is it actually reachable", this just makes the fix
 *  instructions concrete instead of generic. */
function describeLocalMysqlInstall(): string[] {
  const notes: string[] = [];
  const platform = process.platform;

  if (platform === "win32") {
    const services = tryCommand(
      'powershell -NoProfile -Command "Get-Service | Where-Object { $_.Name -match \'mysql|mariadb\' } | ForEach-Object { $_.Name + \' = \' + $_.Status }"'
    );
    if (services) {
      for (const line of services.split(/\r?\n/).filter(Boolean)) notes.push(`Windows service: ${line.trim()}`);
    }
    for (const candidate of ["C:\\xampp\\mysql\\bin\\mysqld.exe", "C:\\wamp64\\bin\\mysql", "C:\\Program Files\\MySQL"]) {
      if (fs.existsSync(candidate)) notes.push(`Found an install at: ${candidate}`);
    }
    if (fs.existsSync("C:\\xampp\\xampp-control.exe")) {
      notes.push("XAMPP detected — start MySQL from the XAMPP Control Panel (or run C:\\xampp\\mysql_start.bat).");
    }
  } else if (platform === "darwin") {
    const brew = tryCommand("brew services list");
    const line = brew?.split(/\r?\n/).find((l) => /mysql|mariadb/i.test(l));
    if (line) notes.push(`brew services: ${line.trim()}`);
    for (const candidate of ["/usr/local/mysql/bin/mysqld", "/opt/homebrew/bin/mysqld"]) {
      if (fs.existsSync(candidate)) notes.push(`Found an install at: ${candidate}`);
    }
    if (notes.length) notes.push("Start it with: brew services start mysql");
  } else {
    for (const unit of ["mysql", "mysqld", "mariadb"]) {
      const status = tryCommand(`systemctl is-active ${unit}`);
      if (status) notes.push(`systemd unit "${unit}" is ${status}`);
    }
    if (notes.length) notes.push("Start it with: sudo systemctl start mysql   (or mariadb)");
  }

  return notes;
}

// ---------------------------------------------------------------------------------------------
// Heal helpers
// ---------------------------------------------------------------------------------------------

function ensureDatabaseExists(label: string, parsed: ParsedDsn): void {
  try {
    execSync(`npx prisma db execute --stdin --url="${withoutDatabase(parsed)}"`, {
      input: `CREATE DATABASE IF NOT EXISTS \`${parsed.databaseName}\`;`,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: apiCwd
    });
    ok(`${label} — database "${parsed.databaseName}" exists (created if it didn't)`);
  } catch (error) {
    fail(
      `${label} — could not create database "${parsed.databaseName}": ${(error as Error).message.split("\n")[0]}\n` +
        `If this MySQL account can't CREATE DATABASE, create it yourself and re-run:\n` +
        `  CREATE DATABASE \`${parsed.databaseName}\`;`
    );
  }
}

function runMigrations(label: string, schema: string): void {
  try {
    execSync(`npx prisma migrate deploy --schema=${schema}`, { stdio: ["pipe", "pipe", "pipe"], cwd: apiCwd });
    ok(`${label} — migrations applied (prisma migrate deploy)`);
  } catch (error) {
    fail(
      `${label} — migration failed: ${(error as Error).message.split("\n")[0]}\n` +
        `Run manually to see the full error: cd apps/api && npx prisma migrate deploy --schema=${schema}`
    );
  }
}

/** Surgically swaps the host:port of one env var's DSN inside .env, leaving the rest of the file
 *  (comments, ordering, quoting style, every other value) untouched.
 *  WHY the explicit `(\r?)` capture instead of a trailing `\s*`: `\s` matches `\r`, so on a
 *  Windows CRLF file a `\s*$` would eat the carriage return and the replacement would write the
 *  line back LF-only — silently converting just the edited lines and leaving the file with mixed
 *  endings. Capturing the CR and putting it back keeps the file byte-identical apart from the
 *  host:port itself. Horizontal whitespace uses `[ \t]` for the same reason. */
function rewriteEnvHostPort(varName: string, parsed: ParsedDsn, host: string, port: number): void {
  const original = fs.readFileSync(ENV_PATH, "utf8");
  const updatedDsn = withHostPort(parsed, host, port);
  const pattern = new RegExp(`^(${varName}[ \\t]*=[ \\t]*)(["']?)(.*?)\\2[ \\t]*(\\r?)$`, "m");
  if (!pattern.test(original)) fail(`--fix-env — couldn't find a ${varName}= line in ${ENV_PATH} to update.`);
  const updated = original.replace(
    pattern,
    (_full, prefix: string, quote: string, _value: string, cr: string) => `${prefix}${quote}${updatedDsn}${quote}${cr}`
  );
  fs.writeFileSync(ENV_PATH, updated);
  ok(`--fix-env — ${varName} now points at ${host}:${port}`);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  info(`System: ${process.platform} ${process.arch}, ${os.type()} ${os.release()}, Node ${process.version}`);
  info(`Checking ${ENV_PATH} ...\n`);

  if (!fs.existsSync(ENV_PATH)) {
    fail(
      `apps/api/.env doesn't exist.\n` +
        `Create it from the template: copy .env.example to apps/api/.env (NOT to the repo root), then fill in\n` +
        `DATABASE_URL / CONTROL_DATABASE_URL / the three JWT secrets / ENCRYPTION_KEY.`
    );
  }

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

  const tenant = parseDsn(env!.DATABASE_URL, "DATABASE_URL");
  const control = parseDsn(env!.CONTROL_DATABASE_URL, "CONTROL_DATABASE_URL");
  ok(`DATABASE_URL parsed — host=${tenant.host} port=${tenant.port} database=${tenant.databaseName}`);
  ok(`CONTROL_DATABASE_URL parsed — host=${control.host} port=${control.port} database=${control.databaseName}`);

  // Advisory only. Prisma (like any WHATWG-compliant parser) splits userinfo at the LAST `@`, so
  // an unencoded `@` in a password genuinely does work — but `#` and `%` do not, and a password
  // with any of the three is worth flagging since it's an easy thing to get subtly wrong by hand.
  const password = rawPassword(tenant);
  const risky = ["#", "%"].filter((c) => password.includes(c));
  if (risky.length > 0) {
    warn(
      `DATABASE_URL's password contains ${risky.map((c) => `"${c}"`).join(" and ")}, which must be percent-encoded ` +
        `in a connection URL (# → %23, % → %25). If authentication fails below, that's the first thing to fix.`
    );
  } else if (password.includes("@")) {
    info(
      `Note: DATABASE_URL's password contains "@". That's fine — the host is read from the last "@" in the URL — ` +
        `but percent-encoding it as %40 is the unambiguous form if you hit trouble elsewhere.`
    );
  }

  // Discovery runs before the pass/fail check specifically so a failure can say "…but MySQL IS
  // running on 3307" instead of just "nothing is listening".
  info("\nScanning this machine for running MySQL servers...");
  const discovered = await discoverMysql(tenant.host);
  if (discovered.length === 0) {
    info(`  no server responded on ${CANDIDATE_PORTS.join(", ")} at ${tenant.host}`);
  } else {
    for (const { port, probe } of discovered) {
      if (probe.serverVersion) info(`  port ${port} — MySQL/MariaDB ${probe.serverVersion}`);
      else if (probe.notMysql) info(`  port ${port} — open, but it did not respond like MySQL`);
      else info(`  port ${port} — open (no greeting read; probably MySQL behind a proxy)`);
    }
  }
  console.log("");

  const configuredIsUp = discovered.some((d) => d.port === tenant.port && !d.probe.notMysql);
  const alternative = discovered.find((d) => d.port !== tenant.port && !d.probe.notMysql);

  if (!configuredIsUp) {
    // The whole point of the discovery above: turn "it's broken" into "here's the one thing to change".
    if (alternative && FIX_ENV && HEAL) {
      warn(`Nothing is listening on ${tenant.host}:${tenant.port}, but MySQL IS running on port ${alternative.port} — applying --fix-env.`);
      rewriteEnvHostPort("DATABASE_URL", tenant, tenant.host, alternative.port);
      rewriteEnvHostPort("CONTROL_DATABASE_URL", control, control.host, alternative.port);
      info("\n[doctor] .env updated. Re-run `npm run doctor:heal -w apps/api` to continue with the corrected settings.\n");
      return;
    }

    const lines = [
      `DATABASE_URL — nothing is listening on ${tenant.host}:${tenant.port}.`
    ];
    if (alternative) {
      lines.push(
        ``,
        `But MySQL IS running on port ${alternative.port}${alternative.probe.serverVersion ? ` (${alternative.probe.serverVersion})` : ""}. Your .env is pointed at the wrong port.`,
        `Fix it automatically:   npm run doctor:heal -w apps/api -- --fix-env`,
        `Or edit apps/api/.env by hand — change both DATABASE_URL and CONTROL_DATABASE_URL to port ${alternative.port}.`
      );
    } else {
      lines.push(
        ``,
        `No MySQL server responded on any of ${CANDIDATE_PORTS.join(", ")} — it's most likely not started.`
      );
      const installNotes = describeLocalMysqlInstall();
      if (installNotes.length > 0) {
        lines.push(``, `What this machine has:`);
        for (const note of installNotes) lines.push(`  - ${note}`);
      } else {
        lines.push(
          ``,
          `No local MySQL install was detected either. Install one (XAMPP on Windows, \`brew install mysql\` on macOS,`,
          `\`sudo apt install mysql-server\` on Debian/Ubuntu), or point DATABASE_URL at a server you already run.`
        );
      }
      lines.push(
        ``,
        `If you meant to use this repo's Docker Compose stack instead, its MySQL listens on 3307 — run \`docker compose up -d\` first.`
      );
    }
    fail(lines.join("\n"));
  }

  ok(`DATABASE_URL — TCP reachable at ${tenant.host}:${tenant.port}`);

  if (control.host !== tenant.host || control.port !== tenant.port) {
    const controlProbe = await probePort(control.host, control.port);
    if (!controlProbe.open) {
      fail(
        `CONTROL_DATABASE_URL — nothing is listening on ${control.host}:${control.port}, even though DATABASE_URL's server is up.\n` +
          `These two normally point at the same server (different database names). Check apps/api/.env.`
      );
    }
    ok(`CONTROL_DATABASE_URL — TCP reachable at ${control.host}:${control.port}`);
  } else {
    ok(`CONTROL_DATABASE_URL — same server as DATABASE_URL, already verified`);
  }

  if (HEAL) {
    ensureDatabaseExists("DATABASE_URL", tenant);
    ensureDatabaseExists("CONTROL_DATABASE_URL", control);
  }

  try {
    execSync("npx prisma db execute --stdin --schema=prisma/schema.prisma", {
      input: "SELECT 1;",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: apiCwd
    });
    ok("DATABASE_URL — credentials accepted, query succeeded");
  } catch (error) {
    const detail = (error as Error).message;
    const hint = /P1000|Authentication failed/i.test(detail)
      ? `The server is reachable, so this is a username/password problem, not a networking one.\n` +
        `  - XAMPP's default is user "root" with an EMPTY password: mysql://root:@${tenant.host}:${tenant.port}/${tenant.databaseName}\n` +
        `  - If your password contains #, % or other URL-special characters, percent-encode them (# → %23, % → %25).`
      : `Check the username/password in DATABASE_URL match what your MySQL server actually has configured.`;
    fail(`DATABASE_URL — the server answered but authentication or the query failed: ${detail.split("\n")[0]}\n${hint}`);
  }

  if (HEAL) {
    runMigrations("DATABASE_URL", "prisma/schema.prisma");
    runMigrations("CONTROL_DATABASE_URL", "prisma/control/schema.prisma");
    console.log("\n[doctor] Healed — databases created and migrated. Next: `npm run seed -w apps/api` (first run only), then `npm run dev`.\n");
    return;
  }

  await checkFaceReadiness(env!);

  console.log("\n[doctor] All checks passed — safe to run `npm run db:migrate` / `npm run dev`.\n");
}

/**
 * Face-verification preflight. These surface at setup time the three failure modes that
 * otherwise appear only when a real employee tries to verify on a Friday evening:
 *  - the camera never opens because the app isn't served over HTTPS (getUserMedia requires a
 *    secure context — https or localhost — and browsers fail SILENTLY, no error names the cause);
 *  - the face image directory isn't writable by the API process;
 *  - the ML models can't load / take absurdly long on this hardware (checked only under
 *    --face, because loading ~10MB of models costs a couple of seconds and most doctor runs are
 *    diagnosing database problems).
 * Advisory (warn, not fail): the feature is off by default, and a broken face stack must not
 * block diagnosing the database issues people actually run doctor for.
 */
async function checkFaceReadiness(env: { APP_BASE_URL: string; UPLOAD_DIR: string }): Promise<void> {
  info("\nFace verification preflight (advisory):");

  const base = env.APP_BASE_URL;
  const isSecureContext = base.startsWith("https://") || /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(base);
  if (isSecureContext) {
    ok(`APP_BASE_URL (${base}) is a secure context — browsers will allow camera access`);
  } else {
    warn(
      `APP_BASE_URL is ${base} — browsers only allow camera access (getUserMedia) over HTTPS or on localhost.\n` +
        `  Deployed at a plain-HTTP LAN address, the face-capture camera will SILENTLY never appear.\n` +
        `  Put the app behind HTTPS (a real certificate, or an internal CA on a LAN) before enabling face verification.`
    );
  }

  const faceDir = path.join(env.UPLOAD_DIR, "face");
  try {
    fs.mkdirSync(faceDir, { recursive: true });
    const probeFile = path.join(faceDir, `.doctor-probe-${Date.now()}`);
    fs.writeFileSync(probeFile, "ok");
    fs.rmSync(probeFile, { force: true });
    ok(`Face image directory writable — ${faceDir}`);
  } catch (error) {
    warn(`Face image directory ${faceDir} is not writable: ${(error as Error).message}\n  Captures and enrollments will fail to store until this is fixed.`);
  }

  const freeGb = os.freemem() / 1024 ** 3;
  if (freeGb < 1) {
    warn(
      `Only ${freeGb.toFixed(1)} GB of memory is currently free. The face models hold ~0.5 GB per API process ` +
        `once loaded (plus GC headroom) — budget at least 1 GB free before enabling face verification.`
    );
  } else {
    ok(`Memory headroom — ${freeGb.toFixed(1)} GB free (face models need ~1 GB per API process)`);
  }

  if (process.argv.includes("--face")) {
    info("  --face: loading the ML models (once per process, same cost the first real request pays)...");
    const startedAt = Date.now();
    try {
      const { getHuman, analyzeFace } = await import("../src/services/face.service.js");
      await getHuman();
      const loadMs = Date.now() - startedAt;
      // A tiny black frame — proves the full pipeline (sharp decode → tensor → detect) runs,
      // not just that files exist. "No face found" is the expected, correct result.
      const sharp = (await import("sharp")).default;
      const blank = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .jpeg()
        .toBuffer();
      const inferStart = Date.now();
      await analyzeFace(blank);
      ok(`Face models load and run — load ${loadMs} ms, inference ${Date.now() - inferStart} ms`);
      if (loadMs > 15_000) {
        warn(`Model load took ${Math.round(loadMs / 1000)}s — expect slow first verifications on this hardware.`);
      }
    } catch (error) {
      warn(`Face models failed to load: ${(error as Error).message.split("\n")[0]}\n  Face verification will 500 until this is resolved (reinstall node_modules?).`);
    }
  } else {
    info("  (run with --face to also load the ML models and time an inference)");
  }
}

main();
