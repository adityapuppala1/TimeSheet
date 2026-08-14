/**
 * A "change your password" flow that accepts the password you already have has changed nothing.
 *
 * WHERE IT BIT: first sign-in. Account creation and every admin reset set `mustChangePassword`,
 * precisely BECAUSE somebody other than the account holder knows the current password. Typing
 * that same password into both boxes cleared the flag, revoked the other sessions, and reported
 * success — leaving the account exactly as exposed as it was, with the banner gone and nothing
 * left to prompt a real change.
 *
 * The rule is enforced against the STORED HASH, not against the submitted `currentPassword`
 * string, so it also holds on `resetPassword`, which has no `currentPassword` to compare with —
 * an emailed reset link is sent for the same reason, and re-setting the same password there is
 * the same non-change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { changePassword, resetPassword } = await import("../../src/services/auth.service.js");
const { hashPassword, hashToken } = await import("../../src/utils/security.js");

const CURRENT = "the-current-one";
const USER_ID = "user-1";

let client: PrismaClient;
let storedHash: string;

/** The real bcrypt hash, not a stub: the check under test is `verifyPassword(next, storedHash)`,
 *  and a fake hash would make the test pass for the wrong reason. */
beforeEach(async () => {
  storedHash = await hashPassword(CURRENT);
  client = {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: USER_ID, passwordHash: storedHash }),
      findUnique: vi.fn().mockResolvedValue({ id: USER_ID, passwordHash: storedHash }),
      update: vi.fn().mockResolvedValue({ id: USER_ID })
    },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    passwordResetToken: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({})
    },
    $transaction: vi.fn().mockResolvedValue([])
  } as unknown as PrismaClient;
});

const inTenant = <T>(fn: () => Promise<T>) => runInTenant(client, fn, "org-1");

describe("changePassword", () => {
  it("refuses a new password identical to the current one", async () => {
    await expect(inTenant(() => changePassword(USER_ID, CURRENT, CURRENT))).rejects.toThrow(/different from your current/i);
  });

  it("writes nothing and revokes nothing when it refuses", async () => {
    // The order matters as much as the refusal: a rejected attempt that had already revoked the
    // user's other sessions would sign them out of their phone for typing the wrong thing.
    await inTenant(() => changePassword(USER_ID, CURRENT, CURRENT)).catch(() => undefined);
    expect(client.user.update).not.toHaveBeenCalled();
    expect(client.session.updateMany).not.toHaveBeenCalled();
  });

  it("still accepts a genuinely different password, and clears the must-change flag", async () => {
    await inTenant(() => changePassword(USER_ID, CURRENT, "a-genuinely-new-one"));
    const update = vi.mocked(client.user.update).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data.mustChangePassword).toBe(false);
    expect(update.data.passwordHash).not.toBe(storedHash);
  });

  it("still rejects a wrong current password, with the message about THAT", async () => {
    await expect(inTenant(() => changePassword(USER_ID, "not-the-current-one", "something-else"))).rejects.toThrow(
      /current password is incorrect/i
    );
  });
});

describe("resetPassword", () => {
  /** The emailed link's happy path needs a token row whose bcrypt hash actually matches. */
  async function withMatchingToken(raw: string) {
    vi.mocked(client.passwordResetToken.findMany).mockResolvedValue([
      { id: "tok-1", userId: USER_ID, tokenHash: await hashToken(raw), usedAt: null, expiresAt: new Date(Date.now() + 60_000) }
    ] as never);
  }

  it("refuses to re-set the password the account already has", async () => {
    await withMatchingToken("raw-token");
    await expect(inTenant(() => resetPassword("raw-token", CURRENT))).rejects.toThrow(/different from your current/i);
  });

  it("leaves the link usable after refusing, instead of burning it on a rejected attempt", async () => {
    await withMatchingToken("raw-token");
    await inTenant(() => resetPassword("raw-token", CURRENT)).catch(() => undefined);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("accepts a different password", async () => {
    await withMatchingToken("raw-token");
    await inTenant(() => resetPassword("raw-token", "a-genuinely-new-one"));
    expect(client.$transaction).toHaveBeenCalled();
  });
});
