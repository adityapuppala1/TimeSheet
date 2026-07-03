import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

export { templates } from "./mail-templates.js";

let transporter: Transporter | null = null;
let transportReady = false;
let transportVerified: boolean | null = null;
let transportVerifyError: string | null = null;

function getTransport(): Transporter | null {
  if (transportReady) return transporter;
  transportReady = true;

  if (!env.SMTP_HOST) {
    console.warn(
      "[mail] SMTP_HOST is empty — emails will NOT be delivered. Set SMTP_HOST/PORT/USER/PASS in apps/api/.env and restart."
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
  });

  transporter
    .verify()
    .then(() => {
      transportVerified = true;
      console.info(`[mail] SMTP transport ready (${env.SMTP_HOST}:${env.SMTP_PORT}, secure=${env.SMTP_SECURE}).`);
    })
    .catch((error) => {
      transportVerified = false;
      transportVerifyError = (error as Error).message;
      console.warn(`[mail] SMTP verification failed (${env.SMTP_HOST}:${env.SMTP_PORT}): ${transportVerifyError}`);
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
    issues.push("MAIL_FROM has no parseable address. Use 'Display Name <user@domain.com>' format.");
    return { fromAddress: null, fromDomain: null, userDomain: null, issues };
  }

  // Hard fail: reserved TLDs
  for (const tld of NON_DELIVERABLE_TLDS) {
    if (domain.endsWith(tld)) {
      issues.push(
        `MAIL_FROM domain "${domain}" uses ${tld} — a reserved TLD that real mail servers silently drop or send to spam. ` +
        "Change MAIL_FROM to use a domain you own and have verified with your SMTP provider."
      );
      break;
    }
  }

  // Mismatch: SMTP_USER and MAIL_FROM on different domains
  let userDomain: string | null = null;
  if (smtpUser && smtpUser.includes("@")) {
    userDomain = smtpUser.split("@").pop()!.toLowerCase();
    if (userDomain !== domain) {
      issues.push(
        `MAIL_FROM domain "${domain}" does not match SMTP_USER domain "${userDomain}". ` +
        "Many providers (Gmail, Office365, SendGrid, Mailgun, SES) reject or silently quarantine mismatched senders unless the From domain is explicitly verified. " +
        `Either change MAIL_FROM to use @${userDomain}, or add ${domain} as a verified sender with your SMTP provider.`
      );
    }
  }

  return { fromAddress: address, fromDomain: domain, userDomain, issues };
}

/** Public-facing snapshot of mail-transport state. Used by the admin UI banner. */
export function getTransportStatus() {
  const fromCheck = classifyFromAddress(env.MAIL_FROM, env.SMTP_USER);
  return {
    configured: Boolean(env.SMTP_HOST),
    host: env.SMTP_HOST || null,
    port: env.SMTP_HOST ? env.SMTP_PORT : null,
    secure: env.SMTP_HOST ? env.SMTP_SECURE : null,
    user: env.SMTP_USER || null,
    from: env.MAIL_FROM,
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
}

export interface SendResult {
  ok: boolean;
  status: "SENT" | "FAILED" | "SKIPPED";
  errorMessage?: string;
  emailLogId?: string;
  messageId?: string;
}

async function getBccList(to: string): Promise<string[]> {
  try {
    const settings = await prisma.globalNotificationSettings.findUnique({ where: { id: "global" } });
    if (!settings?.bccSuperAdminOnAllEmails) return [];
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

  const bcc = args.skipBcc ? [] : await getBccList(args.to);

  const log = await prisma.emailLog.create({
    data: {
      to: args.to,
      subject: args.subject,
      template: args.template,
      metadata: { ...(args.metadata ?? {}), bcc } as any,
      status: "QUEUED"
    }
  });

  const transport = getTransport();

  if (!transport) {
    const errorMessage =
      "SMTP_HOST is not configured. The email was NOT delivered. Add SMTP credentials to apps/api/.env and restart the API.";
    console.warn(`[mail] (NOT DELIVERED) "${args.subject}" -> ${args.to} — ${errorMessage}`);
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
      from: env.MAIL_FROM,
      to: args.to,
      bcc: bcc.length ? bcc : undefined,
      subject: args.subject,
      html: args.html
    });
    const messageId = info.messageId;
    console.info(
      `[mail] SENT "${args.subject}" -> ${args.to} (messageId=${messageId}${
        info.response ? `, response=${info.response.toString().slice(0, 80)}` : ""
      })`
    );
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "SENT", metadata: { ...(args.metadata ?? {}), bcc, messageId, response: info.response } as any }
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
