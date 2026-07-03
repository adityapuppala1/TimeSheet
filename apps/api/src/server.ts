import type { Server } from "node:http";
import { app } from "./app.js";
import { env, serverTimezone } from "./config/env.js";
import { applyDatabaseTimezone, prisma } from "./config/prisma.js";
import { getTransportStatus } from "./services/mail.service.js";
import { startDailyReminderWorker } from "./workers/daily-reminder.worker.js";
import { startDeadlineReminderWorker } from "./workers/deadline-reminder.worker.js";
import { startEscalationWorker } from "./workers/escalation.worker.js";

/**
 * Fail-fast guards before the server accepts traffic.
 *
 * These prevent obvious misconfigurations from making it into production —
 * e.g. someone deploying with the demo JWT secret strings still set.
 */
function assertProductionSafety() {
  if (env.NODE_ENV !== "production") return;
  const placeholders = [
    "replace-with-strong-access-secret",
    "replace-with-strong-refresh-secret",
    "dev-access-secret-change-before-production",
    "dev-refresh-secret-change-before-production"
  ];
  if (placeholders.includes(env.JWT_ACCESS_SECRET) || placeholders.includes(env.JWT_REFRESH_SECRET)) {
    console.error("[boot] FATAL: JWT_ACCESS_SECRET / JWT_REFRESH_SECRET still use placeholder values.");
    console.error("[boot] Generate strong secrets with: openssl rand -base64 48");
    process.exit(1);
  }
  if (env.WEB_ORIGIN.includes("localhost") || env.WEB_ORIGIN.includes("127.0.0.1")) {
    console.warn("[boot] WARNING: WEB_ORIGIN still references localhost in production mode.");
  }
}

assertProductionSafety();

const server: Server = app.listen(env.API_PORT, async () => {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60).toString().padStart(2, "0");
  const offsetRemMinutes = (Math.abs(offsetMinutes) % 60).toString().padStart(2, "0");
  const offsetLabel = `UTC${offsetSign}${offsetHours}:${offsetRemMinutes}`;

  console.log(`\nAPI listening on http://localhost:${env.API_PORT}`);
  console.log(`[time] Node timezone: ${serverTimezone} (${offsetLabel}) — ${now.toLocaleString()}`);

  try {
    const tz = await applyDatabaseTimezone();
    console.log(
      `[db.time] mysql session=${tz.sessionTimeZone ?? "?"}, global=${tz.globalTimeZone ?? "?"}, ` +
        `offset=${tz.offset}, applied(global=${tz.globalApplied}, session=${tz.sessionApplied})`
    );
    if (tz.now) console.log(`[db.time] mysql NOW(): ${tz.now}`);
    for (const message of tz.errors) console.warn(`[db.time] ${message}`);
  } catch (error) {
    console.warn(`[db.time] timezone alignment failed: ${(error as Error).message}`);
  }

  const mail = getTransportStatus();
  if (mail.configured) {
    console.log(`[mail] configured: ${mail.host}:${mail.port} (secure=${mail.secure}) — from "${mail.from}"`);
  } else {
    console.warn("[mail] SMTP NOT configured — emails will be marked FAILED with a clear note in EmailLog.");
    console.warn('[mail] Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in apps/api/.env and restart.');
  }

  startEscalationWorker();
  startDeadlineReminderWorker();
  startDailyReminderWorker();
});

/**
 * Graceful shutdown.
 *
 * Docker / Kubernetes sends SIGTERM and waits 10–30 seconds before SIGKILL.
 * We stop accepting new connections, let in-flight requests finish, close
 * the Prisma pool, then exit. If anything hangs past the grace window we
 * force-exit so the orchestrator can replace us cleanly.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — draining...`);

  const forceExit = setTimeout(() => {
    console.error("[shutdown] grace window exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(async (err) => {
    if (err) console.error("[shutdown] server.close error:", err.message);
    try {
      await prisma.$disconnect();
      console.log("[shutdown] prisma disconnected");
    } catch (error) {
      console.error("[shutdown] prisma disconnect error:", (error as Error).message);
    }
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Last-ditch error nets so a stray promise rejection doesn't take the process
 * down silently. Real production should also wire to an error tracker (Sentry,
 * Bugsnag, etc.) — these console.error calls are the minimum.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
  // After an uncaught exception the process state may be corrupt — drain and bail.
  shutdown("SIGTERM");
});
