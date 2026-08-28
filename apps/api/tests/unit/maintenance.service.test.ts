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
    managedByPlatform: false,
    managedByLabel: null,
    managedReference: null,
    ...over
  };
}

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(dispatchNotification).mockClear();
  // A default row, because `getMaintenanceSettings` upserts and therefore ALWAYS has one in
  // production — `updateMaintenanceSettings` now reads it before validating anything, to answer
  // "you may not change this at all" ahead of "your dates are wrong". A stub that returns
  // undefined would be testing a state the database cannot be in.
  vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow({ enabled: false }) as never);
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

/**
 * THE PLATFORM LOCK.
 *
 * A deployment-wide maintenance window that any single workspace can switch off is not a window,
 * it is a suggestion: the tenant that clears it takes a live database into the migration the
 * window existed to protect, and nobody finds out until the restore. So a platform-armed window is
 * refused to tenant-sourced writes — including the "just turn it off" write, which is the one
 * somebody actually reaches for.
 *
 * The default matters as much as the rule: a caller that passes no `source` is treated as the
 * LESS privileged one. A future endpoint that forgets the parameter fails closed.
 */
describe("platform-managed windows", () => {
  const armedByPlatform = () => settingsRow({ enabled: true, managedByPlatform: true, managedByLabel: "Platform operations", managedReference: "bc-1" });

  const tenantWrite = (over: Partial<Parameters<typeof updateMaintenanceSettings>[0]> = {}) =>
    runInTenant(
      client,
      () =>
        updateMaintenanceSettings({
          enabled: false,
          scheduledStartAt: null,
          scheduledEndAt: null,
          message: null,
          userId: "workspace-admin",
          ...over
        }),
      freshOrg()
    );

  it("refuses a workspace admin who tries to cancel it", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(armedByPlatform() as never);
    await expect(tenantWrite()).rejects.toMatchObject({ statusCode: 409, code: "MAINTENANCE_PLATFORM_MANAGED" });
  });

  it("refuses a workspace admin who tries to move it, before complaining about the dates", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(armedByPlatform() as never);
    // Deliberately an INVALID window as well: the lock must be reported, not the date error. An
    // admin told "your end time is wrong" will fix the end time and try again, forever.
    await expect(
      tenantWrite({ enabled: true, scheduledStartAt: new Date(Date.now() + 2 * HOUR), scheduledEndAt: new Date(Date.now() + HOUR) })
    ).rejects.toMatchObject({ statusCode: 409, code: "MAINTENANCE_PLATFORM_MANAGED" });
  });

  it("treats a caller that forgot to say who it is as the workspace — the lock fails closed", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(armedByPlatform() as never);
    await expect(tenantWrite({ source: undefined })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lets the platform change and clear its own window", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(armedByPlatform() as never);
    await expect(tenantWrite({ source: "platform", userId: "platform-admin@x.io" })).resolves.toBeTruthy();
  });

  it("hands control back when the platform clears it — the flag rides with the window", async () => {
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(armedByPlatform() as never);
    await tenantWrite({ source: "platform", userId: "platform-admin@x.io" });
    const update = vi.mocked(client.maintenanceSettings.upsert).mock.calls.at(-1)?.[0]?.update as Record<string, unknown>;
    expect(update).toMatchObject({ enabled: false, managedByPlatform: false, managedByLabel: null, managedReference: null });
  });

  it("stamps the label and reference a workspace quotes back to support", async () => {
    await runInTenant(
      client,
      () =>
        updateMaintenanceSettings({
          enabled: true,
          scheduledStartAt: new Date(Date.now() + HOUR),
          scheduledEndAt: new Date(Date.now() + 2 * HOUR),
          message: "Database maintenance.",
          userId: "platform-admin@x.io",
          source: "platform",
          managedByLabel: "TimeSphere platform operations",
          managedReference: "bc-42"
        }),
      freshOrg()
    );
    const update = vi.mocked(client.maintenanceSettings.upsert).mock.calls.at(-1)?.[0]?.update as Record<string, unknown>;
    expect(update).toMatchObject({ managedByPlatform: true, managedByLabel: "TimeSphere platform operations", managedReference: "bc-42" });
  });

  it("leaves a workspace's OWN window entirely theirs", async () => {
    // The lock must not leak into the ordinary case: a window this workspace armed for itself is
    // still theirs to cancel, which is most windows.
    vi.mocked(client.maintenanceSettings.upsert).mockResolvedValue(settingsRow({ enabled: true, managedByPlatform: false }) as never);
    await expect(tenantWrite()).resolves.toBeTruthy();
  });
});

describe("getOnlineUsers", () => {
  let sessionSeq = 0;
  const sessionFor = (
    userId: string,
    minutesAgo: number,
    over: Partial<Record<string, unknown>> = {},
    session: Partial<Record<string, unknown>> = {}
  ) => ({
    id: `sess-${++sessionSeq}`,
    lastSeenAt: new Date(Date.now() - minutesAgo * 60_000),
    createdAt: new Date(Date.now() - 60 * 60_000),
    userAgent: null,
    ipAddress: null,
    ...session,
    user: { id: userId, name: `User ${userId}`, email: `${userId}@x.io`, deletedAt: null, role: { name: "EMPLOYEE" }, ...over }
  });

  it("counts PEOPLE, not sessions — several devices dedupe to one row keeping the freshest", async () => {
    vi.mocked(client.session.findMany).mockResolvedValue([
      sessionFor("u1", 1), // ordered lastSeenAt desc, as the real query does
      sessionFor("u1", 9),
      sessionFor("u2", 4)
    ] as never);
    const { count, sessionCount, users } = await runInTenant(client, () => getOnlineUsers(), freshOrg());
    expect(count).toBe(2);
    // …but the device-level total is reported alongside it rather than lost.
    expect(sessionCount).toBe(3);
    expect(users.find((u) => u.id === "u1")!.lastSeenAt).toEqual(expect.any(Date));
    // Kept the most recent sighting (1 min ago), not the stale one.
    expect(Date.now() - users.find((u) => u.id === "u1")!.lastSeenAt!.getTime()).toBeLessThan(5 * 60_000);
  });

  it("KEEPS the second device rather than dropping it — the unexpected session is the point", async () => {
    vi.mocked(client.session.findMany).mockResolvedValue([
      sessionFor("u1", 1, {}, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", ipAddress: "203.0.113.9" }),
      sessionFor("u1", 9, {}, { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", ipAddress: "::ffff:192.168.1.5" })
    ] as never);
    const { users } = await runInTenant(client, () => getOnlineUsers(), freshOrg());
    const [phone, laptop] = users[0]!.sessions; // freshest first, matching the query's ordering
    expect(users[0]!.sessions).toHaveLength(2);
    expect(phone!.device).toBe("Safari on iOS 17");
    expect(phone!.formFactor).toBe("mobile");
    expect(phone!.ipIsPrivate).toBe(false);
    expect(laptop!.device).toBe("Chrome on Windows 10/11");
    expect(laptop!.ipIsPrivate).toBe(true);
    expect(laptop!.signedInAt).toBeInstanceOf(Date);
  });

  it("never selects the refresh-token hashes — a leak here would be a credential leak", async () => {
    vi.mocked(client.session.findMany).mockResolvedValue([sessionFor("u1", 1)] as never);
    await runInTenant(client, () => getOnlineUsers(), freshOrg());
    const select = (vi.mocked(client.session.findMany).mock.calls[0]![0] as { select: Record<string, unknown> }).select;
    expect(select.refreshHash).toBeUndefined();
    expect(select.previousRefreshHash).toBeUndefined();
  });

  it("excludes soft-deleted users even when their session rows survive", async () => {
    vi.mocked(client.session.findMany).mockResolvedValue([
      sessionFor("ghost", 2, { deletedAt: new Date() }),
      sessionFor("real", 3)
    ] as never);
    const { count, sessionCount, users } = await runInTenant(client, () => getOnlineUsers(), freshOrg());
    expect(count).toBe(1);
    expect(sessionCount).toBe(1); // the ghost's session isn't counted either
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
