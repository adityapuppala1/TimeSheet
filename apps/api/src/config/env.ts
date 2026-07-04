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
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
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
