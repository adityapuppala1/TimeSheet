/**
 * V17 A3 — attendance from any source through ONE ingest path.
 *
 * The database is an in-memory fake (only the calls the ingest makes); everything else — the
 * ingest service, the webhook verifier and handler, the public API routes with the real key
 * middleware, the MCP dispatcher and the CSV validator — is the real code. What is pinned:
 *
 *  - matching by email / employee code / external id, active people only;
 *  - dedupe on (source, externalRef) BEFORE the person lookup;
 *  - priority conflicts in BOTH directions, losers kept as SUPERSEDED events;
 *  - unknown people recorded as UNMATCHED and reported to callers as RECEIVED (no existence leak);
 *  - the work date resolved in the person's timezone, not UTC;
 *  - HMAC: valid, bad signature, stale timestamp, replayed event id, disabled source → 404;
 *  - API keys: old READ/WRITE keys get no attendance access; the granular grants are required;
 *  - MCP tools act only as the caller; CSV validation reports per-row errors.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const db = {
  users: [] as Row[],
  sources: [] as Row[],
  records: [] as Row[],
  events: [] as Row[],
  holidays: [] as Row[],
  calendars: [] as Row[],
  apiKeys: [] as Row[]
};
let settings: Row;
const entitlements: Record<string, boolean> = {};
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("gte" in v || "lte" in v) {
        const val = row[k] as Date;
        return (!v.gte || val >= v.gte) && (!v.lte || val <= v.lte);
      }
      if ("in" in v) return (v.in as unknown[]).includes(row[k]);
      if (k === "userId_workDate") return row.userId === v.userId && +row.workDate === +v.workDate;
      return k === "user";
    }
    if (v instanceof Date) return +row[k] === +v;
    return (row[k] ?? null) === v;
  });
}

function withSourceRef(r: Row | undefined) {
  if (!r) return null;
  const src = db.sources.find((s) => s.id === r.sourceId);
  return { ...r, sourceRef: src ? { name: src.name, priority: src.priority, id: src.id } : null };
}

function uniqueErr() {
  return Object.assign(new Error("unique"), { code: "P2002", meta: { target: "AttendanceEvent_dedupeKey_key" } });
}

let sites: Row[] = [];
const fake: Row = {
  attendanceSite: { findMany: async () => sites },
  globalAttendanceSettings: { upsert: async () => settings, findUnique: async () => settings },
  user: {
    findFirst: async ({ where }: Row) => db.users.find((u) => matches(u, where)) ?? null,
    findUnique: async ({ where }: Row) => db.users.find((u) => u.id === where.id) ?? null,
    findMany: async ({ where }: Row) => db.users.filter((u) => matches(u, where)),
    update: async () => ({})
  },
  attendanceSource: {
    findUnique: async ({ where }: Row) => db.sources.find((s) => s.id === where.id) ?? null,
    update: async ({ where, data }: Row) => Object.assign(db.sources.find((s) => s.id === where.id)!, data)
  },
  attendanceEvent: {
    create: async ({ data }: Row) => {
      if (data.dedupeKey && db.events.some((e) => e.dedupeKey === data.dedupeKey)) throw uniqueErr();
      const row = { id: nextId("ev"), createdAt: new Date(), dedupeKey: null, ...data };
      db.events.push(row);
      return row;
    },
    findUnique: async ({ where }: Row) => db.events.find((e) => (where.id ? e.id === where.id : e.dedupeKey === where.dedupeKey)) ?? null,
    update: async ({ where, data }: Row) => Object.assign(db.events.find((e) => e.id === where.id)!, data),
    updateMany: async ({ where, data }: Row) => {
      const hit = db.events.filter((e) => matches(e, where));
      hit.forEach((e) => Object.assign(e, data));
      return { count: hit.length };
    }
  },
  attendanceRecord: {
    findUnique: async ({ where }: Row) => withSourceRef(db.records.find((r) => (where.id ? r.id === where.id : matches(r, where)))),
    // Honours a top-level `select`, so a test can see what a route actually exposes.
    findMany: async ({ where, select }: Row) =>
      db.records
        .filter((r) => matches(r, where))
        .map(withSourceRef)
        .map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (r as Row)[k]])) : r)),
    create: async ({ data }: Row) => {
      if (db.records.some((r) => r.userId === data.userId && +r.workDate === +data.workDate)) throw Object.assign(new Error("u"), { code: "P2002", meta: { target: "x" } });
      const row = { id: nextId("rec"), ...data };
      db.records.push(row);
      return row;
    },
    update: async ({ where, data }: Row) => Object.assign(db.records.find((r) => r.id === where.id)!, data)
  },
  holiday: { findMany: async ({ where }: Row) => db.holidays.filter((h) => matches(h, { date: where.date, ...(where.calendarId ? { calendarId: where.calendarId } : {}) })) },
  holidayCalendar: {
    findFirst: async () => db.calendars.find((c) => c.isDefault) ?? null,
    findUnique: async ({ where }: Row) => db.calendars.find((c) => c.id === where.id) ?? null
  },
  apiKey: {
    findUnique: async ({ where }: Row) => db.apiKeys.find((k) => k.keyHash === where.keyHash) ?? null,
    update: async () => ({})
  },
  mcpToolInvocation: { create: async () => ({}), update: async () => ({}), findUnique: async () => null }
};
fake.$transaction = async (fn: (tx: Row) => unknown) => fn(fake);

// 7.0.0: no shifts assigned in these fixtures, so every work date is the plain local day.
vi.mock("../../src/services/attendance-shift.service.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/attendance-shift.service.js")>();
  const ds = await import("../../src/services/attendance-day-status.js");
  return {
    ...real,
    shiftsForUsers: async () => new Map(),
    shiftForUser: async () => null,
    currentWorkDay: async (_u: string, now: Date, tz: string | null | undefined, fb: string | null | undefined) => ({ dateKey: ds.workDateKeyFor(now, tz, fb, null), shift: null })
  };
});

vi.mock("../../src/config/prisma.js", () => ({ prisma: fake }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }), tenantContext: { getStore: () => ({ orgId: "org-1" }) } }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_org: string, key: string) => entitlements[key] ?? false,
  getPlanningEntitlements: async () => ({ ...entitlements })
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/face.service.js", () => ({
  getFaceSettings: async () => ({ enabled: false }),
  isFaceFeatureAllowedForOrg: async () => true,
  consumeVerification: async () => "x"
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5] }) }));

const ingest = await import("../../src/services/attendance-ingest.service.js");
const webhook = await import("../../src/services/attendance-webhook.service.js");
const csv = await import("../../src/services/attendance-csv.service.js");
const { encryptSecret } = await import("../../src/utils/encryption.js");
const { publicApiRouter } = await import("../../src/controllers/public-api.controller.js");
const { attendanceWebhookRouter } = await import("../../src/controllers/attendance-webhook.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { parseApiKeyGrants } = await import("../../src/middleware/public-api-auth.js");
const { invokeMcpTool, MCP_TOOLS } = await import("../../src/services/mcp-tools.js");

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-11-23T10:00:00Z");

beforeEach(() => {
  seq = 0;
  db.users = [
    { id: "u-ana", name: "Ana", email: "ana@x.io", employeeCode: "E100", scimExternalId: "ext-ana", status: "ACTIVE", deletedAt: null, timezone: "Asia/Kolkata", holidayCalendarId: null },
    { id: "u-bo", name: "Bo", email: "bo@x.io", employeeCode: "E200", scimExternalId: null, status: "INACTIVE", deletedAt: null, timezone: "UTC", holidayCalendarId: null }
  ];
  db.sources = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Front door", kind: "WEBHOOK", enabled: true, priority: 5, matchField: "EMPLOYEE_CODE", secretEncrypted: encryptSecret(SECRET) },
    { id: "22222222-2222-2222-2222-222222222222", name: "Old door", kind: "WEBHOOK", enabled: false, priority: 0, matchField: "EMAIL", secretEncrypted: encryptSecret(SECRET) }
  ];
  db.records = [];
  db.events = [];
  db.calendars = [{ id: "cal-1", name: "India", isDefault: true }];
  db.holidays = [{ calendarId: "cal-1", date: new Date("2026-12-25T00:00:00Z"), name: "Christmas", isOptional: false, calendar: { id: "cal-1", name: "India", isDefault: true } }];
  db.apiKeys = [];
  settings = { id: "global", attendanceEnabled: true, punchInMode: "OPTIONAL", locationMode: "OFF", punchInFaceRequired: false, apiPriority: 30, webPriority: 20, mcpPriority: 20, csvPriority: 10 };
  entitlements.attendanceEnabled = true;
  entitlements.attendanceIntegrationsEnabled = true;
  sites = [];
});

const DOOR = "11111111-1111-1111-1111-111111111111";

/* ================================================================== */

describe("ingestPunch", () => {
  it("matches by email, employee code and external id", async () => {
    const a = await ingest.ingestPunch({ kind: "API", identifier: "ANA@x.io", matchField: "EMAIL", punchInAt: "2026-11-23T03:30:00Z", externalRef: "a", now: NOW });
    expect(a).toMatchObject({ status: "ACCEPTED", created: true });
    db.records = [];
    const b = await ingest.ingestPunch({ kind: "API", identifier: "E100", matchField: "EMPLOYEE_CODE", punchInAt: "2026-11-23T03:30:00Z", externalRef: "b", now: NOW });
    expect(b.created).toBe(true);
    db.records = [];
    const c = await ingest.ingestPunch({ kind: "API", identifier: "ext-ana", matchField: "EXTERNAL_ID", punchInAt: "2026-11-23T03:30:00Z", externalRef: "c", now: NOW });
    expect(c.created).toBe(true);
  });

  it("records an unknown or inactive person as UNMATCHED, and callers only ever see RECEIVED", async () => {
    const unknown = await ingest.ingestPunch({ kind: "API", identifier: "ghost@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "g", now: NOW });
    const inactive = await ingest.ingestPunch({ kind: "API", identifier: "bo@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "h", now: NOW });
    const known = await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "i", now: NOW });
    expect(unknown.status).toBe("UNMATCHED");
    expect(inactive.status).toBe("UNMATCHED");
    expect(db.records).toHaveLength(1);
    expect(new Set([unknown, inactive, known].map((r) => ingest.publicStatus(r.status)))).toEqual(new Set(["RECEIVED"]));
  });

  it("dedupes on (source, externalRef) before resolving the person", async () => {
    await ingest.ingestPunch({ kind: "API", identifier: "ghost@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "same", now: NOW });
    const again = await ingest.ingestPunch({ kind: "API", identifier: "ghost@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "same", now: NOW });
    expect(again.status).toBe("DUPLICATE");
    // The same ref from a different kind is a different delivery.
    const csvSame = await ingest.ingestPunch({ kind: "CSV", identifier: "ana@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "same", now: NOW });
    expect(csvSame.status).toBe("ACCEPTED");
  });

  it("resolves the work date in the person's timezone, not UTC", async () => {
    // 20:00 UTC on the 22nd is 01:30 on the 23rd in Kolkata.
    await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-22T20:00:00Z", externalRef: "tz", now: NOW });
    expect(db.records[0].workDate.toISOString().slice(0, 10)).toBe("2026-11-23");
  });

  it("a higher-priority source takes the day over; the old owner becomes SUPERSEDED", async () => {
    const web = await ingest.ingestPunch({ kind: "WEB", person: { id: "u-ana", timezone: "Asia/Kolkata" }, punchInAt: NOW, now: NOW });
    expect(web.created).toBe(true);
    const device = await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:25:00Z", externalRef: "d1", now: NOW });
    expect(device).toMatchObject({ status: "ACCEPTED", created: false, recordId: web.recordId });
    expect(db.records[0]).toMatchObject({ source: "WEBHOOK", sourceId: DOOR });
    expect(db.events.find((e) => e.id === web.eventId)!.status).toBe("SUPERSEDED");
  });

  it("a lower-priority source loses and is kept for audit", async () => {
    await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:25:00Z", externalRef: "d1", now: NOW });
    const late = await ingest.ingestPunch({ kind: "CSV", identifier: "ana@x.io", punchInAt: "2026-11-23T03:00:00Z", externalRef: "c1", now: NOW });
    expect(late.status).toBe("SUPERSEDED");
    expect(db.records).toHaveLength(1);
    expect(db.records[0].source).toBe("WEBHOOK");
    expect(+db.records[0].punchInAt).toBe(+new Date("2026-11-23T03:25:00Z"));
  });

  it("respects configured priorities: raising WEB above devices flips the outcome", async () => {
    settings.webPriority = 5000;
    await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:25:00Z", externalRef: "d1", now: NOW });
    const web = await ingest.ingestPunch({ kind: "WEB", person: { id: "u-ana", timezone: "Asia/Kolkata" }, punchInAt: NOW, now: NOW });
    expect(web.status).toBe("ACCEPTED");
    expect(db.records[0].source).toBe("WEB");
  });

  it("merges a later punch-out from the same source into its record", async () => {
    await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:25:00Z", externalRef: "in", now: NOW });
    const out = await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:25:00Z", punchOutAt: "2026-11-23T09:00:00Z", externalRef: "out", now: NOW });
    expect(out.status).toBe("ACCEPTED");
    expect(+db.records[0].punchOutAt).toBe(+new Date("2026-11-23T09:00:00Z"));
  });

  it("7.0.0: an approved correction (REGULARIZATION) replaces even a device punch, keeps the old one, and needs no integrations plan", async () => {
    const device = await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:25:00Z", externalRef: "d1", now: NOW });
    entitlements.attendanceIntegrationsEnabled = false;
    const fix = await ingest.ingestPunch({ kind: "REGULARIZATION", userId: "u-ana", punchInAt: "2026-11-23T04:00:00Z", punchOutAt: "2026-11-23T08:00:00Z", externalRef: "REG:r1", now: NOW });
    expect(fix).toMatchObject({ status: "ACCEPTED", created: false, recordId: device.recordId });
    expect(db.records).toHaveLength(1);
    // A correction may move punch-in LATER: it replaces, it does not merge to the earliest.
    expect(db.records[0]).toMatchObject({ source: "REGULARIZATION" });
    expect(+db.records[0].punchInAt).toBe(+new Date("2026-11-23T04:00:00Z"));
    expect(db.events.find((e) => e.id === device.eventId)!.status).toBe("SUPERSEDED");
    const fixEvent = db.events.find((e) => e.id === fix.eventId)!;
    expect(fixEvent.input.previous).toMatchObject({ source: "WEBHOOK", punchInAt: "2026-11-23T03:25:00.000Z" });
    // A later device swipe cannot undo the decision, and a replayed approval is a duplicate.
    entitlements.attendanceIntegrationsEnabled = true;
    const swipe = await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E100", punchInAt: "2026-11-23T03:10:00Z", externalRef: "d2", now: NOW });
    expect(swipe.status).toBe("SUPERSEDED");
    const again = await ingest.ingestPunch({ kind: "REGULARIZATION", userId: "u-ana", punchInAt: "2026-11-23T04:00:00Z", externalRef: "REG:r1", now: NOW });
    expect(again.status).toBe("DUPLICATE");
    expect(ingest.rankOf("REGULARIZATION", null, settings)).toBeGreaterThan(ingest.rankOf("WEBHOOK", 5000, settings));
  });

  it("7.0.0: labels a punch that carries a location with its work site, from any source", async () => {
    sites = [{ name: "Bengaluru office", latitude: 12.9716, longitude: 77.5946, radiusM: 200 }];
    await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "s1", evidence: { lat: 12.9717, lng: 77.5947 }, now: NOW });
    expect(db.records[0].siteLabel).toBe("At Bengaluru office");
    db.records = [];
    await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "s2", evidence: { lat: 13.1, lng: 77.6 }, now: NOW });
    expect(db.records[0].siteLabel).toBe("Outside work sites");
    db.records = [];
    // No location: nothing to say.
    await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "s3", now: NOW });
    expect(db.records[0].siteLabel).toBeNull();
  });

  it("rejects malformed times without a thrown error", async () => {
    const naive = await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-23T09:00", externalRef: "n", now: NOW });
    const backwards = await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-23T09:00:00Z", punchOutAt: "2026-11-23T08:00:00Z", externalRef: "b", now: NOW });
    const future = await ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: "2026-11-24T09:00:00Z", externalRef: "f", now: NOW });
    expect([naive.status, backwards.status, future.status]).toEqual(["REJECTED", "REJECTED", "REJECTED"]);
  });

  it("gates integrations on the plan but leaves the web punch alone", async () => {
    entitlements.attendanceIntegrationsEnabled = false;
    await expect(ingest.ingestPunch({ kind: "API", identifier: "ana@x.io", punchInAt: NOW, externalRef: "x", now: NOW })).rejects.toThrow(/plan/);
    const web = await ingest.ingestPunch({ kind: "WEB", person: { id: "u-ana", timezone: "UTC" }, punchInAt: NOW, now: NOW });
    expect(web.status).toBe("ACCEPTED");
  });

  it("replays an UNMATCHED event once the mapping is fixed", async () => {
    const miss = await ingest.ingestPunch({ kind: "WEBHOOK", sourceId: DOOR, identifier: "E999", punchInAt: "2026-11-23T03:25:00Z", externalRef: "m", now: NOW });
    expect(miss.status).toBe("UNMATCHED");
    db.users[0].employeeCode = "E999";
    const replay = await ingest.replayUnmatchedEvent(miss.eventId!);
    expect(replay.status).toBe("ACCEPTED");
    expect(db.events.find((e) => e.id === miss.eventId)!.status).toBe("SUPERSEDED");
    await expect(ingest.replayUnmatchedEvent(replay.eventId!)).rejects.toThrow(/unmatched/i);
  });

  it("caps an oversized raw payload", () => {
    const capped = ingest.capRawPayload({ blob: "x".repeat(20_000) }) as Row;
    expect(capped.truncated).toBe(true);
    expect(capped.preview.length).toBe(ingest.RAW_PAYLOAD_CAP);
  });
});

/* ================================================================== */

describe("webhook signature", () => {
  const body = '{"identifier":"E100","punchInAt":"2026-11-23T03:25:00Z"}';
  const ts = String(Math.floor(NOW.getTime() / 1000));
  const EVT = "evt-1";
  const sig = webhook.signAttendancePayload(SECRET, ts, EVT, body);

  it("accepts a valid signature inside the window", () => {
    expect(webhook.verifyAttendanceSignature({ secret: SECRET, timestamp: ts, eventId: EVT, signature: sig, rawBody: body, nowMs: NOW.getTime() })).toBe("OK");
  });
  it("signs the event id: a captured body replayed under a fresh event id fails", () => {
    // eslint-disable-next-line sonarjs/hardcoded-secret-signatures -- a test fixture HMAC, not a credential
    expect(sig).toBe("sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${EVT}.${body}`).digest("hex"));
    expect(webhook.verifyAttendanceSignature({ secret: SECRET, timestamp: ts, eventId: "evt-2", signature: sig, rawBody: body, nowMs: NOW.getTime() })).toBe("BAD_SIGNATURE");
  });
  it("refuses a bad signature, a tampered body, and a wrong secret", () => {
    const base = { timestamp: ts, eventId: EVT, rawBody: body, nowMs: NOW.getTime() };
    expect(webhook.verifyAttendanceSignature({ ...base, secret: SECRET, signature: sig.replace(/.$/, (c) => (c === "0" ? "1" : "0")) })).toBe("BAD_SIGNATURE");
    expect(webhook.verifyAttendanceSignature({ ...base, secret: SECRET, signature: sig, rawBody: body.replace("E100", "E101") })).toBe("BAD_SIGNATURE");
    expect(webhook.verifyAttendanceSignature({ ...base, secret: "other", signature: sig })).toBe("BAD_SIGNATURE");
  });
  it("refuses a stale or future timestamp and missing headers", () => {
    expect(webhook.verifyAttendanceSignature({ secret: SECRET, timestamp: ts, eventId: EVT, signature: sig, rawBody: body, nowMs: NOW.getTime() + 301_000 })).toBe("STALE");
    expect(webhook.verifyAttendanceSignature({ secret: SECRET, timestamp: ts, eventId: EVT, signature: sig, rawBody: body, nowMs: NOW.getTime() - 301_000 })).toBe("STALE");
    expect(webhook.verifyAttendanceSignature({ secret: SECRET, timestamp: undefined, eventId: EVT, signature: sig, rawBody: body })).toBe("MISSING");
    expect(webhook.verifyAttendanceSignature({ secret: SECRET, timestamp: ts, eventId: undefined, signature: sig, rawBody: body })).toBe("MISSING");
  });
});

describe("POST /integrations/attendance/:sourceId", () => {
  function app() {
    const a = express();
    a.use("/hook", express.raw({ type: () => true, limit: "512kb" }), attendanceWebhookRouter);
    a.use(errorHandler);
    return a;
  }
  function send(sourceId: string, payload: unknown, opts: { secret?: string; ts?: number; eventId?: string; sentEventId?: string } = {}) {
    const raw = JSON.stringify(payload);
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const eventId = opts.eventId ?? crypto.randomUUID();
    return request(app())
      .post(`/hook/${sourceId}`)
      .set("content-type", "application/json")
      .set(webhook.TIMESTAMP_HEADER, ts)
      .set(webhook.SIGNATURE_HEADER, webhook.signAttendancePayload(opts.secret ?? SECRET, ts, eventId, raw))
      .set(webhook.EVENT_ID_HEADER, opts.sentEventId ?? eventId)
      .send(raw);
  }

  it("accepts a signed punch and records it", async () => {
    const res = await send(DOOR, { identifier: "E100", punchInAt: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(202);
    expect(res.body.results[0].status).toBe("RECEIVED");
    expect(db.records).toHaveLength(1);
  });

  it("401s a bad signature and a stale timestamp", async () => {
    expect((await send(DOOR, { identifier: "E100", punchInAt: new Date().toISOString() }, { secret: "wrong" })).status).toBe(401);
    expect((await send(DOOR, { identifier: "E100", punchInAt: new Date().toISOString() }, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect(db.records).toHaveLength(0);
  });

  it("keeps a sender's coordinates out of the stored raw payload", async () => {
    const res = await send(DOOR, { identifier: "E100", punchInAt: new Date(Date.now() - 60_000).toISOString(), location: { lat: 12.97, lng: 77.59 } });
    expect(res.status).toBe(202);
    expect(JSON.stringify(db.events.at(-1)?.rawPayload)).not.toMatch(/12\.97|77\.59|location/);
  });

  it("401s a captured delivery replayed with a fresh event id", async () => {
    const payload = { identifier: "E100", punchInAt: new Date(Date.now() - 60_000).toISOString() };
    const res = await send(DOOR, payload, { eventId: "captured-1", sentEventId: "fresh-2" });
    expect(res.status).toBe(401);
    expect(db.records).toHaveLength(0);
  });

  it("treats a replayed event id as a duplicate", async () => {
    const payload = { identifier: "E100", punchInAt: new Date(Date.now() - 60_000).toISOString() };
    const eventId = crypto.randomUUID();
    await send(DOOR, payload, { eventId });
    const replay = await send(DOOR, payload, { eventId });
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(db.events.filter((e) => e.status === "ACCEPTED")).toHaveLength(1);
  });

  it("404s a disabled source, an unknown source, and a workspace without the entitlement, identically", async () => {
    const payload = { identifier: "E100", punchInAt: new Date().toISOString() };
    const disabled = await send("22222222-2222-2222-2222-222222222222", payload);
    const unknown = await send("33333333-3333-3333-3333-333333333333", payload);
    entitlements.attendanceIntegrationsEnabled = false;
    const unentitled = await send(DOOR, payload);
    expect([disabled.status, unknown.status, unentitled.status]).toEqual([404, 404, 404]);
    expect(new Set([disabled.body.message, unknown.body.message, unentitled.body.message]).size).toBe(1);
  });

  it("never reveals whether the person exists", async () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    const known = await send(DOOR, { identifier: "E100", punchInAt: t });
    const ghost = await send(DOOR, { identifier: "NOPE", punchInAt: t });
    expect(ghost.status).toBe(known.status);
    expect(ghost.body.results[0].status).toBe(known.body.results[0].status);
  });

  it("logs a test event without creating a record", async () => {
    const res = await send(DOOR, { test: true, identifier: "test", punchInAt: new Date().toISOString() });
    expect(res.status).toBe(202);
    expect(db.records).toHaveLength(0);
    expect(db.events.at(-1)).toMatchObject({ isTest: true, status: "ACCEPTED" });
  });
});

/* ================================================================== */

describe("public API attendance scopes", () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use("/v1", publicApiRouter);
    a.use(errorHandler);
    return a;
  }
  function addKey(scope: "READ" | "WRITE", grants: string | null): string {
    const plain = `tsk_${crypto.randomBytes(8).toString("hex")}`;
    db.apiKeys.push({ id: nextId("key"), scope, grants, keyHash: crypto.createHash("sha256").update(plain).digest("hex"), revokedAt: null, expiresAt: null });
    return plain;
  }
  const punch = { email: "ana@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "p-1" };

  it("parses grants defensively", () => {
    expect(parseApiKeyGrants(null)).toEqual([]);
    expect(parseApiKeyGrants("attendance:read, bogus ,attendance:read")).toEqual(["attendance:read"]);
  });

  it("an existing WRITE key (no grants) gets no attendance access", async () => {
    const key = addKey("WRITE", null);
    expect((await request(app()).post("/v1/attendance/punches").set("authorization", `Bearer ${key}`).send(punch)).status).toBe(403);
    expect((await request(app()).get("/v1/attendance?from=2026-11-01&to=2026-11-30").set("authorization", `Bearer ${key}`)).status).toBe(403);
    expect((await request(app()).get("/v1/holidays?from=2026-12-01&to=2026-12-31").set("authorization", `Bearer ${key}`)).status).toBe(403);
  });

  it("attendance:read does not allow writing", async () => {
    const key = addKey("READ", "attendance:read");
    expect((await request(app()).post("/v1/attendance/punches").set("authorization", `Bearer ${key}`).send(punch)).status).toBe(403);
    const holidays = await request(app()).get("/v1/holidays?from=2026-12-01&to=2026-12-31").set("authorization", `Bearer ${key}`);
    expect(holidays.status).toBe(200);
    expect(holidays.body.items[0]).toMatchObject({ date: "2026-12-25", name: "Christmas" });
  });

  it("attendance:write posts a single punch and a batch with per-item results", async () => {
    const key = addKey("READ", "attendance:write,attendance:read");
    const single = await request(app()).post("/v1/attendance/punches").set("authorization", `Bearer ${key}`).send(punch);
    expect(single.status).toBe(202);
    expect(single.body.status).toBe("RECEIVED");
    const batch = await request(app())
      .post("/v1/attendance/punches")
      .set("authorization", `Bearer ${key}`)
      .send([punch, { ...punch, externalRef: undefined }, { email: "ghost@x.io", punchInAt: "2026-11-23T03:30:00Z", externalRef: "p-2" }]);
    expect(batch.status).toBe(207);
    expect(batch.body.results.map((r: Row) => r.status)).toEqual(["DUPLICATE", "REJECTED", "RECEIVED"]);
    const list = await request(app()).get("/v1/attendance?from=2026-11-01&to=2026-11-30").set("authorization", `Bearer ${key}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).not.toHaveProperty("lat");
  });

  it("refuses a batch over the cap", async () => {
    const key = addKey("READ", "attendance:write");
    const big = Array.from({ length: 501 }, (_, i) => ({ ...punch, externalRef: `r${i}` }));
    expect((await request(app()).post("/v1/attendance/punches").set("authorization", `Bearer ${key}`).send(big)).status).toBe(413);
  });
});

/* ================================================================== */

describe("MCP attendance tools", () => {
  const ana = { id: "u-ana", name: "Ana", email: "ana@x.io", role: "EMPLOYEE", permissions: [] as string[] };
  const ctx = { user: ana as never, req: { user: ana as never }, caller: { kind: "MCP_CREDENTIAL" as const, id: "cred-1" } };
  const mcp = { enabled: true, allowWrites: true, toolOverrides: { punch_in: true } };

  it("are registered with no permission (self-scoped) and are not destructive", () => {
    const names = ["punch_in", "get_my_attendance", "list_holidays"];
    for (const name of names) {
      const spec = MCP_TOOLS.find((t) => t.name === name)!;
      expect(spec.permission).toBeNull();
      expect(spec.destructive).toBe(false);
    }
    expect(MCP_TOOLS.find((t) => t.name === "punch_in")!.mutating).toBe(true);
  });

  it("punch_in punches the caller in and get_my_attendance reads only their days", async () => {
    db.records.push({ id: "other", userId: "u-bo", workDate: new Date("2026-11-23T00:00:00Z"), punchInAt: NOW, source: "WEB", sourceId: null, flagged: false, faceAttemptId: null, lat: null, lng: null });
    const out = (await invokeMcpTool(ctx, "punch_in", {}, mcp)) as Row;
    expect(out.created).toBe(true);
    expect(db.records.find((r) => r.userId === "u-ana")!.source).toBe("MCP");
    const key = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const mine = (await invokeMcpTool(ctx, "get_my_attendance", { from: key(-5), to: key(5) }, mcp)) as Row;
    expect(mine.count).toBe(1);
    expect(mine.days[0].source).toBe("MCP");
  });

  it("punch_in is refused when the workspace requires location", async () => {
    settings.locationMode = "REQUIRED";
    await expect(invokeMcpTool(ctx, "punch_in", {}, mcp)).rejects.toThrow(/web app/);
  });

  it("list_holidays reads the caller's (default) calendar", async () => {
    const res = (await invokeMcpTool(ctx, "list_holidays", { from: "2026-12-01", to: "2026-12-31" }, mcp)) as Row;
    expect(res).toMatchObject({ calendar: "India", holidays: [{ date: "2026-12-25", name: "Christmas" }] });
  });
});

/* ================================================================== */

describe("CSV import validation", () => {
  it("parses quotes, CRLF and a BOM", () => {
    expect(csv.parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });

  it("reports header and per-row errors and resolves HH:mm in the person's zone", async () => {
    expect((await csv.validateCsv("who,date\nx,2026-11-23", "EMAIL")).headerErrors).toEqual(['Missing column "identifier".', 'Missing column "punch_in".', 'Unknown column "who".']);
    const { rows } = await csv.validateCsv(
      [
        "identifier,date,punch_in,punch_out",
        "ana@x.io,2026-11-23,09:00,18:00",
        "ghost@x.io,2026-11-23,09:00,",
        "ana@x.io,2026-02-30,9:00,",
        "ana@x.io,2026-11-24,09:00,08:00",
        "ana@x.io,2026-11-23,09:00,18:00"
      ].join("\n"),
      "EMAIL"
    );
    // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
    expect(rows[0]).toMatchObject({ errors: [], punchInAt: "2026-11-23T03:30:00.000Z", punchOutAt: "2026-11-23T12:30:00.000Z" });
    expect(rows[1].errors).toContain("no active person matches this identifier");
    expect(rows[2].errors).toContain("date must be YYYY-MM-DD");
    expect(rows[3].errors).toContain("punch_out is before punch_in");
    expect(rows[4].errors).toContain("duplicate row in this file");
  });

  it("commits only the valid rows, idempotently", async () => {
    const text = "identifier,date,punch_in\nana@x.io,2026-11-20,09:00\nghost@x.io,2026-11-20,09:00";
    const first = await csv.commitCsv(text, "EMAIL", null);
    expect(first).toMatchObject({ total: 2, skipped: 1, ACCEPTED: 1 });
    const second = await csv.commitCsv(text, "EMAIL", null);
    expect(second).toMatchObject({ DUPLICATE: 1 });
  });
});
