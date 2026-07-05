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
import { getGlobalEmailIntakeSettings, processInboundEmail, type ParsedInboundEmail } from "../services/email-intake.service.js";
import { decryptSecret } from "../utils/encryption.js";
import { runForEveryOrg } from "./run-for-every-org.js";

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
      await runForEveryOrg("email-intake", pollOnce);
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

type ParsedMailAddress = Awaited<ReturnType<typeof simpleParser>>["to"];

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
  let pollError: string | null = null;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        try {
          const message = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!message || !message.source) continue;

          const parsed = await simpleParser(message.source);
          const email: ParsedInboundEmail = {
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
            }))
          };

          const result = await processInboundEmail(email);
          if (result.created) processedCount += 1;
        } catch (error) {
          console.error(`[email-intake] failed to process message uid=${uid}:`, (error as Error).message);
        } finally {
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        }
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

  if (processedCount > 0) {
    console.info(`[email-intake] poll complete: ${processedCount} ticket(s) created.`);
  }
}
