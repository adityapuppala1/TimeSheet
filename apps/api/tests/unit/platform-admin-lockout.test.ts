/**
 * H4 — the console's sign-in had a per-IP limiter and nothing per ACCOUNT, and its second factor
 * could be switched off with the password alone.
 *
 *  - Consecutive failures (password or second factor) are counted on the account. From the fifth
 *    the account is locked, for a minute, then two, four… capped at an hour; a completed sign-in
 *    resets it. The IP limiter cannot see one password being guessed from a thousand addresses.
 *  - A locked account answers the CORRECT password exactly like a wrong one — same status, same
 *    message, same bcrypt round — so the lock is not an oracle for "this address is an operator"
 *    and the password guess that lands during a lock is worth nothing.
 *  - Turning the factor off needs a current code (or a recovery code) as well as the password: a
 *    stolen password, or a walked-away console, must not be enough to strip it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

let row: Record<string, unknown>;

/** Enough of Prisma's `where` for the account row: equality, null, `lt`/`gt`, `AND`/`OR`. */
function matches(subject: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(subject, w));
    if (key === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(subject, w));
    const value = subject[key] as number | Date | null | undefined;
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const { lt, gt } = cond as { lt?: number | Date; gt?: number | Date };
      if (value === null || value === undefined) return false;
      return (lt === undefined || value < lt) && (gt === undefined || value > gt);
    }
    return value === cond;
  });
}

function apply(data: Record<string, unknown>) {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    next[key] = value && typeof value === "object" && "increment" in (value as object) ? Number(row[key] ?? 0) + (value as { increment: number }).increment : value;
  }
  row = next;
}

const control = {
  platformAdminUser: {
    findUnique: vi.fn(async () => row),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      apply(data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!matches(row, where)) return { count: 0 };
      apply(data);
      return { count: 1 };
    })
  },
  platformAdminSession: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  platformAdminRecoveryCode: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  platformAuditLog: { create: vi.fn() }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

let service: typeof import("../../src/services/platform-admin-auth.service.js");
let totp: typeof import("../../src/utils/totp.js");
let security: typeof import("../../src/utils/security.js");
let encryption: typeof import("../../src/utils/encryption.js");
let platformSecurity: typeof import("../../src/utils/platform-admin-security.js");

const PASSWORD = "Correct-Horse-Battery-9";
let passwordHash: string;
let secret: string;

beforeAll(async () => {
  service = await import("../../src/services/platform-admin-auth.service.js");
  totp = await import("../../src/utils/totp.js");
  security = await import("../../src/utils/security.js");
  encryption = await import("../../src/utils/encryption.js");
  platformSecurity = await import("../../src/utils/platform-admin-security.js");
  passwordHash = await security.hashPassword(PASSWORD);
  secret = totp.generateTotpSecret();
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  control.platformAdminSession.create.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" });
  control.platformAdminRecoveryCode.findMany.mockResolvedValue([]);
  control.platformAdminRecoveryCode.deleteMany.mockResolvedValue({ count: 0 });
  row = {
    id: ADMIN_ID,
    email: "ops@timesphere.app",
    name: "Ops",
    role: "OWNER",
    status: "ACTIVE",
    passwordHash,
    mfaEnabled: false,
    mfaSecret: null,
    mfaLastUsedStep: null,
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastFailedLoginAt: null
  };
});

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const enrolled = () => ({ mfaEnabled: true, mfaSecret: encryption.encryptSecret(secret) });
const currentCode = () => totp.totpCodeForStep(secret, totp.totpStepAt());

const wrong = () => service.platformAdminLogin("ops@timesphere.app", "definitely-not-it");

describe("lockoutDurationMs", () => {
  it("is nothing below five failures, a minute at five, doubling, and never more than an hour", () => {
    expect(service.lockoutDurationMs(4)).toBe(0);
    expect(service.lockoutDurationMs(5)).toBe(60_000);
    expect(service.lockoutDurationMs(6)).toBe(120_000);
    expect(service.lockoutDurationMs(7)).toBe(240_000);
    expect(service.lockoutDurationMs(40)).toBe(60 * 60_000);
  });
});

describe("per-account lockout", () => {
  it("locks the account on the fifth consecutive wrong password", async () => {
    for (let i = 0; i < 4; i++) await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.lockedUntil).toBeNull();
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(5);
    expect((row.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("answers the RIGHT password on a locked account exactly like a wrong one, and opens no session", async () => {
    row = { ...row, failedLoginCount: 5, lockedUntil: new Date(Date.now() + 60_000) };
    vi.mocked(control.platformAdminSession.create).mockClear();

    const error = await service.platformAdminLogin("ops@timesphere.app", PASSWORD).catch((e) => e as { statusCode: number; message: string });
    expect(error).toMatchObject({ statusCode: 401, message: "Invalid email or password" });
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });

  it("does not stretch the lock with guesses made while it is in force", async () => {
    const until = new Date(Date.now() + 60_000);
    row = { ...row, failedLoginCount: 5, lockedUntil: until };
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil).toBe(until);
  });

  it("clears the counter on a completed sign-in", async () => {
    row = { ...row, failedLoginCount: 3, lockedUntil: new Date(Date.now() - 1000) };
    const result = await service.platformAdminLogin("ops@timesphere.app", PASSWORD);
    expect(result.mfaRequired).toBe(false);
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("counts a wrong second-factor code, and refuses the factor while locked", async () => {
    row = { ...row, mfaEnabled: true, mfaSecret: encryption.encryptSecret(secret), failedLoginCount: 4 };
    const challenge = platformSecurity.signPlatformAdminMfaChallenge(ADMIN_ID);
    await expect(service.platformAdminVerifyMfa(challenge, "000000")).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil).toBeInstanceOf(Date);

    // The right code, during the lock: refused, no session.
    await expect(service.platformAdminVerifyMfa(challenge, totp.totpCodeForStep(secret, totp.totpStepAt()))).rejects.toMatchObject({ statusCode: 429 });
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });
});

/*
 * R1-2. The bootstrap owner's address is the same, public one on every install and the sign-in
 * route answers on every host, so a lock a STRANGER can arm is a way to keep the platform's owner
 * off the console — about one wrong guess an hour once the ladder tops out, forever, because the
 * count never decayed.
 */
describe("a stranger cannot keep an MFA-enrolled operator out", () => {
  it("lets the RIGHT password on a locked, enrolled account through to the second-factor step", async () => {
    row = { ...row, ...enrolled(), failedLoginCount: 20, lockedUntil: new Date(Date.now() + 60 * MINUTE) };
    const result = await service.platformAdminLogin("ops@timesphere.app", PASSWORD);
    expect(result.mfaRequired).toBe(true);
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });

  it("does not count wrong passwords against an enrolled account, so they cannot arm the second-factor lock", async () => {
    row = { ...row, ...enrolled() };
    for (let i = 0; i < 12; i++) await expect(wrong()).rejects.toMatchObject({ statusCode: 401, message: "Invalid email or password" });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();

    const { challengeToken } = (await service.platformAdminLogin("ops@timesphere.app", PASSWORD)) as { challengeToken: string };
    const done = await service.platformAdminVerifyMfa(challengeToken, currentCode());
    expect(done.mfaRequired).toBe(false);
  });

  it("still locks the second-factor stage, which only somebody holding the password can reach — and audits it", async () => {
    row = { ...row, ...enrolled(), failedLoginCount: 4 };
    const challenge = platformSecurity.signPlatformAdminMfaChallenge(ADMIN_ID);
    await expect(service.platformAdminVerifyMfa(challenge, "000000")).rejects.toMatchObject({ statusCode: 401 });
    expect(row.lockedUntil).toBeInstanceOf(Date);
    expect(control.platformAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "platform_admin.locked", entityId: ADMIN_ID }) })
    );
  });

  it("does not let second-factor failures decay — the code's guess budget stays at the ladder's", async () => {
    row = { ...row, ...enrolled(), failedLoginCount: 20, lockedUntil: ago(60 * MINUTE), lastFailedLoginAt: ago(120 * MINUTE) };
    const challenge = platformSecurity.signPlatformAdminMfaChallenge(ADMIN_ID);
    await expect(service.platformAdminVerifyMfa(challenge, "000000")).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(21);
    expect((row.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now() + 59 * MINUTE);
  });
});

describe("an account without MFA forgives its failures after a quiet spell, like a tenant account", () => {
  it("forgives them 15 minutes after the last lock ended: the next wrong guess counts as the first", async () => {
    row = { ...row, failedLoginCount: 20, lockedUntil: ago(16 * MINUTE), lastFailedLoginAt: ago(76 * MINUTE) };
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it("does not forgive them inside the quiet spell — the next wrong guess re-arms the full lock", async () => {
    row = { ...row, failedLoginCount: 20, lockedUntil: ago(5 * MINUTE), lastFailedLoginAt: ago(65 * MINUTE) };
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(21);
    expect((row.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now() + 59 * MINUTE);
  });

  it("forgives failures that never reached a lock, a quiet spell after the last one", async () => {
    row = { ...row, failedLoginCount: 4, lastFailedLoginAt: ago(16 * MINUTE) };
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it("forgives a count left from before the failure time was recorded once its lock is a quiet spell old", async () => {
    row = { ...row, failedLoginCount: 30, lockedUntil: ago(16 * MINUTE), lastFailedLoginAt: null };
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(1);
  });

  it("still audits the lock it arms", async () => {
    row = { ...row, failedLoginCount: 4, lastFailedLoginAt: ago(MINUTE) };
    await expect(wrong()).rejects.toMatchObject({ statusCode: 401 });
    expect(row.failedLoginCount).toBe(5);
    expect(control.platformAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "platform_admin.locked", entityId: ADMIN_ID }) })
    );
  });
});

/*
 * R1-8. A hijacked console session must not be a place to guess the factor or the password at the
 * global rate limit: wrong proofs on the two routes that re-ask for them count like sign-in failures,
 * and both routes refuse while the account is locked.
 */
describe("the routes that re-ask for a proof count wrong ones toward the lockout", () => {
  it("counts a wrong code on turning the factor off, then refuses even the right code while locked", async () => {
    row = { ...row, ...enrolled(), failedLoginCount: 4 };
    await expect(service.disablePlatformAdminMfa(ADMIN_ID, PASSWORD, "000000")).rejects.toMatchObject({ statusCode: 400 });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil).toBeInstanceOf(Date);

    await expect(service.disablePlatformAdminMfa(ADMIN_ID, PASSWORD, currentCode())).rejects.toMatchObject({ statusCode: 429 });
    expect(row.mfaEnabled).toBe(true);
  });

  it("counts a wrong password on turning the factor off", async () => {
    row = { ...row, ...enrolled(), failedLoginCount: 2 };
    await expect(service.disablePlatformAdminMfa(ADMIN_ID, "definitely-not-it", currentCode())).rejects.toMatchObject({ statusCode: 400 });
    expect(row.failedLoginCount).toBe(3);
  });

  it("counts a wrong current password on change-password, then refuses even the right one while locked", async () => {
    row = { ...row, failedLoginCount: 4, lastFailedLoginAt: ago(MINUTE) };
    const SESSION = "22222222-2222-4222-8222-222222222222";
    await expect(service.changePlatformAdminPassword(ADMIN_ID, SESSION, "definitely-not-it", "A-Brand-New-Password-99")).rejects.toMatchObject({
      statusCode: 400
    });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil).toBeInstanceOf(Date);

    await expect(service.changePlatformAdminPassword(ADMIN_ID, SESSION, PASSWORD, "A-Brand-New-Password-99")).rejects.toMatchObject({ statusCode: 429 });
    expect(row.passwordHash).toBe(passwordHash);
  });
});

describe("turning the second factor off", () => {
  beforeEach(() => {
    row = { ...row, mfaEnabled: true, mfaSecret: encryption.encryptSecret(secret) };
  });

  it("refuses the password alone", async () => {
    await expect(service.disablePlatformAdminMfa(ADMIN_ID, PASSWORD, "")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.disablePlatformAdminMfa(ADMIN_ID, PASSWORD, "000000")).rejects.toMatchObject({ statusCode: 400 });
    expect(row.mfaEnabled).toBe(true);
  });

  it("accepts the password with a current code", async () => {
    await service.disablePlatformAdminMfa(ADMIN_ID, PASSWORD, totp.totpCodeForStep(secret, totp.totpStepAt()));
    expect(row.mfaEnabled).toBe(false);
  });

  it("accepts the password with a recovery code, for the operator whose phone is gone", async () => {
    control.platformAdminRecoveryCode.findMany.mockResolvedValue([{ id: "rc-1", codeHash: await security.hashToken("ABCDEFGHJK") }]);
    control.platformAdminRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
    await service.disablePlatformAdminMfa(ADMIN_ID, PASSWORD, "ABCDE-FGHJK", { recovery: true });
    expect(row.mfaEnabled).toBe(false);
  });
});
