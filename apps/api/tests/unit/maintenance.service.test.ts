/**
 * Tests for maintenance mode's service layer.
 *
 * The assertions that matter most here are the SAFETY properties, not the happy path:
 * - `isMaintenanceActive` must fail OPEN — a broken settings lookup degrading to "everyone is
 *   locked out" would turn a monitoring hiccup into a full outage.
 * - a settings toggle must take effect immediately (cache invalidation), because the admin
 *   watching "enable" do nothing for 10 seconds will click it again, and again.
 * - `forceLogoutNonAdmins` must never revoke a SUPER_ADMIN session — that would lock the one
 *   key that opens the room inside the room.
 * - enabling without a coherent window must be rejected loudly, never guessed at.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

// dispatchNotification does real DB writes + detached email sends — stub the whole module so
// notifyUsersOfMaintenance's recipient selection can be asserted without side effects.
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined)
}));

const { dispatchNotification } = await import("../../src/services/notify.service.js");
const {
  phaseOf,
  isMaintenanceActive,
  updateMaintenanceSettings,
  getOnlineUsers,
  forceLogoutNonAdmins,
  notifyUsersOfMaintenance
} = await import("../../src/services/maintenance.service.js");

let client: ReturnType<typeof createFakeTenantClient>;

/** Each test that touches `isMaintenanceActive` runs under its OWN orgId — the service caches
 *  per-org for 10s, and a shared orgId would let one test's cached settings leak into the next. */
let orgCounter = 0;
const freshOrg = () => `org-maint-${++orgCounter}`;

const HOUR = 60 * 60 * 1000;

function settingsRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "global",
    enabled: true,
    scheduledStartAt: new Date(Date.now() - HOUR),
    scheduledEndAt: new Date(Date.now() + HOUR),
    message: null,
    updatedById: null,
    updatedAt: new Date(),
    ...over
  };
}

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(dispatchNotification).mockClear();
});

describe("phaseOf", () => {
  const base = settingsRow() as never;

  it("is off when disabled, regardless of the window", () => {
    expect(phaseOf(settingsRow({ enabled: false }) as never)).toBe("off");
  });

  it("is off when enabled but no start time exists (armed-but-unscheduled must not fire)", () => {
    expect(phaseOf(settingsRow({ scheduledStartAt: null }) as never)).toBe("off");
  });

  it("is scheduled before the start, active inside, ended after", () => {
    const now = new Date();
    expect(phaseOf(base, new Date(now.getTime() - 2 * HOUR))).toBe("scheduled");
    expect(phaseOf(base, now)).toBe("active");
    expect(phaseOf(base, new Date(now.getTime() + 2 * HOUR))).toBe("ended");
  });

  it("stays active indefinitely when no end time is set", () => {
    const openEnded = settingsRow({ scheduledEndAt: null }) as never;
    expect(phaseOf(openEnded, new Date(Date.now() + 365 * 24 * HOUR))).toBe("active");
  });
});

describe("isMaintenanceActive", () => {
  it("is true inside an active window", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow() as never);
    expect(await runInTenant(client, () => isMaintenanceActive(), freshOrg())).toBe(true);
  });

  it("FAILS OPEN when the settings lookup throws", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockRejectedValue(new Error("db down"));
    expect(await runInTenant(client, () => isMaintenanceActive(), freshOrg())).toBe(false);
  });

  it("caches per org — a second check inside the TTL does not re-query", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow() as never);
    const orgId = freshOrg();
    await runInTenant(client, () => isMaintenanceActive(), orgId);
    await runInTenant(client, () => isMaintenanceActive(), orgId);
    expect(client.maintenanceSettings.upsert).toHaveBeenCalledTimes(1);
  });

  it("a settings update takes effect immediately (cache invalidated), not after the TTL", async () => {
    const orgId = freshOrg();
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow() as never);
    expect(await runInTenant(client, () => isMaintenanceActive(), orgId)).toBe(true);

    // Admin turns it off. The very next check must see it without waiting out the 10s TTL.
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow({ enabled: false }) as never);
    await runInTenant(
      client,
      () =>
        updateMaintenanceSettings({
          enabled: false,
          scheduledStartAt: null,
          scheduledEndAt: null,
          message: null,
          userId: "admin-1"
        }),
      orgId
    );
    expect(await runInTenant(client, () => isMaintenanceActive(), orgId)).toBe(false);
  });
});

describe("updateMaintenanceSettings validation", () => {
  const attempt = (over: Partial<Parameters<typeof updateMaintenanceSettings>[0]>) =>
    runInTenant(
      client,
      () =>
        updateMaintenanceSettings({
          enabled: true,
          scheduledStartAt: new Date(Date.now() + HOUR),
          scheduledEndAt: new Date(Date.now() + 2 * HOUR),
          message: null,
          userId: "admin-1",
          ...over
        }),
      freshOrg()
    );

  it("rejects enabling without a start time", async () => {
    await expect(attempt({ scheduledStartAt: null })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects enabling without an end time", async () => {
    await expect(attempt({ scheduledEndAt: null })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a window that ends before it starts", async () => {
    await expect(
      attempt({
        scheduledStartAt: new Date(Date.now() + 2 * HOUR),
        scheduledEndAt: new Date(Date.now() + HOUR)
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a window entirely in the past", async () => {
    await expect(
      attempt({
        scheduledStartAt: new Date(Date.now() - 3 * HOUR),
        scheduledEndAt: new Date(Date.now() - 2 * HOUR)
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("disabling never validates the window — clearing a stale schedule must always work", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow({ enabled: false }) as never);
    await expect(attempt({ enabled: false, scheduledStartAt: null, scheduledEndAt: null })).resolves.toBeTruthy();
  });
});

describe("getOnlineUsers", () => {
  const sessionFor = (userId: string, minutesAgo: number, over: Partial<Record<string, unknown>> = {}) => ({
    lastSeenAt: new Date(Date.now() - minutesAgo * 60_000),
    user: { id: userId, name: `User ${userId}`, email: `${userId}@x.io`, deletedAt: null, role: { name: "EMPLOYEE" }, ...over }
  });

  it("counts PEOPLE, not sessions — several devices dedupe to one row keeping the freshest", async () => {
    vi.mocked(client.session.findMany).mockResolvedValue([
      sessionFor("u1", 1), // ordered lastSeenAt desc, as the real query does
      sessionFor("u1", 9),
      sessionFor("u2", 4)
    ] as never);
    const { count, users } = await runInTenant(client, () => getOnlineUsers(), freshOrg());
    expect(count).toBe(2);
    expect(users.find((u) => u.id === "u1")!.lastSeenAt).toEqual(expect.any(Date));
    // Kept the most recent sighting (1 min ago), not the stale one.
    expect(Date.now() - users.find((u) => u.id === "u1")!.lastSeenAt!.getTime()).toBeLessThan(5 * 60_000);
  });

  it("excludes soft-deleted users even when their session rows survive", async () => {
    vi.mocked(client.session.findMany).mockResolvedValue([
      sessionFor("ghost", 2, { deletedAt: new Date() }),
      sessionFor("real", 3)
    ] as never);
    const { count, users } = await runInTenant(client, () => getOnlineUsers(), freshOrg());
    expect(count).toBe(1);
    expect(users[0]!.id).toBe("real");
  });
});

describe("forceLogoutNonAdmins", () => {
  it("revokes only non-SUPER_ADMIN sessions", async () => {
    vi.mocked(client.session.updateMany).mockResolvedValue({ count: 7 } as never);
    const result = await runInTenant(client, () => forceLogoutNonAdmins("admin-1"), freshOrg());
    expect(result.revokedSessions).toBe(7);

    const arg = vi.mocked(client.session.updateMany).mock.calls[0]![0] as {
      where: { revokedAt: null; user: { role: { name: { not: string } } } };
      data: { revokedAt: Date };
    };
    // THE assertion of this suite: the exemption is in the WHERE clause, server-side, not
    // filtered in JS where a refactor could quietly drop it.
    expect(arg.where.user.role.name.not).toBe("SUPER_ADMIN");
    expect(arg.where.revokedAt).toBeNull();
    expect(arg.data.revokedAt).toBeInstanceOf(Date);
  });
});

describe("notifyUsersOfMaintenance", () => {
  it("refuses when no window is enabled — the notification quotes the schedule", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow({ enabled: false }) as never);
    await expect(runInTenant(client, () => notifyUsersOfMaintenance(), freshOrg())).rejects.toMatchObject({
      statusCode: 422
    });
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("notifies online non-admins only — SUPER_ADMINs are running the maintenance, not warned of it", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow() as never);
    vi.mocked(client.session.findMany).mockResolvedValue([
      { lastSeenAt: new Date(), user: { id: "emp", name: "Emp", email: "e@x.io", deletedAt: null, role: { name: "EMPLOYEE" } } },
      { lastSeenAt: new Date(), user: { id: "boss", name: "Boss", email: "b@x.io", deletedAt: null, role: { name: "SUPER_ADMIN" } } }
    ] as never);

    const { notified } = await runInTenant(client, () => notifyUsersOfMaintenance(), freshOrg());
    expect(notified).toBe(1);
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchNotification).mock.calls[0]![0]).toMatchObject({
      userId: "emp",
      category: "maintenance.scheduled"
    });
  });

  it("pre-renders the email fallback — no {{placeholders}} can reach an inbox literally", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(
      settingsRow({ message: "<b>DB upgrade</b>" }) as never
    );
    vi.mocked(client.session.findMany).mockResolvedValue([
      { lastSeenAt: new Date(), user: { id: "emp", name: "Emp", email: "e@x.io", deletedAt: null, role: { name: "EMPLOYEE" } } }
    ] as never);

    await runInTenant(client, () => notifyUsersOfMaintenance(), freshOrg());
    const call = vi.mocked(dispatchNotification).mock.calls[0]![0] as {
      email: { fallback: { html: string } };
    };
    expect(call.email.fallback.html).not.toContain("{{");
    // The admin's message is untrusted for the HTML context — must arrive escaped.
    expect(call.email.fallback.html).not.toContain("<b>DB upgrade</b>");
    expect(call.email.fallback.html).toContain("&lt;b&gt;DB upgrade&lt;/b&gt;");
  });
});
