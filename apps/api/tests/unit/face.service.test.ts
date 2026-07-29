import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

// The ML side (model loading, embeddings, antispoof) is verified separately against the real
// models — see scripts/verify-face-service.ts, which can't run as a unit test because it needs
// the ~10MB model files and real face images. What's tested HERE is the security-critical
// decision logic that sits around it: who is required to verify, and the single-use/expiry
// rules that stop a passed check being replayed. That logic is what a bug would silently
// weaken, and it's pure enough to test without any ML at all.
const { mockGetFaceSettings } = vi.hoisted(() => ({ mockGetFaceSettings: vi.fn() }));

const { consumeVerification, isFaceVerificationRequired } = await import("../../src/services/face.service.js");

// getFaceSettings is exported from the same module under test, so it can't be vi.mock'd out of
// its own module — instead the fake Prisma client's upsert (which is all getFaceSettings does)
// returns whatever this test wants.
function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    enabled: true,
    requireForTimesheet: true,
    requireForTicket: false,
    enforcementMode: "SELECTED",
    matchThreshold: 0.75,
    antispoofThreshold: 0.5,
    livenessThreshold: 0.6,
    maxAttempts: 3,
    verificationTtlSeconds: 300,
    imageRetentionDays: 30,
    consentText: null,
    ...overrides
  };
}

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
  mockGetFaceSettings.mockReset();
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

  it("consumes a valid verification and links it to the submission", async () => {
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue(baseAttempt as never);
    vi.mocked(client.faceVerificationAttempt.updateMany).mockResolvedValue({ count: 1 } as never);

    await expect(
      runInTenant(client, () =>
        consumeVerification({ verificationId: "v1", userId: "u1", context: "TIMESHEET", timesheetId: "ts-9" })
      )
    ).resolves.toBeUndefined();

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
