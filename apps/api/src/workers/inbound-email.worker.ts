/**
 * IMAP polling worker for the email-to-ticket pipeline.
 * WHAT: connects to the admin-configured mailbox, fetches unseen messages, hands each to
 * `email-intake.service.ts#processInboundEmail()`, then marks it `\Seen`.
 * WHY polling instead of a push webhook: this app runs locally/on-prem without a public
 * domain, so IMAP (same "app password" pattern already used for outbound SMTP) needs no
 * inbound network exposure. `processInboundEmail()` itself doesn't know or care how the
 * email arrived, so swapping in a webhook later is a worker-only change.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { getGlobalAISettings } from "../services/ai.service.js";
import {
  getGlobalEmailIntakeSettings,
  processInboundEmail,
  type InboundMailHeaders,
  type ParsedInboundEmail,
  type ProcessResult
} from "../services/email-intake.service.js";
import { decryptSecret } from "../utils/encryption.js";
import { runForEveryOrg } from "./run-for-every-org.js";
import { runOncePerTick } from "../services/job-claim.service.js";

let started = false;
let polling = false;

/**
 * Fixed one-minute cron tick that internally decides whether a poll is actually due,
 * based on the admin-configurable `pollIntervalMinutes` (DB-backed, no restart needed
 * to change the cadence — same philosophy as GlobalTicketSettings' SLA hours).
 */
export function startInboundEmailWorker() {
  if (started) return;
  started = true;

  cron.schedule("* * * * *", async () => {
    if (polling) return;
    polling = true;
    try {
      // Once per minute for the deployment, and never while another pod's poll is still running:
      // two pollers search the same unseen messages and each opens a ticket for every one of them
      // before either has flagged it as seen. The lease in runOncePerTick is what prevents that.
      await runOncePerTick("email-intake", "minute", () => runForEveryOrg("email-intake", pollOnce));
    } catch (error) {
      console.error("[email-intake] poll failed:", (error as Error).message);
    } finally {
      polling = false;
    }
  });

  console.info("[email-intake] worker scheduled (checks every minute; actual cadence follows the configured poll interval).");
}

function flattenAddresses(value: ParsedMailAddress): string[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((obj) => obj.value.map((v) => v.address).filter((a): a is string => Boolean(a)));
}

type ParsedMail = Awaited<ReturnType<typeof simpleParser>>;
type ParsedMailAddress = ParsedMail["to"];

/** A header's value as text: mailparser hands back plain strings for most headers and an address
 *  object (with a `text` rendering) for address-shaped ones such as Return-Path. */
function headerText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "");
  return undefined;
}

/**
 * The headers the intake pipeline's loop guard and reply threading read (email-intake.service.ts).
 * List-Id is parsed by mailparser into the `list` header's `id`; References may be one id or many.
 */
function inboundHeaders(parsed: ParsedMail): InboundMailHeaders {
  const list = parsed.headers.get("list") as { id?: { id?: string; name?: string } } | undefined;
  return {
    autoSubmitted: headerText(parsed.headers.get("auto-submitted")),
    precedence: headerText(parsed.headers.get("precedence")),
    listId: list?.id ? list.id.id || list.id.name || "list" : undefined,
    returnPath: headerText(parsed.headers.get("return-path")),
    inReplyTo: parsed.inReplyTo,
    references: asList(parsed.references)
  };
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** A parsed IMAP message as the transport-agnostic shape `processInboundEmail` takes. */
export function toParsedInboundEmail(parsed: ParsedMail): ParsedInboundEmail {
  return {
    from: {
      address: parsed.from?.value[0]?.address ?? "unknown@unknown",
      name: parsed.from?.value[0]?.name
    },
    to: flattenAddresses(parsed.to),
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    html: parsed.html,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType,
      content: a.content
    })),
    headers: inboundHeaders(parsed)
  };
}

/** One unseen message: fetched, parsed, handed to the pipeline — and flagged `\Seen` whatever
 *  happened, so a message that fails is not retried into a ticket on every poll. */
async function processMessage(client: ImapFlow, uid: number): Promise<ProcessResult | null> {
  try {
    const message = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!message || !message.source) return null;
    return await processInboundEmail(toParsedInboundEmail(await simpleParser(message.source)));
  } catch (error) {
    console.error(`[email-intake] failed to process message uid=${uid}:`, (error as Error).message);
    return null;
  } finally {
    await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
  }
}

async function pollOnce() {
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.aiEnabled || !aiSettings.emailIngestionEnabled) return;

  const settings = await getGlobalEmailIntakeSettings();
  if (!settings.imapHost || !settings.imapUser || !settings.imapPassword) return;

  const dueAt = settings.lastPolledAt
    ? new Date(settings.lastPolledAt.getTime() + settings.pollIntervalMinutes * 60_000)
    : new Date(0);
  if (new Date() < dueAt) return;

  let imapPassword: string;
  try {
    imapPassword = decryptSecret(settings.imapPassword);
  } catch {
    // Only reachable if a password was stored before encryption-at-rest was added —
    // re-saving it from the admin settings UI re-encrypts it correctly.
    await prisma.emailIntakeSettings.update({
      where: { id: "global" },
      data: { lastPolledAt: new Date(), lastPollError: "Stored IMAP password is unreadable — re-enter it in Workspace Settings." }
    });
    return;
  }

  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapSecure,
    auth: { user: settings.imapUser, pass: imapPassword },
    logger: false
  });

  let processedCount = 0;
  let droppedCount = 0;
  let pollError: string | null = null;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        const result = await processMessage(client, uid);
        if (result?.created) processedCount += 1;
        if (result?.reason === "AUTOMATED_SENDER") droppedCount += 1;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (error) {
    pollError = (error as Error).message;
    console.error("[email-intake] IMAP connection failed:", pollError);
  } finally {
    client.close();
  }

  await prisma.emailIntakeSettings.update({
    where: { id: "global" },
    data: { lastPolledAt: new Date(), lastPollError: pollError }
  });

  // Drops are each audited (and counted on the intake settings); the line here is for whoever is
  // reading the server log when a mailbox seems to go quiet.
  if (processedCount > 0 || droppedCount > 0) {
    console.info(`[email-intake] poll complete: ${processedCount} ticket(s) created, ${droppedCount} automated message(s) dropped.`);
  }
}
