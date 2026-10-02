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
import { createHash } from "node:crypto";
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
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
// Password sign-in is ON for this workspace — the SSO-only refusal has its own test
// (auth-mail-routes.test.ts).
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
}));

const { changePassword, resetPassword } = await import("../../src/services/auth.service.js");
const { hashPassword } = await import("../../src/utils/security.js");

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
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: USER_ID, passwordHash: storedHash, status: "ACTIVE", deletedAt: null }),
      findUnique: vi.fn().mockResolvedValue({ id: USER_ID, passwordHash: storedHash, status: "ACTIVE", deletedAt: null }),
      update: vi.fn().mockResolvedValue({ id: USER_ID })
    },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    passwordResetToken: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
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
  /** The emailed link's happy path needs a `<selector>.<verifier>` row whose verifier matches —
   *  see reset-token.service.ts for the format. */
  const SELECTOR = "selectorSelector";
  const VERIFIER = "v".repeat(48);
  const RAW = `${SELECTOR}.${VERIFIER}`;
  function withMatchingToken() {
    vi.mocked(client.passwordResetToken.findUnique).mockResolvedValue({
      id: "tok-1",
      userId: USER_ID,
      selector: SELECTOR,
      tokenHash: createHash("sha256").update(VERIFIER).digest("hex"),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    } as never);
  }

  it("refuses to re-set the password the account already has", async () => {
    withMatchingToken();
    await expect(inTenant(() => resetPassword(RAW, CURRENT))).rejects.toThrow(/different from your current/i);
  });

  it("leaves the link usable after refusing, instead of burning it on a rejected attempt", async () => {
    withMatchingToken();
    await inTenant(() => resetPassword(RAW, CURRENT)).catch(() => undefined);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("accepts a different password", async () => {
    withMatchingToken();
    await inTenant(() => resetPassword(RAW, "a-genuinely-new-one"));
    expect(client.$transaction).toHaveBeenCalled();
  });
});

/**
 * The shared password policy (utils/password-policy.ts, audit #10) is wired into both self-service
 * routes. The rules themselves are pinned in password-policy.test.ts; this only proves they are
 * ENFORCED here, before anything is written.
 */
describe("the password policy applies to change and reset", () => {
  it("change-password refuses one of the most common passwords", async () => {
    await expect(inTenant(() => changePassword(USER_ID, CURRENT, "Password123"))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("change-password refuses a password bcrypt would silently truncate", async () => {
    await expect(inTenant(() => changePassword(USER_ID, CURRENT, "x".repeat(73)))).rejects.toThrow(/72/);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a reset (or welcome) link refuses a common password and leaves the link usable", async () => {
    vi.mocked(client.passwordResetToken.findUnique).mockResolvedValue({
      id: "tok-1",
      userId: USER_ID,
      selector: "selectorSelector",
      tokenHash: createHash("sha256").update("v".repeat(48)).digest("hex"),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    } as never);
    await expect(inTenant(() => resetPassword(`selectorSelector.${"v".repeat(48)}`, "qwertyuiop"))).rejects.toMatchObject({
      statusCode: 422
    });
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});
