/**
 * WHAT: the one place this app actually talks to an SMTP server. Lazily creates+verifies a
 * nodemailer transport, exposes `sendMail()` (every outbound email in the app goes through this)
 * and `getTransportStatus()` (powers the admin settings banner warning when SMTP isn't
 * configured or the From-address looks undeliverable).
 * WHY: centralizing here means every caller gets the same `EmailLog` audit trail, the same
 * graceful "SMTP not configured — log to console instead of crashing" fallback, and the same
 * BCC-super-admin behavior, without re-implementing any of it.
 * HOW: SMTP config is resolved from `GlobalMailSettings` (Workspace Settings → Mail server,
 * admin-configurable, password encrypted at rest) with `apps/api/.env`'s `SMTP_*` vars as the
 * fallback when no DB row is configured — the same "DB row, else env var" relationship
 * `ai.service.ts#resolveApiKey` already has between `GlobalAISettings.apiKey` and
 * `ANTHROPIC_API_KEY`, so an existing on-prem deployment that only ever set `.env` keeps working
 * completely unconfigured. `getTransport()` builds+caches the transporter keyed on a hash of the
 * resolved config so a settings change is picked up on the next send without a restart — see
 * `invalidateMailTransportCache()`, called by `controllers/settings.controller.ts` after a save.
 * `classifyFromAddress` proactively flags common deliverability foot-guns (reserved TLDs,
 * MAIL_FROM/SMTP_USER domain mismatch) since those cause silent drops that are otherwise very
 * hard to diagnose.
 * WHO calls this: `notify.service.ts` (the higher-level "should this even send" gate) and
 * `dispatchTransactional` — nothing else calls `sendMail` directly.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { isEmailRoleMuted, type EmailRoleMutes, type NotificationPreferences } from "@timesheet/shared";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { decryptSecret } from "../utils/encryption.js";

export { templates } from "./mail-templates.js";

interface ResolvedMailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** Which layer actually supplied `host` — surfaced in getTransportStatus() so the admin UI
   *  can say "using your saved Mail server settings" vs. "using apps/api/.env". */
  source: "database" | "env";
}

/** DB row (if any), decrypted, else the env-var fallback — see this file's header comment. */
async function resolveMailConfig(): Promise<ResolvedMailConfig> {
  const settings = await prisma.globalMailSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  if (settings?.host) {
    let pass = "";
    if (settings.password) {
      try {
        pass = decryptSecret(settings.password);
      } catch {
        // Undecryptable (e.g. ENCRYPTION_KEY rotated without re-encrypting) — treat as
        // "not set" rather than crash the whole transport; verification will surface the
        // resulting auth failure clearly instead of a silent decrypt error.
      }
    }
    return {
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      user: settings.user ?? "",
      pass,
      from: settings.fromAddress || env.MAIL_FROM,
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
    source: "env"
  };
}

let transporter: Transporter | null = null;
let cachedConfigKey: string | null = null;
let transportVerified: boolean | null = null;
let transportVerifyError: string | null = null;
let lastResolvedConfig: ResolvedMailConfig | null = null;

function configKey(config: ResolvedMailConfig): string {
  return JSON.stringify({ host: config.host, port: config.port, secure: config.secure, user: config.user, pass: config.pass, from: config.from });
}

/** Call after saving GlobalMailSettings so the next send picks up the new config immediately —
 *  without this, the cached transporter (built from the old config) would keep being reused
 *  until the API process restarts. */
export function invalidateMailTransportCache(): void {
  cachedConfigKey = null;
}

async function getTransport(): Promise<Transporter | null> {
  const config = await resolveMailConfig();
  lastResolvedConfig = config;
  const key = configKey(config);

  if (key === cachedConfigKey) return transporter;
  cachedConfigKey = key;

  if (!config.host) {
    transporter = null;
    console.warn(
      "[mail] No SMTP host configured — emails will NOT be delivered. Set it from Workspace Settings → Mail server, or SMTP_HOST/PORT/USER/PASS in apps/api/.env."
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined
  });

  transportVerified = null;
  transportVerifyError = null;
  transporter
    .verify()
    .then(() => {
      transportVerified = true;
      console.info(`[mail] SMTP transport ready (${config.host}:${config.port}, secure=${config.secure}, source=${config.source}).`);
    })
    .catch((error) => {
      transportVerified = false;
      transportVerifyError = (error as Error).message;
      console.warn(`[mail] SMTP verification failed (${config.host}:${config.port}): ${transportVerifyError}`);
    });

  return transporter;
}

/* ============================== From-address health ============================== */

/** Reserved / non-deliverable TLDs per RFC 2606 + common dev placeholders. */
const NON_DELIVERABLE_TLDS = [".local", ".test", ".example", ".localhost", ".invalid", ".internal", ".localdomain"];

function extractEmail(from: string): { address: string | null; domain: string | null } {
  // Matches "Name <user@domain>" or bare "user@domain"
  const match = from.match(/<?([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)>?/);
  if (!match) return { address: null, domain: null };
  return { address: `${match[1]}@${match[2]}`, domain: match[2].toLowerCase() };
}

function classifyFromAddress(from: string, smtpUser: string): {
  fromAddress: string | null;
  fromDomain: string | null;
  userDomain: string | null;
  issues: string[];
} {
  const issues: string[] = [];
  const { address, domain } = extractEmail(from);

  if (!domain) {
    issues.push("The From address has no parseable address. Use 'Display Name <user@domain.com>' format.");
    return { fromAddress: null, fromDomain: null, userDomain: null, issues };
  }

  // Hard fail: reserved TLDs
  for (const tld of NON_DELIVERABLE_TLDS) {
    if (domain.endsWith(tld)) {
      issues.push(
        `From-address domain "${domain}" uses ${tld} — a reserved TLD that real mail servers silently drop or send to spam. ` +
        "Use a domain you own and have verified with your SMTP provider."
      );
      break;
    }
  }

  // Mismatch: SMTP user and From address on different domains
  let userDomain: string | null = null;
  if (smtpUser && smtpUser.includes("@")) {
    userDomain = smtpUser.split("@").pop()!.toLowerCase();
    if (userDomain !== domain) {
      issues.push(
        `From-address domain "${domain}" does not match the SMTP account's domain "${userDomain}". ` +
        "Many providers (Gmail, Office365, SendGrid, Mailgun, SES) reject or silently quarantine mismatched senders unless the From domain is explicitly verified. " +
        `Either change the From address to use @${userDomain}, or add ${domain} as a verified sender with your SMTP provider.`
      );
    }
  }

  return { fromAddress: address, fromDomain: domain, userDomain, issues };
}

/** Public-facing snapshot of mail-transport state. Used by the admin UI banner. Triggers
 *  transport (re)build/verification as a side effect, same as sendMail would. */
export async function getTransportStatus() {
  await getTransport(); // resolves config as a side effect (no-op rebuild if unchanged) and ensures verify has been attempted at least once
  const config = lastResolvedConfig!;
  const fromCheck = classifyFromAddress(config.from, config.user);
  return {
    configured: Boolean(config.host),
    configSource: config.source,
    host: config.host || null,
    port: config.host ? config.port : null,
    secure: config.host ? config.secure : null,
    user: config.user || null,
    from: config.from,
    fromAddress: fromCheck.fromAddress,
    fromDomain: fromCheck.fromDomain,
    userDomain: fromCheck.userDomain,
    fromIssues: fromCheck.issues,
    verified: transportVerified,
    verifyError: transportVerifyError
  };
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  template: string;
  metadata?: Record<string, unknown>;
  /**
   * When true, do NOT BCC the super-admin list. Used by the test / smoke-test
   * paths so debug sends don't spam every super admin's inbox. Real
   * transactional sends (welcome, approval, SLA) keep the BCC behaviour the
   * workspace settings configured.
   */
  skipBcc?: boolean;
  /**
   * Real Cc recipients — visible to every recipient, unlike `bcc` above (which is always
   * the hidden super-admin audit copy). Added for the ticket-closed-digest email (cc's the
   * closing ticket's own tenant admins) — see services/security-report.service.ts. Every
   * caller-supplied address here must already be filtered to the current tenant by the
   * caller; this function does not re-check tenant scope, it only forwards the list.
   */
  cc?: string[];
  /**
   * The `GlobalNotificationSettings` boolean column this send belongs to (e.g.
   * `"emailDailyReminder"`), supplied by `notify.service.ts#dispatchNotification`. Used for one
   * thing: honouring the SUPER_ADMIN row of the per-role mute matrix on the *audit BCC*, so
   * that muting a category for super admins actually empties their inbox instead of leaving the
   * hidden copy arriving anyway.
   *
   * Passed in rather than looked up here because the category -> column map lives in
   * notify.service.ts, which already imports this module; importing it back would be a cycle.
   * Absent for `dispatchTransactional()` sends, which have no category and so BCC as before.
   */
  preferenceKey?: string;
}

export interface SendResult {
  ok: boolean;
  status: "SENT" | "FAILED" | "SKIPPED";
  errorMessage?: string;
  emailLogId?: string;
  messageId?: string;
}

async function getBccList(to: string, preferenceKey?: string): Promise<string[]> {
  try {
    const settings = await prisma.globalNotificationSettings.findUnique({ where: { id: "global" } });
    if (!settings?.bccSuperAdminOnAllEmails) return [];
    // A super admin who muted this category in the Email channels matrix has said "not in my
    // inbox". The blanket audit BCC would otherwise re-deliver exactly what they just muted,
    // which is the single loudest source of super-admin inbox noise (every reminder for every
    // employee, every day).
    if (
      preferenceKey &&
      isEmailRoleMuted(
        settings.emailRoleMutes as EmailRoleMutes | null,
        preferenceKey as keyof NotificationPreferences,
        "SUPER_ADMIN"
      )
    ) {
      return [];
    }
    const admins = await prisma.user.findMany({
      where: { status: "ACTIVE", deletedAt: null, role: { name: "SUPER_ADMIN" } },
      select: { email: true }
    });
    return admins.map((a) => a.email).filter((email) => email.toLowerCase() !== to.toLowerCase());
  } catch {
    return [];
  }
}

export async function sendMail(
  toOrArgs: string | SendArgs,
  subject?: string,
  html?: string,
  template?: string
): Promise<SendResult> {
  const args: SendArgs =
    typeof toOrArgs === "string"
      ? { to: toOrArgs, subject: subject ?? "", html: html ?? "", template: template ?? "ad-hoc" }
      : toOrArgs;

  if (!args.to) return { ok: false, status: "SKIPPED", errorMessage: "Recipient is empty" };

  const bcc = args.skipBcc ? [] : await getBccList(args.to, args.preferenceKey);

  // `to` may itself be a comma-separated list of multiple primary recipients (the ticket-closed
  // digest puts both the closer and their manager there) — split it so cc-dedup checks every
  // primary address, not just the raw (possibly multi-address) string as one unit.
  const toAddresses = new Set(args.to.split(",").map((address) => address.trim().toLowerCase()).filter(Boolean));
  const cc = Array.from(new Set(args.cc?.map((address) => address.trim()).filter(Boolean) ?? [])).filter(
    (address) => !toAddresses.has(address.toLowerCase())
  );

  const log = await prisma.emailLog.create({
    data: {
      to: args.to,
      subject: args.subject,
      template: args.template,
      metadata: { ...(args.metadata ?? {}), bcc, cc } as any,
      status: "QUEUED"
    }
  });

  const transport = await getTransport();
  const from = lastResolvedConfig?.from ?? env.MAIL_FROM;

  if (!transport) {
    const errorMessage =
      "No SMTP host configured. The email was NOT delivered. Configure one from Workspace Settings → Mail server, or set SMTP_HOST/PORT/USER/PASS in apps/api/.env and restart.";
    console.warn(`[mail] (NOT DELIVERED) "${args.subject}" -> ${args.to}${cc.length ? ` (cc: ${cc.join(", ")})` : ""} — ${errorMessage}`);
    if (process.env.NODE_ENV !== "test") {
      console.info("---- email body (preview only, not sent) ----");
      console.info(args.html);
      console.info("---- end preview ----");
    }
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "FAILED", errorMessage }
    });
    return { ok: false, status: "FAILED", errorMessage, emailLogId: log.id };
  }

  try {
    const info = await transport.sendMail({
      from,
      to: args.to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject: args.subject,
      html: args.html
    });
    const messageId = info.messageId;
    console.info(
      `[mail] SENT "${args.subject}" -> ${args.to}${cc.length ? ` (cc: ${cc.join(", ")})` : ""} (messageId=${messageId}${
        info.response ? `, response=${info.response.toString().slice(0, 80)}` : ""
      })`
    );
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "SENT", metadata: { ...(args.metadata ?? {}), bcc, cc, messageId, response: info.response } as any }
    });
    return { ok: true, status: "SENT", emailLogId: log.id, messageId };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[mail] FAILED "${args.subject}" -> ${args.to}: ${message}`);
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "FAILED", errorMessage: message }
    });
    return { ok: false, status: "FAILED", errorMessage: message, emailLogId: log.id };
  }
}
