import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

// The ML side (model loading, embeddings, antispoof) is verified separately against the real
// models — see scripts/verify-face-service.ts, which can't run as a unit test because it needs
// the ~10MB model files and real face images. What's tested HERE is the security-critical
// decision logic that sits around it: who is required to verify, the single-use/expiry rules
// that stop a passed check being replayed, the plan-entitlement fail-open, and the
// challenge–response pose/redemption rules. That logic is what a bug would silently weaken,
// and it's pure enough to test without any ML at all.
const { mockIsAllowed } = vi.hoisted(() => ({ mockIsAllowed: vi.fn() }));

// The entitlement check reads the CONTROL plane (plan-limits.service → controlPrisma), which a
// unit test has no business touching — mock the module boundary, not the database.
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isFaceVerificationAllowed: mockIsAllowed
}));

const { consumeVerification, isFaceVerificationRequired, redeemChallenge, verifyChallengePose } = await import(
  "../../src/services/face.service.js"
);

// getFaceSettings is exported from the same module under test, so it can't be vi.mock'd out of
// its own module — instead the fake Prisma client's upsert (which is all getFaceSettings does)
// returns whatever this test wants.
function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    enabled: true,
    requireForTimesheet: true,
    requireForTicket: false,
    requireForApproval: false,
    challengeEnabled: true,
    enforcementMode: "SELECTED",
    matchThreshold: 0.75,
    antispoofThreshold: 0.5,
    livenessThreshold: 0.6,
    maxAttempts: 3,
    verificationTtlSeconds: 300,
    imageRetentionDays: 30,
    consentText: null,
    entitlementLostAt: null,
    ...overrides
  };
}

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
  mockIsAllowed.mockReset();
  mockIsAllowed.mockResolvedValue(true);
});

describe("isFaceVerificationRequired", () => {
  it("is false when the workspace switch is off, whatever the per-user flag says", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ enabled: false }) as never);
    vi.mocked(client.user.findUnique).mockResolvedValue({ faceVerificationRequired: true } as never);

    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TIMESHEET"))).resolves.toBe(false);
  });

  it("is false for a context the policy doesn't cover", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(
      settings({ requireForTicket: false, enforcementMode: "ALL" }) as never
    );

    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TICKET"))).resolves.toBe(false);
  });

  it("in ALL mode applies to everyone without consulting the per-user flag", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ enforcementMode: "ALL" }) as never);

    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TIMESHEET"))).resolves.toBe(true);
    expect(client.user.findUnique).not.toHaveBeenCalled();
  });

  it("in SELECTED mode follows the per-user flag", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings() as never);

    vi.mocked(client.user.findUnique).mockResolvedValue({ faceVerificationRequired: false } as never);
    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TIMESHEET"))).resolves.toBe(false);

    vi.mocked(client.user.findUnique).mockResolvedValue({ faceVerificationRequired: true } as never);
    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TIMESHEET"))).resolves.toBe(true);
  });

  it("fails OPEN when the plan entitlement is gone — a lapsed payment must never lock people out", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ enforcementMode: "ALL" }) as never);
    mockIsAllowed.mockResolvedValue(false);

    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TIMESHEET"))).resolves.toBe(false);
  });

  it("covers APPROVAL only when requireForApproval is on", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(
      settings({ requireForApproval: false, enforcementMode: "ALL" }) as never
    );
    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "APPROVAL"))).resolves.toBe(false);

    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(
      settings({ requireForApproval: true, enforcementMode: "ALL" }) as never
    );
    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "APPROVAL"))).resolves.toBe(true);
  });

  it("skips the control-plane entitlement query entirely while the feature is off", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ enabled: false }) as never);

    await expect(runInTenant(client, () => isFaceVerificationRequired("u1", "TIMESHEET"))).resolves.toBe(false);
    expect(mockIsAllowed).not.toHaveBeenCalled();
  });
});

describe("consumeVerification", () => {
  const baseAttempt = {
    id: "v1",
    userId: "u1",
    context: "TIMESHEET",
    outcome: "PASSED",
    consumedAt: null,
    createdAt: new Date()
  };

  beforeEach(() => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings() as never);
  });

  it("rejects a missing verification id (fails closed)", async () => {
    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: undefined, userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });

  it("rejects a verification belonging to a different user", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue({ ...baseAttempt, userId: "someone-else" } as never);

    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });

  it("rejects a verification issued for a different context", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue({ ...baseAttempt, context: "TICKET" } as never);

    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });

  it("rejects a verification that didn't pass", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue({ ...baseAttempt, outcome: "NO_MATCH" } as never);

    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });

  it("rejects an already-consumed verification (no replay across submissions)", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue({ ...baseAttempt, consumedAt: new Date() } as never);

    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });

  it("rejects a verification older than the configured TTL", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue({
      ...baseAttempt,
      createdAt: new Date(Date.now() - 301 * 1000) // TTL is 300s
    } as never);

    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });

  it("consumes a valid verification, links it to the submission, and returns the attempt id", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue(baseAttempt as never);
    vi.mocked(client.faceVerificationAttempt.updateMany).mockResolvedValue({ count: 1 } as never);

    await expect(
      runInTenant(client, () =>
        consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET", timesheetId: "ts-9" })
      )
    ).resolves.toBe("v1");

    expect(client.faceVerificationAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "v1", consumedAt: null },
        data: expect.objectContaining({ timesheetId: "ts-9" })
      })
    );
  });

  it("rejects when a concurrent submission won the race (updateMany matched nothing)", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue(baseAttempt as never);
    // Both requests read an unconsumed row; the conditional update is what actually arbitrates.
    vi.mocked(client.faceVerificationAttempt.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(
      runInTenant(client, () => consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET" }))
    ).rejects.toMatchObject({ statusCode: 428 });
  });
});

describe("redeemChallenge", () => {
  it("returns null for a missing id (controller records CHALLENGE_FAILED)", async () => {
    await expect(runInTenant(client, () => redeemChallenge({ challengeId: null, userId: "u1", context: "TIMESHEET" }))).resolves.toBeNull();
    expect(client.faceChallenge.updateMany).not.toHaveBeenCalled();
  });

  it("returns null when the conditional redeem matches nothing — expired, foreign, or already spent", async () => {
    vi.mocked(client.faceChallenge.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(runInTenant(client, () => redeemChallenge({ challengeId: "c1", userId: "u1", context: "TIMESHEET" }))).resolves.toBeNull();
    // The single conditional updateMany IS the owner/context/expiry/single-use check — assert
    // every one of those constraints is in the WHERE, not re-checked racefully afterwards.
    expect(client.faceChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "c1", userId: "u1", context: "TIMESHEET", usedAt: null })
      })
    );
  });

  it("redeems once and returns the instruction to enforce", async () => {
    vi.mocked(client.faceChallenge.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(client.faceChallenge.findUnique).mockResolvedValue({ id: "c1", instruction: "TURN_LEFT" } as never);

    await expect(runInTenant(client, () => redeemChallenge({ challengeId: "c1", userId: "u1", context: "TIMESHEET" }))).resolves.toBe(
      "TURN_LEFT"
    );
  });
});

describe("verifyChallengePose", () => {
  const face = (yaw: number, pitch: number) =>
    ({ embedding: [], antispoofReal: 1, livenessScore: 1, faceCount: 1, yaw, pitch }) as const;

  it("passes a clear head turn for a TURN instruction (either direction — axis-based by design)", () => {
    expect(verifyChallengePose("TURN_LEFT", face(0, 0), face(0.5, 0.05)).ok).toBe(true);
    expect(verifyChallengePose("TURN_RIGHT", face(0.1, 0), face(-0.4, 0.02)).ok).toBe(true);
  });

  it("rejects a static replay — no meaningful pose change between frames", () => {
    const result = verifyChallengePose("TURN_LEFT", face(0.02, 0.01), face(0.03, 0.02));
    expect(result.ok).toBe(false);
    expect(result.yawDelta).toBeLessThan(0.1);
  });

  it("rejects the wrong axis: a nod cannot satisfy a turn, a turn cannot satisfy LOOK_UP", () => {
    // Nodded instead of turning — pitch dominates yaw.
    expect(verifyChallengePose("TURN_LEFT", face(0, 0), face(0.1, 0.5)).ok).toBe(false);
    // Turned instead of tilting.
    expect(verifyChallengePose("LOOK_UP", face(0, 0), face(0.6, 0.1)).ok).toBe(false);
  });

  it("passes a clear tilt for LOOK_UP", () => {
    expect(verifyChallengePose("LOOK_UP", face(0, 0), face(0.05, 0.3)).ok).toBe(true);
  });
});
