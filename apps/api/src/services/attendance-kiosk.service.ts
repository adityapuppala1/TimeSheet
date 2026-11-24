/**
 * 7.0.0 kiosk / QR punch. OFF by default (GlobalAttendanceSettings.kioskEnabled, and attendance on).
 *
 * DEVICE. A super admin creates a kiosk (optionally bound to an AttendanceSite) and is shown its
 * device token ONCE. Only the token's SHA-256 is stored. Rotate replaces the hash and the signing
 * salt (the old token and every code it signed stop at once); revoke stamps revokedAt.
 *
 * CODE. The kiosk page, authenticated by the device token, fetches a code every ~30 s and shows it
 * as a QR. A code is `base64url({k: kioskId, w: window, n: nonce}).base64url(HMAC-SHA256)`, where
 * window = floor(epoch ms / 30 s) and the key is derived from the server's ENCRYPTION_KEY, the
 * TENANT's org id, the kiosk id and the kiosk's salt. The tenant is resolved from the Host, so a
 * code minted for one workspace can never verify in another: the kiosk row is not there, and even a
 * colliding id would derive a different key.
 *
 * PUNCH. A signed-in person scans the QR on their own phone; the punch page sends the code. The API
 * checks the signature (constant time), that the window is the current or the previous one, that
 * the kiosk is not revoked, and records the nonce per person (unique) so the same code cannot be
 * replayed. It then punches through ingestPunch with source KIOSK.
 *
 * RULES. Being at the kiosk is the presence check: a kiosk punch SATISFIES requireSite (it is never
 * blocked or flagged by it), carries no location and its site label is the kiosk's site name (none
 * for an unbound kiosk). FACE applies exactly as for the web punch: when punchInFaceRequired is on
 * (and face verification is on and in the plan) the phone runs the same PUNCH_IN face check and
 * sends the single-use verificationId; faceFailureRule BLOCK refuses, ALLOW_FLAGGED records the punch
 * flagged. The kiosk device itself never sees a face.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { env, serverTimezone } from "../config/env.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { ingestPunch } from "./attendance-ingest.service.js";
import { isAttendanceOn, resolveFace } from "./attendance-punch.service.js";
import { currentWorkDay } from "./attendance-shift.service.js";

export const KIOSK_WINDOW_MS = 30_000;
const NONCE_TTL_MS = 10 * 60_000;

export const hashKioskToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

type KioskRow = { id: string; name: string; siteId: string | null; keySalt: string; revokedAt: Date | null; site?: { name: string } | null };

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

export async function isKioskOn(): Promise<boolean> {
  if (!(await isAttendanceOn())) return false;
  return Boolean((await getAttendanceSettings())?.kioskEnabled);
}

export async function assertKioskOn(): Promise<void> {
  if (!(await isKioskOn())) throw new AppError(403, "Kiosk punch-in is not enabled for this workspace.", { code: "KIOSK_OFF" });
}

/* ------------------------------------------------------------------ *
 * Devices (super admin)
 * ------------------------------------------------------------------ */

export function publicKiosk(k: KioskRow & { tokenHint: string; lastSeenAt: Date | null; createdAt: Date }) {
  return { id: k.id, name: k.name, siteId: k.siteId, siteName: k.site?.name ?? null, tokenHint: k.tokenHint, revoked: Boolean(k.revokedAt), revokedAt: k.revokedAt, lastSeenAt: k.lastSeenAt, createdAt: k.createdAt };
}

const include = { site: { select: { name: true } } } as const;

async function assertSite(siteId: string | null | undefined): Promise<void> {
  if (!siteId) return;
  if (!(await prisma.attendanceSite.findUnique({ where: { id: siteId }, select: { id: true } }))) throw new AppError(422, "Unknown work site.", { code: "UNKNOWN_SITE" });
}

function newToken() {
  const token = `tsk_${randomBytes(32).toString("hex")}`;
  return { token, tokenHash: hashKioskToken(token), tokenHint: token.slice(4, 10), keySalt: randomBytes(16).toString("hex") };
}

export async function listKiosks() {
  const rows = await prisma.attendanceKiosk.findMany({ orderBy: { createdAt: "asc" }, include });
  return rows.map(publicKiosk);
}

export async function createKiosk(input: { name: string; siteId?: string | null }, actorId: string) {
  await assertSite(input.siteId);
  const t = newToken();
  const row = await prisma.attendanceKiosk.create({ data: { name: input.name, siteId: input.siteId ?? null, tokenHash: t.tokenHash, tokenHint: t.tokenHint, keySalt: t.keySalt, createdById: actorId }, include });
  await audit(actorId, "attendance.kiosk_created", "AttendanceKiosk", row.id, { name: row.name, siteId: row.siteId });
  return { kiosk: publicKiosk(row), token: t.token };
}

export async function updateKiosk(id: string, input: { name?: string; siteId?: string | null }, actorId: string) {
  await assertSite(input.siteId);
  if (!(await prisma.attendanceKiosk.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, "Kiosk not found");
  const row = await prisma.attendanceKiosk.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.siteId === undefined ? {} : { siteId: input.siteId }) }, include });
  await audit(actorId, "attendance.kiosk_updated", "AttendanceKiosk", id, input);
  return publicKiosk(row);
}

/** New token AND new signing salt; un-revokes. The old token and its codes stop at once. */
export async function rotateKiosk(id: string, actorId: string) {
  if (!(await prisma.attendanceKiosk.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, "Kiosk not found");
  const t = newToken();
  const row = await prisma.attendanceKiosk.update({ where: { id }, data: { tokenHash: t.tokenHash, tokenHint: t.tokenHint, keySalt: t.keySalt, revokedAt: null }, include });
  await audit(actorId, "attendance.kiosk_rotated", "AttendanceKiosk", id);
  return { kiosk: publicKiosk(row), token: t.token };
}

export async function revokeKiosk(id: string, actorId: string, now = new Date()) {
  const result = await prisma.attendanceKiosk.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
  if (result.count === 0 && !(await prisma.attendanceKiosk.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, "Kiosk not found");
  await audit(actorId, "attendance.kiosk_revoked", "AttendanceKiosk", id);
}

/* ------------------------------------------------------------------ *
 * Codes
 * ------------------------------------------------------------------ */

function signingKey(kiosk: Pick<KioskRow, "id" | "keySalt">): Buffer {
  const orgId = requireTenantContext().orgId;
  return createHmac("sha256", Buffer.from(env.ENCRYPTION_KEY, "hex")).update(`kiosk-qr|${orgId}|${kiosk.id}|${kiosk.keySalt}`).digest();
}

const windowOf = (now: Date) => Math.floor(now.getTime() / KIOSK_WINDOW_MS);

/** Pure-ish: signs one code for this kiosk and window. */
export function signKioskCode(kiosk: Pick<KioskRow, "id" | "keySalt">, window: number, nonce = randomBytes(12).toString("hex")): string {
  const payload = b64url(JSON.stringify({ k: kiosk.id, w: window, n: nonce }));
  const sig = createHmac("sha256", signingKey(kiosk)).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

/** The device token → its kiosk. Same 401 for unknown and revoked: a device learns nothing else. */
export async function authenticateKiosk(token: string | undefined | null, now = new Date()) {
  if (!token || token.length > 200) throw new AppError(401, "This kiosk is not registered. Ask an administrator for a new device token.", { code: "KIOSK_UNAUTHORIZED" });
  const kiosk = await prisma.attendanceKiosk.findUnique({ where: { tokenHash: hashKioskToken(token) }, include });
  if (!kiosk || kiosk.revokedAt) throw new AppError(401, "This kiosk is not registered. Ask an administrator for a new device token.", { code: "KIOSK_UNAUTHORIZED" });
  // At most one write a minute per device.
  if (!kiosk.lastSeenAt || now.getTime() - kiosk.lastSeenAt.getTime() > 60_000) {
    await prisma.attendanceKiosk.update({ where: { id: kiosk.id }, data: { lastSeenAt: now } });
  }
  return kiosk;
}

/** What the kiosk screen shows: the code (for the QR), when it rotates, and its own labels. */
export async function issueKioskCode(token: string | undefined | null, now = new Date()) {
  await assertKioskOn();
  const kiosk = await authenticateKiosk(token, now);
  const window = windowOf(now);
  const expiresAt = new Date((window + 1) * KIOSK_WINDOW_MS);
  return { code: signKioskCode(kiosk, window), expiresAt: expiresAt.toISOString(), refreshInMs: Math.max(1000, expiresAt.getTime() - now.getTime()), kioskName: kiosk.name, siteName: kiosk.site?.name ?? null };
}

const invalid = () => new AppError(422, "This code is not valid. Scan the code on the kiosk again.", { code: "KIOSK_CODE_INVALID" });

/** Signature, window (current or previous) and device. Returns the kiosk and the nonce. */
export async function verifyKioskCode(code: unknown, now = new Date()) {
  if (typeof code !== "string" || code.length > 400) throw invalid();
  const [payload, sig, extra] = code.split(".");
  if (!payload || !sig || extra !== undefined) throw invalid();
  let parsed: { k?: unknown; w?: unknown; n?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    throw invalid();
  }
  const { k, w, n } = parsed;
  if (typeof k !== "string" || k.length > 64 || typeof w !== "number" || !Number.isInteger(w) || typeof n !== "string" || !/^[0-9a-f]{8,32}$/.test(n)) throw invalid();
  const kiosk = await prisma.attendanceKiosk.findUnique({ where: { id: k }, include });
  if (!kiosk) throw invalid();
  const expected = createHmac("sha256", signingKey(kiosk)).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  if (kiosk.revokedAt) throw new AppError(422, "This kiosk has been switched off. Ask an administrator.", { code: "KIOSK_REVOKED" });
  const current = windowOf(now);
  if (w !== current && w !== current - 1) throw new AppError(422, "This code has expired. Scan the code on the kiosk again.", { code: "KIOSK_CODE_EXPIRED" });
  return { kiosk, nonce: n, window: w };
}

/* ------------------------------------------------------------------ *
 * Punch
 * ------------------------------------------------------------------ */

export interface KioskPunchInput {
  userId: string;
  code: unknown;
  verificationId?: string | null;
  ip: string | null;
  userAgent: string | null;
  now?: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

export async function kioskPunch(input: KioskPunchInput) {
  await assertKioskOn();
  const now = input.now ?? new Date();
  const { kiosk, nonce } = await verifyKioskCode(input.code, now);

  // Single use per person: the nonce row is unique on (person, kiosk, nonce).
  await prisma.attendanceKioskNonce.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - NONCE_TTL_MS) } } });
  try {
    await prisma.attendanceKioskNonce.create({ data: { kioskId: kiosk.id, userId: input.userId, nonce } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "This code has already been used. Scan the code on the kiosk again.", { code: "KIOSK_CODE_USED" });
    throw error;
  }

  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, timezone: true } });
  if (!user) throw new AppError(404, "User not found");
  const { dateKey } = await currentWorkDay(input.userId, now, user.timezone, serverTimezone);
  const workDate = new Date(`${dateKey}T00:00:00Z`);
  const existing = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: input.userId, workDate } }, select: { id: true, punchInAt: true, source: true } });
  // Already in today: nothing to do, and no face verification is burnt.
  if (existing) return { created: false, workDate: dateKey, punchInAt: existing.punchInAt, kioskName: kiosk.name, siteName: kiosk.site?.name ?? null };

  const settings = await getAttendanceSettings();
  const { faceAttemptId, flagged } = await resolveFace(settings, { userId: input.userId, verificationId: input.verificationId ?? null });
  const siteLabel = kiosk.site?.name ?? null;
  const result = await ingestPunch({
    kind: "KIOSK",
    userId: input.userId,
    person: { id: input.userId, timezone: user.timezone },
    punchInAt: now,
    now,
    gateChecked: true,
    externalRef: `KIOSK:${kiosk.id}:${nonce}`,
    // No location from a kiosk punch; the kiosk's site is the label and satisfies requireSite.
    evidence: { lat: null, lng: null, accuracyM: null, ip: input.ip, userAgent: input.userAgent, faceAttemptId, flagged, siteLabel, siteFlagged: false },
    rawPayload: { kioskId: kiosk.id }
  });
  if (result.created) {
    await audit(input.userId, "attendance.punched_in", "AttendanceRecord", result.recordId ?? dateKey, { workDate: dateKey, source: "KIOSK", kioskId: kiosk.id, faceVerified: Boolean(faceAttemptId) && !flagged, flagged });
  }
  return { created: result.created, workDate: dateKey, punchInAt: now, kioskName: kiosk.name, siteName: siteLabel };
}
