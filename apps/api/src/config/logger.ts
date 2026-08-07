/**
 * WHAT: rotating file logs. Mirrors everything the process already prints to stdout into
 * time-bucketed files under a configurable root, gzips each day once the date rolls over, and
 * prunes whole days past a retention window.
 *
 * WHY HAND-ROLLED RATHER THAN A DEPENDENCY: this codebase has no logging library at all — every
 * call site is `console.info/warn/error`, and `morgan("tiny")` writes HTTP lines to stdout. The
 * options were (a) adopt pino/winston and rewrite ~1,500 call sites across 200 files, (b) add
 * winston-daily-rotate-file purely as a sink and keep console.* anyway, or (c) this. (a) is a
 * codebase-wide change with a codebase-wide blast radius for a feature that is "write the same
 * text to a file too". (b) still adds a transitive dependency tree for ~150 lines of logic we'd
 * configure rather than write. The rotation rules asked for here (4-hour buckets inside a
 * per-DATE directory, gzip on date rollover, day-granularity retention) are not the default of
 * either library, so either way the interesting part is written by hand. So: no new dependency.
 *
 * ── APPROACH: CENTRAL CAPTURE, NOT A REWRITE ────────────────────────────────────────────────
 *
 * `initFileLogging()` wraps `console.log/info/warn/error/debug` so each call does what it always
 * did (the ORIGINAL function is invoked first and unconditionally — Docker, `npm run dev` and
 * systemd all read stdout, and nothing here may take that away) and then additionally appends a
 * timestamped, level-tagged line to the current file. Not one existing call site changes, and
 * removing the feature is deleting one call in server.ts.
 *
 * The one non-console source worth capturing is morgan's HTTP access log, which writes straight
 * to `process.stdout`; app.ts hands it a stream that routes through `console.info` instead. We
 * deliberately do NOT patch `process.stdout.write` itself: the patched console writes through it,
 * so any bug in the wrapper becomes infinite recursion inside the logger, at which point the
 * process is unrecoverable and the logs that would explain it are the thing that broke.
 *
 * ── NAMING SCHEME ───────────────────────────────────────────────────────────────────────────
 *
 *   <LOG_DIR>/2026-08-07/app-2026-08-07_00-04.log      ← 00:00–03:59 local
 *   <LOG_DIR>/2026-08-07/app-2026-08-07_04-08.log      ← 04:00–07:59 local
 *   …
 *   <LOG_DIR>/2026-08-06/app-2026-08-06_20-24.log.gz   ← yesterday, compressed on rollover
 *
 * The date appears in BOTH the directory and the filename on purpose: the directory makes
 * "delete everything older than N days" a directory operation, and the redundant date in the
 * filename means a file copied out of its directory — attached to a ticket, dropped in a chat —
 * still says which day it is. Windows are LOCAL-time and derived from the wall clock, so a
 * restart mid-window appends to the file it was already writing instead of starting a new one.
 *
 * ── FAILURE POSTURE ─────────────────────────────────────────────────────────────────────────
 *
 * File logging must never be able to take the app down. Every filesystem operation in here is
 * wrapped; the first failure prints ONE warning to the real console, sets `degraded`, and the
 * process runs console-only forever after. A full disk, a revoked ACL or an unmounted NAS
 * degrades logging, not service.
 *
 * WHO calls this: server.ts (`initFileLogging()` at boot, `closeFileLogging()` on shutdown),
 * app.ts (morgan's stream), controllers/settings.controller.ts (status for the admin card).
 */
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { env } from "./env.js";

export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

const CAPTURED_LEVELS: LogLevel[] = ["log", "info", "warn", "error", "debug"];

export interface LoggingStatus {
  /** Configured AND currently working. False covers both "not configured" and "degraded". */
  enabled: boolean;
  /** Empty when LOG_DIR is unset — the default, meaning console-only. */
  directory: string;
  rotateHours: number;
  retentionDays: number;
  compressOnRollover: boolean;
  /** True once a filesystem failure forced console-only mode. */
  degraded: boolean;
  degradedReason: string | null;
  /** The file being appended to right now, so an admin can go and tail it. */
  currentFile: string | null;
  /** Pattern documentation for the UI, rendered from the live config rather than hard-coded. */
  namingExample: string;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `2026-08-07` in LOCAL time — the process TZ is pinned in env.ts, so this matches every other
 *  timestamp the app produces (audit rows, emails, cron hours). */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * `00-04` — the [start, end) hour window `date` falls in, for a bucket of `rotateHours`.
 *
 * The final window of a day is CLAMPED to 24 rather than wrapping: with rotateHours=5 the day is
 * 00-05/05-10/10-15/15-20/20-24, so the last file is short. Clamping keeps every filename inside
 * one calendar date, which is what makes the per-date directory and the gzip-on-rollover rule
 * unambiguous; a wrapping window would put 22:00–03:00 in two days at once.
 */
export function windowLabel(date: Date, rotateHours: number): string {
  const size = Math.min(24, Math.max(1, Math.floor(rotateHours) || 1));
  const start = Math.floor(date.getHours() / size) * size;
  return `${pad2(start)}-${pad2(Math.min(start + size, 24))}`;
}

/** Pure path arithmetic — no I/O — so the naming/rollover rules are unit-testable on their own. */
export function logFileFor(root: string, date: Date, rotateHours: number): { day: string; dayDir: string; filePath: string } {
  const day = dayKey(date);
  const dayDir = path.join(root, day);
  return { day, dayDir, filePath: path.join(dayDir, `app-${day}_${windowLabel(date, rotateHours)}.log`) };
}

/** `2026-08-07 14:05:22.031` — local, sortable, and no timezone suffix to mislead anyone into
 *  reading it as UTC. The process timezone is stated once in the boot banner. */
function timestamp(date: Date): string {
  return (
    `${dayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, "0")}`
  );
}

const original: Record<LogLevel, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

let active = false;
let degraded = false;
let degradedReason: string | null = null;
let stream: fs.WriteStream | null = null;
let streamPath: string | null = null;
let streamDay: string | null = null;

/** One warning, then silence. A logger that logs about its own failure on every line would
 *  bury the application output it exists to preserve. */
function degrade(reason: string): void {
  if (degraded) return;
  degraded = true;
  degradedReason = reason;
  try {
    stream?.end();
  } catch {
    /* already broken */
  }
  stream = null;
  streamPath = null;
  original.warn(
    `[logger] file logging DISABLED for the rest of this process — ${reason}\n` +
      `[logger] console output is unaffected. Fix LOG_DIR (${env.LOG_DIR}) and restart to re-enable.`
  );
}

function writeLine(level: LogLevel, args: unknown[]): void {
  if (!active || degraded) return;
  try {
    const now = new Date();
    const target = logFileFor(env.LOG_DIR, now, env.LOG_ROTATE_HOURS);
    if (target.filePath !== streamPath) {
      const previousDay = streamDay;
      stream?.end();
      fs.mkdirSync(target.dayDir, { recursive: true });
      stream = fs.createWriteStream(target.filePath, { flags: "a" });
      stream.on("error", (error) => degrade(error.message));
      streamPath = target.filePath;
      streamDay = target.day;
      // Detached: compressing yesterday must not add latency to the console call that happened
      // to be the first one after midnight.
      if (previousDay && previousDay !== target.day) void rollDay(previousDay);
    }
    stream?.write(`${timestamp(now)} ${level.toUpperCase().padEnd(5)} ${util.format(...args)}\n`);
  } catch (error) {
    degrade((error as Error).message);
  }
}

/** Gzip a finished day, then prune whatever has aged out. Never throws. */
async function rollDay(day: string): Promise<void> {
  if (env.LOG_COMPRESS_ON_ROLLOVER) await compressDay(env.LOG_DIR, day).catch(() => undefined);
  await pruneOldDays(env.LOG_DIR, env.LOG_RETENTION_DAYS).catch(() => undefined);
}

/**
 * Gzips every `.log` in one day-directory and removes the original.
 *
 * Streamed rather than read-then-write: a busy day's file can be hundreds of MB, and buffering it
 * to compress it would spike RSS on a box that is, by hypothesis, already short of disk. The
 * original is deleted only after the `.gz` is fully written — a crash mid-compress leaves both,
 * which the next pass tidies, rather than neither.
 */
export async function compressDay(root: string, day: string): Promise<number> {
  const dir = path.join(root, day);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let compressed = 0;
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const source = path.join(dir, name);
    const destination = `${source}.gz`;
    try {
      await pipeline(fs.createReadStream(source), zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION }), fs.createWriteStream(destination));
      await fs.promises.rm(source, { force: true });
      compressed += 1;
    } catch {
      await fs.promises.rm(destination, { force: true }).catch(() => undefined);
    }
  }
  return compressed;
}

/**
 * Deletes day-directories older than `retentionDays`.
 *
 * Only directories whose name is exactly `YYYY-MM-DD` are ever considered, and the comparison is
 * on the parsed DATE, not on mtime. Both are deliberate: this function deletes recursively inside
 * an operator-supplied root, so anything it does not positively recognise as one of its own day
 * directories — a stray file, someone's notes, a sibling application's folder — is left alone.
 */
export async function pruneOldDays(root: string, retentionDays: number): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const [year, month, dayOfMonth] = entry.name.split("-").map(Number);
    const dirDate = new Date(year, month - 1, dayOfMonth);
    if (Number.isNaN(dirDate.getTime()) || dirDate >= cutoff) continue;
    try {
      await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // A locked file (Windows, a tail -f) just means this day gets pruned on the next rollover.
    }
  }
  return removed;
}

/**
 * Turns file logging on. Idempotent, and a no-op when LOG_DIR is unset — which is the default, so
 * an untouched deployment behaves exactly as it did before this file existed.
 *
 * The startup catch-up (compress + prune) matters more than it looks: a process that was stopped
 * over midnight never observes a rollover, so without this an app restarted each morning would
 * accumulate uncompressed days forever and never honour retention.
 */
export function initFileLogging(): LoggingStatus {
  if (active || !env.LOG_DIR) return getLoggingStatus();

  try {
    fs.mkdirSync(env.LOG_DIR, { recursive: true });
    const probe = path.join(env.LOG_DIR, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (error) {
    // Not `degrade()`: nothing was ever active, and the message an operator needs here names the
    // variable they got wrong rather than describing a fallback.
    degraded = true;
    degradedReason = (error as Error).message;
    original.warn(
      `[logger] LOG_DIR "${env.LOG_DIR}" is not usable (${degradedReason}) — continuing with console-only logging.\n` +
        `[logger] Create the directory and grant the service account write access, then restart.`
    );
    return getLoggingStatus();
  }

  active = true;
  for (const level of CAPTURED_LEVELS) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      writeLine(level, args);
    };
  }

  const today = dayKey(new Date());
  streamDay = today;
  void (async () => {
    if (env.LOG_COMPRESS_ON_ROLLOVER) {
      const days = await fs.promises.readdir(env.LOG_DIR).catch(() => [] as string[]);
      for (const day of days) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day !== today) await compressDay(env.LOG_DIR, day).catch(() => undefined);
      }
    }
    await pruneOldDays(env.LOG_DIR, env.LOG_RETENTION_DAYS).catch(() => undefined);
  })();

  console.info(
    `[logger] file logging enabled — ${env.LOG_DIR}/<date>/app-<date>_<HH-HH>.log, ` +
      `rotating every ${env.LOG_ROTATE_HOURS}h, gzip on date rollover=${env.LOG_COMPRESS_ON_ROLLOVER}, retention ${env.LOG_RETENTION_DAYS}d`
  );
  return getLoggingStatus();
}

/** Flushes and closes the current file. Called from server.ts's graceful shutdown so the last
 *  lines of a rolling deploy's outgoing process actually reach disk. */
export function closeFileLogging(): void {
  try {
    stream?.end();
  } catch {
    /* shutting down anyway */
  }
  stream = null;
  streamPath = null;
}

export function getLoggingStatus(): LoggingStatus {
  const example = logFileFor(env.LOG_DIR || "<LOG_DIR>", new Date(), env.LOG_ROTATE_HOURS).filePath;
  return {
    enabled: active && !degraded,
    directory: env.LOG_DIR,
    rotateHours: env.LOG_ROTATE_HOURS,
    retentionDays: env.LOG_RETENTION_DAYS,
    compressOnRollover: env.LOG_COMPRESS_ON_ROLLOVER,
    degraded,
    degradedReason,
    currentFile: streamPath,
    namingExample: example
  };
}
