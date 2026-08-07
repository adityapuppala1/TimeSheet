/**
 * WHAT: loads `.env`, validates every environment variable this API depends on against a Zod
 * schema, and exports the single typed `env` object everything else imports.
 * WHY: a missing/malformed env var should fail loudly at boot (a clear Zod error naming exactly
 * which variable and why), not surface later as a cryptic runtime error three services deep —
 * `schema.parse(process.env)` at the bottom of this file is what enforces that.
 * HOW: only six variables have no default (`DATABASE_URL`, `CONTROL_DATABASE_URL`,
 * `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PLATFORM_ADMIN_JWT_SECRET`, `ENCRYPTION_KEY`) —
 * everything else degrades to a sane default so a fresh checkout boots without needing every
 * knob configured. `server.ts#assertProductionSafety` adds a second, stricter layer on top of
 * this (secret-strength entropy checks) that only runs when `NODE_ENV=production`.
 * WHO calls this: every file in the API imports `{ env }` from here — it's the one place
 * `process.env` is read directly.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

/**
 * Environment profiles. `APP_ENV` picks WHICH .env file configures this process:
 *
 *   (unset)              → .env                (local development — unchanged default)
 *   APP_ENV=uat          → .env.uat, then .env (uat wins on conflicts, .env fills gaps)
 *   APP_ENV=production   → .env.production, then .env
 *
 * Layering works because dotenv never overwrites a variable that's already set — the profile
 * file loads FIRST, so its values win; the base .env only fills whatever the profile left out.
 * Real shell environment variables beat both, unchanged.
 *
 * A NAMED profile whose file is missing is a hard, loud failure — an operator who asked for
 * "uat" and silently got local database credentials would be debugging the wrong universe.
 * Copy apps/api/.env.uat.example → .env.uat (same for production) and fill it in.
 */
const APP_ENV = process.env.APP_ENV?.trim();
if (APP_ENV) {
  const profilePath = `.env.${APP_ENV}`;
  const result = dotenv.config({ path: profilePath });
  if (result.error) {
    console.error(
      `[env] APP_ENV=${APP_ENV} but ${profilePath} could not be read (${(result.error as Error).message}).\n` +
        `[env] Copy .env.${APP_ENV}.example to ${profilePath} in apps/api/ and fill it in — refusing to boot with the wrong environment's config.`
    );
    process.exit(1);
  }
  console.log(`[env] profile: ${APP_ENV} (${profilePath}, with .env as fallback for unset keys)`);
}
dotenv.config();

/**
 * Force the Node.js process timezone before any Date is created elsewhere.
 *
 * Defaults to Asia/Kolkata (IST, UTC+5:30) so daily-reminder cron hours,
 * audit timestamps, and email "createdAt" formatting line up with India
 * business hours regardless of where the host runs.
 *
 * Override via `TZ=Europe/London` (or any IANA zone) in apps/api/.env.
 */
process.env.TZ = process.env.TZ || "Asia/Kolkata";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  TZ: z.string().default("Asia/Kolkata"),
  DATABASE_URL: z.string().min(1),
  // The platform's own database (org registry, SSO config, plan tiers, platform-admin
  // accounts) — separate from every tenant's own database. See apps/api/prisma/control/schema.prisma
  // and apps/api/src/config/control-prisma.ts. Not yet consumed by the request path (that's
  // Phase B1's tenant-resolution middleware) — Phase B0 only needs it reachable for seeding.
  CONTROL_DATABASE_URL: z.string().min(1),
  // The Organization.slug used when a request's Host header doesn't carry a real subdomain
  // (localhost, a bare IP, an on-prem deployment's own domain with no subdomain routing set
  // up). A single-tenant on-prem deployment only ever has this one org and never needs real
  // subdomain routing at all — see prisma/control/seed.ts, which seeds an org with this slug.
  DEFAULT_ORG_SLUG: z.string().min(1).default("default"),
  // The MySQL server new tenant databases get physically created on when a platform admin
  // provisions an org through the console (Phase B8) — a DSN with credentials but no database
  // name, e.g. "mysql://root:@localhost:3306". Optional: a deployment that provisions tenant
  // databases some other way (a separate ops process, a different server per customer) simply
  // leaves this unset, and the provisioning endpoint returns a clear error instead of guessing.
  TENANT_DB_PROVISION_BASE_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  // Deliberately separate from JWT_ACCESS_SECRET/JWT_REFRESH_SECRET (which every tenant
  // currently shares) — a platform-admin token must never verify successfully even if a
  // tenant secret ever leaked, since platform admins can see/administer every org.
  PLATFORM_ADMIN_JWT_SECRET: z.string().min(16),
  // 32 raw bytes, hex-encoded (64 hex chars) — AES-256-GCM key for utils/encryption.ts.
  // Generate one with: openssl rand -hex 32
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be a 64-character hex string (32 bytes) — generate one with: openssl rand -hex 32"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(14),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  APP_BASE_URL: z.string().default("http://localhost:5173"),
  MAIL_FROM: z.string().default("Timesheet Portal <no-reply@timesheet.local>"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_SECURE: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  UPLOAD_DIR: z.string().default("uploads"),

  SLA_DEFAULT_APPROVAL_HOURS: z.coerce.number().default(48),
  SLA_CRON_SCHEDULE: z.string().default("*/15 * * * *"),
  SLA_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .default("true")
    .transform((value) => value === "true" || value === "1"),

  TICKET_SLA_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .default("true")
    .transform((value) => value === "true" || value === "1"),
  TICKET_SLA_CRON_SCHEDULE: z.string().default("*/15 * * * *"),
  TICKET_SLA_LOW_HOURS: z.coerce.number().default(168),
  TICKET_SLA_MEDIUM_HOURS: z.coerce.number().default(72),
  TICKET_SLA_HIGH_HOURS: z.coerce.number().default(24),
  TICKET_SLA_CRITICAL_HOURS: z.coerce.number().default(4),

  // Optional — AI features stay disabled (GlobalAISettings.aiEnabled defaults false) until this is set.
  ANTHROPIC_API_KEY: z.string().default(""),

  /**
   * Per-request API telemetry (middleware/request-telemetry.ts → ApiRequestSample).
   *
   * OFF BY DEFAULT, and that is the important part: this middleware sits in the hot path of every
   * single request and writes a row per sampled one. An operator has to ASK for that cost; a
   * deployment that never touches these variables pays one boolean check per request and nothing
   * else. On a busy instance turn the rate down rather than the feature off — percentiles from a
   * 10% sample are still percentiles, whereas no data answers nothing.
   */
  API_TELEMETRY_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  /** Fraction of requests recorded, 0..1. 1 = every request. */
  API_TELEMETRY_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  /** How often the in-memory buffer is drained to the database. */
  API_TELEMETRY_FLUSH_MS: z.coerce.number().min(250).default(5_000),
  /** Hard ceiling on buffered rows. Past it, new samples are DROPPED (and counted) rather than
   *  allowed to grow into a memory leak — losing telemetry beats losing the process. */
  API_TELEMETRY_MAX_BUFFER: z.coerce.number().min(100).default(5_000),
  /** Rows older than this are pruned nightly. These accumulate per request, not per hour. */
  API_TELEMETRY_RETENTION_DAYS: z.coerce.number().min(1).default(14),

  /**
   * Host identity for the telemetry rows. Named for the Kubernetes downward API so a Deployment
   * can map them straight through (`fieldRef: metadata.name` / `metadata.namespace`); off-cluster
   * they stay empty and the columns are written NULL rather than filled with a guess.
   */
  POD_NAME: z.string().default(""),
  POD_NAMESPACE: z.string().default(""),
  CLUSTER_NAME: z.string().default(""),
  /** Container runtimes set this to the pod/container name. Only consulted if os.hostname()
   *  somehow yields nothing — os.hostname() already returns the pod name inside a pod. */
  HOSTNAME: z.string().default("")
});

const parsed = schema.parse(process.env);

/**
 * APP_BASE_URL="auto" (or any URL containing the "{lan-ip}" token) resolves to the machine's
 * OWN address at boot instead of an IP frozen into .env — a laptop that hops networks gets a
 * new DHCP address, and every emailed link built on the old one dies quietly.
 *
 * Resolution rules, stated because each is a choice:
 *  - Primary non-internal IPv4, preferring private ranges (192.168./10.) over anything exotic —
 *    the audience for "auto" is a LAN deployment, and the LAN address is the one colleagues
 *    can actually open.
 *  - "auto" assumes the dev web port (5173) and picks https exactly when the dev certificate
 *    pair exists (the same signal vite.config.ts switches on) — the two ends of the link derive
 *    the scheme from one artefact and cannot disagree. Other ports/schemes: use "{lan-ip}"
 *    inside a full URL, e.g. "https://{lan-ip}:8443".
 *  - Detected once at BOOT. An IP change needs an API restart — a link's base flipping between
 *    two addresses mid-session would be far harder to debug than a stale one.
 *  - Production should pin a real domain; "auto" there gets a loud warning, not a refusal —
 *    an on-prem LAN pilot IS production to the people using it.
 */
function resolveAppBaseUrl(configured: string): string {
  const wantsAuto = configured === "auto";
  const wantsToken = configured.includes("{lan-ip}");
  if (!wantsAuto && !wantsToken) return configured;

  const candidates: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal && !iface.address.startsWith("169.254.")) {
        candidates.push(iface.address);
      }
    }
  }
  const ip = candidates.find((a) => a.startsWith("192.168.") || a.startsWith("10.")) ?? candidates[0] ?? "localhost";

  let resolved: string;
  if (wantsToken) {
    resolved = configured.replaceAll("{lan-ip}", ip);
  } else {
    const certsExist = [resolve(process.cwd(), "../web/certs/dev-cert.pem"), resolve(process.cwd(), "apps/web/certs/dev-cert.pem")]
      .some((p) => existsSync(p));
    resolved = `${certsExist ? "https" : "http"}://${ip}:5173`;
  }
  console.log(`[env] APP_BASE_URL ${configured} → ${resolved} (emailed links use this base; restart after an IP change)`);
  if (process.env.NODE_ENV === "production") {
    console.warn("[env] APP_BASE_URL is auto-detected in production — pin a real domain so emailed links survive address changes.");
  }
  return resolved;
}

export const env = { ...parsed, APP_BASE_URL: resolveAppBaseUrl(parsed.APP_BASE_URL) };

/** Effective IANA timezone the Node process is honouring. */
export const serverTimezone =
  Intl.DateTimeFormat().resolvedOptions().timeZone || env.TZ;
