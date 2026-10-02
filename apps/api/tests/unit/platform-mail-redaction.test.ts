/**
 * G13 — one-time credentials sat readable in the platform email log.
 *
 * `PlatformEmailLog.payload` keeps the rendered body so a failed message can be resent "exactly as it
 * was". For a signup verification code, and for a retention email's reactivation and feedback links,
 * "the body" IS a live credential — and `GET /email-log/:id` hands it to every console role,
 * READ_ONLY included. A code read off the log completes somebody else's signup; a reactivation link
 * read off it restores a lapsed customer's workspace.
 *
 * Now each template declares which of its variables are credentials (`sensitiveVars`), and their
 * values are replaced with a marker in the STORED copy at write time. The message that is SENT is
 * untouched. What an operator still has to diagnose delivery: recipient, subject, status, the relay's
 * error, the template, the marker, timestamps, and the body with only the credential blanked out.
 * Such a row cannot be resent as it was — it says so, and says what to do instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createEmailLog = vi.fn();
const findEmailLog = vi.fn();

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: (...a: unknown[]) => sendMail(...a), close: vi.fn() }) } }));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformMailSettings: { findUnique: vi.fn(async () => ({ host: "smtp.test", port: 587, secure: false, user: null, encryptedPassword: null, fromAddress: "p@t.test", replyTo: null })) },
    platformEmailTemplate: { findUnique: vi.fn(async () => null) },
    platformEmailLog: { create: (...a: unknown[]) => createEmailLog(...a), findUnique: (...a: unknown[]) => findEmailLog(...a) }
  }
}));

const { sendPlatformTemplate, resendPlatformEmail } = await import("../../src/services/platform-mail.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({});
  createEmailLog.mockResolvedValue({ id: "log-1" });
});

const stored = () => (createEmailLog.mock.calls.at(-1)?.[0] as { data: { payload: { html: string; redacted?: string[] }; subject: string } }).data;
const sent = () => sendMail.mock.calls.at(-1)?.[0] as { html: string };

describe("credentials are blanked in the stored copy, not in the sent one", () => {
  it("a signup verification code", async () => {
    await sendPlatformTemplate("signup.verify", { to: "new@acme.test", vars: { code: "418902" } });
    expect(sent().html).toContain("418902");
    expect(stored().payload.html).not.toContain("418902");
    expect(stored().payload.html).toContain("[redacted]");
    expect(stored().payload.redacted).toEqual(["code"]);
  });

  it("a retention email's reactivation and feedback links", async () => {
    await sendPlatformTemplate("retention.day30", {
      to: "owner@acme.test",
      vars: {
        name: "Priya",
        workspace: "Acme",
        reactivateUrl: "https://timesphere.test/reactivate/REACTIVATE-TOKEN-123",
        feedbackUrl: "https://timesphere.test/feedback/FEEDBACK-TOKEN-456",
        retentionDays: "90",
        deleteDate: "1 Jan 2027"
      }
    });
    expect(sent().html).toContain("REACTIVATE-TOKEN-123");
    const html = stored().payload.html;
    expect(html).not.toContain("REACTIVATE-TOKEN-123");
    expect(html).not.toContain("FEEDBACK-TOKEN-456");
    // Everything that is not a credential is still there to read.
    expect(html).toContain("Acme");
  });

  it("leaves an ordinary message's stored body exactly as sent", async () => {
    await sendPlatformTemplate("platform.smtp_test", { to: "ops@t.test", vars: { sentAt: "now", host: "smtp.test" } });
    expect(stored().payload.html).toBe(sent().html);
    expect(stored().payload.redacted).toBeUndefined();
  });
});

describe("a redacted row cannot be resent as it was", () => {
  it("says so, rather than sending a message whose link is gone", async () => {
    findEmailLog.mockResolvedValue({ id: "log-1", to: "new@acme.test", subject: "s", templateKey: "signup.verify", organizationId: null, dayMarker: null, isTest: false, payload: { html: "<p>[redacted]</p>", redacted: ["code"] } });
    await expect(resendPlatformEmail("log-1", "ops@t.test")).rejects.toMatchObject({ statusCode: 409 });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
