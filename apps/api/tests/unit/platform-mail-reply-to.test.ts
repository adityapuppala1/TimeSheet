/**
 * Per-message `replyTo` on platform email — the gap that made the sales notification worth sending.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM sales-lead.test.ts. That suite mocks the mail service, so it
 * can only prove that `createSalesLead` HANDS a reply-to address to `sendPlatformTemplate`. If the
 * service then dropped it on the floor, every one of those tests would still pass and every real
 * lead notification would still reply to ourselves. The claim only means something at the transport
 * boundary, so this drives the real service with nodemailer mocked and reads what was actually
 * handed to `sendMail`.
 *
 * TWO PROPERTIES, and the second is the one easy to regress: a per-message value WINS, and its
 * absence still falls back to the deployment-wide `replyTo` exactly as it did before 4.0.0. A
 * change that made every platform email reply to its recipient would pass a test for the first
 * property alone.
 *
 * AND THE RESEND, which is the same claim one day later. The console's Resend button rebuilds the
 * message from the `PlatformEmailLog` row, so a reply address that was never written to that row is
 * a reply address the resend cannot have — and the failure is silent, visible only to whoever
 * receives an answer meant for somebody else. The round-trip below sends for real, feeds the log
 * row it wrote back to the resend, and reads the transport a second time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const close = vi.fn();
const findMailSettings = vi.fn();
const findTemplateOverride = vi.fn();
const createEmailLog = vi.fn();
const findEmailLog = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => sendMail(...a), close: () => close() }) }
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformMailSettings: { findUnique: (...a: unknown[]) => findMailSettings(...a) },
    platformEmailTemplate: { findUnique: (...a: unknown[]) => findTemplateOverride(...a) },
    platformEmailLog: { create: (...a: unknown[]) => createEmailLog(...a), findUnique: (...a: unknown[]) => findEmailLog(...a) }
  }
}));

const { sendPlatformMail, sendPlatformTemplate, resendPlatformEmail } = await import("../../src/services/platform-mail.service.js");

/** A configured relay with a deployment-wide reply-to, which is the case that can go wrong. */
const RELAY = { id: "global", host: "smtp.example.test", port: 587, secure: false, user: "u", encryptedPassword: null, fromAddress: "TimeSphere <no-reply@example.test>", replyTo: "ops@example.test", salesInboxAddress: null };

const raw = (extra: Record<string, unknown> = {}) => ({ to: "somebody@example.test", subject: "Subject", html: "<p>Body</p>", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  findMailSettings.mockResolvedValue(RELAY);
  findTemplateOverride.mockResolvedValue(null);
  createEmailLog.mockResolvedValue({ id: "log-1" });
  sendMail.mockResolvedValue({});
});

describe("replyTo on a platform message", () => {
  it("uses the deployment-wide address when the message names none — the behaviour before 4.0.0", async () => {
    await sendPlatformMail(raw());
    expect(sendMail.mock.calls[0][0].replyTo).toBe("ops@example.test");
  });

  it("lets a per-message address win", async () => {
    await sendPlatformMail(raw({ replyTo: "prospect@northwind.example" }));
    expect(sendMail.mock.calls[0][0].replyTo).toBe("prospect@northwind.example");
  });

  it("is undefined, not empty, when neither is set", async () => {
    // nodemailer treats an empty string as a header worth writing; `undefined` omits it.
    findMailSettings.mockResolvedValue({ ...RELAY, replyTo: null });
    await sendPlatformMail(raw());
    expect(sendMail.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("threads through the template path, which is the one the sales notification takes", async () => {
    await sendPlatformTemplate("sales.lead", {
      to: "sales@example.test",
      replyTo: "prospect@northwind.example",
      vars: { company: "Northwind", name: "Priya", email: "prospect@northwind.example" }
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "sales@example.test", replyTo: "prospect@northwind.example" });
  });
});

/**
 * The row `logPlatformEmail` just wrote, shaped as `findUnique` would hand it back. Built from the
 * REAL create call rather than hand-written, so a send that stopped recording the reply address
 * cannot be papered over by a fixture that still names one.
 */
const loggedRow = () => ({ id: "log-1", ...(createEmailLog.mock.calls[0][0] as { data: Record<string, unknown> }).data });

describe("resending a logged message", () => {
  it("replies to the same address the original did", async () => {
    await sendPlatformMail(raw({ to: "sales@example.test", replyTo: "prospect@northwind.example", templateKey: "sales.lead" }));
    findEmailLog.mockResolvedValue(loggedRow());
    sendMail.mockClear();

    await resendPlatformEmail("log-1", "operator@example.test");

    // Not "ops@example.test". A resent lead notification that answers ourselves is the original bug
    // one day later, and nobody would see it until the prospect's reply failed to arrive.
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "sales@example.test", replyTo: "prospect@northwind.example" });
  });

  it("resends an ordinary message on the deployment-wide address, having stored none of its own", async () => {
    await sendPlatformMail(raw());
    expect((createEmailLog.mock.calls[0][0] as { data: { payload: Record<string, unknown> } }).data.payload).toEqual({ html: "<p>Body</p>" });

    findEmailLog.mockResolvedValue(loggedRow());
    sendMail.mockClear();
    await resendPlatformEmail("log-1", "operator@example.test");

    expect(sendMail.mock.calls[0][0].replyTo).toBe("ops@example.test");
  });

  it("still resends a row written before the reply address was kept", async () => {
    // Every existing row in every deployment has this shape. The resend must read it as "no
    // per-message address", not as a payload it no longer understands.
    findEmailLog.mockResolvedValue({
      id: "log-legacy",
      to: "somebody@example.test",
      subject: "Subject",
      templateKey: "platform.raw",
      organizationId: null,
      dayMarker: null,
      isTest: false,
      payload: { html: "<p>Body</p>" }
    });

    const result = await resendPlatformEmail("log-legacy", "operator@example.test");

    expect(result.ok).toBe(true);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ html: "<p>Body</p>", replyTo: "ops@example.test" });
  });
});
