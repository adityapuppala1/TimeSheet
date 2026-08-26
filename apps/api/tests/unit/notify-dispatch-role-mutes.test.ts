/**
 * `dispatchNotification`'s per-role email-mute check (notify.service.ts:183-231) — previously
 * had zero test coverage. Pins two things: the pre-existing single-role behavior (must not
 * regress) and the multi-role fix itself — a recipient who holds more than one role (schema.prisma's
 * `UserRole`) should only have the email leg suppressed when EVERY held role is muted for that
 * category, not just their primary account role. This is the actual fix for the reported bug: a
 * SUPER_ADMIN who is also someone's real manager (via managerId, resolved elsewhere) was silently
 * losing manager-relationship email whenever an admin muted SUPER_ADMIN for that category.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/mail.service.js", () => ({ sendMail: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/template-store.service.js", () => ({
  renderEmailTemplate: vi.fn().mockResolvedValue({ subject: "Subject", html: "<p>Body</p>" })
}));

const { sendMail } = await import("../../src/services/mail.service.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");

const RECIPIENT_ID = "recipient-1";

function baseSettings(emailRoleMutes: Record<string, string[]> | null) {
  return {
    id: "global",
    emailDailyEscalation: true, // the category toggle itself is on — only per-role muting is under test
    emailRoleMutes
  };
}

function recipient(roleName: string, extraRoleNames: string[] = []) {
  return {
    id: RECIPIENT_ID,
    email: "recipient@example.com",
    status: "ACTIVE",
    deletedAt: null,
    role: { name: roleName },
    userRoles: extraRoleNames.map((name) => ({ role: { name } }))
  };
}

/** dispatchNotification's email leg is deliberately fire-and-forget — flush microtasks so the
 *  detached send has a chance to run before asserting on it. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

const EMAIL_ARGS = {
  userId: RECIPIENT_ID,
  category: "reminder.escalation" as const,
  title: "Escalation",
  body: "Someone missed a deadline",
  email: { templateKey: "escalation" as const, vars: {} }
};

describe("dispatchNotification — per-role email suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the email when the recipient's one role is not muted (baseline, single-role)", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.user.findUnique).mockResolvedValue(recipient("MANAGER") as never);
    vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue(baseSettings({ emailDailyEscalation: ["SUPER_ADMIN"] }) as never);

    await runInTenant(client, () => dispatchNotification(EMAIL_ARGS));
    await flush();

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("suppresses the email when the recipient's one role is muted (baseline, single-role — must not regress)", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.user.findUnique).mockResolvedValue(recipient("SUPER_ADMIN") as never);
    vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue(baseSettings({ emailDailyEscalation: ["SUPER_ADMIN"] }) as never);

    await runInTenant(client, () => dispatchNotification(EMAIL_ARGS));
    await flush();

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("the in-app bell always fires, even when the email leg is suppressed", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.user.findUnique).mockResolvedValue(recipient("SUPER_ADMIN") as never);
    vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue(baseSettings({ emailDailyEscalation: ["SUPER_ADMIN"] }) as never);

    await runInTenant(client, () => dispatchNotification(EMAIL_ARGS));

    expect(client.notification.create).toHaveBeenCalledTimes(1);
  });

  it("THE FIX: sends the email when a second held role is unmuted, even though the primary role is muted", async () => {
    const client = createFakeTenantClient();
    // A SUPER_ADMIN who is also granted MANAGER — the exact reported scenario.
    vi.mocked(client.user.findUnique).mockResolvedValue(recipient("SUPER_ADMIN", ["MANAGER"]) as never);
    vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue(baseSettings({ emailDailyEscalation: ["SUPER_ADMIN"] }) as never);

    await runInTenant(client, () => dispatchNotification(EMAIL_ARGS));
    await flush();

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("suppresses the email only when EVERY held role is muted for that category", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.user.findUnique).mockResolvedValue(recipient("SUPER_ADMIN", ["MANAGER"]) as never);
    vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue(
      baseSettings({ emailDailyEscalation: ["SUPER_ADMIN", "MANAGER"] }) as never
    );

    await runInTenant(client, () => dispatchNotification(EMAIL_ARGS));
    await flush();

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("a recipient with no UserRole rows at all still resolves correctly from their primary role alone", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.user.findUnique).mockResolvedValue(recipient("EMPLOYEE") as never); // no extra roles
    vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue(baseSettings(null) as never); // no mutes configured

    await runInTenant(client, () => dispatchNotification(EMAIL_ARGS));
    await flush();

    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
