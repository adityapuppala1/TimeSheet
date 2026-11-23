/**
 * V17 A4 — the punch-in reminder rides the EXISTING email pipeline: its own category toggle
 * (emailPunchInReminder), the per-role mute matrix, and sendMail (which writes the EmailLog row the
 * email analytics read, keyed by the category — spelled the same as the template, so the analytics
 * card maps it by identity). Real dispatchNotification; only the SMTP send and renderer are faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationPreferenceKeys } from "@timesheet/shared";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/mail.service.js", () => ({ sendMail: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/template-store.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/template-store.service.js")>("../../src/services/template-store.service.js");
  return { ...actual, renderEmailTemplate: vi.fn().mockResolvedValue({ subject: "Subject", html: "<p>Body</p>" }) };
});

const { sendMail } = await import("../../src/services/mail.service.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");
const { resolveLogTemplate } = await import("../../src/services/email-analytics.service.js");
const { TEMPLATE_KEYS } = await import("../../src/services/template-store.service.js");
const { SEED_TEMPLATES } = await import("../../prisma/email-templates-seed.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ARGS = {
  userId: "asha",
  category: "reminder.punch_in" as const,
  title: "You haven't punched in yet",
  body: "No punch-in recorded",
  link: "/app",
  email: { templateKey: "reminder.punch_in", vars: { name: "Asha", date: "2026-11-18" }, fallback: { subject: "s", html: "h" } }
};

function setup(settings: Record<string, unknown>) {
  const client = createFakeTenantClient();
  vi.mocked(client.user.findUnique).mockResolvedValue({
    id: "asha",
    email: "asha@acme.test",
    status: "ACTIVE",
    deletedAt: null,
    role: { name: "EMPLOYEE" },
    userRoles: []
  } as never);
  vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue({ id: "global", emailRoleMutes: null, ...settings } as never);
  return client;
}

beforeEach(() => vi.clearAllMocks());

describe("the punch-in reminder's email gates", () => {
  it("sends through sendMail under its own category when the toggle is on", async () => {
    const client = setup({ emailPunchInReminder: true });
    await runInTenant(client, () => dispatchNotification(ARGS));
    await flush();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0][0]).toMatchObject({
      to: "asha@acme.test",
      template: "reminder.punch_in",
      preferenceKey: "emailPunchInReminder"
    });
  });

  it("the category toggle off stops the email, never the bell", async () => {
    const client = setup({ emailPunchInReminder: false });
    await runInTenant(client, () => dispatchNotification(ARGS));
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
    expect(client.notification.create).toHaveBeenCalledTimes(1);
  });

  it("honours the role mute matrix", async () => {
    const client = setup({ emailPunchInReminder: true, emailRoleMutes: { emailPunchInReminder: ["EMPLOYEE"] } });
    await runInTenant(client, () => dispatchNotification(ARGS));
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("the punch-in template is registered everywhere an admin looks", () => {
  it("is a settings key the Email channels screen renders", () => {
    expect(notificationPreferenceKeys).toContain("emailPunchInReminder");
  });
  it("is listed in the Email Templates editor and seeded for fresh installs", () => {
    expect(TEMPLATE_KEYS).toContain("reminder.punch_in");
    expect(SEED_TEMPLATES["reminder.punch_in"].bodyHtml).toContain("{{appUrl}}/app");
  });
  it("maps its EmailLog rows to its own analytics card", () => {
    expect(resolveLogTemplate("reminder.punch_in")).toEqual({ cards: ["reminder.punch_in"], isTest: false });
  });
});
