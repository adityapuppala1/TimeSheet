/**
 * Attendance (V17 A2) — the employee half: "what is my day?" and "punch me in".
 *
 * THE GATE: workspace toggle AND plan entitlement, like change management. Two forms of the same
 * predicate for the same reason change.service.ts has two: the pop-up's status read is made by
 * every signed-in person on every page load, so "attendance is off" must be a normal 200 answer
 * there (isAttendanceOn), while the punch itself refuses with a message naming what is off
 * (assertAttendanceOn).
 *
 * WHAT A NON-ADMIN SEES: only what the pop-up needs to run its steps (mode, location mode, whether
 * face is required, the consent wording). Never the reminder hour, AI toggles, retention or group
 * size — those are admin configuration, and GET /api/attendance/admin/settings stays admin-only.
 *
 * IDEMPOTENT BY CONSTRUCTION: AttendanceRecord is unique on (userId, workDate). A second punch the
 * same day — a double click, two tabs, a biometric punch that arrived first — returns the existing
 * row and never consumes a face verification or rewrites evidence. The P2002 catch covers the race
 * where two requests both saw "no record yet".
 */
import type { AttendanceRecord, AttendanceSourceKind } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { resolveDayStatus, type AttendanceDayStatus } from "./attendance-day-status.js";
import { consumeVerification, getFaceSettings, isFaceFeatureAllowedForOrg } from "./face.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";
import { audit } from "./audit.service.js";
import { ingestPunch } from "./attendance-ingest.service.js";
import { enabledSites, OUTSIDE_SITES, siteLabelFor } from "./attendance-site.service.js";
import { currentWorkDay, publicShift } from "./attendance-shift.service.js";
import { loadApprovedLeave, type LeaveLookup, type LeaveOnDay } from "./leave-query.service.js";

/** Shown when the admin left locationConsentText empty. Plain about what is kept and for how long. */
export const DEFAULT_LOCATION_CONSENT =
  "When you punch in, your workspace records your approximate location, network address and browser so attendance can be verified. It is kept for a limited time set by your administrator and is visible only to people who manage attendance.";

const SOURCE_LABELS: Record<AttendanceSourceKind, string> = {
  WEB: "Web",
  API: "API",
  WEBHOOK: "Integration",
  MCP: "AI assistant",
  CSV: "Import",
  REGULARIZATION: "Correction"
};

export async function isAttendanceOn(): Promise<boolean> {
  const settings = await getAttendanceSettings();
  if (!settings?.attendanceEnabled) return false;
  return isPlanningCapabilityAllowed(requireTenantContext().orgId, "attendanceEnabled");
}

export async function assertAttendanceOn(): Promise<void> {
  const settings = await getAttendanceSettings();
  if (!settings?.attendanceEnabled) {
    throw new AppError(403, "Attendance is off for this workspace. A super admin can enable it in Workspace Settings → Attendance & Leave.");
  }
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "attendanceEnabled"))) {
    throw new AppError(403, "Attendance & Leave is not included in this plan. Upgrade to Team or Enterprise to use it.");
  }
}

/**
 * Approved leave covering the day, with the half taken (V17 Phase B). A thin wrapper over
 * leave-query.service.ts so every Phase A caller kept its import.
 */
export async function findLeaveForDay(userId: string, dateKey: string): Promise<LeaveOnDay | null> {
  return (await loadApprovedLeave([userId], dateKey, dateKey))(userId, dateKey);
}

/**
 * Approved leave for many people over a date range, as a lookup (V17 A5 shape, Phase B data). ONE
 * query however many people — Team Activity judges a whole team's day at once.
 */
export async function findLeaveInRange(userIds: readonly string[], from: string, to: string): Promise<LeaveLookup> {
  return loadApprovedLeave(userIds, from, to);
}

/** The person's holiday on `dateKey`: their own calendar, else the workspace default. */
export async function findHoliday(holidayCalendarId: string | null, dateKey: string, userId?: string): Promise<{ name: string } | null> {
  const calendarId =
    holidayCalendarId ??
    (await prisma.holidayCalendar.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id ??
    null;
  if (!calendarId) return null;
  const holiday = await prisma.holiday.findFirst({
    where: { calendarId, date: new Date(`${dateKey}T00:00:00Z`) },
    select: { id: true, name: true, isOptional: true }
  });
  if (!holiday) return null;
  // 7.0.0: an optional holiday is a holiday only for someone who opted into it.
  if (holiday.isOptional) {
    if (!userId) return null;
    const opted = await prisma.holidayOptIn.findUnique({ where: { userId_holidayId: { userId, holidayId: holiday.id } }, select: { id: true } });
    if (!opted) return null;
  }
  return { name: holiday.name };
}

/**
 * Face is required for a punch only when the attendance setting asks for it AND face verification
 * is switched on AND the plan includes it. The entitlement half fails OPEN, the same rule as
 * isFaceVerificationRequired: a billing change must not lock everyone out of punching in.
 */
export async function isPunchInFaceRequired(punchInFaceRequired: boolean): Promise<boolean> {
  if (!punchInFaceRequired) return false;
  const face = await getFaceSettings();
  if (!face?.enabled) return false;
  return isFaceFeatureAllowedForOrg();
}

export function publicRecord(record: (AttendanceRecord & { sourceRef?: { name: string } | null }) | null) {
  if (!record) return null;
  return {
    id: record.id,
    workDate: record.workDate.toISOString().slice(0, 10),
    punchInAt: record.punchInAt.toISOString(),
    punchOutAt: record.punchOutAt?.toISOString() ?? null,
    source: record.source,
    // A named integration ("Front door biometric") says more than its kind ever could.
    sourceLabel: record.sourceRef?.name ?? SOURCE_LABELS[record.source],
    flagged: record.flagged,
    faceVerified: Boolean(record.faceAttemptId) && !record.flagged,
    hasLocation: record.lat != null && record.lng != null,
    /** 7.0.0: "At <site>" / "Outside work sites"; never a coordinate. */
    siteLabel: record.siteLabel ?? null
  };
}

export type PunchStep = "LOCATION" | "FACE";

export interface MyTodayResponse {
  enabled: boolean;
  punchInMode?: "OFF" | "OPTIONAL" | "MANDATORY";
  locationMode?: "OFF" | "OPTIONAL" | "REQUIRED";
  faceRequired?: boolean;
  faceFailureRule?: "BLOCK" | "ALLOW_FLAGGED";
  consentText?: string;
  consentNeeded?: boolean;
  dateKey?: string;
  status?: AttendanceDayStatus;
  isWorkingDay?: boolean;
  holidayName?: string | null;
  /** Only when the admin turned lateness on: the confirmation may say how late (informational). */
  latenessEnabled?: boolean;
  expectedStartMinute?: number;
  /** 7.0.0: the person's shift for this work date; null = the workspace day. */
  shift?: ReturnType<typeof publicShift>;
  /** 7.0.0: corrections can be asked for (and how far back). Absent while they are off. */
  regularization?: { enabled: true; maxDaysBack: number };
  record?: ReturnType<typeof publicRecord>;
  steps?: PunchStep[];
}

async function loadUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, holidayCalendarId: true, attendanceLocationConsentAt: true }
  });
  if (!user) throw new AppError(404, "User not found");
  return user;
}

export async function getMyToday(userId: string, now: Date = new Date()): Promise<MyTodayResponse> {
  if (!(await isAttendanceOn())) return { enabled: false };
  const [settings, planning, user] = await Promise.all([getAttendanceSettings(), getPlanningSettings(), loadUser(userId)]);
  const { dateKey, shift } = await currentWorkDay(userId, now, user.timezone, serverTimezone);
  const [holiday, leave, record, faceRequired] = await Promise.all([
    findHoliday(user.holidayCalendarId, dateKey, userId),
    findLeaveForDay(userId, dateKey),
    prisma.attendanceRecord.findUnique({
      where: { userId_workDate: { userId, workDate: new Date(`${dateKey}T00:00:00Z`) } },
      include: { sourceRef: { select: { name: true } } }
    }),
    isPunchInFaceRequired(settings.punchInFaceRequired)
  ]);
  const day = resolveDayStatus({
    dateKey,
    workingDays: planning.workingDays,
    holiday,
    leave,
    punchedIn: Boolean(record),
    now,
    timeZone: user.timezone,
    fallbackZone: serverTimezone,
    shift
  });
  const steps: PunchStep[] = [];
  if (settings.locationMode !== "OFF") steps.push("LOCATION");
  if (faceRequired) steps.push("FACE");
  return {
    enabled: true,
    punchInMode: settings.punchInMode,
    locationMode: settings.locationMode,
    faceRequired,
    faceFailureRule: settings.faceFailureRule,
    consentText: settings.locationConsentText?.trim() || DEFAULT_LOCATION_CONSENT,
    consentNeeded: settings.locationMode !== "OFF" && !user.attendanceLocationConsentAt,
    dateKey,
    status: day.status,
    isWorkingDay: day.isWorkingDay,
    holidayName: day.holidayName,
    // A shift's start replaces the workspace start for lateness.
    ...(settings.latenessEnabled ? { latenessEnabled: true, expectedStartMinute: shift ? shift.startMinute : settings.expectedStartMinute } : {}),
    shift: publicShift(shift),
    ...(settings.regularizationEnabled ? { regularization: { enabled: true as const, maxDaysBack: settings.regularizationMaxDaysBack } } : {}),
    record: publicRecord(record),
    steps
  };
}

export interface PunchInInput {
  userId: string;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  consentAccepted?: boolean;
  verificationId?: string | null;
  ip: string | null;
  userAgent: string | null;
  now?: Date;
}

type PunchLocation = { lat: number; lng: number; accuracyM: number | null };

/** Location by mode. OFF stores nothing even if the client sent it — the admin said not to collect it. */
function resolveLocation(mode: "OFF" | "OPTIONAL" | "REQUIRED", input: PunchInInput, hasConsent: boolean): PunchLocation | null {
  if (mode === "OFF") return null;
  if (typeof input.lat !== "number" || typeof input.lng !== "number") {
    if (mode === "REQUIRED") {
      throw new AppError(422, "Your workspace requires your location to punch in. Allow location access in your browser and try again.");
    }
    return null;
  }
  if (!hasConsent && input.consentAccepted !== true) {
    throw new AppError(422, "Please accept the location notice before punching in.");
  }
  return { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM == null ? null : Math.round(input.accuracyM) };
}

/**
 * 7.0.0 work sites: the label for this punch and what the rule does with it. No sites (or no
 * location) = no label, and only BLOCK / ALLOW_FLAGGED ever act on that. Never a coordinate in the
 * message: "outside work sites" is all the person is told.
 */
async function resolveSite(rule: "OFF" | "BLOCK" | "ALLOW_FLAGGED", location: PunchLocation | null): Promise<{ label: string | null; flagged: boolean }> {
  const sites = await enabledSites();
  const label = siteLabelFor(location ?? { lat: null, lng: null }, sites);
  const atSite = label !== null && label !== OUTSIDE_SITES;
  if (rule === "OFF" || sites.length === 0 || atSite) return { label, flagged: false };
  if (rule === "BLOCK") {
    throw new AppError(422, location ? "You can punch in from the web only at a work site. You appear to be outside all of them." : "Your workspace needs your location to check you are at a work site. Allow location access and try again.", {
      code: "OUTSIDE_WORK_SITES"
    });
  }
  return { label: label ?? OUTSIDE_SITES, flagged: true };
}

/**
 * Face. Reuses the /face/verify flow: the client verifies with context PUNCH_IN and presents the
 * single-use id, which consumeVerification checks for owner, context, outcome, age and reuse.
 */
async function resolveFace(
  settings: { punchInFaceRequired: boolean; faceFailureRule: "BLOCK" | "ALLOW_FLAGGED" },
  input: PunchInInput
): Promise<{ faceAttemptId: string | null; flagged: boolean }> {
  if (!(await isPunchInFaceRequired(settings.punchInFaceRequired))) return { faceAttemptId: null, flagged: false };
  try {
    const id = await consumeVerification({ verificationId: input.verificationId, userId: input.userId, context: "PUNCH_IN" });
    return { faceAttemptId: id, flagged: false };
  } catch (error) {
    if (settings.faceFailureRule === "BLOCK" || !(error instanceof AppError)) throw error;
  }
  // ALLOW_FLAGGED: the punch stands, marked for review. Keep the failed attempt's id only when it
  // really is this person's PUNCH_IN attempt, so the reviewer can see the scores behind it.
  if (!input.verificationId) return { faceAttemptId: null, flagged: true };
  const attempt = await prisma.faceVerificationAttempt.findUnique({
    where: { id: input.verificationId },
    select: { userId: true, context: true }
  });
  const own = attempt?.userId === input.userId && attempt.context === "PUNCH_IN";
  return { faceAttemptId: own ? input.verificationId : null, flagged: true };
}

export async function punchIn(input: PunchInInput): Promise<{ created: boolean; record: NonNullable<ReturnType<typeof publicRecord>> }> {
  await assertAttendanceOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  if (settings.punchInMode === "OFF") {
    throw new AppError(403, "Punching in from the web is not enabled for this workspace.");
  }
  const user = await loadUser(input.userId);
  const { dateKey } = await currentWorkDay(input.userId, now, user.timezone, serverTimezone);
  const workDate = new Date(`${dateKey}T00:00:00Z`);
  const include = { sourceRef: { select: { name: true } } } as const;

  // Idempotency first: a second punch must not burn a face verification or overwrite evidence.
  const existing = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: input.userId, workDate } }, include });
  if (existing) return { created: false, record: publicRecord(existing)! };

  const location = resolveLocation(settings.locationMode, input, Boolean(user.attendanceLocationConsentAt));
  // Before the face check: a punch the site rule refuses must not burn a face verification.
  const site = await resolveSite(settings.requireSite ?? "OFF", location);
  const { faceAttemptId, flagged } = await resolveFace(settings, input);

  // Persisted through the single ingest path (attendance-ingest.service.ts) as a WEB event, so the
  // web punch is ranked, logged and conflict-resolved exactly like every other source. The gate was
  // checked above with the web's own messages.
  const result = await ingestPunch({
    kind: "WEB",
    userId: input.userId,
    person: { id: input.userId, timezone: user.timezone },
    punchInAt: now,
    now,
    gateChecked: true,
    evidence: {
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      accuracyM: location?.accuracyM ?? null,
      ip: input.ip,
      userAgent: input.userAgent,
      faceAttemptId,
      flagged,
      siteLabel: site.label,
      siteFlagged: site.flagged
    },
    beforeCreate: async (tx) => {
      if (location && !user.attendanceLocationConsentAt) {
        await tx.user.update({ where: { id: input.userId }, data: { attendanceLocationConsentAt: now } });
      }
    }
  });
  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: input.userId, workDate } }, include });
  if (!record) throw new AppError(409, "Your punch could not be recorded. Please try again.");
  // Lost a race (or to a higher-priority source that arrived between the check above and now):
  // the day already has its punch, which is the A2 contract for a second punch.
  if (!result.created) return { created: false, record: publicRecord(record)! };

  // Never the coordinates in the audit log: it is read far more widely than attendance is.
  await audit(input.userId, "attendance.punched_in", "AttendanceRecord", record.id, {
    workDate: dateKey,
    source: "WEB",
    hasLocation: Boolean(location),
    faceVerified: Boolean(faceAttemptId) && !flagged,
    flagged
  });
  return { created: true, record: publicRecord(record)! };
}

export interface PunchOutInput {
  userId: string;
  now?: Date;
}

/**
 * Punch out: stamps today's record with the time, through the same ingest path as every other
 * source (a WEB event, logged and merged by attendance-ingest.service.ts). Same gates as punch-in
 * (module on, web punching not OFF). Idempotent: a second call keeps the first punch-out. Refused
 * (409) when there is no punch-in today, or when today's record belongs to another source — a
 * biometric device owns its own punch-out and must not be overwritten from the browser.
 */
export async function punchOut(input: PunchOutInput): Promise<{ updated: boolean; record: NonNullable<ReturnType<typeof publicRecord>> }> {
  await assertAttendanceOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  if (settings.punchInMode === "OFF") {
    throw new AppError(403, "Punching from the web is not enabled for this workspace.");
  }
  const user = await loadUser(input.userId);
  const { dateKey } = await currentWorkDay(input.userId, now, user.timezone, serverTimezone);
  const workDate = new Date(`${dateKey}T00:00:00Z`);
  const include = { sourceRef: { select: { name: true } } } as const;
  const existing = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: input.userId, workDate } }, include });
  if (!existing) throw new AppError(409, "You have not punched in today, so there is nothing to punch out of.");
  if (existing.punchOutAt) return { updated: false, record: publicRecord(existing)! };
  if (existing.source !== "WEB") {
    throw new AppError(409, `Today's punch came from ${publicRecord(existing)!.sourceLabel}; its punch-out is recorded there.`);
  }
  await ingestPunch({
    kind: "WEB",
    userId: input.userId,
    person: { id: input.userId, timezone: user.timezone },
    punchInAt: existing.punchInAt,
    punchOutAt: now,
    now,
    gateChecked: true
  });
  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: input.userId, workDate } }, include });
  if (!record) throw new AppError(409, "Your punch-out could not be recorded. Please try again.");
  await audit(input.userId, "attendance.punched_out", "AttendanceRecord", record.id, { workDate: dateKey, source: "WEB" });
  return { updated: true, record: publicRecord(record)! };
}

/** The person's holiday list (own calendar, else the default) over [from, to], for the Holidays screen. */
export async function getMyHolidays(userId: string, from: string, to: string) {
  const user = await loadUser(userId);
  const calendar = user.holidayCalendarId
    ? await prisma.holidayCalendar.findUnique({ where: { id: user.holidayCalendarId }, select: { id: true, name: true } })
    : await prisma.holidayCalendar.findFirst({ where: { isDefault: true }, select: { id: true, name: true } });
  if (!calendar) return { calendar: null, from, to, holidays: [], maxOptionalPerYear: null, optionalTakenByYear: {} };
  const rows = await prisma.holiday.findMany({
    where: { calendarId: calendar.id, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
    orderBy: { date: "asc" },
    select: { id: true, date: true, name: true, isOptional: true }
  });
  // 7.0.0: which optional holidays this person took, and the calendar's yearly cap.
  const [cap, optIns] = await Promise.all([
    prisma.holidayCalendar.findUnique({ where: { id: calendar.id }, select: { maxOptionalPerYear: true } }),
    prisma.holidayOptIn.findMany({ where: { userId, holiday: { calendarId: calendar.id } }, select: { holidayId: true, holiday: { select: { date: true } } } })
  ]);
  const opted = new Set(optIns.map((o) => o.holidayId));
  const optionalTakenByYear: Record<string, number> = {};
  for (const o of optIns) {
    const y = String(o.holiday.date.getUTCFullYear());
    optionalTakenByYear[y] = (optionalTakenByYear[y] ?? 0) + 1;
  }
  return {
    calendar,
    from,
    to,
    maxOptionalPerYear: cap?.maxOptionalPerYear ?? null,
    optionalTakenByYear,
    holidays: rows.map((h) => ({
      id: h.id,
      date: h.date.toISOString().slice(0, 10),
      name: h.name,
      isOptional: h.isOptional,
      optedIn: h.isOptional && opted.has(h.id)
    }))
  };
}
