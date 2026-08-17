/**
 * The new-release announcement.
 *
 * Two properties carry it, and both are about NOT being annoying:
 *  - it fires exactly once per version per workspace, whatever the restart count. This runs at
 *    boot, and boots happen — under Compose `restart:` or a Kubernetes Deployment they can happen
 *    every few seconds while something else is wrong. A per-boot notification would bury the bell
 *    under the same row a hundred times, and the bell is where real alerts live.
 *  - it never emails. `release.published` is in-app only by construction (a `null` in
 *    notify.service.ts's SETTINGS_FIELD); the bulk helper refuses any category that isn't.
 *
 * And one about honesty: it only points people at notes that exist in this build.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { announceRunningReleaseForOrg, whatsNewLink } = await import("../../src/services/release-announce.service.js");
const { appVersion } = await import("../../src/config/version.js");
const { dispatchInAppToMany } = await import("../../src/services/notify.service.js");

let client: ReturnType<typeof createFakeTenantClient>;

/** The version under test is the one this checkout actually declares, so the test cannot pass
 *  against a changelog entry that does not exist — see changelog-releases.service.test.ts, which
 *  is what keeps VERSION and CHANGELOG.md in step in the first place. */
const RUNNING = appVersion.version;

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.notification.findFirst).mockResolvedValue(null);
  vi.mocked(client.notification.createMany).mockImplementation(((args: { data: unknown[] }) =>
    Promise.resolve({ count: args.data.length })) as never);
  vi.mocked(client.user.findMany).mockResolvedValue([{ id: "user-1" }, { id: "user-2" }] as never);
});

describe("announceRunningReleaseForOrg", () => {
  it("writes one in-app row per active user, pointing at this release on What's new", async () => {
    const result = await runInTenant(client, () => announceRunningReleaseForOrg());

    expect(result).toEqual({ version: RUNNING, notified: 2 });
    const [{ data }] = vi.mocked(client.notification.createMany).mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      userId: "user-1",
      category: "release.published",
      link: `/app/whats-new?release=${RUNNING}`
    });
    expect(String(data[0].title)).toContain(`v${RUNNING}`);
  });

  it("only asks for ACTIVE, undeleted users — a disabled account has no bell to read", async () => {
    await runInTenant(client, () => announceRunningReleaseForOrg());

    expect(vi.mocked(client.user.findMany).mock.calls[0][0]).toMatchObject({
      where: { status: "ACTIVE", deletedAt: null }
    });
  });

  it("stays silent when this workspace has already been told about this version", async () => {
    // The dedupe store IS the notification row: same version, same link, therefore already sent.
    vi.mocked(client.notification.findFirst).mockResolvedValue({ id: "n-1" } as never);

    const result = await runInTenant(client, () => announceRunningReleaseForOrg());

    expect(result).toBeNull();
    expect(client.notification.createMany).not.toHaveBeenCalled();
    // And it looked for THIS version specifically, not "any release notification ever".
    expect(vi.mocked(client.notification.findFirst).mock.calls[0][0]).toMatchObject({
      where: { category: "release.published", link: `/app/whats-new?release=${RUNNING}` }
    });
  });

  it("stays silent when there is nobody to tell", async () => {
    vi.mocked(client.user.findMany).mockResolvedValue([] as never);

    await expect(runInTenant(client, () => announceRunningReleaseForOrg())).resolves.toBeNull();
    expect(client.notification.createMany).not.toHaveBeenCalled();
  });

  it("refuses to announce a version whose notes are not in this build", async () => {
    // A dev build ("0.0.0-dev"), or a VERSION bumped before the changelog section was written.
    // Sending everybody to a page with nothing on it is worse than saying nothing.
    vi.stubEnv("APP_VERSION", "0.0.0-dev");
    vi.resetModules();
    const mod = await import("../../src/services/release-announce.service.js");

    await expect(runInTenant(client, () => mod.announceRunningReleaseForOrg())).resolves.toBeNull();
    expect(client.notification.createMany).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("whatsNewLink", () => {
  it("is the deep link the What's-new page expands on arrival", () => {
    expect(whatsNewLink("2.4.0")).toBe("/app/whats-new?release=2.4.0");
  });
});

describe("dispatchInAppToMany", () => {
  it("refuses a category that has an email leg", async () => {
    // The invariant, stated where it can fail: this path skips every email gate (category toggle,
    // per-role mutes) because its categories have no email at all. The day one of them grows an
    // email payload, this throws instead of quietly sending an ungated one to everybody.
    await expect(
      runInTenant(client, () =>
        dispatchInAppToMany({ userIds: ["user-1"], category: "timesheet.approved", title: "t", body: "b" })
      )
    ).rejects.toThrow(/email leg/);
  });

  it("writes nothing for an empty recipient list", async () => {
    const created = await runInTenant(client, () =>
      dispatchInAppToMany({ userIds: [], category: "release.published", title: "t", body: "b" })
    );
    expect(created).toBe(0);
    expect(client.notification.createMany).not.toHaveBeenCalled();
  });
});
