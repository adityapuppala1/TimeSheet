/**
 * WHAT: process entry point — runs boot-time fail-fast safety checks, starts the HTTP server,
 * logs diagnostics (timezone, DB connectivity, mail transport status), starts every cron
 * worker, and wires graceful shutdown.
 * WHY `assertProductionSafety` exists: a placeholder/weak JWT secret or encryption key is the
 * kind of mistake that's invisible until it's exploited — this refuses to boot in production
 * with one (entropy-estimated, not just a denylist of known-bad strings, so a hand-typed weak
 * secret is caught too, not just the literal example values from `.env.example`).
 * WHY graceful shutdown matters: Docker/Kubernetes sends SIGTERM and waits before SIGKILL —
 * stopping new connections, draining in-flight requests, then disconnecting Prisma cleanly is
 * what avoids dropped requests during a rolling deploy.
 * WHO calls this: nothing — this IS the entry point (`node dist/src/server.js`, or `tsx watch
 * src/server.ts` in dev).
 */
import type { Server } from "node:http";
import { closeFileLogging, initFileLogging } from "./config/logger.js";
import { app } from "./app.js";
import { controlPrisma } from "./config/control-prisma.js";
import { env, serverTimezone } from "./config/env.js";
import { applyDatabaseTimezone, disconnectAllTenantClients, getTenantClient } from "./config/prisma.js";
import { tenantContext } from "./config/tenant-context.js";
import { decryptSecret } from "./utils/encryption.js";
import { getTransportStatus } from "./services/mail.service.js";
import { startChatTelegramWorker } from "./workers/chat-telegram.worker.js";
import { startDailyReminderWorker } from "./workers/daily-reminder.worker.js";
import { startDeadlineReminderWorker } from "./workers/deadline-reminder.worker.js";
import { startEscalationWorker } from "./workers/escalation.worker.js";
import { startInboundEmailWorker } from "./workers/inbound-email.worker.js";
import { startMailQueueWorker } from "./workers/mail-queue.worker.js";
import { startTicketEscalationWorker } from "./workers/ticket-escalation.worker.js";
import { startWeeklyDigestWorker } from "./workers/weekly-digest.worker.js";
import { startSecurityWeeklyDigestWorker } from "./workers/security-weekly-digest.worker.js";
import { startFaceRetentionWorker } from "./workers/face-retention.worker.js";
import { startWebhookRetryWorker } from "./workers/webhook-retry.worker.js";
import { startBugPatternDigestWorker } from "./workers/bug-pattern-digest.worker.js";
import { startAIEvalWorker } from "./workers/ai-eval.worker.js";
import { startAgentRunWorker } from "./workers/agent-run.worker.js";
import { startFlowScheduleWorker } from "./workers/flow-schedule.worker.js";
import { startGoalDigestWorker } from "./workers/goal-digest.worker.js";
import { startAIRetentionWorker } from "./workers/ai-retention.worker.js";
import { runForEveryOrg } from "./workers/run-for-every-org.js";
import { registerFlowDispatch } from "./services/automation-dispatch.service.js";
import { reportTenantSchemaDrift } from "./services/tenant-schema-check.service.js";
import { reportDeploymentConfig } from "./config/deployment-check.js";
import { warmFaceModelsIfEnabled } from "./services/face.service.js";
import { announceRunningRelease } from "./services/release-announce.service.js";
import { startIdentityWeeklyDigestWorker } from "./workers/identity-weekly-digest.worker.js";
import { startProjectRiskWorker } from "./workers/project-risk.worker.js";
import { startReportSubscriptionWorker } from "./workers/report-subscription.worker.js";
import { startServiceHealthWorker } from "./workers/service-health.worker.js";
import { startApiTelemetryRetentionWorker } from "./workers/api-telemetry-retention.worker.js";
import { flushApiTelemetry, startApiTelemetry } from "./services/api-telemetry.service.js";

/**
 * Fail-fast guards before the server accepts traffic.
 *
 * These prevent obvious misconfigurations from making it into production —
 * e.g. someone deploying with the demo JWT secret strings still set.
 */
const PRIVATE_LAN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

/**
 * A denylist of exact placeholder strings is brittle — it only catches values nobody
 * bothered to change at all. This estimates order-0 Shannon entropy (bits/char) instead, so
 * it also rejects LOW-QUALITY secrets someone typed by hand (repeated characters, a short
 * alphabet, a memorable phrase) rather than generating with `openssl rand`, regardless of
 * whether the exact string happens to match a known placeholder.
 */
function looksLikeWeakSecret(secret: string): string | null {
  const commonWords = ["secret", "password", "changeme", "placeholder", "example", "replace-with", "change-before-production"];
  const lower = secret.toLowerCase();
  const matchedWord = commonWords.find((word) => lower.includes(word));
  if (matchedWord) return `contains the common placeholder substring "${matchedWord}"`;

  if (secret.length < 32) return `is only ${secret.length} characters (want 32+)`;

  const uniqueChars = new Set(secret).size;
  if (uniqueChars < 10) return `only uses ${uniqueChars} distinct characters (looks repetitive)`;

  const frequencies = new Map<string, number>();
  for (const char of secret) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  const bitsPerChar = [...frequencies.values()].reduce((bits, count) => {
    const p = count / secret.length;
    return bits - p * Math.log2(p);
  }, 0);
  if (bitsPerChar < 3.5) return `has low character-level entropy (${bitsPerChar.toFixed(1)} bits/char, want 3.5+)`;

  return null;
}

function assertProductionSafety() {
  // This warning is intentionally NOT gated on NODE_ENV === "production" — the whole point
  // is to catch the case where an operator forgot to set it. A real public-facing WEB_ORIGIN
  // (not localhost/private-LAN) with NODE_ENV left unset or non-"production" silently
  // disables the CORS private-LAN bypass guard's tightening and this very check, so it's
  // exactly the situation most worth shouting about.
  if (env.NODE_ENV !== "production" && !PRIVATE_LAN_RE.test(env.WEB_ORIGIN.split(",")[0]?.trim() ?? "")) {
    console.warn("=".repeat(70));
    console.warn(`[boot] WARNING: NODE_ENV="${env.NODE_ENV}" but WEB_ORIGIN ("${env.WEB_ORIGIN}") looks like a real, public domain.`);
    console.warn("[boot] If this is a real deployment, set NODE_ENV=production so production-only");
    console.warn("[boot] safety checks (secret strength, cookie Secure flag, CORS strictness) actually run.");
    console.warn("=".repeat(70));
  }

  if (env.NODE_ENV !== "production") return;

  for (const [name, value] of [
    ["JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET],
    ["JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET],
    ["ENCRYPTION_KEY", env.ENCRYPTION_KEY]
  ] as const) {
    const weakness = looksLikeWeakSecret(value);
    if (weakness) {
      console.error(`[boot] FATAL: ${name} ${weakness}.`);
      console.error("[boot] Generate a strong one with: openssl rand -hex 32  (or -base64 48 for JWT secrets)");
      process.exit(1);
    }
  }

  if (PRIVATE_LAN_RE.test(env.WEB_ORIGIN.split(",")[0]?.trim() ?? "")) {
    console.warn("[boot] WARNING: WEB_ORIGIN still references localhost/a private LAN address in production mode.");
  }
}

assertProductionSafety();

// Before anything else this process prints. A no-op unless LOG_DIR is set, and it never throws:
// an unusable log directory degrades to console-only with one warning (see config/logger.ts).
initFileLogging();

const server: Server = app.listen(env.API_PORT, async () => {
  /* startup banner below */
});

/**
 * Single-instance guard. Without it, a second `npm run dev` used to LOOK like it worked: this
 * process crashed with a raw EADDRINUSE stack, but Vite (which picks the next free port when
 * unguarded) came up anyway and proxied to the FIRST instance — a half-dead stack quietly
 * burning CPU and RAM per extra invocation, with nothing on screen saying so. Now the duplicate
 * names the situation and exits 0: not an error, just "already running, use the existing one".
 */
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.log(
      `\n[api] Port ${env.API_PORT} is already in use — another API instance is running.\n` +
        `[api] One backend is all the app needs; this duplicate will exit. Use the existing one,\n` +
        `[api] or stop it first if you meant to restart (the process listening on :${env.API_PORT}).`
    );
    process.exit(0);
  }
  throw err;
});

server.on("listening", async () => {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60).toString().padStart(2, "0");
  const offsetRemMinutes = (Math.abs(offsetMinutes) % 60).toString().padStart(2, "0");
  const offsetLabel = `UTC${offsetSign}${offsetHours}:${offsetRemMinutes}`;

  console.log(`\nAPI listening on http://localhost:${env.API_PORT}`);
  console.log(`[time] Node timezone: ${serverTimezone} (${offsetLabel}) — ${now.toLocaleString()}`);

  // Warm the DEFAULT_ORG_SLUG tenant client at boot (fail loudly here rather than on a
  // request if the control plane or that org's database is misconfigured), and reuse it for
  // the db.time diagnostic log that used to run against the single static client. Also used
  // to give getTransportStatus() below a tenant context to read GlobalMailSettings from — it
  // now checks the DB (Workspace Settings → Mail server) in addition to env vars, and `prisma`
  // is only resolvable inside a request/tenantContext.run(), never at bare module scope.
  try {
    // WAIT for the one-time seed rather than exiting — and the difference is a first install
    // that works versus one that deadlocks. An earlier revision did `process.exit(1)` here, and
    // under any supervisor that restarts the container (compose `restart:`, a Kubernetes
    // Deployment) that produced a crash loop too tight for `docker compose exec`/`kubectl exec`
    // to land the seed in — while install.sh's documented order (wait for health, THEN seed)
    // could never see a healthy API in the first place, because health died with the process.
    // The listener is already up by this point, so waiting keeps /api/health serving, keeps the
    // container Up for the seed command, and turns "unseeded" into a state an operator can read
    // in the logs and fix — which is what it always actually was.
    let org = await controlPrisma.organization.findUnique({ where: { slug: env.DEFAULT_ORG_SLUG }, include: { database: true } });
    while (!org?.database) {
      console.error(`[boot] control-plane Organization "${env.DEFAULT_ORG_SLUG}" is missing or has no database record — waiting for the one-time seed.`);
      console.error("[boot] Run: npm run control:seed -w apps/api   (then: npm run seed -w apps/api)");
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      org = await controlPrisma.organization.findUnique({ where: { slug: env.DEFAULT_ORG_SLUG }, include: { database: true } });
    }
    const defaultClient = await getTenantClient(org.id, decryptSecret(org.database.encryptedDsn));

    await tenantContext.run({ orgId: org.id, orgSlug: org.slug, client: defaultClient }, async () => {
      const tz = await applyDatabaseTimezone(defaultClient);
      console.log(
        `[db.time] mysql session=${tz.sessionTimeZone ?? "?"}, global=${tz.globalTimeZone ?? "?"}, ` +
          `offset=${tz.offset}, applied(global=${tz.globalApplied}, session=${tz.sessionApplied})`
      );
      if (tz.now) console.log(`[db.time] mysql NOW(): ${tz.now}`);
      for (const message of tz.errors) console.warn(`[db.time] ${message}`);

      const mail = await getTransportStatus();
      if (mail.configured) {
        console.log(`[mail] configured (${mail.configSource}): ${mail.host}:${mail.port} (secure=${mail.secure}) — from "${mail.from}"`);
      } else {
        console.warn("[mail] SMTP NOT configured — emails will be marked FAILED with a clear note in EmailLog.");
        console.warn("[mail] Set it from Workspace Settings → Mail server, or SMTP_HOST/PORT/USER/PASS in apps/api/.env and restart.");
      }
    });
  } catch (error) {
    console.warn(`[db.time] timezone alignment failed: ${(error as Error).message}`);
  }

  startEscalationWorker();
  startDeadlineReminderWorker();
  startDailyReminderWorker();
  startTicketEscalationWorker();
  startProjectRiskWorker();
  startReportSubscriptionWorker();
  startServiceHealthWorker();
  // Drains deferred outbound email. Started alongside the inbound poller — the two halves
  // of the mail path, and the outbound one is the reason a rate-limited send now arrives late
  // instead of not at all.
  startMailQueueWorker();
  startInboundEmailWorker();
  startChatTelegramWorker();
  startWeeklyDigestWorker();
  startSecurityWeeklyDigestWorker();
  startFaceRetentionWorker();
  startIdentityWeeklyDigestWorker();
  startWebhookRetryWorker();
  startBugPatternDigestWorker();
  startAIRetentionWorker();
  startAIEvalWorker();
  startAgentRunWorker();
  startFlowScheduleWorker();
  startGoalDigestWorker();
  startApiTelemetryRetentionWorker();

  // The Studio's event triggers. Registered once, for the whole internal event vocabulary — which
  // flows actually fire is decided by the flows, not by what this file was compiled knowing about.
  registerFlowDispatch();
  // Starts the machine-snapshot refresh and the buffer's flush timer. A no-op unless
  // API_TELEMETRY_ENABLED is set, so an untouched deployment starts no extra timers.
  startApiTelemetry();

  // Detached: loads the face models at boot IF any org has the feature enabled, so the first
  // verification after a restart doesn't pay the multi-second cold model load. Deployments
  // with the feature off pay nothing (see warmFaceModelsIfEnabled's header).
  // How this deployment is ADDRESSED, checked before anything else is reported: an app whose
  // APP_BASE_URL is missing from WEB_ORIGIN works perfectly on localhost and refuses every sign-in
  // from the only address its users were given. Synchronous and cheap — three string comparisons.
  reportDeploymentConfig({ appBaseUrl: env.APP_BASE_URL, webOrigin: env.WEB_ORIGIN, nodeEnv: process.env.NODE_ENV });

  // Detached, and the first thing worth knowing at boot: a tenant left behind by a missed
  // `migrate:tenants` looks exactly like healthy code until a worker touches a table that is not
  // there. Warns rather than refusing to start — one org being behind must not take down the ones
  // that are fine.
  void reportTenantSchemaDrift().catch((error) =>
    console.warn(`[tenant-schema] could not check tenant schema versions: ${(error as Error).message}`)
  );

  void warmFaceModelsIfEnabled(runForEveryOrg).catch((error) =>
    console.warn(`[face] boot warm-up skipped: ${(error as Error).message}`)
  );

  // Detached, and at BOOT rather than on a schedule, because "the version changed" only ever
  // happens when this process is replaced. Writes one bell notification per user per new version,
  // at most once per workspace (see release-announce.service.ts for the dedupe), so a restart loop
  // cannot turn into a notification loop.
  void announceRunningRelease(runForEveryOrg).catch((error) =>
    console.warn(`[release-announce] skipped: ${(error as Error).message}`)
  );
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
      // Before the pools close, not after: buffered telemetry is written through the tenant clients
      // `disconnectAllTenantClients` is about to tear down. A rolling deploy replaces this process
      // every release, so without this every replacement silently loses its last flush interval.
      await flushApiTelemetry();
      await disconnectAllTenantClients();
      await controlPrisma.$disconnect();
      console.log("[shutdown] prisma disconnected");
    } catch (error) {
      console.error("[shutdown] prisma disconnect error:", (error as Error).message);
    }
    // Last, so the two lines above still reach the file. A rolling deploy replaces this process
    // every release; without the flush its final moments exist only in a container's stdout.
    closeFileLogging();
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
