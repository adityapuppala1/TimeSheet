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
import dotenv from "dotenv";
import { z } from "zod";

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
  ANTHROPIC_API_KEY: z.string().default("")
});

export const env = schema.parse(process.env);

/** Effective IANA timezone the Node process is honouring. */
export const serverTimezone =
  Intl.DateTimeFormat().resolvedOptions().timeZone || env.TZ;
