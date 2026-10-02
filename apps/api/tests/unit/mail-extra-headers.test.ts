/**
 * A send can carry extra headers and a fixed Message-ID — on its first attempt AND on a retry.
 *
 * Email intake's confirmation needs both: `Auto-Submitted: auto-replied` so another mailbox's
 * autoresponder does not answer it (the loop RFC 3834 exists to prevent), and a Message-ID naming
 * the ticket so the customer's reply threads onto it. A retried send is rebuilt from the EmailLog
 * row alone, so a header that lived only in the first call's arguments would silently vanish on the
 * attempt that finally got through — the test covers that path explicitly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const hoisted = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      verify: () => Promise.resolve(true),
      sendMail: (msg: Record<string, unknown>) => {
        hoisted.sent.push(msg);
        return Promise.resolve({ messageId: String(msg.messageId ?? "<generated@x>"), response: "250 OK" });
      },
      close: () => undefined
    })
  }
}));

const { sendMail, attemptEmailDelivery } = await import("../../src/services/mail.service.js");

let client: PrismaClient;

beforeEach(() => {
  hoisted.sent.length = 0;
  client = {
    globalMailSettings: { findUnique: vi.fn().mockResolvedValue({ id: "global", host: "smtp.acme.test", port: 587, secure: false, user: "u", password: null, fromAddress: "support@acme.test" }) },
    globalNotificationSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "log-1", ...data })),
      update: vi.fn().mockResolvedValue({})
    },
    user: { findMany: vi.fn().mockResolvedValue([]) }
  } as unknown as PrismaClient;
});

const HEADERS = { "Auto-Submitted": "auto-replied", "Reply-To": "support@acme.test" };
const MESSAGE_ID = "<ticket-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.confirmation@acme.test>";

describe("extra headers and a fixed Message-ID", () => {
  it("go out on the first attempt", async () => {
    await runInTenant(client, () =>
      sendMail({ to: "casey@example.com", subject: "[WEB-12] We received your report", html: "<p>hi</p>", template: "t", skipBcc: true, headers: HEADERS, messageId: MESSAGE_ID }),
      `org-headers-${Date.now()}`
    );
    expect(hoisted.sent[0]).toMatchObject({ headers: HEADERS, messageId: MESSAGE_ID });
  });

  it("are kept on the log row, so a retry sends them too", async () => {
    await runInTenant(client, () =>
      sendMail({ to: "casey@example.com", subject: "x", html: "<p>hi</p>", template: "t", skipBcc: true, headers: HEADERS, messageId: MESSAGE_ID }),
      `org-headers-row-${Date.now()}`
    );
    const row = vi.mocked(client.emailLog.create).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
    hoisted.sent.length = 0;

    // The queue worker re-drives a row from what was persisted, nothing else.
    await runInTenant(client, () =>
      attemptEmailDelivery({ id: "log-1", to: "casey@example.com", subject: "x", attempts: 1, metadata: row.data.metadata, payload: { html: "<p>hi</p>" } }),
      `org-headers-retry-${Date.now()}`
    );
    expect(hoisted.sent[0]).toMatchObject({ headers: HEADERS, messageId: MESSAGE_ID });
  });

  it("are absent from an ordinary send", async () => {
    await runInTenant(client, () => sendMail({ to: "casey@example.com", subject: "x", html: "<p>hi</p>", template: "t", skipBcc: true }), `org-plain-${Date.now()}`);
    expect(hoisted.sent[0]).not.toHaveProperty("headers");
    expect(hoisted.sent[0]).not.toHaveProperty("messageId");
  });
});
