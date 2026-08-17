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
import { Prisma } from "@prisma/client";
import { isEmailRoleMuted, type EmailRoleMutes, type NotificationPreferences } from "@timesheet/shared";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { decryptSecret } from "../utils/encryption.js";
import { AGENT_MAIL_DOMAIN } from "./agent-identity.js";

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
  /** Simultaneous SMTP connections, and messages per window across the pool. See the throttle
   *  block on GlobalMailSettings for where the defaults come from. */
  maxConnections: number;
  maxMessagesPerWindow: number;
  rateWindowMs: number;
}

/** Floors and ceilings on the admin-supplied throttle. A `maxConnections: 0` would wedge the pool
 *  and a `maxConnections: 500` would earn the rate-limit rejection this whole mechanism exists to
 *  avoid — so the settings are clamped rather than trusted, and the API validates them too. */
const THROTTLE_BOUNDS = {
  maxConnections: { min: 1, max: 20, fallback: 3 },
  maxMessagesPerWindow: { min: 1, max: 5000, fallback: 25 },
  rateWindowMs: { min: 1000, max: 3_600_000, fallback: 60_000 }
} as const;

function clampThrottle(value: unknown, bound: { min: number; max: number; fallback: number }): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return bound.fallback;
  return Math.min(bound.max, Math.max(bound.min, Math.round(numeric)));
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
      source: "database",
      maxConnections: clampThrottle(settings.maxConnections, THROTTLE_BOUNDS.maxConnections),
      maxMessagesPerWindow: clampThrottle(settings.maxMessagesPerWindow, THROTTLE_BOUNDS.maxMessagesPerWindow),
      rateWindowMs: clampThrottle(settings.rateWindowMs, THROTTLE_BOUNDS.rateWindowMs)
    };
  }
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
    source: "env",
    // An env-only deployment has no settings row to read, so it gets the same conservative
    // defaults the column defaults use — never "unlimited".
    maxConnections: THROTTLE_BOUNDS.maxConnections.fallback,
    maxMessagesPerWindow: THROTTLE_BOUNDS.maxMessagesPerWindow.fallback,
    rateWindowMs: THROTTLE_BOUNDS.rateWindowMs.fallback
  };
}

/**
 * SMTP config is a TENANT setting (`GlobalMailSettings` lives in each org's own database), but
 * one Node process serves every org — so the transport cache has to be keyed by orgId. It used
 * to be five single-slot module variables, which leaked across tenants two ways:
 *   - `lastResolvedConfig` was written inside `getTransport()` and read back by callers AFTER
 *     awaiting it. `resolveMailConfig()` is a database round-trip, so another org's request
 *     routinely resolved in that window and overwrote the slot — org A's mail went out stamped
 *     with org B's From address, and A's admin "Mail server" banner rendered B's host/port/user.
 *   - `transportVerified`/`transportVerifyError` were only ever written by the most recent
 *     transport build anywhere in the process, so A's banner showed B's SMTP error string
 *     (which names B's host, and often B's SMTP username) with no race required at all.
 * Nothing is read from module scope after an await anymore: `getTransport()` hands the caller
 * the whole entry, and the async `verify()` mutates that same org's entry rather than a global.
 */
interface MailTransportEntry {
  configKey: string;
  transporter: Transporter | null;
  config: ResolvedMailConfig;
  /** null until the async verify() settles. Mutated in place by the .then/.catch below. */
  verified: boolean | null;
  verifyError: string | null;
}

const transportsByOrg = new Map<string, MailTransportEntry>();
/** Each entry can hold a live nodemailer connection pool, so the cache is bounded the same way
 *  config/prisma.ts bounds its tenant client cache — evict the oldest rather than grow forever. */
const MAX_CACHED_TRANSPORTS = 50;

function configKey(config: ResolvedMailConfig): string {
  return JSON.stringify({ host: config.host, port: config.port, secure: config.secure, user: config.user, pass: config.pass, from: config.from });
}

/** Call after saving GlobalMailSettings so the next send picks up the new config immediately —
 *  without this, the cached transporter (built from the old config) would keep being reused
 *  until the API process restarts. Scoped to the calling tenant: one org saving its mail
 *  settings must not tear down every other org's connection pool. */
export function invalidateMailTransportCache(): void {
  const { orgId } = requireTenantContext();
  transportsByOrg.get(orgId)?.transporter?.close?.();
  transportsByOrg.delete(orgId);
}

async function getTransport(): Promise<MailTransportEntry> {
  const { orgId } = requireTenantContext();
  const config = await resolveMailConfig();
  const key = configKey(config);

  const cached = transportsByOrg.get(orgId);
  if (cached && cached.configKey === key) return cached;
  cached?.transporter?.close?.();

  const entry: MailTransportEntry = { configKey: key, transporter: null, config, verified: null, verifyError: null };
  transportsByOrg.set(orgId, entry);
  if (transportsByOrg.size > MAX_CACHED_TRANSPORTS) {
    const oldest = transportsByOrg.keys().next().value as string | undefined;
    if (oldest && oldest !== orgId) {
      transportsByOrg.get(oldest)?.transporter?.close?.();
      transportsByOrg.delete(oldest);
    }
  }

  if (!config.host) {
    console.warn(
      "[mail] No SMTP host configured — emails will NOT be delivered. Set it from Workspace Settings → Mail server, or SMTP_HOST/PORT/USER/PASS in apps/api/.env."
    );
    return entry;
  }

  /**
   * POOLED AND RATE-LIMITED, which it was not.
   *
   * Every `sendMail` used to build its own connection and fire immediately, and
   * `dispatchNotification` deliberately detaches the send — so a bulk approval of twenty
   * timesheets, or the daily reminder sweep across a fifty-person workspace, opened that many
   * simultaneous SMTP connections in the same tick. Office 365 allows three; Gmail's SMTP relay
   * throttles well before twenty. The "frequent rate limits" were self-inflicted from here.
   *
   * `pool` reuses connections instead of opening one per message; `maxConnections` bounds how
   * many exist at once; `rateDelta`/`rateLimit` are nodemailer's own token bucket — at most
   * `rateLimit` messages per `rateDelta` milliseconds, queued internally rather than rejected.
   * Together they mean a burst is PACED instead of refused, and the durable queue below only has
   * to handle what survives that.
   */
  entry.transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    pool: true,
    maxConnections: config.maxConnections,
    rateDelta: config.rateWindowMs,
    rateLimit: config.maxMessagesPerWindow,
    // Providers cap messages per connection and drop the socket past it, which surfaces as a
    // mid-burst failure that looks like a rate limit. Recycling the connection first is cheaper
    // than the retry it would otherwise cost.
    maxMessages: 100
  });

  entry.transporter
    .verify()
    .then(() => {
      entry.verified = true;
      console.info(`[mail] SMTP transport ready (${config.host}:${config.port}, secure=${config.secure}, source=${config.source}).`);
    })
    .catch((error) => {
      entry.verified = false;
      entry.verifyError = (error as Error).message;
      console.warn(`[mail] SMTP verification failed (${config.host}:${config.port}): ${entry.verifyError}`);
    });

  return entry;
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
  // Everything below reads THIS org's entry, handed back by getTransport — never a module-level
  // slot, which another tenant's concurrent resolve would have overwritten by now.
  const entry = await getTransport();
  const config = entry.config;
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
    verified: entry.verified,
    verifyError: entry.verifyError
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
   * "This message body contains a credential — never persist it."
   *
   * WHY IT EXISTS: the retry queue keeps the RENDERED body on the `EmailLog` row so a deferred
   * send has something to send. For almost every email that is a rendered notification and
   * harmless. For a password-reset link it is the live token — bcrypt-hashed in
   * `PasswordResetToken` precisely so that database access does not yield a usable one — and for
   * an admin-generated password it is the password itself. Storing either, even for the seconds
   * between the attempt and the SENT write, would hand back exactly what the hashing was
   * protecting.
   *
   * A message marked sensitive is therefore never persisted and never retried: there is nothing
   * to retry it WITH, and a reset token that expires in thirty minutes is worthless by the time
   * the queue would get to it anyway. The recipient's remedy is to ask for another link, which is
   * one click and always works.
   *
   * Belt and braces: `looksSensitive()` below re-checks the rendered HTML for token-shaped
   * content regardless of this flag, so a future template that carries a secret and forgets to
   * set it is still not stored.
   */
  sensitive?: boolean;
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
  /** `QUEUED` means the send did not succeed but WILL be retried — see `classifyFailure`. It is a
   *  distinct outcome from FAILED on purpose: a caller that reports "could not send" for a
   *  message the queue is about to deliver is lying to the user. */
  status: "SENT" | "FAILED" | "SKIPPED" | "QUEUED";
  errorMessage?: string;
  emailLogId?: string;
  messageId?: string;
  /** Set when the row is parked for another attempt. */
  nextAttemptAt?: Date;
}

/* ============================== Retry policy ============================== */

/**
 * How many times a message is tried before the queue gives up on it. Five attempts on the
 * schedule below spans a little over half an hour, which covers the shapes that actually happen:
 * a provider's per-minute cap, a brief relay outage, a DNS blip.
 */
export const MAX_SEND_ATTEMPTS = 5;

/** 1m, 5m, 15m, 30m between attempts, each with up to 20% jitter so a burst that was rejected
 *  together does not come back in lockstep and get rejected together again. */
const BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000];

export function nextSendAttemptAt(attempt: number, now = Date.now()): Date {
  const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
  return new Date(now + base + Math.floor(base * 0.2 * Math.random()));
}

/**
 * Is this failure worth trying again?
 *
 * The distinction that matters: a 4xx/5xx SMTP code beginning 4 is by definition TEMPORARY ("try
 * again later" — which is exactly what a rate limit is), while a 5xx is permanent ("this mailbox
 * does not exist"). Retrying a permanent failure forever is how a queue turns one bad address
 * into a reputation problem with the provider.
 *
 * Network-level errors are retryable too: a dropped socket or a timeout says nothing about
 * whether the message was acceptable.
 */
export function classifyFailure(error: unknown): { retryable: boolean; reason: string } {
  const err = error as { responseCode?: number; code?: string; message?: string };
  const message = err?.message ?? String(error);

  // nodemailer surfaces the SMTP reply code verbatim. 4xx = transient by RFC 5321.
  if (typeof err?.responseCode === "number") {
    if (err.responseCode >= 400 && err.responseCode < 500) return { retryable: true, reason: message };
    // 550 is the usual "mailbox unavailable", but several providers answer 550 for "sending
    // quota exceeded" too, so the text decides when the code alone is ambiguous.
    if (/rate|quota|too many|throttl|try again|slow down|busy|temporar/i.test(message)) {
      return { retryable: true, reason: message };
    }
    return { retryable: false, reason: message };
  }

  const transientCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ESOCKET", "ECONNECTION"];
  if (err?.code && transientCodes.includes(err.code)) return { retryable: true, reason: message };
  if (/rate limit|too many|throttl|try again later|quota/i.test(message)) return { retryable: true, reason: message };

  // Unrecognised. Treated as retryable — the queue caps attempts anyway, so the cost of being
  // wrong here is four extra tries; the cost of the opposite is a silently dropped email.
  return { retryable: true, reason: message };
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

/**
 * Attempts ONE delivery of an EmailLog row and records the outcome.
 *
 * Shared verbatim by the first attempt (`sendMail`, below) and every retry
 * (`workers/mail-queue.worker.ts`), because two copies of "what happens when the SMTP server says
 * no" is how a queue ends up retrying permanent failures and giving up on transient ones.
 *
 * On success the row goes SENT and its `payload` is cleared — the rendered HTML exists only while
 * the message is still deliverable, so this table stays an audit trail rather than becoming a copy
 * of every email the workspace ever sent.
 */
export async function attemptEmailDelivery(row: {
  id: string;
  to: string;
  subject: string;
  attempts: number;
  metadata: unknown;
  payload: unknown;
  /** False for a message whose body is deliberately not persisted (see `SendArgs.sensitive`).
   *  A failure is then terminal, because there is nothing on the row to try again with. */
  retryable?: boolean;
}): Promise<SendResult> {
  const meta = (row.metadata ?? {}) as { bcc?: string[]; cc?: string[] };
  const body = (row.payload ?? {}) as { html?: string };
  const attempt = row.attempts + 1;
  const now = new Date();

  const { transporter: transport, config } = await getTransport();
  const from = config.from || env.MAIL_FROM;

  if (!transport) {
    const errorMessage =
      "No SMTP host configured. The email was NOT delivered. Configure one from Workspace Settings → Mail server, or set SMTP_HOST/PORT/USER/PASS in apps/api/.env and restart.";
    console.warn(`[mail] (NOT DELIVERED) "${row.subject}" -> ${row.to} — ${errorMessage}`);
    if (process.env.NODE_ENV !== "test") {
      console.info("---- email body (preview only, not sent) ----");
      console.info(body.html ?? "");
      console.info("---- end preview ----");
    }
    // Terminal, and deliberately NOT retried: an unconfigured transport does not become
    // configured in five minutes, and parking every notification in the queue meanwhile would
    // dump the backlog on the admin the moment they saved a host.
    await prisma.emailLog.update({
      where: { id: row.id },
      // `Prisma.DbNull`, not `undefined` — `undefined` means "leave this column alone" to Prisma,
      // which would keep the rendered body on a row nobody will ever send.
      data: { status: "FAILED", errorMessage, attempts: attempt, lastAttemptAt: now, nextAttemptAt: null, payload: Prisma.DbNull }
    });
    return { ok: false, status: "FAILED", errorMessage, emailLogId: row.id };
  }

  try {
    const info = await transport.sendMail({
      from,
      to: row.to,
      cc: meta.cc?.length ? meta.cc : undefined,
      bcc: meta.bcc?.length ? meta.bcc : undefined,
      subject: row.subject,
      html: body.html ?? ""
    });
    const messageId = info.messageId;
    console.info(
      `[mail] SENT "${row.subject}" -> ${row.to}${meta.cc?.length ? ` (cc: ${meta.cc.join(", ")})` : ""}` +
        `${attempt > 1 ? ` on attempt ${attempt}` : ""} (messageId=${messageId}${
          info.response ? `, response=${info.response.toString().slice(0, 80)}` : ""
        })`
    );
    await prisma.emailLog.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        attempts: attempt,
        lastAttemptAt: now,
        nextAttemptAt: null,
        // Cleared: the message is delivered, so the rendered body has no further job to do.
        payload: Prisma.DbNull,
        errorMessage: null,
        metadata: { ...meta, messageId, response: info.response } as any
      }
    });
    return { ok: true, status: "SENT", emailLogId: row.id, messageId };
  } catch (error) {
    const classified = classifyFailure(error);
    const reason = classified.reason;
    // `row.retryable === false` wins over the classification: the failure may well be transient,
    // but this row cannot be re-driven, so parking it QUEUED would leave it visible in the queue
    // forever waiting for a body that was never stored.
    const retryable = classified.retryable && row.retryable !== false;
    const exhausted = attempt >= MAX_SEND_ATTEMPTS;

    if (!retryable || exhausted) {
      console.error(
        `[mail] GAVE UP on "${row.subject}" -> ${row.to} after ${attempt} attempt(s)` +
          `${retryable ? " (attempt limit reached)" : " (permanent failure)"}: ${reason}`
      );
      await prisma.emailLog.update({
        where: { id: row.id },
        data: { status: "FAILED", errorMessage: reason, attempts: attempt, lastAttemptAt: now, nextAttemptAt: null, payload: Prisma.DbNull }
      });
      return { ok: false, status: "FAILED", errorMessage: reason, emailLogId: row.id };
    }

    const nextAttemptAt = nextSendAttemptAt(attempt);
    console.warn(
      `[mail] deferred "${row.subject}" -> ${row.to} (attempt ${attempt}/${MAX_SEND_ATTEMPTS}, retrying ${nextAttemptAt.toISOString()}): ${reason}`
    );
    await prisma.emailLog.update({
      where: { id: row.id },
      data: { status: "QUEUED", errorMessage: reason, attempts: attempt, lastAttemptAt: now, nextAttemptAt }
    });
    return { ok: false, status: "QUEUED", errorMessage: reason, emailLogId: row.id, nextAttemptAt };
  }
}

/**
 * Every outbound email in the app enters here.
 *
 * Still attempts the send INLINE rather than only enqueueing it, so the common case — a
 * well-configured relay with headroom — keeps its existing latency and its existing `SendResult`,
 * and the "Send test email" button in settings still reports what actually happened. What changed
 * is the failure path: a transient rejection (a rate limit, a dropped socket) now parks the row
 * for `workers/mail-queue.worker.ts` to retry instead of marking it FAILED and losing the message.
 */
/**
 * The safety net for `SendArgs.sensitive`.
 *
 * Matches the two shapes that must never reach the `payload` column: a reset link (the token is
 * the whole capability) and a one-time password handed out in the body. Deliberately a check on
 * the RENDERED html rather than on the template key — an admin can edit any template from the
 * Email templates screen, so the key is not a reliable statement about what the body contains.
 *
 * False positives are cheap: the only cost is that this one message is not retried.
 */
export function looksSensitive(html: string): boolean {
  return /reset-password\?token=|[?&]token=[A-Za-z0-9_-]{16,}|one-time password|temporary password/i.test(html);
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

  /**
   * AGENT IDENTITIES HAVE NO MAILBOX (V8 phase 3).
   *
   * An `AgentProfile`'s identity is a real `User` row — that is what makes assignment, workload and
   * audit work unchanged — and it is therefore picked up by every "all active users" recipient
   * query in the codebase (the weekly digest, release announcements, deadline reminders). Without
   * this, each of those posts mail to a synthesised address and books a permanent bounce.
   *
   * Enforced HERE, at the choke point every outbound email already funnels through, rather than by
   * adding `isAgent: false` to a dozen recipient queries — the same argument the file header makes
   * for admin toggles and budget caps being enforceable only because every caller passes here.
   *
   * A string check rather than a lookup, deliberately: agent addresses live on `.invalid`, the
   * domain RFC 2606 reserves precisely so it can never resolve. That makes the address itself the
   * declaration, costs no query on the hot path, and is impossible to get wrong by forgetting to
   * join a table. `SKIPPED` (not an error) because nothing is wrong — there was simply nobody to
   * write to.
   */
  const primaries = args.to.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (primaries.length > 0 && primaries.every((address) => address.endsWith(AGENT_MAIL_DOMAIN))) {
    return { ok: false, status: "SKIPPED", errorMessage: "Recipient is an automation identity with no mailbox" };
  }

  const bcc = args.skipBcc ? [] : await getBccList(args.to, args.preferenceKey);

  // `to` may itself be a comma-separated list of multiple primary recipients (the ticket-closed
  // digest puts both the closer and their manager there) — split it so cc-dedup checks every
  // primary address, not just the raw (possibly multi-address) string as one unit.
  const toAddresses = new Set(args.to.split(",").map((address) => address.trim().toLowerCase()).filter(Boolean));
  const cc = Array.from(new Set(args.cc?.map((address) => address.trim()).filter(Boolean) ?? [])).filter(
    (address) => !toAddresses.has(address.toLowerCase())
  );

  // Written BEFORE the attempt, as it always was — a process that dies mid-send leaves a QUEUED
  // row the worker picks up, rather than an email nobody can account for.
  // A credential-bearing body is never written to the row — see SendArgs.sensitive. The row
  // itself still exists (who, what, when, and the outcome), it simply has nothing to retry with,
  // which is what `attemptEmailDelivery` reads as "terminal".
  const sensitive = args.sensitive === true || looksSensitive(args.html);

  const log = await prisma.emailLog.create({
    data: {
      to: args.to,
      subject: args.subject,
      template: args.template,
      metadata: { ...(args.metadata ?? {}), bcc, cc, ...(sensitive ? { sensitive: true } : {}) } as any,
      status: "QUEUED",
      payload: sensitive ? undefined : ({ html: args.html } as any)
    }
  });

  // The body is still passed to THIS attempt in memory — only the persisted copy is withheld.
  return attemptEmailDelivery({
    id: log.id,
    to: log.to,
    subject: log.subject,
    attempts: 0,
    metadata: log.metadata,
    payload: { html: args.html },
    retryable: !sensitive
  });
}
