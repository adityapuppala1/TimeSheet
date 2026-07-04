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
  AUDIT_VIEW: "audit:view",
  TICKETS_VIEW: "tickets:view",
  TICKETS_WRITE: "tickets:write",
  TICKETS_ASSIGN: "tickets:assign",
  TICKETS_MANAGE: "tickets:manage"
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
  ticketId?: string;
}

/** Admin-editable — the actual list of active types lives in the TicketType table (`ticketTypeApi.list()`). */
export type TicketType = string;

export const ticketPriorities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type TicketPriority = (typeof ticketPriorities)[number];

export const ticketStatuses = ["OPEN", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

/** Valid forward/backward moves for the ticket workflow. Shared so the API can enforce it and the UI can restrict the status picker to the same set. */
export const ticketStatusTransitions: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["IN_PROGRESS"],
  IN_PROGRESS: ["IN_REVIEW", "OPEN"],
  IN_REVIEW: ["RESOLVED", "IN_PROGRESS"],
  RESOLVED: ["CLOSED", "REOPENED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["IN_PROGRESS"]
};

export interface TicketInput {
  projectId: string;
  moduleId?: string;
  type: TicketType;
  title: string;
  description?: string;
  priority: TicketPriority;
  assigneeId?: string;
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
  emailTicketAssigned: boolean;
  emailTicketStatusChanged: boolean;
  emailTicketCommented: boolean;
  emailTicketSlaBreach: boolean;
  emailTicketEscalation: boolean;
  emailTicketNeedsReview: boolean;
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
  "emailDailyEscalation",
  "emailTicketAssigned",
  "emailTicketStatusChanged",
  "emailTicketCommented",
  "emailTicketSlaBreach",
  "emailTicketEscalation",
  "emailTicketNeedsReview"
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

/** Workspace-wide ticket SLA hours + opt-in analytics toggles. */
export interface GlobalTicketSettings {
  slaLowHours: number;
  slaMediumHours: number;
  slaHighHours: number;
  slaCriticalHours: number;
  /** Off by default — needs User.hourlyRate populated to be meaningful. */
  enableCostAnalytics: boolean;
  /** Off by default — per-person resolution/velocity rankings. */
  enableLeaderboard: boolean;
  updatedAt: string;
  updatedById: string | null;
}

/** Selectable models for AI features, cheapest/fastest first. */
export const aiModels = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest & cheapest" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" }
] as const;

/** Master + per-feature AI toggles. `aiEnabled` is the workspace-wide kill switch. */
export interface GlobalAISettings {
  aiEnabled: boolean;
  autoTriageEnabled: boolean;
  autoTriageAutoApply: boolean;
  duplicateDetectionEnabled: boolean;
  writingAssistantEnabled: boolean;
  commentSummaryEnabled: boolean;
  workspaceSearchEnabled: boolean;
  emailIngestionEnabled: boolean;
  weeklyDigestEnabled: boolean;
  model: string;
  confidenceThreshold: number;
  monthlyBudgetUsd: number | null;
  updatedAt: string;
  updatedById: string | null;
  /** Read-only. Whether ANTHROPIC_API_KEY is set server-side — toggles do nothing until this is true. */
  apiKeyConfigured: boolean;
}

export const emailMatchTypes = ["TO_ADDRESS", "TO_PLUS_TAG", "SUBJECT_PREFIX"] as const;
export type EmailMatchType = (typeof emailMatchTypes)[number];

/** Workspace-wide IMAP mailbox connection + polling cadence for email-to-ticket ingestion. */
export interface EmailIntakeSettings {
  imapHost: string | null;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string | null;
  /** Read-only. Whether an IMAP password is currently saved — the actual value is never returned. */
  imapPasswordSet: boolean;
  pollIntervalMinutes: number;
  fallbackProjectId: string | null;
  lastPolledAt: string | null;
  lastPollError: string | null;
  updatedAt: string;
  updatedById: string | null;
}

export interface EmailRoutingRuleRow {
  id: string;
  matchType: EmailMatchType;
  matchValue: string;
  projectId: string;
  project: { id: string; name: string; code: string };
  defaultModuleId: string | null;
  defaultModule: { id: string; name: string } | null;
  isActive: boolean;
  createdAt: string;
}

export interface ModuleAssigneeRuleRow {
  id: string;
  moduleId: string;
  module: { id: string; name: string; projectId: string };
  defaultAssigneeId: string;
  defaultAssignee: { id: string; name: string; email: string };
  createdAt: string;
}

export function calculateHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const minutes = eh * 60 + em - (sh * 60 + sm);
  return Math.max(0, Math.round((minutes / 60) * 100) / 100);
}
