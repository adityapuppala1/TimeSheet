/**
 * Attendance, leave & holidays (V17) — workspace settings and the module gate.
 *
 * Same two-key gate as change management: the workspace toggle (GlobalAttendanceSettings.
 * attendanceEnabled) AND the plan entitlement (PlanTierLimit.attendanceEnabled). The admin
 * settings routes only need the ENTITLEMENT half — an admin has to be able to configure the module
 * before switching it on — so the two are separate functions rather than one with a flag.
 */
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { lazyCreateSettings } from "../utils/lazy-create-settings.js";
import { getPlanningEntitlements, isPlanningCapabilityAllowed } from "./plan-limits.service.js";

const SETTINGS_ID = "global";

/** Upserted on read, like every other Global*Settings singleton. Every field defaults OFF. */
export async function getAttendanceSettings() {
  return lazyCreateSettings(
    () => prisma.globalAttendanceSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } }),
    () => prisma.globalAttendanceSettings.findUnique({ where: { id: SETTINGS_ID } })
  );
}

/** The four attendance entitlements, for the settings screen's locked/upgrade states. */
export async function getAttendanceEntitlements() {
  const all = await getPlanningEntitlements(requireTenantContext().orgId);
  return {
    attendanceEnabled: all.attendanceEnabled,
    leaveManagementEnabled: all.leaveManagementEnabled,
    attendanceIntegrationsEnabled: all.attendanceIntegrationsEnabled,
    attendanceAiInsightsEnabled: all.attendanceAiInsightsEnabled
  };
}

/** Refuses with the commercial message when the plan lacks attendance. Used by every admin write. */
export async function assertAttendanceEntitled(): Promise<void> {
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "attendanceEnabled"))) {
    throw new AppError(403, "Attendance & Leave is not included in this plan. Upgrade to Team or Enterprise to use it.");
  }
}

/* ------------------------------------------------------------------ *
 * Validation
 *
 * Every field optional and `.strict()`: a PUT carries only what the admin changed, and an unknown
 * key is a client bug worth a 422 rather than a silently ignored column. No z.coerce anywhere —
 * validate() discards its parse, so the handler sees the raw body; JSON already carries real
 * numbers and booleans, which is what these schemas demand.
 * ------------------------------------------------------------------ */

export const attendanceSettingsBody = z
  .object({
    attendanceEnabled: z.boolean(),
    punchInMode: z.enum(["OFF", "OPTIONAL", "MANDATORY"]),
    locationMode: z.enum(["OFF", "OPTIONAL", "REQUIRED"]),
    punchInFaceRequired: z.boolean(),
    faceFailureRule: z.enum(["BLOCK", "ALLOW_FLAGGED"]),
    punchInReminderHour: z.number().int().min(0).max(23),
    punchInReminderEnabled: z.boolean(),
    missedDayReasonEnabled: z.boolean(),
    aiInsightsSelf: z.boolean(),
    aiInsightsManager: z.boolean(),
    aiInsightsOrg: z.boolean(),
    // Below 3 an "average" identifies a person; 3 is the floor, not a recommendation.
    minGroupSize: z.number().int().min(3).max(100),
    // V17 A6: how long an AI suggestion set is reused, and the opt-in lateness measure.
    aiInsightsFrequency: z.enum(["DAILY", "WEEKLY"]),
    latenessEnabled: z.boolean(),
    // Minutes after local midnight; 5:00-14:00 covers every sane office start.
    expectedStartMinute: z.number().int().min(300).max(840),
    locationConsentText: z.string().trim().max(2000).nullable(),
    locationRetentionDays: z.number().int().min(1).max(3650),
    // A3 conflict priorities for sourceless punches (attendance-ingest.service.ts#rankOf).
    apiPriority: z.number().int().min(-1000).max(5000),
    webPriority: z.number().int().min(-1000).max(5000),
    mcpPriority: z.number().int().min(-1000).max(5000),
    csvPriority: z.number().int().min(-1000).max(5000)
  })
  .partial()
  .strict();

export type AttendanceSettingsInput = z.infer<typeof attendanceSettingsBody>;

/** AI insight toggles need their own entitlement; the rest only need attendance itself. */
export const AI_INSIGHT_KEYS = ["aiInsightsSelf", "aiInsightsManager", "aiInsightsOrg"] as const;

/** YYYY-MM-DD, and a real calendar day (2027-02-30 is refused, not rolled into March). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real date");

export const calendarBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    isDefault: z.boolean().optional()
  })
  .strict();

export const holidayBody = z
  .object({
    date: isoDate,
    name: z.string().trim().min(1).max(120),
    isOptional: z.boolean().optional()
  })
  .strict();

export const reasonOptionBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Upper-case letters, digits and underscores"),
    label: z.string().trim().min(1).max(120),
    enabled: z.boolean().optional(),
    order: z.number().int().min(0).max(10000).optional(),
    requiresNote: z.boolean().optional()
  })
  .strict();

/** A DATE column round-trips as midnight UTC; the client only ever wants the calendar day. */
export function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
