/* The in-app help articles — one source for the Help page AND Ask AI's help tool, so the two can
   never tell a person different steps. See help-articles.ts for the writing rules. */
export * from "./help-articles.js";
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

/* =========================== Platform console governance (5.0.0) ===========================
 *
 * WHAT: the role/capability vocabulary for the `/platform-admin` console — the operator plane,
 * NOT a tenant workspace. Deliberately its own set of names beside `roles`/`permissions` above
 * rather than an extension of them: a platform operator has no workspace, no `User` row, and no
 * tenant session, and the one mistake that must never be possible is a guard reading the tenant
 * role for a control-plane decision (see apps/web/src/App.tsx's `RedirectIfPlatformAdmin` header
 * for the same argument on the client).
 *
 * WHY IT EXISTS AT ALL: until 5.0.0 `requirePlatformAdmin` was the console's entire authorization
 * surface. It proved you were *an* admin and nothing more, so every platform admin could drop any
 * tenant's database, restore over one, retune every plan tier and read every stored AI credential.
 * "Everyone who can sign in can do everything" is not a policy, it is the absence of one.
 */
export const platformRoles = ["OWNER", "OPERATOR", "SUPPORT", "BILLING", "READ_ONLY"] as const;
export type PlatformRole = (typeof platformRoles)[number];

/**
 * Capabilities, in the same flat `as const` shape as `permissions` above so both planes read the
 * same way at a call site. Five, not fifty: a matrix an operator cannot hold in their head is a
 * matrix nobody audits, and every route in the console falls cleanly into one of these buckets.
 */
export const platformCapabilities = {
  /** See the console. Every signed-in operator holds this; it is what READ_ONLY is. */
  PLATFORM_READ: "platform:read",
  /** Act ON a customer without changing the platform: rescues, resends, advisories, lead pipeline.
   *  Everything here is either reversible or a message. */
  PLATFORM_SUPPORT: "platform:support",
  /** Money: plan tiers, the Stripe configuration, an org's tier/seat/AI-budget overrides, and the
   *  backup policy a tier entitles. Deliberately does NOT include the tenant rescue routes — a
   *  finance role has no business inside a customer's user table. */
  PLATFORM_BILLING: "platform:billing",
  /** Run the platform: mail/AI/retention/backup configuration, provisioning, org status changes,
   *  maintenance windows, and the snapshot download. */
  PLATFORM_OPERATE: "platform:operate",
  /** Grant power to other people, and countersign somebody else's irreversible action. */
  PLATFORM_OWNER: "platform:owner"
} as const;

export type PlatformCapability = (typeof platformCapabilities)[keyof typeof platformCapabilities];

/**
 * The matrix, written out per role rather than derived from a ladder.
 *
 * SUPPORT AND BILLING ARE SIBLINGS, NOT RUNGS. The obvious shape is a single ordered ladder
 * (READ_ONLY < SUPPORT < BILLING < OPERATOR < OWNER), and it is wrong in both directions: it would
 * hand a finance operator the break-glass that resets a customer's super-admin password, and hand
 * a support operator the ability to move a workspace onto a different plan. Neither is a capability
 * the other job needs, and the whole point of splitting the console's single all-powerful role is
 * to stop granting authority nobody asked for.
 *
 * OPERATOR IS THE UNION, because it is the on-call role: the person holding the pager at 3am must
 * not discover that restoring service needs a second account they do not have.
 */
export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, readonly PlatformCapability[]> = {
  READ_ONLY: [platformCapabilities.PLATFORM_READ],
  SUPPORT: [platformCapabilities.PLATFORM_READ, platformCapabilities.PLATFORM_SUPPORT],
  BILLING: [platformCapabilities.PLATFORM_READ, platformCapabilities.PLATFORM_BILLING],
  OPERATOR: [
    platformCapabilities.PLATFORM_READ,
    platformCapabilities.PLATFORM_SUPPORT,
    platformCapabilities.PLATFORM_BILLING,
    platformCapabilities.PLATFORM_OPERATE
  ],
  OWNER: [
    platformCapabilities.PLATFORM_READ,
    platformCapabilities.PLATFORM_SUPPORT,
    platformCapabilities.PLATFORM_BILLING,
    platformCapabilities.PLATFORM_OPERATE,
    platformCapabilities.PLATFORM_OWNER
  ]
};

/** One-line descriptions, so the console's role picker explains itself instead of showing five
 *  enum values and hoping the reader already knows what they mean. */
export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  OWNER: "Owner — everything, plus creating operators and countersigning irreversible actions",
  OPERATOR: "Operator — runs the platform: configuration, provisioning, backups, maintenance",
  SUPPORT: "Support — customer rescues, resends, advisories and the sales pipeline",
  BILLING: "Billing — plan tiers, Stripe configuration and per-workspace commercial overrides",
  READ_ONLY: "Read only — sees the console, changes nothing"
};

export function platformRoleHas(role: PlatformRole, capability: PlatformCapability): boolean {
  return PLATFORM_ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

/**
 * The irreversible actions that need a second pair of eyes, and the label the console shows for
 * each. Shared because the API enforces the list and the console has to describe what it just
 * queued — two copies of "which actions are two-person" would drift the first time one is added.
 *
 * The test of membership is NOT "is it dangerous". It is "can it be undone". A suspended workspace
 * can be un-suspended; a deleted one cannot, a restored-over one cannot, and an operator account
 * somebody quietly promoted to OWNER can grant itself anything before anyone notices.
 */
export const platformTwoPersonActions = {
  RETENTION_DELETE: "retention.delete",
  SNAPSHOT_RESTORE: "snapshot.restore",
  SNAPSHOT_DELETE: "snapshot.delete",
  ADMIN_CREATE: "admin.create",
  ADMIN_ROLE_CHANGE: "admin.role_change"
} as const;

export type PlatformTwoPersonAction = (typeof platformTwoPersonActions)[keyof typeof platformTwoPersonActions];

export const PLATFORM_TWO_PERSON_LABEL: Record<PlatformTwoPersonAction, string> = {
  "retention.delete": "Delete a workspace and its database",
  "snapshot.restore": "Restore a snapshot over a workspace",
  "snapshot.delete": "Delete a pre-deletion snapshot",
  "admin.create": "Create a platform admin account",
  "admin.role_change": "Change a platform admin's role"
};

/** How long a queued request stays approvable. Long enough to find a colleague in another
 *  timezone, short enough that an approval is a decision about NOW and not about last week. */
export const PLATFORM_APPROVAL_TTL_HOURS = 24;

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

/** Ingest-only assessment types — see docs/ROADMAP.md's "Security assessment suite"
 *  section. SSAT = secrets scanning, SSCT = software supply-chain testing (SBOM/provenance),
 *  distinct from a plain CVE-only dependency check. VAPT is deliberately absent from the CI
 *  webhook's accepted set — it's a periodic human-led assessment, not a per-finding type an
 *  automated webhook posts. */
/** Includes VAPT even though the CI ingestion webhook never accepts it as input (see
 *  devops-webhook.controller.ts's own VAPT-excluding type list) — this constant is
 *  the *display*-side source of truth (report rendering, the ticket Security tab), where a VAPT
 *  finding (uploaded via Workspace Settings, not the webhook) needs to render identically to
 *  the other types. */
/**
 * QUALITY and LINT are the two CODE-QUALITY members, and they are the reason
 * `securityFindingTypeDisciplines` below exists. They share this table, this ingest, this
 * fingerprint and this verification machinery with the five security types on purpose — a Sonar
 * code smell and a Semgrep injection warning are the same SHAPE of record (a tool, a rule, a file, a
 * line, a claim that got fixed or did not) — but they are emphatically not the same NUMBER. See the
 * discipline map for what that separation buys and where it is enforced.
 *
 * ORDER IS STORAGE LAYOUT, not taxonomy — the same argument `securityFindingStatuses` makes below.
 * MySQL stores an ENUM as the ordinal of its member, so `ALTER TABLE … MODIFY … ENUM(…)` is an
 * in-place alter only when the new member is APPENDED; slot one into the middle and every existing
 * row's stored ordinal has to be rewritten. Hence QUALITY and LINT at the end rather than beside
 * SAST where a taxonomy would put them. Keep this identical to the `SecurityFindingType` enum in
 * prisma/schema.prisma, member for member and order for order.
 */
export const securityFindingTypes = ["SAST", "DAST", "SSAT", "SSCT", "VAPT", "QUALITY", "LINT"] as const;
export type SecurityFindingType = (typeof securityFindingTypes)[number];

/** The two things a finding can be ABOUT. `"security"` is exposure — something an attacker could
 *  use. `"quality"` is maintainability — something that will cost the team later. Both are worth
 *  tracking; only one of them belongs in a security posture number. */
export type SecurityFindingDiscipline = "security" | "quality";

/**
 * Which discipline each finding type belongs to — the one place that answers "does this count as
 * SECURITY exposure?", for every score, chart and digest that has to ask.
 *
 * WHY THIS EXISTS. SonarQube and ESLint ingestion means a workspace can post a thousand code smells
 * in one night, through the same webhook, into the same table, as its SAST findings. Without this
 * map every one of them would be a "finding": the org risk score would climb, the by-severity chart
 * would fill with MEDIUMs, the Monday security digest would open with a number nobody could act on,
 * and a single CRITICAL SQL injection would be one row in ten thousand. The failure is not that the
 * numbers would be wrong — each row is a real thing a real tool reported. The failure is that the
 * figure a security team reads would stop measuring security, quietly, on the day somebody wired up
 * a linter.
 *
 * WHAT IS *NOT* SPLIT, deliberately, and this is the whole reason one table was chosen: the
 * per-ticket security report, verification and reopen, module routing, deduplication and
 * fingerprinting all serve BOTH disciplines unchanged. A lint rule that keeps coming back after
 * somebody said they fixed it is exactly as interesting as a vulnerability that does, and it costs
 * nothing to answer that question for both.
 *
 * NOT A STORED COLUMN. It is derived from `type`, so there is no migration, no second field that can
 * disagree with the first, and no possibility of a row whose discipline says one thing and whose
 * type says another. The price is that a type cannot be re-disciplined per workspace — which is the
 * right price, because "is a code smell a security problem?" is not a per-workspace opinion.
 *
 * ADDING A VALUE: add it to `securityFindingTypes` above, and this Record stops compiling until
 * somebody decides whether it counts against a workspace's security posture. That failure is the
 * point; it is the check this map exists to provide.
 */
export const securityFindingTypeDisciplines: Record<SecurityFindingType, SecurityFindingDiscipline> = {
  SAST: "security",
  DAST: "security",
  SSAT: "security",
  SSCT: "security",
  VAPT: "security",
  /** Sonar's BUG and CODE_SMELL, and anything else a quality gate reports. Sonar's own
   *  VULNERABILITY is NOT here — it maps to SAST, because it is static analysis finding a
   *  vulnerability and belongs in the security numbers. */
  QUALITY: "quality",
  /** ESLint and friends. A lint warning is a maintainability signal; treating one as security
   *  exposure is how a risk score becomes noise. */
  LINT: "quality"
};

/** WHY MUTABLE ARRAYS: identical reasoning to `securityFindingStatusesIn` below — every consumer is
 *  a Prisma `type: { in: … }` filter, and Prisma's `Enumerable<T>` does not accept a `readonly`
 *  array. */
function securityFindingTypesIn(discipline: SecurityFindingDiscipline): SecurityFindingType[] {
  return securityFindingTypes.filter((type) => securityFindingTypeDisciplines[type] === discipline);
}

/** The types that count against a workspace's SECURITY posture — the risk score, the by-severity
 *  breakdown, the weekly security digest, and the one-line verdict on a ticket's report. */
export const securityDisciplineFindingTypes = securityFindingTypesIn("security");
/** The code-quality types. Reported in their own section, never folded into the numbers above. */
export const qualityDisciplineFindingTypes = securityFindingTypesIn("quality");

export const securityFindingSeverities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type SecurityFindingSeverity = (typeof securityFindingSeverities)[number];

/**
 * WHY THE ORDER LOOKS WRONG. Read as a life cycle this should be
 * OPEN → ACKNOWLEDGED → PENDING_VERIFICATION → FIXED → ACCEPTED_RISK, and PENDING_VERIFICATION
 * belongs in the middle. It is last because MySQL stores an ENUM column as the ORDINAL of its
 * member, and `ALTER TABLE … MODIFY … ENUM(…)` is an in-place, no-rewrite operation only when the
 * new member is APPENDED. Insert one in the middle and every existing row's stored ordinal has to
 * be rewritten — a full table copy, on the one table an org's scanners append to every night. The
 * list is a storage layout, not a workflow diagram; the workflow lives in
 * `securityFindingStatusBuckets` below, which is order-independent. Keep this identical to the
 * `SecurityFindingStatus` enum in prisma/schema.prisma, member for member and order for order.
 */
export const securityFindingStatuses = ["OPEN", "ACKNOWLEDGED", "FIXED", "ACCEPTED_RISK", "PENDING_VERIFICATION"] as const;
export type SecurityFindingStatus = (typeof securityFindingStatuses)[number];

/** The three answers to "is this finding still a problem?". `pending` is the middle one: somebody
 *  says it is fixed and nothing has confirmed that yet. */
export type SecurityFindingStatusBucket = "open" | "resolved" | "pending";

/**
 * Which bucket each finding status falls into — the one place that answers "is this still a
 * problem?", for every report, digest and score that has to ask.
 *
 * WHY THIS EXISTS. The open/resolved split used to be typed out by hand in five independent
 * places: the Security Insights aggregation (report.controller.ts), the per-ticket report behind
 * the risk verdict and the ticket-closed digest (security-report.service.ts), the weekly security
 * digest worker, the bug-pattern digest worker, and the admin chat tool that validates a status
 * the model typed. Five copies of one list is five chances for a newly added status to be missing
 * from four of them — and the resulting failure is the worst shape a security metric can fail in.
 * Not wrong and loud: quietly LOW. The finding sits in the table, counts nowhere, and every
 * dashboard reports a cleaner workspace than the one that exists.
 *
 * ADDING A VALUE: add it to `securityFindingStatuses` above, and this Record stops compiling until
 * somebody decides which bucket it belongs to. Every reader then reads it from here, so the
 * decision lands everywhere at once. That failure is the point; it is the check this map exists to
 * provide.
 */
export const securityFindingStatusBuckets: Record<SecurityFindingStatus, SecurityFindingStatusBucket> = {
  OPEN: "open",
  ACKNOWLEDGED: "open",
  FIXED: "resolved",
  ACCEPTED_RISK: "resolved",
  /** Somebody says this is fixed; no scan has agreed yet. See `unresolvedSecurityFindingStatuses`
   *  for why that is not the same thing as resolved. */
  PENDING_VERIFICATION: "pending"
};

/** WHY MUTABLE ARRAYS and not `as const` tuples: every consumer of these is a Prisma
 *  `status: { in: … }` filter, and Prisma's `Enumerable<T>` does not accept a `readonly` array —
 *  the call sites this replaced all had to write `{ in: [...OPEN_FINDING_STATUSES] }` to strip the
 *  readonly-ness back off. Handing them an array they can pass straight in removes the spread and
 *  the temptation to hand-write the list instead. */
function securityFindingStatusesIn(bucket: SecurityFindingStatusBucket): SecurityFindingStatus[] {
  return securityFindingStatuses.filter((status) => securityFindingStatusBuckets[status] === bucket);
}

/** Findings nobody has claimed to have fixed. */
export const openSecurityFindingStatuses = securityFindingStatusesIn("open");
/** Findings that are done with — fixed and confirmed, or consciously accepted. */
export const resolvedSecurityFindingStatuses = securityFindingStatusesIn("resolved");
/** Findings claimed fixed but not yet confirmed by a later scan. */
export const pendingSecurityFindingStatuses = securityFindingStatusesIn("pending");

/**
 * Everything that is NOT resolved — the set that counts against a workspace's posture.
 *
 * WHY `pending` LANDS HERE. A claimed-but-unconfirmed fix is an unproven fix. If pending counted
 * as resolved, a workspace could lower its own risk score, empty its own insights page and quieten
 * its own weekly digest by marking findings fixed — no scanner involved, no evidence required.
 * The number that is supposed to measure exposure would instead measure how willing somebody was
 * to close a ticket. So a pending finding keeps counting until a scan stops reporting it, and only
 * then does it move to `resolved`.
 */
export const unresolvedSecurityFindingStatuses = [...openSecurityFindingStatuses, ...pendingSecurityFindingStatuses];

export const securityFindingAiVerdicts = ["TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_REVIEW"] as const;
export type SecurityFindingAiVerdict = (typeof securityFindingAiVerdicts)[number];

/**
 * WHERE ONE CLAIMED FIX STANDS WITH THE SCANNER — the verification ladder, in one column.
 *
 * `status` above answers "is this still a problem?". This answers the separate question "what does
 * the EVIDENCE say?", and the two are deliberately not the same field. A finding can be
 * PENDING_VERIFICATION (somebody closed the ticket) while the evidence is still AWAITING_PROOF, and
 * it can be FIXED while carrying VERIFIED_FIXED — which is the only combination that means a
 * scanner, not a person, decided it was over.
 *
 * WHY A COLUMN RATHER THAN THREE TIMESTAMPS READ TOGETHER: the verdict pass and the sweep both ask
 * "which findings are waiting on proof, on this repository and branch?" — a question a single
 * indexed value answers and a derivation over `status`, `verifiedFixedAt` and a due date does not.
 * The timestamps still exist beside it; they carry the EVIDENCE (which run, which commit, when),
 * and this carries the CONCLUSION.
 *
 * Null is the ordinary value: a finding that has never been through the gate has no verdict, and
 * that is not the same as having failed one.
 */
export const securityFindingVerificationStates = [
  /** A ticket was resolved/closed while this was still open. The next scan by the SAME TOOL on the
   *  same repo+branch decides. */
  "AWAITING_PROOF",
  /** A qualifying scan ran and did not report it. The strongest statement this system can make. */
  "VERIFIED_FIXED",
  /** A qualifying scan ran and reported it again. The fix did not hold. */
  "REFUTED_BY_SCAN",
  /** The grace window closed with no qualifying scan. NOT a failure — nobody proved anything either
   *  way, and treating silence as guilt is how a system like this gets switched off. */
  "UNVERIFIED"
] as const;
export type SecurityFindingVerificationState = (typeof securityFindingVerificationStates)[number];

/** What each verification state is called wherever a person reads it — the badge on the ticket's
 *  Security panel and the lines in the reopen digest. One list so the email and the screen cannot
 *  describe the same row differently. */
export const securityFindingVerificationLabels: Record<SecurityFindingVerificationState, string> = {
  AWAITING_PROOF: "Awaiting proof",
  VERIFIED_FIXED: "Verified fixed",
  REFUTED_BY_SCAN: "Reopened by scan",
  UNVERIFIED: "Unverified"
};

/**
 * What one row of an AI proposal points AT — the single source for the API and the browser alike.
 *
 * WHY THIS LIVES HERE and not as a literal union in each app. It used to be written twice: once in
 * `ai-proposal.service.ts` (correct, six values) and once by hand in the web's `api.ts` (four
 * values, missing CHANGE and TICKET_LABEL). The copies drifted, and because the web's copy said
 * CHANGE could not occur, TypeScript happily accepted a page that routed every proposal target to
 * the ticket sheet — so a change id was fetched as a ticket, 404'd, and rendered a blank panel.
 * Two apps agreeing about a wire format is exactly what this package is for.
 *
 * WHY IT IS NOT A PRISMA ENUM, unlike its three siblings on the same table (`AiProposalKind`,
 * `AiProposalStatus`, `AiProposalChangeOp`), which is a fair question to ask:
 *   - Every row is created through ONE path — `createProposal` in ai-proposal.service.ts — whose
 *     `changes` are `DraftChange[]`, and `DraftChange.targetType` is this type. The database
 *     already cannot receive a value outside this list, so an enum would add no guarantee.
 *   - A MySQL enum makes every future value a schema migration on a live table. That cost is worth
 *     paying for `status`, which drives queries and indexes; it is not worth paying for a
 *     discriminator that only decides which page a link opens.
 * If that ever stops being true — a second write path, or a query that filters on this column —
 * revisit it, but do so deliberately rather than for symmetry.
 *
 * ADDING A VALUE: add it here, and the web's `destinationFor` (pages/Proposals.tsx) will fail to
 * compile until somebody decides where its "open this" chevron should go. That failure is the
 * point; it is the check this list exists to provide.
 */
export const aiProposalTargetTypes = ["TICKET", "CHANGE", "PROJECT", "BOOKING", "LINK", "TICKET_LABEL"] as const;
export type AiProposalTargetType = (typeof aiProposalTargetTypes)[number];

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
  /** The other half of that pair: a scan proved a claimed fix did not hold. Goes wider than the
   *  close digest on purpose — the closer, the assignee and everyone who logged time against the
   *  ticket, with the closer's manager and the module owner in Cc. See
   *  security-report.service.ts#sendTicketReopenedDigest. */
  emailTicketReopenedDigest: boolean;
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
  "emailTicketReopenedDigest",
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
  /** Off by default, and the sibling of the switch above. When true, a ticket can't move to
   *  RESOLVED while the latest SonarQube quality gate on a branch linked to it reports ERROR — see
   *  `assertQualityGateAllowsResolve` in api/src/services/ticket.service.ts, which is the one place
   *  it is enforced for all three surfaces that can resolve a ticket. */
  blockResolveOnFailingQualityGate: boolean;
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

/**
 * How often a workspace's database is backed up automatically.
 *
 * The ORDER of this union is not what compares them — `BACKUP_FREQUENCY_RANK` is, so a member can
 * be added without every comparison in the codebase silently changing meaning.
 */
export type BackupFrequency = "NONE" | "WEEKLY" | "DAILY" | "HOURLY";

/** Least to most frequent. A tier permits any cadence whose rank is <= its own. */
export const BACKUP_FREQUENCY_RANK: Record<BackupFrequency, number> = { NONE: 0, WEEKLY: 1, DAILY: 2, HOURLY: 3 };

export const BACKUP_FREQUENCY_LABEL: Record<BackupFrequency, string> = {
  NONE: "No automatic backups",
  WEEKLY: "Weekly",
  DAILY: "Daily",
  HOURLY: "Hourly"
};

/** True when `wanted` is within what `ceiling` allows. The one comparison, so the API, the worker
 *  and the console cannot disagree about what a tier permits. */
export function backupFrequencyAllowed(wanted: BackupFrequency, ceiling: BackupFrequency): boolean {
  return BACKUP_FREQUENCY_RANK[wanted] <= BACKUP_FREQUENCY_RANK[ceiling];
}

/** Every cadence a tier may choose, most frequent first — what the console's picker renders. */
export function allowedBackupFrequencies(ceiling: BackupFrequency): BackupFrequency[] {
  return (["HOURLY", "DAILY", "WEEKLY", "NONE"] as BackupFrequency[]).filter((f) => backupFrequencyAllowed(f, ceiling));
}

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

  /* --- Managed backups (3.14.0) ------------------------------------------------------------ */
  /**
   * The most frequent AUTOMATIC backup this tier may schedule, and a CEILING rather than a
   * setting: a workspace picks its own cadence and the server clamps it to this, so a downgrade
   * takes effect on the next tick without anyone editing a policy.
   *
   * `NONE` means the tier cannot use the backup module at all — Starter. Fails CLOSED like every
   * capability on this interface.
   *
   * WHY IT IS TIERED AT ALL, since a backup is not a feature anybody wants to be sold: it has a
   * real, recurring, per-workspace cost that scales with how often it runs — a dump, egress to an
   * off-site destination, and storage that is kept for as long as the retention policy says. A
   * flat "everyone gets hourly" is a bill somebody pays. What is NOT tiered is the pre-deletion
   * snapshot: every workspace gets one before the retention programme drops it, on every plan.
   */
  backupFrequency: BackupFrequency;
  /** How many destinations may be configured at once. 0 pairs with a `NONE` frequency. */
  maxBackupDestinations: number;
  /**
   * Test restores and point-in-time recovery. Gated separately from the schedule because it is the
   * expensive half — a test restore materialises an entire database somewhere to prove the dump
   * reads back.
   */
  backupPitrEnabled: boolean;
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
    practiceUpdateEnabled: false,
    // No automatic backups on Starter. The pre-deletion snapshot the retention programme takes is
    // NOT this — every workspace gets one of those, on every plan.
    backupFrequency: "NONE",
    maxBackupDestinations: 0,
    backupPitrEnabled: false
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
    practiceUpdateEnabled: true,
    // WEEKLY, and one destination. A weekly off-site copy is the honest floor for a paying team:
    // it bounds the worst case at seven days of work, and it costs one dump and one upload a week
    // per workspace. Daily is what Enterprise buys, because daily is what multiplies the cost.
    backupFrequency: "WEEKLY",
    maxBackupDestinations: 1,
    // Test restores and PITR are the expensive half — a whole database materialised to prove a
    // dump reads back — so they are the other thing Enterprise buys.
    backupPitrEnabled: false
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
    practiceUpdateEnabled: true,
    // DAILY, dedicated, with room for several destinations — a primary bucket plus an off-site
    // copy is a normal enterprise requirement, not an exotic one. HOURLY exists in the model and
    // is deliberately NOT granted by the tier: it is a per-contract conversation, because it
    // multiplies both egress and storage by twenty-four.
    backupFrequency: "DAILY",
    maxBackupDestinations: 5,
    backupPitrEnabled: true
  }
};

/* ================================ List price (5.0.0) ==================================== *
 *
 * WHAT A SEAT COSTS, as one constant, because until 5.0.0 there was no price anywhere in this
 * product's data at all. `PlatformBillingSettings` holds Stripe Price IDs — opaque handles whose
 * amounts live in Stripe — and `PlanTierLimit` held entitlements and no money. So MRR was not
 * derivable, and the very common deployment that assigns tiers by hand and has no Stripe account
 * had nothing to derive it from either.
 *
 * WHY IT IS *NOT* A FIELD ON `PlanTierLimits` ABOVE: everything on that interface is something the
 * server ENFORCES — a ceiling, an allowlist, a capability that fails closed. A price enforces
 * nothing. Folding it in would also mean `plan-tier-claims.test.ts`'s entitlement contract and this
 * commercial one fail together, when they are two different conversations with two different
 * owners. They are pinned side by side in that same test instead.
 *
 * THIS IS A LIST PRICE. It is what the pricing page advertises, not what any given customer pays:
 * a discount, an annual commitment or a negotiated Enterprise contract all differ from it. Every
 * figure the platform console derives from it is labelled "list" for exactly that reason.
 *
 * `perSeatMinor` is MINOR UNITS (cents) so no money is ever held in a float. `null` means the tier
 * has no list price — Enterprise is priced per contract, and the landing page says "Custom". A
 * null must never be rendered, or summed, as zero: the console shows an unset price as "Not set"
 * and leaves those workspaces out of the MRR total with the count stated beside it.
 */
export interface PlanTierListPrice {
  /** Per seat, per month, in minor units of `currency`. `null` = no list price (priced per deal). */
  perSeatMinor: number | null;
  /** ISO-4217. One currency across the deployment; the console formats with it rather than a `$`. */
  currency: string;
}

export const PLAN_TIER_LIST_PRICES: Record<PlanTier, PlanTierListPrice> = {
  /** Free, and a real 0 rather than a null — Starter has a price and it is nothing. */
  STARTER: { perSeatMinor: 0, currency: "USD" },
  TEAM: { perSeatMinor: 800, currency: "USD" },
  /** "Talk to sales" on the pricing page, and deliberately unset here. A made-up Enterprise list
   *  price would show up in an MRR figure an operator would then quote to somebody. */
  ENTERPRISE: { perSeatMinor: null, currency: "USD" }
};

/** Minor units as a person reads them: `800` → `$8`, `850` → `$8.50`, `null` → the fallback. */
export function formatMinorUnits(minor: number | null | undefined, currency = "USD", fallback = "—"): string {
  if (minor === null || minor === undefined) return fallback;
  const major = minor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    // Whole amounts read better without ".00" in a pricing card; fractional ones need both digits.
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(major);
}

/** What the pricing card shows for a tier. "Custom" rather than an em dash: a landing page saying
 *  "—" reads as an oversight, and this is the tier where the answer really is a conversation. */
export function planTierPriceLabel(tier: PlanTier): string {
  return formatMinorUnits(PLAN_TIER_LIST_PRICES[tier].perSeatMinor, PLAN_TIER_LIST_PRICES[tier].currency, "Custom");
}

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

/* ------------------------------------------------------------------------------------------ *
 * Sales enquiries (4.0.0)
 *
 * The vocabulary the public contact form offers, the API validates against, and the console
 * displays. THREE surfaces, which is exactly the number at which a copied list starts drifting:
 * add an option to the form and the API rejects it; rename a label in the console and the
 * notification email keeps the old one. The codes are what is stored (`SalesLead.teamSize` and
 * friends are short strings, not MySQL enums, so they survive a rename); the labels are the only
 * words a person ever sees.
 * ------------------------------------------------------------------------------------------ */

/** Bands, not a number: nobody knows their exact headcount, and the band is the part that decides
 *  who picks the enquiry up. */
export const TEAM_SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "500+"] as const;
export type TeamSizeBand = (typeof TEAM_SIZE_BANDS)[number];
export const TEAM_SIZE_LABEL: Record<TeamSizeBand, string> = {
  "1-10": "1–10 people",
  "11-50": "11–50 people",
  "51-200": "51–200 people",
  "201-500": "201–500 people",
  "500+": "500+ people"
};

/** How they want to run it — the first question an enterprise buyer asks, so it is asked of them. */
export const DEPLOYMENT_INTERESTS = ["SAAS", "PRIVATE_CLOUD", "ON_PREM", "UNSURE"] as const;
export type DeploymentInterest = (typeof DEPLOYMENT_INTERESTS)[number];
export const DEPLOYMENT_LABEL: Record<DeploymentInterest, string> = {
  SAAS: "Hosted by TimeSphere",
  PRIVATE_CLOUD: "Our own cloud",
  ON_PREM: "On our own hardware",
  UNSURE: "Not decided yet"
};

export const SALES_TIMELINES = ["NOW", "THIS_QUARTER", "EXPLORING"] as const;
export type SalesTimeline = (typeof SALES_TIMELINES)[number];
export const TIMELINE_LABEL: Record<SalesTimeline, string> = {
  NOW: "Now",
  THIS_QUARTER: "This quarter",
  EXPLORING: "Exploring"
};

/** What they are evaluating. A closed list, because it decides which demo they are shown — free
 *  text here would only be a second, worse copy of the message field. */
export const SALES_INTERESTS = ["TIMESHEETS", "TICKETING", "CHANGE", "AI", "SSO_SCIM", "COMPLIANCE", "BACKUPS", "INTEGRATIONS"] as const;
export type SalesInterest = (typeof SALES_INTERESTS)[number];
export const INTEREST_LABEL: Record<SalesInterest, string> = {
  TIMESHEETS: "Timesheets & approvals",
  TICKETING: "Ticketing & SLAs",
  CHANGE: "Change management",
  AI: "AI assistance",
  SSO_SCIM: "SSO / SCIM",
  COMPLIANCE: "Audit & compliance",
  BACKUPS: "Backups & retention",
  INTEGRATIONS: "Integrations"
};

/** The pipeline a lead moves through, in the order it moves. */
export const SALES_LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "WON", "LOST"] as const;
export type SalesLeadStatus = (typeof SALES_LEAD_STATUSES)[number];

/** A code back into words, tolerating a value stored before an option was renamed. */
export const salesLabel = (map: Record<string, string>, code: string | null | undefined): string => (code ? (map[code] ?? code) : "—");
