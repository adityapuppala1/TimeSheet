/**
 * V17 A2 — the employee attendance routes through the real router and the real punch service.
 *
 * Only the edges are mocked (prisma, plan entitlements, face verification). What is under test is
 * the service's decisions: the two-key gate, the non-admin read exposing no admin fields, location
 * REQUIRED refusing a missing fix, consent captured once, face BLOCK vs ALLOW_FLAGGED, and that a
 * second punch returns the first record without consuming another verification.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "u-1", name: "Mia", email: "m@x.io", role: "EMPLOYEE", permissions: [] as string[] };

const entitlements = { attendanceEnabled: true };
let settings: Record<string, unknown>;
let user: { timezone: string | null; holidayCalendarId: string | null; attendanceLocationConsentAt: Date | null };
let faceEnabled = true;
let faceRule: "pass" | "fail" = "pass";

const recordCreate = vi.fn();
const recordFindUnique = vi.fn();
const userUpdate = vi.fn().mockResolvedValue({});
const consume = vi.fn();
const auditFn = vi.fn().mockResolvedValue(undefined);
const attemptFindUnique = vi.fn();

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
      next();
    }
  };
});

const tx = {
  user: { update: (...a: unknown[]) => userUpdate(...a) },
  // A3: the punch now persists through attendance-ingest.service.ts, which re-reads the day inside
  // its transaction and logs an AttendanceEvent per punch.
  attendanceRecord: {
    create: (...a: unknown[]) => recordCreate(...a),
    findUnique: (...a: unknown[]) => recordFindUnique(...a),
    update: async () => ({})
  },
  attendanceEvent: { create: async () => ({ id: "ev-1" }), updateMany: async () => ({ count: 0 }) }
};
let lastCreated: unknown = null;

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    globalAttendanceSettings: { upsert: async () => settings, findUnique: async () => settings },
    user: { findUnique: async () => user },
    holidayCalendar: { findFirst: async () => null },
    holiday: { findFirst: async () => null },
    attendanceRecord: { findUnique: (...a: unknown[]) => recordFindUnique(...a) },
    faceVerificationAttempt: { findUnique: (...a: unknown[]) => attemptFindUnique(...a) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx)
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getPlanningEntitlements: async () => ({ ...entitlements }),
  isPlanningCapabilityAllowed: async () => entitlements.attendanceEnabled
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [0, 1, 2, 3, 4, 5, 6] }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditFn(...a) }));
vi.mock("../../src/services/face.service.js", async () => {
  const { AppError } = await import("../../src/middleware/error.js");
  return {
    getFaceSettings: async () => ({ enabled: faceEnabled }),
    isFaceFeatureAllowedForOrg: async () => true,
    consumeVerification: async (p: { verificationId?: string | null }) => {
      consume(p);
      if (faceRule === "fail" || !p.verificationId) throw new AppError(428, "Identity verification is required before this can be submitted.");
      return p.verificationId;
    }
  };
});

const { attendanceRouter } = await import("../../src/controllers/attendance.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/att", attendanceRouter);
  a.use(errorHandler);
  return a;
}

function fakeRecord(data: Record<string, unknown>) {
  return {
    id: "rec-1",
    workDate: data.workDate,
    punchInAt: data.punchInAt,
    source: data.source,
    sourceRef: null,
    flagged: data.flagged,
    faceAttemptId: data.faceAttemptId,
    lat: data.lat,
    lng: data.lng
  };
}

function existing(overrides: Record<string, unknown> = {}) {
  return {
    id: "r0",
    workDate: new Date("2026-11-23T00:00:00Z"),
    punchInAt: new Date("2026-11-23T08:50:00Z"),
    source: "WEB",
    sourceRef: null,
    flagged: false,
    faceAttemptId: null,
    lat: null,
    lng: null,
    ...overrides
  };
}

beforeEach(() => {
  entitlements.attendanceEnabled = true;
  settings = {
    id: "global",
    attendanceEnabled: true,
    punchInMode: "OPTIONAL",
    locationMode: "OFF",
    punchInFaceRequired: false,
    faceFailureRule: "BLOCK",
    punchInReminderHour: 11,
    punchInReminderEnabled: true,
    aiInsightsSelf: true,
    minGroupSize: 5,
    locationConsentText: null,
    locationRetentionDays: 90,
    missedDayReasonEnabled: false
  };
  user = { timezone: "UTC", holidayCalendarId: null, attendanceLocationConsentAt: null };
  faceEnabled = true;
  faceRule = "pass";
  lastCreated = null;
  recordFindUnique.mockReset().mockImplementation(async () => lastCreated);
  recordCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => (lastCreated = fakeRecord(data)));
  userUpdate.mockClear();
  consume.mockClear();
  auditFn.mockClear();
  attemptFindUnique.mockReset();
});

describe("GET /me/today", () => {
  it("answers enabled:false (200) when the workspace toggle is off", async () => {
    settings.attendanceEnabled = false;
    const res = await request(app()).get("/att/me/today");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it("answers enabled:false (200) when the plan lacks the entitlement", async () => {
    entitlements.attendanceEnabled = false;
    expect((await request(app()).get("/att/me/today")).body).toEqual({ enabled: false });
  });

  it("exposes only what the pop-up needs — no admin fields", async () => {
    settings.locationMode = "OPTIONAL";
    const res = await request(app()).get("/att/me/today");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      punchInMode: "OPTIONAL",
      locationMode: "OPTIONAL",
      status: "PENDING",
      consentNeeded: true,
      steps: ["LOCATION"]
    });
    for (const key of [
      "punchInReminderHour",
      "punchInReminderEnabled",
      "aiInsightsSelf",
      "minGroupSize",
      "locationRetentionDays",
      "missedDayReasonEnabled",
      "settings"
    ]) {
      expect(res.body).not.toHaveProperty(key);
    }
    expect(typeof res.body.consentText).toBe("string");
  });

  it("reports an existing punch from another source with its label", async () => {
    recordFindUnique.mockResolvedValue(existing({ source: "WEBHOOK", sourceRef: { name: "Biometric" } }));
    const res = await request(app()).get("/att/me/today");
    expect(res.body.status).toBe("PRESENT");
    expect(res.body.record).toMatchObject({ source: "WEBHOOK", sourceLabel: "Biometric" });
  });

  it("lists FACE only when face verification is actually on", async () => {
    settings.punchInFaceRequired = true;
    expect((await request(app()).get("/att/me/today")).body.steps).toEqual(["FACE"]);
    faceEnabled = false;
    expect((await request(app()).get("/att/me/today")).body.steps).toEqual([]);
  });
});

describe("POST /punch-in", () => {
  it("403s when attendance is off, and when the plan lacks it", async () => {
    settings.attendanceEnabled = false;
    expect((await request(app()).post("/att/punch-in").send({})).status).toBe(403);
    settings.attendanceEnabled = true;
    entitlements.attendanceEnabled = false;
    const res = await request(app()).post("/att/punch-in").send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/plan/);
  });

  it("403s when the punch-in mode is OFF", async () => {
    settings.punchInMode = "OFF";
    expect((await request(app()).post("/att/punch-in").send({})).status).toBe(403);
  });

  it("creates a WEB record with server-side IP and user agent, audited without coordinates", async () => {
    const res = await request(app()).post("/att/punch-in").set("User-Agent", "TestUA/1").send({});
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const data = recordCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "u-1", source: "WEB", userAgent: "TestUA/1", flagged: false });
    expect(data.ip).toBeTruthy();
    const meta = auditFn.mock.calls[0][4];
    expect(auditFn.mock.calls[0].slice(0, 4)).toEqual(["u-1", "attendance.punched_in", "AttendanceRecord", "rec-1"]);
    expect(meta).not.toHaveProperty("lat");
    expect(meta).not.toHaveProperty("lng");
  });

  it("refuses a client-supplied ip field", async () => {
    expect((await request(app()).post("/att/punch-in").send({ ip: "1.2.3.4" })).status).toBe(422);
  });

  it("is idempotent: a second punch returns the existing record and consumes nothing", async () => {
    settings.punchInFaceRequired = true;
    recordFindUnique.mockResolvedValue(existing({ faceAttemptId: "f" }));
    const res = await request(app()).post("/att/punch-in").send({ verificationId: "v-2" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, record: { id: "r0" } });
    expect(recordCreate).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("returns the winner when a concurrent punch hits the unique constraint", async () => {
    recordCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    // The pre-check and the first in-transaction read both see no record; the create then loses
    // the race and the retry reads the winner.
    recordFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(existing({ id: "win" }));
    const res = await request(app()).post("/att/punch-in").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, record: { id: "win" } });
  });

  it("location REQUIRED refuses a punch without coordinates", async () => {
    settings.locationMode = "REQUIRED";
    const res = await request(app()).post("/att/punch-in").send({});
    expect(res.status).toBe(422);
    expect(recordCreate).not.toHaveBeenCalled();
  });

  it("location OPTIONAL accepts a punch without coordinates", async () => {
    settings.locationMode = "OPTIONAL";
    expect((await request(app()).post("/att/punch-in").send({})).status).toBe(201);
  });

  it("asks for consent the first time and records it once accepted", async () => {
    settings.locationMode = "REQUIRED";
    const refused = await request(app()).post("/att/punch-in").send({ lat: 12.97, lng: 77.59, accuracyM: 20 });
    expect(refused.status).toBe(422);
    const ok = await request(app()).post("/att/punch-in").send({ lat: 12.97, lng: 77.59, accuracyM: 20, consentAccepted: true });
    expect(ok.status).toBe(201);
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { attendanceLocationConsentAt: expect.any(Date) } }));
    expect(recordCreate.mock.calls[0][0].data).toMatchObject({ lat: 12.97, lng: 77.59, accuracyM: 20 });
  });

  it("does not ask again once consent is on file", async () => {
    settings.locationMode = "OPTIONAL";
    user.attendanceLocationConsentAt = new Date("2026-01-01");
    expect((await request(app()).post("/att/punch-in").send({ lat: 1, lng: 2 })).status).toBe(201);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("location OFF stores nothing even if coordinates are sent", async () => {
    await request(app()).post("/att/punch-in").send({ lat: 1, lng: 2 });
    expect(recordCreate.mock.calls[0][0].data).toMatchObject({ lat: null, lng: null });
  });

  it("refuses half a coordinate", async () => {
    expect((await request(app()).post("/att/punch-in").send({ lat: 1 })).status).toBe(422);
  });

  it("face BLOCK: no verification, no punch", async () => {
    settings.punchInFaceRequired = true;
    const res = await request(app()).post("/att/punch-in").send({});
    expect(res.status).toBe(428);
    expect(recordCreate).not.toHaveBeenCalled();
  });

  it("face BLOCK: a passed PUNCH_IN verification is consumed and linked", async () => {
    settings.punchInFaceRequired = true;
    const res = await request(app()).post("/att/punch-in").send({ verificationId: "v-1" });
    expect(res.status).toBe(201);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ verificationId: "v-1", userId: "u-1", context: "PUNCH_IN" }));
    expect(recordCreate.mock.calls[0][0].data).toMatchObject({ faceAttemptId: "v-1", flagged: false });
  });

  it("face ALLOW_FLAGGED: a failed check still punches in, flagged, keeping this user's attempt id", async () => {
    settings.punchInFaceRequired = true;
    settings.faceFailureRule = "ALLOW_FLAGGED";
    faceRule = "fail";
    attemptFindUnique.mockResolvedValue({ userId: "u-1", context: "PUNCH_IN" });
    const res = await request(app()).post("/att/punch-in").send({ verificationId: "v-bad" });
    expect(res.status).toBe(201);
    expect(res.body.record).toMatchObject({ flagged: true, faceVerified: false });
    expect(recordCreate.mock.calls[0][0].data).toMatchObject({ flagged: true, faceAttemptId: "v-bad" });
  });

  it("face ALLOW_FLAGGED never links someone else's attempt", async () => {
    settings.punchInFaceRequired = true;
    settings.faceFailureRule = "ALLOW_FLAGGED";
    faceRule = "fail";
    attemptFindUnique.mockResolvedValue({ userId: "someone-else", context: "PUNCH_IN" });
    await request(app()).post("/att/punch-in").send({ verificationId: "v-other" });
    expect(recordCreate.mock.calls[0][0].data).toMatchObject({ flagged: true, faceAttemptId: null });
  });

  it("face is not required when face verification itself is off", async () => {
    settings.punchInFaceRequired = true;
    faceEnabled = false;
    expect((await request(app()).post("/att/punch-in").send({})).status).toBe(201);
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("POST /punch-out", () => {
  it("403s when attendance is off or web punching is OFF", async () => {
    settings.attendanceEnabled = false;
    expect((await request(app()).post("/att/punch-out")).status).toBe(403);
    settings.attendanceEnabled = true;
    settings.punchInMode = "OFF";
    expect((await request(app()).post("/att/punch-out")).status).toBe(403);
  });

  it("409s with no punch-in today", async () => {
    recordFindUnique.mockResolvedValue(null);
    const res = await request(app()).post("/att/punch-out");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/not punched in/);
  });

  it("stamps today's WEB punch through the ingest path and audits it; a body time is ignored", async () => {
    recordFindUnique.mockResolvedValue(existing());
    const res = await request(app()).post("/att/punch-out").send({ punchOutAt: "2020-01-01T00:00:00Z" });
    expect(res.status).toBe(201);
    expect(res.body.updated).toBe(true);
    expect(recordCreate).not.toHaveBeenCalled();
    expect(auditFn.mock.calls[0].slice(0, 3)).toEqual(["u-1", "attendance.punched_out", "AttendanceRecord"]);
  });

  it("is idempotent: a second punch-out keeps the first", async () => {
    recordFindUnique.mockResolvedValue(existing({ punchOutAt: new Date("2026-11-23T17:00:00Z") }));
    const res = await request(app()).post("/att/punch-out");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: false, record: { punchOutAt: "2026-11-23T17:00:00.000Z" } });
    expect(auditFn).not.toHaveBeenCalled();
  });

  it("will not overwrite another source's punch from the browser", async () => {
    recordFindUnique.mockResolvedValue(existing({ source: "WEBHOOK", sourceRef: { name: "Biometric" } }));
    const res = await request(app()).post("/att/punch-out");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Biometric/);
    expect(auditFn).not.toHaveBeenCalled();
  });
});
