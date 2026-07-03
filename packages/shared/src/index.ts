export const roles = ["SUPER_ADMIN", "ADMIN", "MANAGER", "TEAM_LEAD", "EMPLOYEE"] as const;
export type RoleName = (typeof roles)[number];

export const activityTypes = [
  "Learning",
  "Code Study",
  "POC",
  "Documentation",
  "Development",
  "Demo",
  "Testing",
  "Meeting",
  "Bug Fixing",
  "Research",
  "Deployment",
  "Support"
] as const;

export type ActivityType = (typeof activityTypes)[number];

export const permissions = {
  USERS_MANAGE: "users:manage",
  PROJECTS_MANAGE: "projects:manage",
  TIMESHEETS_WRITE: "timesheets:write",
  TIMESHEETS_APPROVE: "timesheets:approve",
  REPORTS_VIEW: "reports:view",
  FORMS_CONFIGURE: "forms:configure",
  AUDIT_VIEW: "audit:view"
} as const;

export type Permission = (typeof permissions)[keyof typeof permissions];

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  permissions: Permission[];
  avatarUrl?: string | null;
  bio?: string | null;
  phoneNumber?: string | null;
  timezone?: string | null;
  managerId?: string | null;
  manager?: { id: string; name: string; email: string } | null;
}

export interface TimesheetInput {
  projectId: string;
  moduleId: string;
  submoduleId?: string;
  activityType: ActivityType;
  taskDescription: string;
  workDate: string;
  startTime: string;
  endTime: string;
  notes?: string;
}

/** Per-category email opt-ins, persisted on the workspace settings singleton. */
export interface NotificationPreferences {
  emailTimesheetSubmitted: boolean;
  emailTimesheetApproved: boolean;
  emailTimesheetRejected: boolean;
  emailSlaBreach: boolean;
  emailDeadlineReminder: boolean;
  emailEscalation: boolean;
  emailWeeklyDigest: boolean;
  emailDailyReminder: boolean;
  emailDailyEscalation: boolean;
}

export const notificationPreferenceKeys: ReadonlyArray<keyof NotificationPreferences> = [
  "emailTimesheetSubmitted",
  "emailTimesheetApproved",
  "emailTimesheetRejected",
  "emailSlaBreach",
  "emailDeadlineReminder",
  "emailEscalation",
  "emailWeeklyDigest",
  "emailDailyReminder",
  "emailDailyEscalation"
];

/** Workspace-wide settings: notification toggles + reminder schedule + BCC behavior. */
export interface GlobalSettings extends NotificationPreferences {
  dailyReminderHour: number;
  escalationReminderHour: number;
  remindOnWeekdaysOnly: boolean;
  bccSuperAdminOnAllEmails: boolean;
  updatedAt: string;
  /** Effective IANA timezone the API server is running in. Read-only. */
  serverTimezone: string;
  /** "UTC+05:30" formatted offset matching `serverTimezone` at the moment of the response. */
  serverUtcOffset: string;
  /** ISO timestamp of the server's current time — useful for client/server clock sanity checks. */
  serverNow: string;
}

export function calculateHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const minutes = eh * 60 + em - (sh * 60 + sm);
  return Math.max(0, Math.round((minutes / 60) * 100) / 100);
}
