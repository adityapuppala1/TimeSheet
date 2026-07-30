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

const {
  consumeVerification,
  isFaceVerificationRequired,
  redeemChallenge,
  verifyChallengePose,
  scoreQuality,
  effectiveMatchThreshold,
  assessProvenance,
  recommendMatchThreshold,
  autoTriageHonestFailures
} = await import("../../src/services/face.service.js");

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
    autoTriageHonestFailures: false,
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

describe("scoreQuality", () => {
  const frame = (over: Partial<Parameters<typeof scoreQuality>[0]> = {}) =>
    ({
      embedding: [],
      antispoofReal: 1,
      livenessScore: 1,
      faceCount: 1,
      yaw: 0,
      pitch: 0,
      faceAreaShare: 0.09,
      centreOffset: 0.05,
      brightness: 0.5,
      ...over
    }) as Parameters<typeof scoreQuality>[0];

  it("accepts a well-framed, well-lit capture with no hint", () => {
    const v = scoreQuality(frame());
    expect(v.hint).toBeNull();
    expect(v.score).toBeGreaterThan(0.8);
  });

  it("asks the user to come closer when the face is tiny rather than judging identity", () => {
    const v = scoreQuality(frame({ faceAreaShare: 0.018, centreOffset: 0.02 }));
    expect(v.hint).toMatch(/closer/i);
  });

  it("names darkness specifically — the most common real-world cause", () => {
    expect(scoreQuality(frame({ brightness: 0.05 })).hint).toMatch(/dark/i);
    expect(scoreQuality(frame({ brightness: 0.98 })).hint).toMatch(/washed out|bright/i);
  });

  it("does NOT reject an off-centre face — the model crops the box, so position is not a quality problem", () => {
    // Deliberate: rejecting on position refuses perfectly usable captures. Centring is a live
    // nudge in the client, never a server-side verdict.
    expect(scoreQuality(frame({ centreOffset: 0.85, faceAreaShare: 0.09, brightness: 0.5 })).hint).toBeNull();
  });

  it("rejects a marginal face size even when it clears the absolute floor", () => {
    expect(scoreQuality(frame({ faceAreaShare: 0.022 })).hint).toMatch(/closer/i);
  });

  it("reports no face as a quality problem, never as a match failure", () => {
    const v = scoreQuality(frame({ faceCount: 0 }));
    expect(v.score).toBe(0);
    expect(v.hint).toMatch(/no face/i);
  });
});

describe("effectiveMatchThreshold", () => {
  const passesAt = (values: number[]) =>
    vi.mocked(client.faceVerificationAttempt.findMany).mockResolvedValue(values.map((similarity) => ({ similarity })) as never);

  it("stays on the global threshold until there is a real distribution", async () => {
    passesAt([0.9, 0.91, 0.92]); // only 3 passes
    await expect(runInTenant(client, () => effectiveMatchThreshold("u1", 0.75))).resolves.toBe(0.75);
  });

  it("TIGHTENS for a user whose captures are consistently strong", async () => {
    passesAt(Array.from({ length: 12 }, () => 0.93)); // sd ~0 → personal bar ≈ 0.93
    const t = await runInTenant(client, () => effectiveMatchThreshold("u1", 0.75));
    expect(t).toBeGreaterThan(0.75);
    expect(t).toBeLessThanOrEqual(0.95);
  });

  it("NEVER drops below the workspace threshold, however scattered the user's history", async () => {
    // Wide spread: mean - 3sd lands far below the global setting. Loosening here would let a
    // lookalike in *because* the real user has been sloppy — the exact inversion to avoid.
    passesAt([0.76, 0.99, 0.78, 0.97, 0.8, 0.95, 0.77, 0.98, 0.79, 0.96]);
    await expect(runInTenant(client, () => effectiveMatchThreshold("u1", 0.75))).resolves.toBe(0.75);
  });

  it("is capped so it can never become unpassable", async () => {
    passesAt(Array.from({ length: 20 }, () => 1.0));
    await expect(runInTenant(client, () => effectiveMatchThreshold("u1", 0.75))).resolves.toBeLessThanOrEqual(0.95);
  });
});

describe("assessProvenance", () => {
  const now = new Date("2026-07-30T10:00:00Z");
  const issued = new Date("2026-07-30T09:59:57Z"); // challenge issued 3s before capture

  it("accepts a plausible live capture answering its challenge", () => {
    const v = assessProvenance({
      neutralCapturedAt: now.getTime(),
      gestureCapturedAt: now.getTime() + 3100,
      challengeIssuedAt: issued,
      receivedAt: now
    });
    expect(v.suspect).toBe(false);
    expect(v.note).toBeNull();
    expect(v.captureLagMs).toBe(3000);
    expect(v.frameIntervalMs).toBe(3100);
  });

  it("flags footage captured BEFORE its challenge existed — the replay signature", () => {
    const v = assessProvenance({
      // Captured 10 minutes before the challenge was issued: impossible for a live answer.
      neutralCapturedAt: issued.getTime() - 10 * 60 * 1000,
      gestureCapturedAt: issued.getTime() - 10 * 60 * 1000 + 3000,
      challengeIssuedAt: issued,
      receivedAt: now
    });
    expect(v.suspect).toBe(true);
    expect(v.note).toMatch(/BEFORE its challenge/i);
  });

  it("tolerates ordinary clock skew rather than punishing a wrong laptop clock", () => {
    // 60s early — inside the tolerance. Real machines are genuinely off by this much.
    const v = assessProvenance({
      neutralCapturedAt: issued.getTime() - 60_000,
      gestureCapturedAt: issued.getTime() - 60_000 + 3000,
      challengeIssuedAt: issued,
      receivedAt: now
    });
    expect(v.suspect).toBe(false);
  });

  it("flags reversed frames and impossibly fast intervals", () => {
    expect(
      assessProvenance({ neutralCapturedAt: now.getTime(), gestureCapturedAt: now.getTime() - 500, challengeIssuedAt: issued, receivedAt: now }).note
    ).toMatch(/before the neutral frame/i);
    expect(
      assessProvenance({ neutralCapturedAt: now.getTime(), gestureCapturedAt: now.getTime() + 50, challengeIssuedAt: issued, receivedAt: now }).note
    ).toMatch(/apart/i);
  });

  it("reports nothing when there is no challenge or no timestamps to reason about", () => {
    const v = assessProvenance({ neutralCapturedAt: null, gestureCapturedAt: null, challengeIssuedAt: null, receivedAt: now });
    expect(v.suspect).toBe(false);
    expect(v.captureLagMs).toBeNull();
    expect(v.frameIntervalMs).toBeNull();
  });
});

describe("recommendMatchThreshold", () => {
  const withAttempts = (rows: Array<{ outcome: string; similarity: number }>) => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings() as never);
    vi.mocked(client.faceVerificationAttempt.findMany).mockResolvedValue(rows as never);
  };

  it("declines to advise on a tiny sample instead of inventing a number", async () => {
    withAttempts(Array.from({ length: 12 }, () => ({ outcome: "PASSED", similarity: 0.9 })));
    const r = await runInTenant(client, () => recommendMatchThreshold());
    expect(r.recommendedThreshold).toBeNull();
    expect(r.summary).toMatch(/not enough/i);
  });

  it("recommends a threshold inside the gap when the clusters separate cleanly", async () => {
    withAttempts([
      ...Array.from({ length: 40 }, () => ({ outcome: "PASSED", similarity: 0.9 })),
      ...Array.from({ length: 10 }, () => ({ outcome: "NO_MATCH", similarity: 0.5 }))
    ]);
    const r = await runInTenant(client, () => recommendMatchThreshold());
    expect(r.recommendedThreshold).not.toBeNull();
    expect(r.recommendedThreshold!).toBeGreaterThan(0.5);
    expect(r.recommendedThreshold!).toBeLessThan(0.9);
    expect(r.separation!).toBeGreaterThan(0);
  });

  it("refuses to recommend when the clusters OVERLAP, and says why", async () => {
    // Interleaved scores: no threshold separates these, so tuning only trades one error for
    // the other. Saying that is more useful than emitting a confident number.
    withAttempts([
      ...Array.from({ length: 25 }, (_, i) => ({ outcome: "PASSED", similarity: 0.7 + (i % 5) * 0.01 })),
      ...Array.from({ length: 25 }, (_, i) => ({ outcome: "NO_MATCH", similarity: 0.72 + (i % 5) * 0.01 }))
    ]);
    const r = await runInTenant(client, () => recommendMatchThreshold());
    expect(r.recommendedThreshold).toBeNull();
    expect(r.summary).toMatch(/overlap/i);
    expect(r.summary).toMatch(/enrollment/i);
  });
});

describe("autoTriageHonestFailures", () => {
  it("does nothing unless the workspace opted in", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ autoTriageHonestFailures: false }) as never);
    await expect(runInTenant(client, () => autoTriageHonestFailures())).resolves.toEqual({ resolved: 0 });
    expect(client.faceVerificationAttempt.findMany).not.toHaveBeenCalled();
  });

  it("only ever queries visibility failures with no injection signal", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ autoTriageHonestFailures: true }) as never);
    vi.mocked(client.faceVerificationAttempt.findMany).mockResolvedValue([] as never);

    await runInTenant(client, () => autoTriageHonestFailures());

    // The WHERE clause is the safety boundary: NO_MATCH and SPOOF_SUSPECTED must never be
    // auto-closed, and anything carrying an injection signal must stay for a human.
    const where = vi.mocked(client.faceVerificationAttempt.findMany).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.virtualCameraSuspected).toBe(false);
    expect(where.provenanceSuspect).toBe(false);
    const outcomes = (where.outcome as { in: string[] }).in;
    expect(outcomes).not.toContain("NO_MATCH");
    expect(outcomes).not.toContain("SPOOF_SUSPECTED");
  });

  it("clears a flag only when the same user verified successfully soon after", async () => {
    vi.mocked(client.globalFaceVerificationSettings.upsert).mockResolvedValue(settings({ autoTriageHonestFailures: true }) as never);
    const attempt = { id: "a1", userId: "u1", outcome: "LOW_QUALITY", createdAt: new Date("2026-07-30T09:00:00Z") };
    vi.mocked(client.faceVerificationAttempt.findMany).mockResolvedValue([attempt] as never);

    // No later pass → left alone for a human.
    vi.mocked(client.faceVerificationAttempt.findFirst).mockResolvedValue(null as never);
    await expect(runInTenant(client, () => autoTriageHonestFailures())).resolves.toEqual({ resolved: 0 });
    expect(client.faceVerificationAttempt.update).not.toHaveBeenCalled();

    // A later pass → the failure was a bad frame, not an impostor (an impostor doesn't then pass).
    vi.mocked(client.faceVerificationAttempt.findFirst).mockResolvedValue({ id: "later" } as never);
    await expect(runInTenant(client, () => autoTriageHonestFailures())).resolves.toEqual({ resolved: 1 });
    expect(client.faceVerificationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ flaggedForReview: false, autoResolvedReason: expect.stringContaining("Auto-resolved") })
      })
    );
  });
});

describe("verifyChallengePose", () => {
  const face = (yaw: number, pitch: number) =>
    ({ embedding: [], antispoofReal: 1, livenessScore: 1, faceCount: 1, yaw, pitch, faceAreaShare: 0.09, centreOffset: 0.05, brightness: 0.5 }) as const;

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
