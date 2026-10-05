/**
 * Two-factor sign-in (services/mfa.service.ts): a code works once, recovery codes are single-use,
 * setup only turns on after a confirmed code, the policy blocks turning it off, and the sign-in
 * challenge proves only its own purpose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-test-access-secret-0123";

type UserRow = { id: string; email: string; mfaEnabled: boolean; mfaSecret: string | null; mfaPendingSecret: string | null; mfaLastStep: number | null; mfaEnabledAt: Date | null };
let user: UserRow;
let codes: { id: string; userId: string; codeHash: string; usedAt: Date | null }[];
let requireMfa = false;

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ ...user })),
      update: vi.fn(async ({ data }: { data: Partial<UserRow> }) => Object.assign(user, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const ok = where.OR.some((c: any) => (c.mfaLastStep === null ? user.mfaLastStep === null : user.mfaLastStep !== null && user.mfaLastStep < c.mfaLastStep.lt));
        if (!ok) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      })
    },
    userRecoveryCode: {
      deleteMany: vi.fn(async () => {
        codes = [];
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: any) => {
        codes.push(...data.map((d: any, i: number) => ({ id: `c${i}`, usedAt: null, ...d })));
        return { count: data.length };
      }),
      findMany: vi.fn(async () => codes.filter((c) => c.usedAt === null)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = codes.find((c) => c.id === where.id && c.usedAt === null);
        if (!row) return { count: 0 };
        row.usedAt = data.usedAt;
        return { count: 1 };
      }),
      count: vi.fn(async () => codes.filter((c) => c.usedAt === null).length)
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
  }
}));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn(async () => ({ requireMfa })) } }
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../../src/utils/encryption.js", () => ({ encryptSecret: (s: string) => `enc:${s}`, decryptSecret: (s: string) => s.replace(/^enc:/, "") }));

const mfa = await import("../../src/services/mfa.service.js");
const { totpCodeForStep, totpStepAt } = await import("../../src/utils/totp.js");

beforeEach(() => {
  user = { id: "u1", email: "a@acme.test", mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null, mfaLastStep: null, mfaEnabledAt: null };
  codes = [];
  requireMfa = false;
});

async function enrol() {
  const { secret } = await mfa.startMfaSetup("u1", "acme");
  // Confirm with the PREVIOUS step's code, so the current step is still unused for the tests below.
  const { recoveryCodes } = await mfa.confirmMfaSetup("u1", totpCodeForStep(secret, totpStepAt() - 1));
  return { secret, recoveryCodes };
}

describe("setup", () => {
  it("stays off until a code from the new secret is confirmed", async () => {
    await mfa.startMfaSetup("u1", "acme");
    expect(user.mfaEnabled).toBe(false);
    await expect(mfa.confirmMfaSetup("u1", "000000")).rejects.toMatchObject({ statusCode: 400 });
    expect(user.mfaEnabled).toBe(false);
  });
  it("turns on with a valid code and returns ten recovery codes, stored hashed", async () => {
    const { recoveryCodes } = await enrol();
    expect(user.mfaEnabled).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    expect(codes.every((c) => !recoveryCodes.includes(c.codeHash))).toBe(true);
  });
});

describe("verifyMfaCode", () => {
  it("accepts a current code once and refuses it the second time", async () => {
    const { secret } = await enrol();
    const code = totpCodeForStep(secret, totpStepAt());
    await expect(mfa.verifyMfaCode("u1", code)).resolves.toBe("totp");
    await expect(mfa.verifyMfaCode("u1", code)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("spends a recovery code on use, in any case and without the dash", async () => {
    const { recoveryCodes } = await enrol();
    const typed = recoveryCodes[0].toLowerCase().replace("-", "");
    await expect(mfa.verifyMfaCode("u1", typed)).resolves.toBe("recovery");
    await expect(mfa.verifyMfaCode("u1", recoveryCodes[0])).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("disableMfa", () => {
  it("is refused while the workspace requires two-factor", async () => {
    const { secret } = await enrol();
    requireMfa = true;
    await expect(mfa.disableMfa("u1", "org1", totpCodeForStep(secret, totpStepAt()))).rejects.toMatchObject({ statusCode: 409 });
    expect(user.mfaEnabled).toBe(true);
  });
});

describe("sign-in challenge", () => {
  it("round-trips its own claims", () => {
    const token = mfa.signMfaChallenge({ sub: "u1", org: "org1", rememberMe: true });
    expect(mfa.readMfaChallenge(token)).toEqual({ sub: "u1", org: "org1", rememberMe: true });
  });
  it("refuses a token minted for anything else, even with the same secret", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const other = jwt.sign({ sub: "u1", org: "org1" }, process.env.JWT_ACCESS_SECRET!, { expiresIn: "5m" });
    expect(() => mfa.readMfaChallenge(other)).toThrow(/expired/);
  });
});
