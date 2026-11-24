/**
 * 7.0.0 kiosk / QR punch (services/attendance-kiosk.service.ts): device token stored only as a hash,
 * rotate and revoke, signed codes, and the punch's refusals — forged signature, expired window,
 * replay, revoked device, another tenant — plus the OFF gate and the KIOSK ingest call.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The fake enforces the SAME unique key the database does, read from schema.prisma, so a change
// to the constraint changes what these tests see.
const schema = readFileSync(fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url)), "utf8");
const nonceModel = /model AttendanceKioskNonce \{([\s\S]*?)\n\}/.exec(schema)![1];
const NONCE_KEY = /@@unique\(\[([^\]]+)\]\)/.exec(nonceModel)![1].split(",").map((s) => s.trim()) as Array<"kioskId" | "userId" | "nonce">;

type Kiosk = { id: string; name: string; siteId: string | null; tokenHash: string; tokenHint: string; keySalt: string; revokedAt: Date | null; lastSeenAt: Date | null; createdAt: Date };
let kiosks: Kiosk[] = [];
let nonces: Array<{ kioskId: string; userId: string; nonce: string; createdAt: Date }> = [];
let records: Array<{ userId: string; workDate: Date }> = [];
let orgId = "org-1";
let kioskEnabled = true;
let attendanceOn = true;
const ingest = vi.fn(async (_input: unknown) => ({ eventId: "e", status: "ACCEPTED", reason: null, recordId: "r", created: true }));
const faceFn = vi.fn(async (_s: unknown, _i: unknown) => ({ faceAttemptId: null, flagged: false }));
const sites = [{ id: "site-hq", name: "HQ" }];
const withSite = (k: Kiosk) => {
  const site = sites.find((s) => s.id === k.siteId);
  return { ...k, site: site ? { name: site.name } : null };
};
const match = (k: Kiosk, where: Record<string, unknown>) => Object.entries(where).every(([key, v]) => (k as unknown as Record<string, unknown>)[key] === v);

const client = {
  attendanceKiosk: {
    findMany: async () => kiosks.map(withSite),
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const k = kiosks.find((x) => match(x, where));
      return k ? withSite(k) : null;
    },
    create: async ({ data }: { data: Partial<Kiosk> }) => {
      const k = { id: `kiosk-${kiosks.length + 1}`, revokedAt: null, lastSeenAt: null, createdAt: new Date(), siteId: null, ...data } as Kiosk;
      kiosks.push(k);
      return withSite(k);
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Kiosk> }) => {
      const k = kiosks.find((x) => x.id === where.id)!;
      Object.assign(k, data);
      return withSite(k);
    },
    updateMany: async ({ where, data }: { where: { id: string }; data: Partial<Kiosk> }) => {
      const hit = kiosks.filter((x) => x.id === where.id && x.revokedAt === null);
      hit.forEach((k) => Object.assign(k, data));
      return { count: hit.length };
    }
  },
  attendanceSite: { findUnique: async ({ where }: { where: { id: string } }) => sites.find((s) => s.id === where.id) ?? null },
  attendanceKioskNonce: {
    findFirst: async ({ where }: { where: { kioskId: string; nonce: string } }) => nonces.find((n) => n.kioskId === where.kioskId && n.nonce === where.nonce) ?? null,
    deleteMany: async ({ where }: { where: { createdAt: { lt: Date } } }) => {
      nonces = nonces.filter((n) => n.createdAt >= where.createdAt.lt);
      return { count: 0 };
    },
    create: async ({ data }: { data: { kioskId: string; userId: string; nonce: string } }) => {
      if (nonces.some((n) => NONCE_KEY.every((k) => n[k] === data[k]))) throw Object.assign(new Error("dup"), { code: "P2002" });
      nonces.push({ ...data, createdAt: new Date() });
      return data;
    }
  },
  user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, timezone: null }) },
  attendanceRecord: {
    findUnique: async ({ where }: { where: { userId_workDate: { userId: string; workDate: Date } } }) =>
      records.some((r) => r.userId === where.userId_workDate.userId && r.workDate.getTime() === where.userId_workDate.workDate.getTime()) ? { id: "r", punchInAt: new Date(), source: "WEB" } : null
  }
};

vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => (client as Record<string, unknown>)[key] }) }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId, orgSlug: orgId }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/attendance-settings.service.js", () => ({ getAttendanceSettings: async () => ({ kioskEnabled, punchInFaceRequired: false, faceFailureRule: "BLOCK" }) }));
vi.mock("../../src/services/attendance-ingest.service.js", () => ({ ingestPunch: (input: unknown) => ingest(input) }));
vi.mock("../../src/services/attendance-punch.service.js", () => ({ isAttendanceOn: async () => attendanceOn, resolveFace: (s: unknown, i: unknown) => faceFn(s, i) }));
vi.mock("../../src/services/attendance-shift.service.js", () => ({ currentWorkDay: async () => ({ dateKey: "2026-11-24" }) }));

const svc = await import("../../src/services/attendance-kiosk.service.js");

const NOW = new Date("2026-11-24T04:00:10Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const punch = (userId: string, code: unknown, now = NOW) => svc.kioskPunch({ userId, code, ip: null, userAgent: null, now });

beforeEach(() => {
  kiosks = [];
  nonces = [];
  records = [];
  orgId = "org-1";
  kioskEnabled = true;
  attendanceOn = true;
  ingest.mockClear();
  faceFn.mockClear();
});

async function device(siteId: string | null = "site-hq") {
  return svc.createKiosk({ name: "Front door", siteId }, "sa");
}

describe("devices", () => {
  it("stores only the token's hash, and authenticates by it", async () => {
    const { token } = await device();
    expect(kiosks[0].tokenHash).toBe(svc.hashKioskToken(token));
    expect(JSON.stringify(kiosks[0])).not.toContain(token);
    await expect(svc.authenticateKiosk(token, NOW)).resolves.toMatchObject({ name: "Front door" });
    await expect(svc.authenticateKiosk("tsk_nope", NOW)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("refuses an unknown site", async () => {
    await expect(svc.createKiosk({ name: "x", siteId: "ghost" }, "sa")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rotate retires the old token and every code it signed", async () => {
    const { kiosk, token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    const rotated = await svc.rotateKiosk(kiosk.id, "sa");
    await expect(svc.authenticateKiosk(token, NOW)).rejects.toMatchObject({ statusCode: 401 });
    await expect(svc.authenticateKiosk(rotated.token, NOW)).resolves.toBeTruthy();
    await expect(punch("emp", code)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("the punch", () => {
  it("punches through ingest as KIOSK with the kiosk's site as the label and no location", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    const r = await punch("emp", code, later(5000));
    expect(r).toMatchObject({ created: true, siteName: "HQ" });
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ kind: "KIOSK", userId: "emp", evidence: expect.objectContaining({ siteLabel: "HQ", siteFlagged: false, lat: null, lng: null }) }));
    expect(faceFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a forged signature", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    const [payload, sig] = code.split(".");
    const flipped = `${payload}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;
    await expect(punch("emp", flipped)).rejects.toMatchObject({ statusCode: 422 });
    // A payload edited to another window keeps the old signature: refused too.
    const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const edited = Buffer.from(JSON.stringify({ ...body, w: 1 })).toString("base64url");
    await expect(punch("emp", `${edited}.${sig}`)).rejects.toMatchObject({ statusCode: 422 });
    await expect(punch("emp", "garbage")).rejects.toMatchObject({ statusCode: 422 });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("accepts the previous window, refuses older ones", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    await expect(punch("a", code, later(svc.KIOSK_WINDOW_MS))).resolves.toMatchObject({ created: true });
    await expect(punch("b", code, later(svc.KIOSK_WINDOW_MS * 2 + 1))).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("expired") });
  });

  it("a code is single use across everyone: a second person with the same code is refused", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    await punch("emp", code);
    await expect(punch("someone-else", code)).rejects.toMatchObject({ statusCode: 409, code: "KIOSK_CODE_USED" });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("the kiosk learns when its code was used, so it can show a fresh one", async () => {
    const { token } = await device();
    const { code, nonce } = await svc.issueKioskCode(token, NOW);
    await expect(svc.kioskCodeUsed(token, nonce, NOW)).resolves.toEqual({ used: false });
    await punch("emp", code);
    await expect(svc.kioskCodeUsed(token, nonce, NOW)).resolves.toEqual({ used: true });
    await expect(svc.kioskCodeUsed("tsk_nope", nonce, NOW)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("a code is single use per person", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    await punch("emp", code);
    await expect(punch("emp", code)).rejects.toMatchObject({ statusCode: 409 });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("refuses a revoked device's codes and its token", async () => {
    const { kiosk, token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    await svc.revokeKiosk(kiosk.id, "sa", NOW);
    await expect(punch("emp", code)).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("switched off") });
    await expect(svc.issueKioskCode(token, NOW)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("a code from another tenant never verifies", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    orgId = "org-2"; // same kiosk id and salt, another workspace (Host): another key
    await expect(punch("emp", code)).rejects.toMatchObject({ statusCode: 422 });
    kiosks = []; // the usual case: the row is not in the other tenant's database at all
    await expect(punch("emp", code)).rejects.toMatchObject({ statusCode: 422 });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("is idempotent once the day has a punch, without a face check", async () => {
    const { token } = await device();
    records.push({ userId: "emp", workDate: new Date("2026-11-24T00:00:00Z") });
    const { code } = await svc.issueKioskCode(token, NOW);
    await expect(punch("emp", code)).resolves.toMatchObject({ created: false });
    expect(faceFn).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("is OFF by default: setting off or attendance off refuses codes and punches", async () => {
    const { token } = await device();
    const { code } = await svc.issueKioskCode(token, NOW);
    kioskEnabled = false;
    await expect(svc.issueKioskCode(token, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(punch("emp", code)).rejects.toMatchObject({ statusCode: 403 });
    kioskEnabled = true;
    attendanceOn = false;
    await expect(svc.isKioskOn()).resolves.toBe(false);
  });
});
