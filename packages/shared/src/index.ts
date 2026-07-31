/**
 * WHAT: the single `@timesheet/shared` package — every type/constant that both `apps/api` and
 * `apps/web` need to agree on: roles/permission keys, activity types, ticket status/priority
 * enums + legal status transitions, plan-tier/chat-platform/email-match-type unions, and the
 * shape of settings objects like `GlobalAISettings`/`EmailIntakeSettings`/`ChatIntegrationRow`.
 * WHY this package exists at all: without it, the frontend and backend would each define their
 * own copy of e.g. `TicketStatus`, and the two copies would silently drift apart the first time
 * one side added a value the other didn't know about — importing from one shared source makes
 * that class of bug a compile error instead of a runtime surprise.
 * WHO imports this: nearly every file in both `apps/api/src` and `apps/web/src` that touches a
 * role, permission, ticket, or settings type.
 */
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

/** Ingest-only security-assessment types — see docs/ROADMAP.md's "Security assessment suite"
 *  section. SSAT = secrets scanning, SSCT = software supply-chain testing (SBOM/provenance),
 *  distinct from a plain CVE-only dependency check. VAPT is deliberately absent here — it's a
 *  periodic human-led assessment, not a per-finding type an automated webhook posts. */
/** Includes VAPT even though the CI ingestion webhook never accepts it as input (see
 *  devops-webhook.controller.ts's own hardcoded, VAPT-excluding type list) — this constant is
 *  the *display*-side source of truth (report rendering, the ticket Security tab), where a VAPT
 *  finding (uploaded via Workspace Settings, not the webhook) needs to render identically to
 *  the other 4 types. */
export const securityFindingTypes = ["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const;
export type SecurityFindingType = (typeof securityFindingTypes)[number];

export const securityFindingSeverities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type SecurityFindingSeverity = (typeof securityFindingSeverities)[number];

export const securityFindingStatuses = ["OPEN", "ACKNOWLEDGED", "FIXED", "ACCEPTED_RISK"] as const;
export type SecurityFindingStatus = (typeof securityFindingStatuses)[number];

export const securityFindingAiVerdicts = ["TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_REVIEW"] as const;
export type SecurityFindingAiVerdict = (typeof securityFindingAiVerdicts)[number];

export const testRunStatuses = ["PASSED", "FAILED", "RUNNING"] as const;
export type TestRunStatus = (typeof testRunStatuses)[number];

/** Manual repo/branch/PR linking on a ticket — see prisma/schema.prisma's TicketBranch model
 *  comment for why this is manual, not synced live from a git provider. */
export const ticketBranchPrStatuses = ["NONE", "OPEN", "MERGED", "CLOSED"] as const;
export type TicketBranchPrStatus = (typeof ticketBranchPrStatuses)[number];

/** Public REST API + outbound webhooks — see docs/ROADMAP.md's theme of the same name and
 *  docs/API.md's "Public API" section. Kept in sync manually with
 *  apps/api/src/services/webhook-dispatch.service.ts#WEBHOOK_EVENTS (that file is the source of
 *  truth server-side; this copy is what the settings UI's event checkboxes render from). */
export const outboundWebhookEvents = [
  "ticket.created",
  "ticket.status_changed",
  "ticket.closed",
  "timesheet.submitted",
  "timesheet.approved"
] as const;
export type OutboundWebhookEvent = (typeof outboundWebhookEvents)[number];
export const apiKeyScopes = ["READ", "WRITE"] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

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
  /** Ticket-close security/test-status digest — see docs/ROADMAP.md's security assessment suite. */
  emailTicketClosedDigest: boolean;
  /** AI weekly org-wide security digest to every ADMIN/SUPER_ADMIN — see
   *  workers/security-weekly-digest.worker.ts. Gated alongside GlobalAISettings.securityWeeklyDigestEnabled. */
  emailSecurityWeeklyDigest: boolean;
  /** Face (identity) verification lifecycle — see docs/FACE_VERIFICATION.md. None of these ever
   *  carry a captured image or a score; they link into the app where authorization is checked. */
  emailFaceEnrollmentRequired: boolean;
  emailFaceEnrollmentReminder: boolean;
  emailFaceVerificationFlagged: boolean;
  emailFaceReviewOverdue: boolean;
  emailFaceDataDeleted: boolean;
  emailFaceEntitlementLost: boolean;
  /** Weekly identity-assurance digest to every ADMIN/SUPER_ADMIN — deterministic stats, no AI. */
  emailIdentityWeeklyDigest: boolean;
  /** Monthly "what kept breaking" digest — see workers/bug-pattern-digest.worker.ts. Gated
   *  alongside GlobalAISettings.bugPatternDigestEnabled. */
  emailBugPatternDigest: boolean;
  /** AI-suggested next action when the SLA sweep flags a ticket as stale. Gated alongside
   *  GlobalAISettings.staleTicketNudgeEnabled. */
  emailTicketStaleNudge: boolean;
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
  "emailTicketNeedsReview",
  "emailTicketClosedDigest",
  "emailSecurityWeeklyDigest",
  "emailFaceEnrollmentRequired",
  "emailFaceEnrollmentReminder",
  "emailFaceVerificationFlagged",
  "emailFaceReviewOverdue",
  "emailFaceDataDeleted",
  "emailFaceEntitlementLost",
  "emailIdentityWeeklyDigest",
  "emailBugPatternDigest",
  "emailTicketStaleNudge"
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
  /** Off by default. When true, a ticket can't move to RESOLVED while its latest ingested
   *  TestRun is FAILED — see docs/ROADMAP.md's "Auto testing on branch/PR push" theme. */
  blockResolveOnFailingTests: boolean;
  /** ISO-4217 fallback when a project sets no billingCurrency — see
   *  api/src/services/billing-rate.service.ts. */
  defaultCurrency: string;
  /** Off by default. Gates the Verified Work Attestation endpoints entirely. */
  enableAttestations: boolean;
  /** Off by default, and separate from enableAttestations on purpose: publishing an attestation
   *  to a public unauthenticated URL is a different risk decision from producing one internally. */
  enableAttestationSharing: boolean;
  updatedAt: string;
  updatedById: string | null;
}

/** Selectable models for AI features, cheapest/fastest first. */
export const aiModels = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest & cheapest" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" }
] as const;

export const aiProviders = ["ANTHROPIC", "OPENAI_COMPATIBLE"] as const;
export type AIProvider = (typeof aiProviders)[number];

/** A curated dropdown of well-known OpenAI-compatible endpoints — the admin can still type a
 *  custom baseUrl for anything not listed (see WorkspaceSettings' AI tab). Zen, OpenCode, and
 *  OpenGateway are deliberately not presets here: none are a standard hosted-LLM API with a
 *  stable OpenAI-compatible base URL, so "Custom endpoint" is the honest way to reach them. */
export const aiProviderPresets: Array<{ key: string; label: string; baseUrl: string; needsKey: boolean }> = [
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { key: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  { key: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", needsKey: true },
  { key: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { key: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
  { key: "qwen", label: "Qwen (DashScope)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", needsKey: true },
  { key: "kimi", label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1", needsKey: true },
  { key: "nvidia", label: "Nvidia NIM", baseUrl: "https://integrate.api.nvidia.com/v1", needsKey: true },
  { key: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", needsKey: false },
  { key: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", needsKey: false },
  { key: "custom", label: "Custom endpoint", baseUrl: "", needsKey: true }
];

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
  chatIngestionEnabled: boolean;
  weeklyDigestEnabled: boolean;
  /** Gates ai.service.ts#classifyCiFailure — an AI-authored root-cause comment posted when a
   *  CI test run fails with a failure-log excerpt attached. See docs/ROADMAP.md. */
  ciFailureTriageEnabled: boolean;
  /** Gates ai.service.ts#summarizePullRequest — an AI-authored review-summary comment posted
   *  when a linked PR opens (git-webhook.controller.ts). Needs a live GitHub connection. */
  aiPrReviewSummaryEnabled: boolean;
  /** Gates ai.service.ts#classifySecurityFinding — sibling of ciFailureTriageEnabled, scoped to
   *  ingested SecurityFinding rows (CRITICAL/HIGH only) instead of CI test-run failures. */
  findingTriageEnabled: boolean;
  /** Gates ai.service.ts#generateSecurityWeeklyDigest — an org-wide security summary emailed to
   *  every ADMIN/SUPER_ADMIN weekly. See workers/security-weekly-digest.worker.ts. */
  securityWeeklyDigestEnabled: boolean;
  /** Gates ai.service.ts#generateStatusReport — on-demand project stakeholder update, triggered
   *  synchronously from the Project page rather than a cron worker. */
  statusReportEnabled: boolean;
  /** Gates ai.service.ts#summarizeFaceReviewAttempt — on-demand AI brief for a flagged
   *  identity-check review. Attempt metadata only; captured images/templates never leave the server. */
  faceReviewSummaryEnabled: boolean;
  /** Gates ai.service.ts#explainThresholdRecommendation — narrates (never sets) the
   *  deterministically-computed face-match threshold recommendation. */
  facePolicyCopilotEnabled: boolean;
  /** Gates ai.service.ts#generateBugPatternDigest — monthly "what keeps breaking" recap over
   *  recurring CI failures and security-finding hotspots. See workers/bug-pattern-digest.worker.ts. */
  bugPatternDigestEnabled: boolean;
  /** Gates ai.service.ts#explainAssigneeSuggestion — narrates (never re-ranks) the deterministic
   *  suggest-assignee ranking on ticket creation. */
  assigneeSuggestionAiEnabled: boolean;
  /** Gates a dismissible AI-suggested next action on tickets the SLA sweep already flags as
   *  stale. Never auto-acts. */
  staleTicketNudgeEnabled: boolean;
  /** Gates per-line AI review comments on a PR's actual diff — deeper and riskier than
   *  aiPrReviewSummaryEnabled's 2-3 sentence summary, so its own explicit opt-in. */
  aiPrInlineReviewEnabled: boolean;
  /** Records one AIInteraction row per AI call (feature, model, prompt hash, parse success,
   *  latency) — metadata only, no user content. Makes AI quality measurable at all. */
  aiCaptureEnabled: boolean;
  /** Additionally stores prompt text, model output and input params. Separate toggle because it
   *  retains real user content; required before golden datasets/evals are possible. */
  aiCaptureContentEnabled: boolean;
  aiCaptureRetentionDays: number;
  /** Allows an eval to spend extra model calls judging free-text answers. The only part of a run
   *  that costs more than the replay itself, so it's opt-in and logged under its own feature. */
  aiEvalJudgeEnabled: boolean;
  model: string;
  confidenceThreshold: number;
  monthlyBudgetUsd: number | null;
  updatedAt: string;
  updatedById: string | null;
  /** BYOK — which model family requests go through. See apps/api/src/services/ai.service.ts#callChat. */
  provider: AIProvider;
  /** Only meaningful when provider is OPENAI_COMPATIBLE. */
  baseUrl: string | null;
  /** Read-only. Whether a usable key exists — either a saved BYOK key (`apiKeySet`) or, for the
   *  ANTHROPIC provider only, the server's ANTHROPIC_API_KEY env var. Toggles do nothing until this is true. */
  apiKeyConfigured: boolean;
  /** Read-only. Whether a BYOK key is saved on this row — the key itself is never returned. */
  apiKeySet: boolean;
}

export const emailMatchTypes = ["TO_ADDRESS", "TO_PLUS_TAG", "SUBJECT_PREFIX"] as const;
export type EmailMatchType = (typeof emailMatchTypes)[number];

export const chatPlatforms = ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"] as const;
export type ChatPlatform = (typeof chatPlatforms)[number];

export const chatMatchTypes = ["CHANNEL_ID", "COMMAND_PREFIX"] as const;
export type ChatMatchType = (typeof chatMatchTypes)[number];

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

/** Per-platform chat-connector connection settings (Slack/Teams/Google Chat/Telegram) — same
 *  write-only-secret masking convention as EmailIntakeSettings above. */
export interface ChatIntegrationRow {
  platform: ChatPlatform;
  isEnabled: boolean;
  botTokenSet: boolean;
  signingSecretSet: boolean;
  teamsAppId: string | null;
  teamsAppPasswordSet: boolean;
  googleChatWebhookUrl: string | null;
  defaultProjectId: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface ChatRoutingRuleRow {
  id: string;
  platform: ChatPlatform;
  matchType: ChatMatchType;
  matchValue: string;
  projectId: string;
  project: { id: string; name: string; code: string };
  defaultModuleId: string | null;
  defaultModule: { id: string; name: string } | null;
  isActive: boolean;
  createdAt: string;
}

export function calculateHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const minutes = eh * 60 + em - (sh * 60 + sm);
  return Math.max(0, Math.round((minutes / 60) * 100) / 100);
}
