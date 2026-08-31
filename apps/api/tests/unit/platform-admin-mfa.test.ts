/**
 * The platform console's second factor, and the enumeration property the login path has to keep
 * while gaining one.
 *
 * THE SECURITY CLAIMS UNDER TEST, each one broken on purpose to check the test can see it:
 *
 *  1. NO SESSION EXISTS BEFORE THE FACTOR. `PlatformAdminSession` IS the refresh credential — the
 *     cookie is `<jwt>.<opaque secret>` and `platformAdminRefresh` mints access tokens from it
 *     without asking anything else. If login created a session row and *then* asked for a code, a
 *     stolen password plus one `POST /auth/refresh` would be a full console session and the factor
 *     would be a dialog rather than a control.
 *
 *  2. THE CHALLENGE IS NOT AN ACCESS TOKEN. It carries its own audience, so presenting it as a
 *     Bearer token fails verification rather than being honoured at reduced privilege.
 *
 *  3. A CODE WORKS ONCE. A TOTP code stays valid for its whole 30-second step plus the drift
 *     window, so without a ratchet a code seen over a shoulder or in a proxy log is replayable for
 *     up to 90 seconds.
 *
 *  4. THE LOGIN DOES NOT ANSWER "DOES THIS ACCOUNT EXIST". `auth-login-enumeration.test.ts` pins
 *     this for tenants; a challenge that appears only for enrolled accounts would be the same
 *     oracle in a new shape, so a wrong password must be indistinguishable across enrolled,
 *     unenrolled, deactivated and absent.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

const control = {
  platformAdminUser: { findUnique: vi.fn(), update: vi.fn() },
  platformAdminSession: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  platformAdminRecoveryCode: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

// The real security module, but with every verifyPassword call counted — the enumeration assertion
// is "the expensive compare happened", not what it returned. Same seam as auth-login-enumeration.
vi.mock("../../src/utils/security.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utils/security.js")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

/*
 * ONE dynamic import, in a `beforeAll` with its own budget. Importing a service that pulls in
 * config/env + jsonwebtoken + bcrypt inside an `it` bills the module graph against the 10s test
 * budget and turns a slow machine into a flaky suite.
 */
let service: typeof import("../../src/services/platform-admin-auth.service.js");
let totp: typeof import("../../src/utils/totp.js");
let security: typeof import("../../src/utils/security.js");
let encryption: typeof import("../../src/utils/encryption.js");
let platformSecurity: typeof import("../../src/utils/platform-admin-security.js");

const PASSWORD = "Correct-Horse-Battery-9";
let passwordHash: string;
let secret: string;
let encryptedSecret: string;

beforeAll(async () => {
  service = await import("../../src/services/platform-admin-auth.service.js");
  totp = await import("../../src/utils/totp.js");
  security = await import("../../src/utils/security.js");
  encryption = await import("../../src/utils/encryption.js");
  platformSecurity = await import("../../src/utils/platform-admin-security.js");
  passwordHash = await security.hashPassword(PASSWORD);
  secret = totp.generateTotpSecret();
  encryptedSecret = encryption.encryptSecret(secret);
}, 60_000);

const enrolledRow = (over: Record<string, unknown> = {}) => ({
  id: ADMIN_ID,
  email: "ops@timesphere.app",
  name: "Ops",
  role: "OWNER",
  status: "ACTIVE",
  passwordHash,
  mfaEnabled: true,
  mfaSecret: encryptedSecret,
  mfaEnrolledAt: new Date(),
  mfaLastUsedStep: null as bigint | null,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  control.platformAdminSession.create.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" });
  control.platformAdminUser.update.mockResolvedValue({});
  control.platformAdminRecoveryCode.findMany.mockResolvedValue([]);
  control.platformAdminRecoveryCode.deleteMany.mockResolvedValue({ count: 0 });
  control.platformAdminRecoveryCode.createMany.mockResolvedValue({ count: 10 });
});

describe("login stops at the challenge when a factor is enrolled", () => {
  it("returns a challenge and creates NO session", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());

    const result = (await service.platformAdminLogin("ops@timesphere.app", PASSWORD)) as { mfaRequired: true; challengeToken: string };

    expect(result.mfaRequired).toBe(true);
    expect(result.challengeToken).toBeTruthy();
    // THE load-bearing assertion. A session row here is a refresh credential handed out before the
    // second factor, which would make the factor optional for anyone holding the password.
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });

  it("the challenge token is not accepted as an access token", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    const { challengeToken } = (await service.platformAdminLogin("ops@timesphere.app", PASSWORD)) as { challengeToken: string };

    // Same secret, deliberately different audience. `requirePlatformAdmin` verifies with the
    // console's audience pinned, so this throws rather than authenticating at reduced privilege.
    expect(() => platformSecurity.verifyPlatformAdminAccessToken(challengeToken)).toThrow();
  });

  it("completes the sign-in without a challenge when no factor is enrolled", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow({ mfaEnabled: false, mfaSecret: null }));
    const result = (await service.platformAdminLogin("ops@timesphere.app", PASSWORD)) as { mfaRequired: false; accessToken: string };
    expect(result.mfaRequired).toBe(false);
    expect(result.accessToken).toBeTruthy();
    expect(control.platformAdminSession.create).toHaveBeenCalledTimes(1);
  });
});

describe("verifying the code", () => {
  const challengeFor = (id = ADMIN_ID) => platformSecurity.signPlatformAdminMfaChallenge(id);

  it("a correct code admits, and only then is a session created", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    const code = totp.totpCodeForStep(secret, totp.totpStepAt());

    const result = await service.platformAdminVerifyMfa(challengeFor(), code);

    expect(result.accessToken).toBeTruthy();
    expect(result.admin).toMatchObject({ id: ADMIN_ID, role: "OWNER", mfaEnabled: true });
    expect(control.platformAdminSession.create).toHaveBeenCalledTimes(1);
  });

  it("a wrong code refuses", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    await expect(service.platformAdminVerifyMfa(challengeFor(), "000000")).rejects.toMatchObject({ statusCode: 401 });
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });

  it("records the step it consumed, which is the whole replay defence", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    const step = totp.totpStepAt();

    await service.platformAdminVerifyMfa(challengeFor(), totp.totpCodeForStep(secret, step));

    const ratchet = control.platformAdminUser.update.mock.calls.find((c) => "mfaLastUsedStep" in (c[0] as { data: object }).data);
    expect((ratchet?.[0] as { data: { mfaLastUsedStep: bigint } }).data.mfaLastUsedStep).toBe(BigInt(step));
  });

  it("refuses a REPLAY of a code that is still inside its own valid window", async () => {
    const step = totp.totpStepAt();
    const code = totp.totpCodeForStep(secret, step);
    // The state after the first use. The code has not expired — it is valid for another ~30s plus
    // the drift window — and that is exactly the window this refusal closes.
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow({ mfaLastUsedStep: BigInt(step) }));

    await expect(service.platformAdminVerifyMfa(challengeFor(), code)).rejects.toMatchObject({ statusCode: 401 });
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });

  it("refuses a challenge for an account that has been deactivated since it was issued", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow({ status: "INACTIVE" }));
    await expect(service.platformAdminVerifyMfa(challengeFor(), totp.totpCodeForStep(secret, totp.totpStepAt()))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("refuses a forged or expired challenge with the same message either way", async () => {
    await expect(service.platformAdminVerifyMfa("not-a-token", "123456")).rejects.toMatchObject({ statusCode: 401, message: "Start the sign-in again" });
  });
});

describe("recovery codes", () => {
  const CODE = "ABCDE-FGHJK";

  it("works once", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    control.platformAdminRecoveryCode.findMany.mockResolvedValue([{ id: "rc-1", codeHash: await security.hashToken("ABCDEFGHJK") }]);
    control.platformAdminRecoveryCode.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.platformAdminVerifyMfa(platformSecurity.signPlatformAdminMfaChallenge(ADMIN_ID), CODE, { recovery: true });

    expect(result.usedRecoveryCode).toBe(true);
    expect(control.platformAdminSession.create).toHaveBeenCalledTimes(1);
    // Claimed with `usedAt: null` still in the WHERE — two sign-ins racing the same code both find
    // the row and exactly one of them updates it.
    expect(control.platformAdminRecoveryCode.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rc-1", usedAt: null } }));
  });

  it("and not twice — a consumed code is no longer among the unused rows", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    control.platformAdminRecoveryCode.findMany.mockResolvedValue([]); // it has been spent

    await expect(service.platformAdminVerifyMfa(platformSecurity.signPlatformAdminMfaChallenge(ADMIN_ID), CODE, { recovery: true })).rejects.toMatchObject({
      statusCode: 401
    });
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });

  it("loses the race rather than admitting twice when two sign-ins claim the same row", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow());
    control.platformAdminRecoveryCode.findMany.mockResolvedValue([{ id: "rc-1", codeHash: await security.hashToken("ABCDEFGHJK") }]);
    control.platformAdminRecoveryCode.updateMany.mockResolvedValue({ count: 0 }); // somebody else got there first

    await expect(service.platformAdminVerifyMfa(platformSecurity.signPlatformAdminMfaChallenge(ADMIN_ID), CODE, { recovery: true })).rejects.toMatchObject({
      statusCode: 401
    });
    expect(control.platformAdminSession.create).not.toHaveBeenCalled();
  });
});

describe("enrolment never switches the factor on before it is proved", () => {
  it("stores the secret but leaves mfaEnabled false", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow({ mfaEnabled: false, mfaSecret: null }));

    const { secret: issued, otpauthUri } = await service.beginPlatformAdminMfa(ADMIN_ID);

    expect(issued).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toContain("otpauth://totp/");
    const written = control.platformAdminUser.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(written.data).toHaveProperty("mfaSecret");
    // Enrolling somebody into a factor they have not proved they can produce is how a console locks
    // out its own owner.
    expect(written.data.mfaEnabled).toBeUndefined();
  });

  it("refuses a wrong confirmation code and issues no recovery codes", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow({ mfaEnabled: false }));
    await expect(service.confirmPlatformAdminMfa(ADMIN_ID, "000000")).rejects.toMatchObject({ statusCode: 400 });
    expect(control.platformAdminRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it("turns it on and issues ten codes once the operator proves a real one", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(enrolledRow({ mfaEnabled: false }));

    const { recoveryCodes } = await service.confirmPlatformAdminMfa(ADMIN_ID, totp.totpCodeForStep(secret, totp.totpStepAt()));

    expect(recoveryCodes).toHaveLength(10);
    // Any previous set is destroyed: a code that outlives the enrolment it belonged to is a
    // permanent bypass nobody remembers granting.
    expect(control.platformAdminRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { adminUserId: ADMIN_ID } });
    const stored = (control.platformAdminRecoveryCode.createMany.mock.calls[0][0] as { data: { codeHash: string }[] }).data;
    // Hashed, never the plaintext that went back to the caller.
    expect(stored.every((row) => !recoveryCodes.includes(row.codeHash))).toBe(true);
    expect(control.platformAdminUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mfaEnabled: true }) }));
  });
});

describe("login does not disclose whether a platform-admin account exists", () => {
  const attempt = () => service.platformAdminLogin("ops@timesphere.app", "definitely-not-the-password");

  const cases: [string, unknown][] = [
    ["an address that does not exist", null],
    ["an enrolled account", enrolledRow()],
    ["an unenrolled account", enrolledRow({ mfaEnabled: false, mfaSecret: null })],
    ["a deactivated account", enrolledRow({ status: "INACTIVE" })]
  ];

  it("answers a wrong password identically in all four cases, and always pays one bcrypt round", async () => {
    const seen: { status: number; message: string; rounds: number }[] = [];

    for (const [, row] of cases) {
      vi.clearAllMocks();
      control.platformAdminUser.findUnique.mockResolvedValue(row);
      vi.mocked(security.verifyPassword).mockClear();

      const error = await attempt().catch((e) => e as { statusCode: number; message: string });
      seen.push({ status: error.statusCode, message: error.message, rounds: vi.mocked(security.verifyPassword).mock.calls.length });
      // No challenge, no session, nothing that differs by account state.
      expect(control.platformAdminSession.create).not.toHaveBeenCalled();
    }

    // One shape, four times. A pre-fix `platformAdminLogin` short-circuits on `!admin` and never
    // reaches bcrypt, leaving the missing-account path measurably faster than the others.
    expect(seen).toEqual([
      { status: 401, message: "Invalid email or password", rounds: 1 },
      { status: 401, message: "Invalid email or password", rounds: 1 },
      { status: 401, message: "Invalid email or password", rounds: 1 },
      { status: 401, message: "Invalid email or password", rounds: 1 }
    ]);
  });

  it("compares an unknown address against the constant sentinel hash, not against nothing", async () => {
    control.platformAdminUser.findUnique.mockResolvedValue(null);
    vi.mocked(security.verifyPassword).mockClear();

    await expect(service.platformAdminLogin("ghost@timesphere.app", "whatever-password")).rejects.toMatchObject({ statusCode: 401 });

    expect(security.verifyPassword).toHaveBeenCalledWith("whatever-password", security.DUMMY_PASSWORD_HASH);
  });
});
