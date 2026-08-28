/**
 * Email sent by the DEPLOYMENT rather than by a workspace.
 *
 * WHY IT HAS TO EXIST. Every other outbound mail goes through `mail.service.ts`, which resolves a
 * transport per tenant and writes an `EmailLog` row through the tenant-scoped Prisma proxy — both
 * of which require a tenant context. Signup verification runs BEFORE the workspace exists, and the
 * trial retention programme runs AFTER it is suspended or gone. Neither has a tenant to borrow a
 * relay from, and neither should: a customer's own SMTP settings are the wrong sender for "we miss
 * you".
 *
 * WHAT IT NOW HAS (3.12.0) that the first version deliberately gave up: its own settings row
 * (`PlatformMailSettings`, env `SMTP_*` as the fallback — the same "database row, else env"
 * relationship the tenant transport has), editable templates (`PlatformEmailTemplate` over the
 * shipped defaults in `platform-mail-templates.ts`), and a delivery log (`PlatformEmailLog`) that
 * the console's counts, analytics and resend button all read. What it still does not have is a
 * retry queue — the retention worker runs daily and records the attempt, so a relay outage costs
 * one day, not a message.
 *
 * NOT A GENERAL-PURPOSE BACK DOOR. Anything that has a tenant must use `dispatchTransactional`.
 */
import nodemailer from "nodemailer";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { platformTemplateDef } from "./platform-mail-templates.js";

export interface PlatformMailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  replyTo: string | null;
  source: "database" | "env";
}

/** DB row (if any), decrypted, else the env-var fallback. */
export async function resolvePlatformMailConfig(): Promise<PlatformMailConfig> {
  const row = await controlPrisma.platformMailSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  if (row?.host) {
    let pass = "";
    if (row.encryptedPassword) {
      try {
        pass = decryptSecret(row.encryptedPassword);
      } catch {
        // Undecryptable (ENCRYPTION_KEY rotated) — treat as unset; the auth failure that follows
        // is a clearer symptom than a decrypt error swallowed on every send.
      }
    }
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      user: row.user ?? "",
      pass,
      from: row.fromAddress || env.MAIL_FROM,
      replyTo: row.replyTo ?? null,
      source: "database"
    };
  }
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
    replyTo: null,
    source: "env"
  };
}

export async function getPlatformTransportStatus() {
  const config = await resolvePlatformMailConfig();
  return {
    configured: Boolean(config.host),
    source: config.source,
    host: config.host || null,
    port: config.port,
    secure: config.secure,
    user: config.user || null,
    from: config.from,
    replyTo: config.replyTo
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** What a template variable may be given as. Rendered values are stringified and escaped. */
export type PlatformVarValue = string | number | null | undefined;

/**
 * `{{name}}` substitution with every value HTML-escaped. A workspace name is typed by a stranger at
 * signup and lands in a heading; escaping at the one substitution point is what makes that safe in
 * the shipped body AND in whatever an operator pastes into the editor.
 */
export function applyPlatformVars(template: string, vars: Record<string, PlatformVarValue>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : escapeHtml(String(value));
  });
}

export interface RenderedPlatformEmail {
  subject: string;
  html: string;
  /** Whether an operator override was used — surfaced in the log's metadata. */
  fromOverride: boolean;
}

export async function renderPlatformTemplate(
  key: string,
  vars: Record<string, PlatformVarValue>
): Promise<RenderedPlatformEmail> {
  const def = platformTemplateDef(key);
  if (!def) throw new AppError(404, `Unknown platform template "${key}"`);
  const enriched = { appUrl: env.APP_BASE_URL.replace(/\/$/, ""), ...vars };
  const override = await controlPrisma.platformEmailTemplate.findUnique({ where: { key } }).catch(() => null);
  if (override?.enabled) {
    return { subject: applyPlatformVars(override.subject, enriched), html: applyPlatformVars(override.bodyHtml, enriched), fromOverride: true };
  }
  return { subject: applyPlatformVars(def.subject, enriched), html: applyPlatformVars(def.html, enriched), fromOverride: false };
}

/* ------------------------------------------------------------------------------------------ */
/* Sending                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface PlatformSendArgs {
  to: string;
  subject: string;
  html: string;
  /** What the log row is filed under. Raw sends (no template) are filed as "platform.raw". */
  templateKey?: string;
  organizationId?: string | null;
  /** Retention stage that produced this message — "feedback10", "ended", "30" … */
  dayMarker?: string | null;
  isTest?: boolean;
  metadata?: Record<string, unknown>;
  /** Throw on failure (the signup path — a person is watching) instead of returning it. */
  throwOnFailure?: boolean;
}

export interface PlatformSendResult {
  ok: boolean;
  status: "SENT" | "FAILED" | "SKIPPED";
  emailLogId: string | null;
  errorMessage?: string;
}

async function logPlatformEmail(args: PlatformSendArgs, status: PlatformSendResult["status"], errorMessage?: string) {
  try {
    const row = await controlPrisma.platformEmailLog.create({
      data: {
        organizationId: args.organizationId ?? null,
        templateKey: args.templateKey ?? "platform.raw",
        to: args.to,
        subject: args.subject.slice(0, 255),
        status,
        errorMessage: errorMessage ?? null,
        dayMarker: args.dayMarker ?? null,
        isTest: args.isTest ?? false,
        // Kept for every row, so a FAILED one can be resent exactly as it was and a SENT one can be
        // opened from the log. Platform volume is small; this is not the tenant EmailLog's problem.
        payload: { html: args.html },
        metadata: args.metadata ? JSON.parse(JSON.stringify(args.metadata)) : undefined
      },
      select: { id: true }
    });
    return row.id;
  } catch (error) {
    console.warn(`[platform-mail] could not write the email log: ${(error as Error).message}`);
    return null;
  }
}

export async function sendPlatformMail(args: PlatformSendArgs): Promise<PlatformSendResult> {
  const config = await resolvePlatformMailConfig();

  if (!config.host) {
    const message = "This deployment can't send email yet — configure the platform mail server (or SMTP_HOST).";
    const id = await logPlatformEmail(args, "SKIPPED", message);
    // A 503 rather than a silent success on the signup path: a signup that says "check your email"
    // when no mail can be sent leaves somebody waiting for a code that will never arrive.
    if (args.throwOnFailure) throw new AppError(503, "This deployment can't send email yet, so signup isn't available. Contact the administrator.");
    return { ok: false, status: "SKIPPED", emailLogId: id, errorMessage: message };
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    // BOUNDED. The signup send happens INSIDE the request, so nodemailer's two-minute defaults
    // would leave the button reading "Sending…" for two minutes on a typo'd relay.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000
  });

  try {
    await transporter.sendMail({
      from: config.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      replyTo: config.replyTo ?? undefined
    });
    const id = await logPlatformEmail(args, "SENT");
    return { ok: true, status: "SENT", emailLogId: id };
  } catch (error) {
    const message = (error as Error).message;
    const id = await logPlatformEmail(args, "FAILED", message);
    if (args.throwOnFailure) throw new AppError(502, `Email could not be sent: ${message}`);
    return { ok: false, status: "FAILED", emailLogId: id, errorMessage: message };
  } finally {
    // Not pooled: this sends a handful of messages a day, and a held-open pool would be a
    // connection idling for a message that is not coming.
    transporter.close();
  }
}

/** Render a registered template and send it — the path every retention email and the signup code take. */
export async function sendPlatformTemplate(
  key: string,
  args: Omit<PlatformSendArgs, "subject" | "html" | "templateKey"> & { vars: Record<string, PlatformVarValue> }
): Promise<PlatformSendResult & { subject: string }> {
  const rendered = await renderPlatformTemplate(key, args.vars);
  const result = await sendPlatformMail({
    ...args,
    templateKey: key,
    subject: rendered.subject,
    html: rendered.html,
    metadata: { ...(args.metadata ?? {}), fromOverride: rendered.fromOverride }
  });
  return { ...result, subject: rendered.subject };
}

/** Send the stored rendering of a logged message again — the console's Resend button. */
export async function resendPlatformEmail(logId: string, actorLabel: string): Promise<PlatformSendResult> {
  const row = await controlPrisma.platformEmailLog.findUnique({ where: { id: logId } });
  if (!row) throw new AppError(404, "That email is not in the log.");
  const html = (row.payload as { html?: string } | null)?.html;
  if (!html) throw new AppError(409, "That message's body was not kept, so it cannot be resent as it was — send the template again instead.");
  return sendPlatformMail({
    to: row.to,
    subject: row.subject,
    html,
    templateKey: row.templateKey,
    organizationId: row.organizationId,
    dayMarker: row.dayMarker,
    isTest: row.isTest,
    metadata: { resendOf: row.id, by: actorLabel }
  });
}
