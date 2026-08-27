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
  TICKETS_MANAGE: "tickets:manage",

  /// --- Planning layer (V6) ------------------------------------------------------------------
  /// Adding a key here is NOT enough for an existing install: `prisma/seed.ts` is a one-time
  /// bootstrap that never runs on upgrade (and would wipe custom grants if it did). Every new
  /// key must ALSO be backfilled by idempotent SQL inside the migration that introduces it —
  /// see prisma/migrations/*_v6_phase1_planning_foundation/migration.sql.
  PORTFOLIOS_MANAGE: "portfolios:manage",
  /// Edit the *plan* — dates, hierarchy, dependencies, baselines. Deliberately separate from
  /// TICKETS_WRITE: a developer who can edit a ticket's description shouldn't necessarily be
  /// able to move the whole delivery schedule.
  PLAN_WRITE: "plan:write",
  /// Capacity, bookings, and the workload board.
  RESOURCES_MANAGE: "resources:manage",
  /// Create/route approval chains on work items (distinct from TIMESHEETS_APPROVE, which is
  /// the existing timesheet-only approval right).
  APPROVALS_MANAGE: "approvals:manage",
  /// Publish a personal dashboard to the whole workspace.
  DASHBOARDS_SHARE: "dashboards:share",

  /// --- Goals / OKRs (V8 phase 1) -----------------------------------------------------------
  /// Create/edit/close goals and record progress overrides. Reading is open to any signed-in
  /// user — a goal nobody can see aligns nobody. Same migration-backfill rule as the V6 block
  /// above: the key must ALSO be inserted by idempotent SQL inside the migration introducing it.
  GOALS_MANAGE: "goals:manage",

  /// --- Change management (V8 phase 11) -----------------------------------------------------
  /// Reading is open to any signed-in user within their project scope: a change that is about to
  /// take a service down is not a secret from the people who depend on it. Same migration-backfill
  /// rule as the V6 and goals blocks above — the seed is a one-time bootstrap and never runs on
  /// upgrade, so each key must ALSO be inserted by idempotent SQL inside the migration.
  CHANGES_WRITE: "changes:write",
  /// Decide an approval step that was assigned to you. Deliberately separate from CHANGES_WRITE:
  /// raising a change and signing one off are different authorities, and the person who wrote it
  /// must not be able to wave it through.
  CHANGES_APPROVE: "changes:approve",
  /// Approval policies, categories, freeze windows, force-close.
  CHANGES_MANAGE: "changes:manage"
} as const;

export type Permission = (typeof permissions)[keyof typeof permissions];

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  /** Every role this account may switch into — always includes `role` itself. Length 1 for the
   *  common case (nobody has granted a second role); a "Switch role" control only makes sense to
   *  show when this has more than one entry. See UserRole in schema.prisma. */
  heldRoles: RoleName[];
  /** True while this person is using a password an admin set — drives a "choose your own
   *  password" prompt in the web app; cleared when they change it. */
  mustChangePassword?: boolean;
  permissions: Permission[];
  avatarUrl?: string | null;
  bio?: string | null;
  phoneNumber?: string | null;
  timezone?: string | null;
  managerId?: string | null;
  manager?: { id: string; name: string; email: string } | null;
}

/**
 * A user's real held-role set is the union of their active `role` plus every `UserRole` row —
 * never just the join table alone. Several account-creation paths (SSO first login, SCIM
 * provisioning, the agent service identity, bulk CSV import) write `roleId` directly and never
 * touch `UserRole`, so an account created through any of them must still report its one real role
 * correctly rather than an empty set. Sorted in `roles`' fixed order so a "Switch role" list never
 * reshuffles between renders.
 */
export function resolveHeldRoles(primaryRole: RoleName, extraRoleNames: RoleName[]): RoleName[] {
  const held = new Set<RoleName>([primaryRole, ...extraRoleNames]);
  return roles.filter((r) => held.has(r));
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
// eslint-disable-next-line sonarjs/redundant-type-aliases -- names the concept at every call site
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
  emailPracticeUpdate: boolean;
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
  emailAiAutonomyApplied: boolean;
  /** "Maintenance window scheduled — wrap up" warning a SUPER_ADMIN sends from the Maintenance
   *  settings card. Gates only the EMAIL leg; the in-app notification always fires. */
  emailMaintenanceScheduled: boolean;
  /** "A workflow is waiting for you to approve a step." The one Workflow Studio message with an email
   *  leg, and on by default: a gate blocks everything after it, so a request nobody sees is a workflow
   *  that reads as broken rather than as blocked. */
  emailWorkflowApproval: boolean;
  /** Monday morning, to a goal's OWNER: which of their goals are off track and which periods close
   *  this week. Off by default like every other digest, and silent in a week with nothing to say. */
  emailGoalDigest: boolean;

  /* --- Change management (V8 phase 11). Transactional messages ship ON, the digest ships OFF —
     the same rule every other block here follows. Muting one suppresses only the EMAIL leg; the
     in-app bell always fires, because a change approval that goes silent because somebody tidied
     their mail settings is a governance hole rather than a preference. --- */
  emailChangeSubmitted: boolean;
  emailChangeApprovalRequested: boolean;
  emailChangeApproved: boolean;
  emailChangeRejected: boolean;
  emailChangeScheduled: boolean;
  emailChangeWindowReminder: boolean;
  emailChangeImplementationStarted: boolean;
  emailChangeCompleted: boolean;
  emailChangeFailed: boolean;
  emailChangePirDue: boolean;
  emailChangeFreezeConflict: boolean;
  emailChangeOverdueApproval: boolean;
  emailChangeWeeklyDigest: boolean;
}

export const notificationPreferenceKeys: ReadonlyArray<keyof NotificationPreferences> = [
  "emailTimesheetSubmitted",
  "emailTimesheetApproved",
  "emailTimesheetRejected",
  "emailSlaBreach",
  "emailDeadlineReminder",
  "emailEscalation",
  "emailWeeklyDigest",
  "emailPracticeUpdate",
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
  "emailTicketStaleNudge",
  "emailAiAutonomyApplied",
  "emailMaintenanceScheduled",
  "emailWorkflowApproval",
  "emailGoalDigest",
  "emailChangeSubmitted",
  "emailChangeApprovalRequested",
  "emailChangeApproved",
  "emailChangeRejected",
  "emailChangeScheduled",
  "emailChangeWindowReminder",
  "emailChangeImplementationStarted",
  "emailChangeCompleted",
  "emailChangeFailed",
  "emailChangePirDue",
  "emailChangeFreezeConflict",
  "emailChangeOverdueApproval",
  "emailChangeWeeklyDigest"
];

/**
 * Per-role email suppression, layered UNDER the `NotificationPreferences` booleans: a category
 * must be ON *and* the recipient's role must not be listed here for the email to go out.
 *
 * A missing key means "no role is muted for this category", so `{}` / `undefined` reproduces the
 * pre-matrix behaviour exactly. Only the EMAIL leg is affected — the in-app bell notification
 * always fires, so muting MANAGER on an escalation stops the inbox copy without hiding the
 * escalation itself.
 */
export type EmailRoleMutes = Partial<Record<keyof NotificationPreferences, RoleName[]>>;

/**
 * Single source of truth for "should this recipient get the email", shared by the API's dispatch
 * path and the settings UI's checkbox state so the ticked box and the delivered mail can never
 * disagree. Unknown keys/roles read as "not muted" — an older client PATCHing a payload that
 * predates a new category must never accidentally suppress mail.
 */
export function isEmailRoleMuted(
  mutes: EmailRoleMutes | null | undefined,
  key: keyof NotificationPreferences,
  role: RoleName | null | undefined
): boolean {
  if (!mutes || !role) return false;
  const muted = mutes[key];
  return Array.isArray(muted) && muted.includes(role);
}

/** Workspace-wide settings: notification toggles + reminder schedule + BCC behavior. */
export interface GlobalSettings extends NotificationPreferences {
  dailyReminderHour: number;
  escalationReminderHour: number;
  remindOnWeekdaysOnly: boolean;
  bccSuperAdminOnAllEmails: boolean;
  /** See {@link EmailRoleMutes}. Null on rows written before the matrix shipped. */
  emailRoleMutes: EmailRoleMutes | null;
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
  /**
   * Off by default. When on, every uploaded file is scanned by clamd BEFORE it is written anywhere
   * reachable — and a file that CANNOT be scanned is refused rather than stored, so an unreachable
   * daemon stops uploads instead of silently letting them through. See
   * api/src/services/virus-scan.service.ts.
   */
  virusScanEnabled: boolean;
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

/**
 * Friendly display name for whatever is actually configured — "Anthropic" for the built-in path,
 * or the matching preset's label for OPENAI_COMPATIBLE (falling back to the bare hostname, then
 * "Custom endpoint", when baseUrl matches no known preset). Shared between the API (AIUsageLog.provider,
 * resolved once per call in ai.service.ts#logAIUsage) and the web app (display) so the two can
 * never disagree on what a given baseUrl is called.
 */
export function resolveProviderLabel(provider: AIProvider, baseUrl: string | null | undefined): string {
  if (provider === "ANTHROPIC") return "Anthropic";
  const preset = aiProviderPresets.find((p) => p.baseUrl && p.baseUrl === baseUrl);
  if (preset) return preset.label;
  if (!baseUrl) return "Custom endpoint";
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "Custom endpoint";
  }
}

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
  /** Gates ai.service.ts#narrateChangeRisk — explains a change's ALREADY-COMPUTED risk score in
   *  prose. Never scores, and never approves: approving is excluded at every autonomy level, since
   *  it is a named person accepting risk with no undo. */
  changeRiskNarrativeEnabled: boolean;
  /** Gates ai.service.ts#draftChangeSections — drafts the prose sections that BLOCK a change's
   *  submission. Never writes them: each section becomes a proposal row a person accepts or
   *  rejects. Capped at SUGGEST permanently. */
  changeDraftAssistEnabled: boolean;
  /** Gates ai.service.ts#briefChangeConflicts — reads computed schedule conflicts and says which
   *  matters. Reports; moves nothing. */
  changeConflictBriefEnabled: boolean;
  /** Gates ai.service.ts#draftPostImplementationReview — drafts the PIR from what was recorded while
   *  the change ran. A proposal, never a write. */
  changePirAssistEnabled: boolean;
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
  /** Gates the on-demand AI diagnosis of a grouped email-send failure on the analytics screen.
   *  The grouping is deterministic; the model only explains it. */
  emailFailureTriageEnabled: boolean;
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
  /** MASTER LATCH for per-capability autonomy. While false every capability only suggests,
   *  whatever its AiCapabilityPolicy row says — see api/src/services/ai-autonomy.service.ts.
   *  Orthogonal to the toggles above: those answer "does this run", this answers "how much
   *  authority does it have when it does". */
  aiAutonomyEnabled: boolean;
  /** The provider circuit breaker (apps/api/src/services/ai.service.ts#callChat) — off by
   *  default, same as every other automation here. 3 consecutive failures against one configured
   *  provider moves it to the back of the priority order with no human click; never promotes a
   *  demoted row back automatically. Toggled from the AI providers list itself
   *  (AIProviderListCard.tsx), not this general settings surface — it's a property of the
   *  provider list, not a feature switch. */
  aiAutoFailoverEnabled: boolean;
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

/* ------------------------------------------------------------------ *
 * PLAN TIERS — one source of truth.
 *
 * WHY THIS EXISTS: these numbers used to live only in the control-plane seed, and the marketing
 * pricing table restated them from memory. It drifted, exactly as you'd expect: the comparison
 * table advertised face verification on Team when the seed grants it to Enterprise only, and the
 * feature FAILS CLOSED — so a Team customer who bought partly for that row would have had their
 * admin's attempt to enable it refused. A pricing table is a set of promises; it belongs next to
 * the values that keep them.
 *
 * `apps/api/prisma/control/seed.ts` writes these into PlanTierLimit, and the web pricing dialog
 * renders from them. Change a limit here and both move together.
 * ------------------------------------------------------------------ */

export const planTiers = ["STARTER", "TEAM", "ENTERPRISE"] as const;
export type PlanTier = (typeof planTiers)[number];

/** LDAP is a direct bind rather than a redirect, but it is still an org-level sign-in method and
 *  is gated by the same per-tier allowlist, so it belongs in this union. */
export const ssoProviders = ["GOOGLE", "MICROSOFT", "SAML", "LDAP"] as const;
export type SsoProvider = (typeof ssoProviders)[number];

/** Effectively "no ceiling" — the schema wants a number, not null, on these two tiers. */
export const UNLIMITED_SEATS = 1_000_000;

/** Same idea for a countable planning resource (portfolios, forms, blueprints, …). Declared
 *  here rather than down in the planning section because `PLAN_TIER_LIMITS` below reads it at
 *  module-init time — a `const` further down the file would be in its temporal dead zone. */
export const UNLIMITED_PLAN_ITEMS = 1_000_000;

export interface PlanTierLimits {
  seatLimit: number;
  /** A HARD platform ceiling, clamped over whatever budget the org sets for itself. An explicit
   *  0 is a real cap, not "unlimited" — so Starter cannot make an AI call at all. */
  aiMonthlyBudgetCeilingUsd: number;
  allowedSsoProviders: SsoProvider[];
  allowedChatPlatforms: ChatPlatform[];
  /** Enabling, enrolling and verifying all fail CLOSED without this. */
  faceVerificationEnabled: boolean;

  /* --- Planning layer (V6) ---------------------------------------------------------------
   * All of these fail CLOSED like faceVerificationEnabled: the capability is refused unless
   * the tier grants it. The counts are ceilings on how many of a thing an org may create;
   * 0 means "this tier cannot use the feature at all", which is why STARTER reads as all-zero
   * rather than as a small allowance. Enforced live per request by
   * apps/api/src/services/plan-limits.service.ts — never cached, same as every existing limit. */
  /** Timeline/Gantt, dependencies, baselines, critical path. */
  ganttEnabled: boolean;
  /** Capacity, resource bookings, the workload board. */
  resourceMgmtEnabled: boolean;
  /** Approval chains on work items, including guest approvers. */
  approvalsEnabled: boolean;
  /** Pin/region annotation on attachments. */
  proofingEnabled: boolean;
  /** Admin-defined statuses/transitions per ticket type. */
  customWorkflowsEnabled: boolean;
  /** The proposal-based AI PM copilot family. Spend is still bounded by
   *  aiMonthlyBudgetCeilingUsd — this only decides whether the features exist. */
  aiPmCopilotEnabled: boolean;
  maxPortfolios: number;
  maxRequestForms: number;
  maxBlueprints: number;
  maxCustomFields: number;
  maxDashboards: number;

  /* --- Goals / OKRs (V8 phase 1) --------------------------------------------------------- */
  /** Goals with measured progress sources. Fails CLOSED like every planning capability. */
  goalsEnabled: boolean;
  /** Ceiling on ACTIVE goals; 0 = the tier cannot use goals at all. */
  maxGoals: number;

  /* --- Change management (V8 phase 11) --------------------------------------------------- */
  /** Request/assess/approve/schedule/review changes. Fails CLOSED like every capability here. */
  changeManagementEnabled: boolean;
  /** Ceiling on approval POLICIES. Never on changes themselves — a workspace must always be able
   *  to record a change it actually made, whatever its plan says. */
  maxChangePolicies: number;

  /* --- Weekly AI/ML Practice Update (3.5.0) ------------------------------------------------ */
  /**
   * The consolidated leadership digest — draft, review, send, and the Monday cadence.
   *
   * Gated because of what it reads, not because of what it costs: one document aggregates every
   * project, everyone's hours and every open security finding, and then mails it to addresses that
   * need no account here. Starter is a ten-seat workspace where that document is the workspace.
   *
   * Fails CLOSED like every capability on this interface. The figures are still visible on the
   * pages they come from; what a downgrade removes is the packaged, mailable roll-up.
   */
  practiceUpdateEnabled: boolean;
}

export const PLAN_TIER_LIMITS: Record<PlanTier, PlanTierLimits> = {
  STARTER: {
    seatLimit: 10,
    aiMonthlyBudgetCeilingUsd: 0,
    allowedSsoProviders: ["GOOGLE"],
    allowedChatPlatforms: [],
    faceVerificationEnabled: false,
    ganttEnabled: false,
    resourceMgmtEnabled: false,
    approvalsEnabled: false,
    proofingEnabled: false,
    customWorkflowsEnabled: false,
    aiPmCopilotEnabled: false,
    maxPortfolios: 0,
    maxRequestForms: 0,
    maxBlueprints: 0,
    maxCustomFields: 0,
    maxDashboards: 0,
    goalsEnabled: false,
    maxGoals: 0,
    changeManagementEnabled: false,
    maxChangePolicies: 0,
    practiceUpdateEnabled: false
  },
  TEAM: {
    seatLimit: UNLIMITED_SEATS,
    aiMonthlyBudgetCeilingUsd: 200,
    allowedSsoProviders: ["GOOGLE", "MICROSOFT"],
    allowedChatPlatforms: ["SLACK", "TELEGRAM"],
    faceVerificationEnabled: false,
    // Team gets the everyday planning surface — a schedule, intake, approvals and a dashboard.
    // The two capped-at-Enterprise items are the ones with real ongoing cost or blast radius:
    // resource management reads every person's rate/capacity, and the AI copilot spends money.
    ganttEnabled: true,
    resourceMgmtEnabled: false,
    approvalsEnabled: true,
    proofingEnabled: true,
    customWorkflowsEnabled: false,
    aiPmCopilotEnabled: false,
    maxPortfolios: 1,
    maxRequestForms: 5,
    maxBlueprints: 5,
    maxCustomFields: 10,
    maxDashboards: 3,
    // Goals are an everyday alignment surface, not an enterprise luxury — Team gets them with a
    // ceiling. Measured sources read data the tier already holds, so there is no added cost.
    goalsEnabled: true,
    maxGoals: 25,
    // Change control is governance, not a luxury — a ten-person team shipping to production needs
    // a backout plan as much as a bank does. Team gets it with a policy ceiling; the ceiling is
    // what Enterprise buys off, not the capability.
    changeManagementEnabled: true,
    maxChangePolicies: 5,
    // A practice update is a management artefact, and Team is where a workspace has managers in it.
    practiceUpdateEnabled: true
  },
  ENTERPRISE: {
    seatLimit: UNLIMITED_SEATS,
    aiMonthlyBudgetCeilingUsd: 5000,
    allowedSsoProviders: ["GOOGLE", "MICROSOFT", "SAML", "LDAP"],
    allowedChatPlatforms: ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"],
    faceVerificationEnabled: true,
    ganttEnabled: true,
    resourceMgmtEnabled: true,
    approvalsEnabled: true,
    proofingEnabled: true,
    customWorkflowsEnabled: true,
    aiPmCopilotEnabled: true,
    maxPortfolios: UNLIMITED_PLAN_ITEMS,
    maxRequestForms: UNLIMITED_PLAN_ITEMS,
    maxBlueprints: UNLIMITED_PLAN_ITEMS,
    maxCustomFields: UNLIMITED_PLAN_ITEMS,
    maxDashboards: UNLIMITED_PLAN_ITEMS,
    goalsEnabled: true,
    maxGoals: UNLIMITED_PLAN_ITEMS,
    changeManagementEnabled: true,
    maxChangePolicies: UNLIMITED_PLAN_ITEMS,
    practiceUpdateEnabled: true
  }
};

/* ------------------------------------------------------------------ *
 * PLANNING LAYER (V6) — types both apps agree on.
 *
 * WHAT: the work-item hierarchy, custom workflows/fields, scheduling, resourcing, intake,
 * approvals and the AI proposal envelope.
 * WHY these live here and not in either app: the same drift argument the file header makes for
 * TicketStatus applies doubly to a workflow whose statuses are ADMIN-DEFINED — the API decides
 * whether a transition is legal and the board renders the columns, and those two must be reading
 * the same category vocabulary or a column silently accepts a drop the server then rejects.
 * ------------------------------------------------------------------ */

/**
 * The canonical vocabulary every custom status maps onto.
 *
 * THIS IS THE COMPATIBILITY HINGE OF THE WHOLE V6 PLANNING LAYER. An admin may rename "In
 * review" to "Design QA" or add "Blocked", but every status they define must declare which of
 * these five it behaves like. Existing code — the SLA sweep, escalation worker, every report,
 * the Kanban's column set, `ticketStatusTransitions` — keeps reading the unchanged
 * `Ticket.status` enum, which is derived from the status's `legacyStatus`. Nothing downstream
 * has to learn about custom statuses to keep working correctly.
 */
export const workStatusCategories = ["TODO", "ACTIVE", "REVIEW", "DONE", "CANCELLED"] as const;
export type WorkStatusCategory = (typeof workStatusCategories)[number];

/** The one mapping that makes a custom workflow safe: which category each built-in status IS.
 *  The seeded "Default" workflow is exactly this table, so a workspace that never touches
 *  workflow settings behaves identically to V5. */
export const DEFAULT_STATUS_CATEGORY: Record<TicketStatus, WorkStatusCategory> = {
  OPEN: "TODO",
  IN_PROGRESS: "ACTIVE",
  IN_REVIEW: "REVIEW",
  RESOLVED: "DONE",
  CLOSED: "DONE",
  REOPENED: "TODO"
};

export interface WorkflowStatusRow {
  id: string;
  name: string;
  category: WorkStatusCategory;
  /** Which built-in `TicketStatus` this status writes to `Ticket.status`. Every custom status
   *  must pick one — that column stays canonical for all pre-V6 code. */
  legacyStatus: TicketStatus;
  color: string | null;
  order: number;
  isInitial: boolean;
  isFinal: boolean;
}

export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  /** Null = the workspace default, used by any ticket type without its own workflow. */
  appliesToTicketType: string | null;
  isDefault: boolean;
  isActive: boolean;
  statuses: WorkflowStatusRow[];
  transitions: Array<{ id: string; fromStatusId: string; toStatusId: string; requiresApproval: boolean }>;
}

export const customFieldTypes = [
  "TEXT",
  "NUMBER",
  "DATE",
  "SINGLE_SELECT",
  "MULTI_SELECT",
  "CHECKBOX",
  "USER",
  "CURRENCY",
  "URL"
] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

export const customFieldTargets = ["TICKET", "PROJECT"] as const;
export type CustomFieldTarget = (typeof customFieldTargets)[number];

export interface CustomFieldRow {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  description: string | null;
  /** Only for SINGLE_SELECT/MULTI_SELECT. */
  options: string[];
  isRequired: boolean;
  appliesTo: CustomFieldTarget;
  /** Null = every ticket type. Otherwise the `TicketType.name` this field is scoped to. */
  ticketTypeFilter: string | null;
  showOnRequestForm: boolean;
  order: number;
  isActive: boolean;
}

/** A field's stored value, normalised per type: string | number | boolean | string[] | null. */
export type CustomFieldValue = string | number | boolean | string[] | null;

export const planViewTypes = ["LIST", "BOARD", "TIMELINE", "CALENDAR", "WORKLOAD"] as const;
export type PlanViewType = (typeof planViewTypes)[number];

export const savedViewScopes = ["PERSONAL", "SHARED"] as const;
export type SavedViewScope = (typeof savedViewScopes)[number];

/** Scheduling relationship between two work items. The first three mirror the existing
 *  TicketLinkType values and are unchanged; the four `*_TO_*` values are the standard PM
 *  dependency kinds the timeline solver understands. BLOCKS is treated as FINISH_TO_START by
 *  the solver so every dependency already recorded in V5 keeps meaning what it meant. */
export const ticketLinkTypes = [
  "BLOCKS",
  "DUPLICATE",
  "RELATES",
  "FINISH_TO_START",
  "START_TO_START",
  "FINISH_TO_FINISH",
  "START_TO_FINISH"
] as const;
export type TicketLinkType = (typeof ticketLinkTypes)[number];

/** Which link types the timeline solver treats as real scheduling constraints. */
export const SCHEDULING_LINK_TYPES: readonly TicketLinkType[] = [
  "BLOCKS",
  "FINISH_TO_START",
  "START_TO_START",
  "FINISH_TO_FINISH",
  "START_TO_FINISH"
];

export const approvalDecisions = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export const blueprintKinds = ["PROJECT", "WORK_ITEM"] as const;
export type BlueprintKind = (typeof blueprintKinds)[number];

export const reportCadences = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export type ReportCadence = (typeof reportCadences)[number];

export const riskBands = ["GREEN", "AMBER", "RED"] as const;
export type RiskBand = (typeof riskBands)[number];

/**
 * AI PM copilot proposals — the human-in-the-loop envelope.
 *
 * WHY every AI planning feature returns one of these instead of writing directly: a wrong
 * auto-applied schedule shift or reassignment is indistinguishable from a real plan change once
 * it lands, and there is no undo for "the AI moved 40 dates". A proposal is a set of individually
 * accept/reject-able diffs a human applies, which is the same posture the email/chat intake
 * pipelines already take with `needsReview` — generalised to writes instead of just triage.
 */
export const aiProposalKinds = [
  "PLAN_BREAKDOWN",
  "SCHEDULE_ADJUSTMENT",
  "ASSIGNMENT_REBALANCE",
  "RISK_MITIGATION",
  "BLUEPRINT_SUGGESTION"
] as const;
export type AiProposalKind = (typeof aiProposalKinds)[number];

export const aiProposalStatuses = [
  "PENDING_REVIEW",
  "PARTIALLY_APPLIED",
  "APPLIED",
  "REJECTED",
  "EXPIRED"
] as const;
export type AiProposalStatus = (typeof aiProposalStatuses)[number];

export const aiProposalChangeOps = ["CREATE", "UPDATE", "LINK"] as const;
export type AiProposalChangeOp = (typeof aiProposalChangeOps)[number];

/** Workspace-wide planning toggles. Every one defaults false — same inert-until-opted-in rule
 *  every existing capability in this app follows, so upgrading to V6 changes nothing visible
 *  until an admin turns something on. */
export interface GlobalPlanningSettings {
  enablePlanning: boolean;
  enableResourceManagement: boolean;
  enableApprovals: boolean;
  enableProofing: boolean;
  enableRequestForms: boolean;
  enableCustomWorkflows: boolean;
  /** Default working days for the timeline solver, 0 = Sunday. */
  workingDays: number[];
  /** Fallback capacity when a user has no `weeklyCapacityHours` of their own. */
  defaultWeeklyCapacityHours: number;
  updatedAt: string;
  updatedById: string | null;
}

/* ------------------------------------------------------------------ *
 * CHANGE MANAGEMENT (V8 phase 11) — the vocabulary both apps agree on.
 *
 * Everything here is shared for the same reason `ticketStatusTransitions` is: the API decides
 * whether a move is legal and the UI decides which buttons to offer, and those two answers must
 * come from one table or the UI eventually offers a move the server refuses.
 * ------------------------------------------------------------------ */

/**
 * The four change types, and why there are four rather than ITIL's three.
 *
 * STANDARD, NORMAL and EMERGENCY are the classic vocabulary: pre-approved routine work, planned work
 * that earns a decision, and work that cannot wait for one.
 *
 * MAJOR IS NOT A FOURTH PEER — it is NORMAL escalated, and it exists because two obligations cannot
 * be derived from the risk score:
 *
 *   1. `requiresBackoutPlan` — a MAJOR change needs one even when impact × likelihood bands it LOW.
 *      A platform migration can be low-impact and low-likelihood on every parameter and still be the
 *      thing you must be able to undo. The matrix scores *probability of harm*; it has no way to say
 *      "structurally significant".
 *   2. `requiresReview` — a MAJOR change owes a post-implementation review even when its outcome was
 *      SUCCESSFUL. Everything else owes one only when it went wrong.
 *
 * Deleting MAJOR would therefore silently delete both rules with nothing to replace them. Keep it,
 * and keep it honest: it means "this is significant regardless of what the matrix scored", not
 * "riskier than HIGH".
 */
export const changeKinds = ["STANDARD", "NORMAL", "EMERGENCY", "MAJOR"] as const;
export type ChangeKind = (typeof changeKinds)[number];

export const changeBands = ["LOW", "MEDIUM", "HIGH"] as const;
export type ChangeBand = (typeof changeBands)[number];

export const changeStates = [
  "DRAFT",
  "SUBMITTED",
  "RISK_ASSESSMENT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "IMPLEMENTING",
  "VALIDATION",
  "PIR",
  "CLOSED",
  "REJECTED",
  "CANCELLED"
] as const;
export type ChangeState = (typeof changeStates)[number];

export const changeOutcomes = ["SUCCESSFUL", "SUCCESSFUL_WITH_ISSUES", "FAILED", "ROLLED_BACK"] as const;
export type ChangeOutcome = (typeof changeOutcomes)[number];

/**
 * THE COMPATIBILITY HINGE, the same one `WorkflowStatus.legacyStatus` provides for custom ticket
 * statuses. Every change state declares which built-in `TicketStatus` it writes to the underlying
 * ticket, and both are written in one update — so the SLA sweep, the escalation worker, every
 * report, the Kanban, the exports, the public API and the webhook payloads keep reading a correct
 * `Ticket.status` without knowing this module exists.
 *
 * REJECTED and CANCELLED map to CLOSED rather than to anything alarming: the work is over. FAILED
 * is not here because it is an OUTCOME, not a state — a failed change still owes a review.
 */
export const CHANGE_STATE_TO_TICKET_STATUS: Record<ChangeState, TicketStatus> = {
  DRAFT: "OPEN",
  SUBMITTED: "OPEN",
  RISK_ASSESSMENT: "IN_PROGRESS",
  AWAITING_APPROVAL: "IN_REVIEW",
  APPROVED: "IN_PROGRESS",
  SCHEDULED: "IN_PROGRESS",
  IMPLEMENTING: "IN_PROGRESS",
  VALIDATION: "IN_REVIEW",
  PIR: "IN_REVIEW",
  CLOSED: "CLOSED",
  REJECTED: "CLOSED",
  CANCELLED: "CLOSED"
};

/**
 * Legal moves. Cancellation is reachable from every live state — a change called off after
 * approval is ordinary, and a lifecycle that traps it there would be one people work around.
 *
 * AWAITING_APPROVAL has no manual edge to APPROVED or REJECTED: only the approval chain writes
 * those, from `change.service.ts#settleApproval`. Listing them here would let a determined caller
 * PATCH straight past the board.
 */
export const changeStateTransitions: Record<ChangeState, readonly ChangeState[]> = {
  // Submitting goes STRAIGHT to the approver. There is no queue in between, because the moment a
  // change is submitted the only thing standing between it and a decision is one person reading it.
  DRAFT: ["AWAITING_APPROVAL", "CANCELLED"],
  SUBMITTED: ["RISK_ASSESSMENT", "AWAITING_APPROVAL", "DRAFT", "CANCELLED"],
  RISK_ASSESSMENT: ["AWAITING_APPROVAL", "DRAFT", "CANCELLED"],
  // Nothing manual leads out of here except cancellation. APPROVED and REJECTED are written only by
  // a recorded decision — see change.service.ts#recordDecision — so no caller can PATCH past the
  // approver, which is the single rule the whole module exists to enforce.
  AWAITING_APPROVAL: ["CANCELLED"],
  APPROVED: ["SCHEDULED", "IMPLEMENTING", "CANCELLED"],
  SCHEDULED: ["IMPLEMENTING", "APPROVED", "CANCELLED"],
  IMPLEMENTING: ["VALIDATION", "CANCELLED"],
  // Validation can send it back: a change that failed its checks is implemented again, not closed.
  VALIDATION: ["PIR", "IMPLEMENTING"],
  PIR: ["CLOSED"],
  CLOSED: [],
  // A rejected change is reworked and resubmitted rather than argued about — the resubmission opens
  // a new approval round, so the first decision stays on the record.
  REJECTED: ["DRAFT"],
  CANCELLED: ["DRAFT"]
};

/** Nothing transitions out of these; they are where a change comes to rest. */
export const terminalChangeStates: readonly ChangeState[] = ["CLOSED"];

/**
 * The risk matrix. Impact x likelihood, and the ONLY place a risk level is decided — the field is
 * derived, never typed, so two changes with the same answers cannot carry different risk because
 * two people judged them differently.
 *
 * Deliberately conservative on the diagonal: MEDIUM x MEDIUM reads HIGH. A matrix that rounds down
 * in the middle is a matrix that lets the most common change in any workspace skip the board.
 */
/* ------------------------------------------------------------------ *
 * Which sections a change OWES, by rule.
 *
 * These three predicates decide the conditional submission requirements — the backout plan, the
 * test plan, the communication plan. They live in shared because two surfaces read them and must
 * never disagree: `missingForSubmit` on the API refuses submission on them, and the change form
 * marks fields as required from them. Two hand-maintained copies of "when is a backout plan
 * mandatory" is how the form ends up promising something the server then refuses.
 * ------------------------------------------------------------------ */

export interface ChangeRequirementInput {
  riskLevel?: string | null;
  changeKind?: string | null;
  dataMigration?: boolean | null;
  requiresDowntime?: boolean | null;
}

/** High risk, MAJOR, or anything that moves data. The rule the whole module exists to make
 *  non-optional — see `requiresBackoutPlan` in change.service.ts, which delegates here. */
export function changeNeedsBackoutPlan(change: ChangeRequirementInput): boolean {
  return change.riskLevel === "HIGH" || change.changeKind === "MAJOR" || Boolean(change.dataMigration);
}

/** Anything above LOW. A low-risk routine change may ship on its runbook alone. */
export function changeNeedsTestPlan(change: ChangeRequirementInput): boolean {
  return change.riskLevel !== "LOW";
}

/** Downtime means somebody's work stops — they get told, and the plan says how. */
export function changeNeedsCommunicationPlan(change: ChangeRequirementInput): boolean {
  return Boolean(change.requiresDowntime);
}

export const CHANGE_RISK_MATRIX: Record<ChangeBand, Record<ChangeBand, ChangeBand>> = {
  LOW: { LOW: "LOW", MEDIUM: "LOW", HIGH: "MEDIUM" },
  MEDIUM: { LOW: "LOW", MEDIUM: "HIGH", HIGH: "HIGH" },
  HIGH: { LOW: "MEDIUM", MEDIUM: "HIGH", HIGH: "HIGH" }
};

export function deriveChangeRisk(impact: ChangeBand, likelihood: ChangeBand): ChangeBand {
  return CHANGE_RISK_MATRIX[impact][likelihood];
}

/** One approver slot in a policy. */
export const changeApproverKinds = ["USER", "ROLE", "MANAGER_OF_IMPLEMENTER", "GUEST"] as const;
export type ChangeApproverKind = (typeof changeApproverKinds)[number];

export interface ChangePolicyStep {
  kind: ChangeApproverKind;
  /** A user id, a RoleName, or an email address. Ignored for MANAGER_OF_IMPLEMENTER. */
  value?: string;
  /** Steps sharing an order are asked together even in a sequential chain. */
  order?: number;
}

/**
 * Which fields a state demands before a change may ENTER it.
 *
 * Enforced at the transition, never on save: a draft you cannot save until it is complete is a
 * draft nobody starts. `conditional` entries are evaluated against the change itself, which is why
 * this is a predicate table rather than a list of column names.
 */
export interface ChangeReadiness {
  /** Always required to leave DRAFT. */
  always: readonly string[];
  /** Required only when the predicate holds. */
  conditional: ReadonlyArray<{ field: string; when: string }>;
}

export const CHANGE_SUBMIT_REQUIREMENTS: ChangeReadiness = {
  always: ["justification", "implementationPlan", "plannedStart", "plannedEnd"],
  conditional: [
    { field: "backoutPlan", when: "risk is HIGH, kind is MAJOR, or the change migrates data" },
    { field: "testPlan", when: "risk is above LOW" },
    { field: "communicationPlan", when: "the change requires downtime" },
    { field: "downtimeMinutes", when: "the change requires downtime" }
  ]
};

export interface GlobalChangeSettingsRow {
  enableChangeManagement: boolean;
  approvalSlaHours: number;
  remindHoursBefore: number[];
  requireFaceOnApproval: boolean;
}
