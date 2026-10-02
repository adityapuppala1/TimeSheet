/**
 * The per-role email mutes, for mail that goes out through `dispatchTransactional` rather than
 * `dispatchNotification` — the ticket-closed and "fix did not hold" security digests.
 *
 * THE DEFECT (audit 2026-10, notifications #8): those digests CC every ADMIN and SUPER_ADMIN and
 * never consulted the role mutes, and they passed no preference key, so the super-admin audit BCC
 * skipped its own mute check too. Unticking SUPER_ADMIN and ADMIN for "Ticket-closed security
 * digest" in Settings — which the screen offers — changed nothing: the admins were still CC'd and
 * BCC'd on every close.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/mail.service.js", () => ({ sendMail: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/template-store.service.js", () => ({
  renderEmailTemplate: vi.fn().mockResolvedValue({ subject: "Subject", html: "<p>Body</p>" })
}));

const { sendMail } = await import("../../src/services/mail.service.js");
const { dispatchTransactional, unmutedEmailAddresses, emailPreferenceKey } = await import("../../src/services/notify.service.js");

const person = (email: string, role: string, extra: string[] = []) => ({
  email,
  role: { name: role },
  userRoles: extra.map((name) => ({ role: { name } }))
});

function clientWith(mutes: Record<string, string[]> | null, people: ReturnType<typeof person>[]) {
  const client = createFakeTenantClient();
  vi.mocked(client.globalNotificationSettings.upsert).mockResolvedValue({ id: "global", emailTicketClosedDigest: true, emailRoleMutes: mutes } as never);
  vi.mocked(client.user.findMany).mockResolvedValue(people as never);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("unmutedEmailAddresses", () => {
  it("drops a workspace member every one of whose roles is muted for the category", async () => {
    const client = clientWith({ emailTicketClosedDigest: ["ADMIN", "SUPER_ADMIN"] }, [
      person("admin@acme.test", "ADMIN"),
      person("boss@acme.test", "SUPER_ADMIN"),
      person("dev@acme.test", "EMPLOYEE")
    ]);
    const kept = await runInTenant(client, () =>
      unmutedEmailAddresses("ticket.closed_digest", ["admin@acme.test", "boss@acme.test", "dev@acme.test"])
    );
    expect(kept).toEqual(["dev@acme.test"]);
  });

  it("keeps somebody who also holds an unmuted role — the same rule the in-app path applies", async () => {
    const client = clientWith({ emailTicketClosedDigest: ["SUPER_ADMIN"] }, [person("boss@acme.test", "SUPER_ADMIN", ["MANAGER"])]);
    const kept = await runInTenant(client, () => unmutedEmailAddresses("ticket.closed_digest", ["boss@acme.test"]));
    expect(kept).toEqual(["boss@acme.test"]);
  });

  it("keeps an address that is nobody in the workspace", async () => {
    const client = clientWith({ emailTicketClosedDigest: ["ADMIN"] }, []);
    const kept = await runInTenant(client, () => unmutedEmailAddresses("ticket.closed_digest", ["auditor@client.example"]));
    expect(kept).toEqual(["auditor@client.example"]);
  });
});

describe("dispatchTransactional", () => {
  it("hands the preference key to sendMail, so the super-admin BCC honours the same mute", async () => {
    const client = createFakeTenantClient();
    await runInTenant(client, () =>
      dispatchTransactional({
        to: "dev@acme.test",
        templateKey: "ticket.closed_digest",
        vars: {},
        fallback: { subject: "s", html: "h" },
        preferenceKey: emailPreferenceKey("ticket.closed_digest") ?? undefined
      })
    );
    expect(vi.mocked(sendMail).mock.calls[0][0]).toMatchObject({ preferenceKey: "emailTicketClosedDigest" });
  });
});
