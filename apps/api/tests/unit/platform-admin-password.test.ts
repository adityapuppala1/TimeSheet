/**
 * The platform admin's own password: the seeded-password detector that drives the console banner,
 * and the change flow that is the only way to rotate it without SQL.
 *
 * Two things here are worth a test because getting them wrong is silent:
 *
 *  - The detector must say "seeded" for the exact hash the control seed writes and "not seeded"
 *    for anything else — a detector that is wrong in either direction either nags forever or
 *    never nags, and nothing else surfaces the difference.
 *  - The change must revoke every OTHER session and keep the current one. Revoking all of them
 *    signs the operator out of the console they are hardening; revoking none of them means a
 *    rotation done because a credential leaked does not end the leak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
/*
 * A BUDGET SIZED FOR BCRYPT, not for an assertion.
 *
 * Every login path under test hashes or verifies a password, `bcryptjs` is pure JavaScript, and its
 * cost factor is deliberately expensive — that is the control, not a slow test. This file spends
 * ~18 seconds of CPU on seven tests with nothing else running, so vitest's 10s default is already
 * close in isolation and is exceeded under a full parallel suite on a loaded machine.
 *
 * The failure that produced is the worst kind: red on one run, green on the next, on a file nobody
 * had touched. That teaches people to re-run the suite instead of reading it, which is how a real
 * regression gets waved through. Nothing here hangs — it is bcrypt doing its job — so the honest
 * fix is a budget that says so, kept local to the files that hash rather than raised globally,
 * where it would also hide a genuine deadlock somewhere else.
 */
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const control = {
  platformAdminUser: { findUnique: vi.fn(), update: vi.fn() },
  platformAdminSession: { updateMany: vi.fn(), create: vi.fn() }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { SEEDED_PLATFORM_ADMIN_PASSWORD, usesSeededPassword, changePlatformAdminPassword } = await import(
  "../../src/services/platform-admin-auth.service.js"
);
const { hashPassword } = await import("../../src/utils/security.js");

const ADMIN = "admin-1";
const CURRENT_SESSION = "sess-current";

describe("usesSeededPassword", () => {
  it("recognises the hash the control seed writes", async () => {
    expect(await usesSeededPassword(await hashPassword(SEEDED_PLATFORM_ADMIN_PASSWORD))).toBe(true);
  });

  it("is false for any other password", async () => {
    expect(await usesSeededPassword(await hashPassword("Something-Else-Entirely-42"))).toBe(false);
  });
});

describe("changePlatformAdminPassword", () => {
  let storedHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    storedHash = await hashPassword("Current-Password-1234");
    control.platformAdminUser.findUnique.mockResolvedValue({ id: ADMIN, status: "ACTIVE", passwordHash: storedHash });
    control.platformAdminUser.update.mockResolvedValue({ id: ADMIN });
    control.platformAdminSession.updateMany.mockResolvedValue({ count: 2 });
  });

  it("refuses when the current password is wrong — an unlocked console is not proof of identity", async () => {
    await expect(changePlatformAdminPassword(ADMIN, CURRENT_SESSION, "not-the-password", "A-Brand-New-Password-99")).rejects.toMatchObject({ statusCode: 400 });
    expect(control.platformAdminUser.update).not.toHaveBeenCalled();
  });

  it("refuses the seeded bootstrap password as a new value", async () => {
    await expect(changePlatformAdminPassword(ADMIN, CURRENT_SESSION, "Current-Password-1234", SEEDED_PLATFORM_ADMIN_PASSWORD)).rejects.toMatchObject({ statusCode: 400 });
    expect(control.platformAdminUser.update).not.toHaveBeenCalled();
  });

  it("refuses re-using the current password", async () => {
    await expect(changePlatformAdminPassword(ADMIN, CURRENT_SESSION, "Current-Password-1234", "Current-Password-1234")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses an inactive admin even with the right password", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue({ id: ADMIN, status: "INACTIVE", passwordHash: storedHash });
    await expect(changePlatformAdminPassword(ADMIN, CURRENT_SESSION, "Current-Password-1234", "A-Brand-New-Password-99")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("stores a new hash, revokes every other session and keeps this one", async () => {
    const result = await changePlatformAdminPassword(ADMIN, CURRENT_SESSION, "Current-Password-1234", "A-Brand-New-Password-99");

    const update = control.platformAdminUser.update.mock.calls[0][0] as { where: { id: string }; data: { passwordHash: string } };
    expect(update.where).toEqual({ id: ADMIN });
    // Never the plaintext, never the old hash.
    expect(update.data.passwordHash).not.toBe("A-Brand-New-Password-99");
    expect(update.data.passwordHash).not.toBe(storedHash);

    const revoke = control.platformAdminSession.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: { revokedAt: Date } };
    expect(revoke.where).toMatchObject({ adminUserId: ADMIN, revokedAt: null, id: { not: CURRENT_SESSION } });
    expect(revoke.data.revokedAt).toBeInstanceOf(Date);
    expect(result).toEqual({ otherSessionsRevoked: 2 });
  });
});
