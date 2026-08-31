/**
 * The in-app help: every article, in one place, for BOTH of its consumers.
 *
 * WHY THIS LIVES IN `packages/shared` and not in the web app: the Help page renders these articles
 * and Ask AI answers "how do I…" questions from them, and those are different processes — the page
 * is a browser bundle, the assistant is the API. Two copies of "how to raise a change" would
 * disagree within a month, which is the exact failure this repo has now fixed three times
 * (connectors, proposal target types, the pitch exports). One module, two importers, and a search
 * function they share — so what the page shows and what the assistant says are the same words
 * filtered by the same role predicate.
 *
 * THE RULES FOR WRITING AN ARTICLE, because docs rot in a specific way here:
 *  - Every claim maps to shipped UI. `where` is a real navigation path; `steps` are the real
 *    clicks. The marketing pages' rule applies doubly to documentation — a doc that describes a
 *    button that isn't there costs more trust than no doc.
 *  - `roles` is the VIEWER gate, absent meaning everyone. It drives the Help page's filter and the
 *    assistant's, through the same helper, so neither can show an employee a super-admin SOP.
 *  - `screenshot` names a file in `apps/web/public/product/` — the twelve real captures. No
 *    screenshot is invented for an article that lacks one; a test asserts every named file exists.
 *  - Keywords carry the words people actually type ("raise", "SOP", "FAQ"), not taxonomy.
 */

import type { RoleName } from "./index.js";

export interface HelpArticle {
  /** Stable anchor — the Help page's deep link and the assistant's reference. */
  id: string;
  category: HelpCategory;
  title: string;
  /** Who this is FOR. Absent = every role. Also the visibility gate on both surfaces. */
  roles?: RoleName[];
  /** The navigation path, as a person would read it. */
  where: string;
  /** When somebody should reach for this. One or two sentences. */
  when: string;
  /** The actual clicks, in order. */
  steps: string[];
  /** Anything worth knowing that is not a step — limits, gotchas, what happens next. */
  notes?: string;
  /** A file in apps/web/public/product/. Only real captures. */
  screenshot?: string;
  keywords: string[];
}

export const HELP_CATEGORIES = [
  "Getting started",
  "Timesheets",
  "Tickets",
  "Change management",
  "Dashboards & reports",
  "People & roles",
  "AI",
  "Workspace settings",
  "Platform & operations"
] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];

const ADMIN: RoleName[] = ["ADMIN", "SUPER_ADMIN"];
const APPROVERS: RoleName[] = ["MANAGER", "TEAM_LEAD", "ADMIN", "SUPER_ADMIN"];
const SA: RoleName[] = ["SUPER_ADMIN"];

export const HELP_ARTICLES: HelpArticle[] = [
  /* ── Getting started ─────────────────────────────────────────────────────────────────────── */
  {
    id: "sign-in",
    category: "Getting started",
    title: "Signing in",
    where: "The sign-in page at /login",
    when: "Every session. The page shows only the methods your workspace has switched on.",
    steps: [
      "Pick a method: Continue with Google / Microsoft / single sign-on if your admin enabled them, or the Password tab.",
      "If your workspace uses a directory (LDAP / Active Directory), switch to the Directory tab and use your directory credentials.",
      "Press the round fingerprint sensor (or Enter) to sign in — it scans while your credentials are checked, turns green on success and red on failure.",
      "Wrong workspace? Use “Not your workspace? Find yours” at the bottom — every workspace has its own address."
    ],
    notes:
      "Already signed in? Opening /login sends you straight into the app. To sign in as somebody else on a shared machine, sign out first from the profile menu. The fingerprint is the submit button, not a biometric check.",
    keywords: ["login", "log in", "sso", "google", "microsoft", "ldap", "directory", "password", "fingerprint", "workspace"]
  },
  {
    id: "profile-and-appearance",
    category: "Getting started",
    title: "Your profile, avatar and theme",
    where: "Profile menu (top-right avatar) → Profile; theme toggle in the top bar",
    when: "First day, and whenever your details change.",
    steps: [
      "Open the profile menu (your avatar, top right) and choose Profile.",
      "Upload a profile photo — images are re-encoded, and scanned first when your admin has malware scanning on.",
      "Add your phone number so approvers can reach you about urgent items.",
      "Toggle light/dark with the sun/moon button in the top bar — the new theme sweeps out from the button."
    ],
    keywords: ["profile", "avatar", "photo", "phone", "theme", "dark mode", "light mode", "appearance"]
  },
  {
    id: "notifications",
    category: "Getting started",
    title: "The notification bell",
    where: "Top bar → the bell",
    when: "Anything addressed to you lands here: approvals waiting, mentions, escalations, release announcements.",
    steps: [
      "Click the bell to open the panel; unread items are marked.",
      "Click a notification to jump to the thing it is about.",
      "Release announcements appear here once per upgrade — What's new in the profile menu keeps the full history."
    ],
    keywords: ["notifications", "bell", "alerts", "unread", "mentions"]
  },

  /* ── Timesheets ──────────────────────────────────────────────────────────────────────────── */
  {
    id: "log-time",
    category: "Timesheets",
    title: "Logging a timesheet entry",
    where: "Sidebar → Log timesheet",
    when: "Daily, for the work you actually did — entries feed approvals, utilisation and the client-facing record.",
    steps: [
      "Pick the project, then module and submodule — the pickers only offer what you are assigned to.",
      "Set the date, start time and hours. Overlapping another of your entries is flagged before you save.",
      "Describe the task. “Refine with AI” tightens grammar and clarity only — it will not add facts or change numbers, because an approver signs this text.",
      "Attach evidence if useful (files are scanned first when scanning is on), then save. The entry starts as a draft.",
      "Submit it to start the review clock — your manager sees it instantly."
    ],
    notes: "A daily-cap warning appears when a day's total looks wrong. The dashboard's “No entry for today yet” banner is the shortcut back here.",
    screenshot: "timesheet.png",
    keywords: ["log", "time", "timesheet", "entry", "hours", "submit", "draft", "task", "attachment"]
  },
  {
    id: "timesheet-statuses",
    category: "Timesheets",
    title: "What the timesheet statuses mean",
    where: "Sidebar → History (your entries), or the dashboard's This week card",
    when: "When you want to know where an entry is in the pipeline.",
    steps: [
      "DRAFT — only you can see it; edit freely.",
      "PENDING — submitted, waiting on your manager. Editing pulls it back to draft.",
      "APPROVED — locked into the record at the rate that applied on approval.",
      "REJECTED — comes back with the approver's note; fix and resubmit."
    ],
    keywords: ["status", "draft", "pending", "approved", "rejected", "resubmit", "history"]
  },
  {
    id: "approve-timesheets",
    category: "Timesheets",
    title: "Approving or rejecting timesheets",
    roles: APPROVERS,
    where: "Sidebar → Approvals",
    when: "The queue opens on what is waiting for your decision.",
    steps: [
      "Open Approvals — it lists entries awaiting you; the status filter widens it to everything you may see.",
      "Open an entry for the full detail: task text, attachments, the day's other entries.",
      "Approve, or reject with a note the person can act on.",
      "Export one entry's full detail when you need it outside the app."
    ],
    notes: "Approval snapshots the billing rate — a rate change next quarter cannot rewrite what was approved today. Identity-verified approvals feed the attestation PDF.",
    keywords: ["approve", "reject", "approvals", "queue", "manager", "review", "pending", "timesheet", "timesheets"]
  },

  /* ── Tickets ─────────────────────────────────────────────────────────────────────────────── */
  {
    id: "raise-ticket",
    category: "Tickets",
    title: "Raising a ticket",
    where: "Sidebar → Tickets → New ticket",
    when: "Bugs, tasks and requests — anything that should be tracked, assigned and closed.",
    steps: [
      "Choose the project, a type and a priority; add a clear title and description (Refine with AI is available on both).",
      "If AI triage is enabled, a suggested priority/assignee appears — it is a suggestion you accept or ignore.",
      "Duplicate detection warns when an existing ticket looks like the same issue — check it before filing a twin.",
      "Attach screenshots or files (scanned first when scanning is on) and create."
    ],
    notes: "Tickets can also arrive without this form: email intake, Slack/Teams/Google Chat/Telegram, and public request forms all land as routed tickets when configured.",
    screenshot: "tickets.png",
    keywords: ["ticket", "raise", "create", "bug", "task", "issue", "priority", "duplicate", "triage"]
  },
  {
    id: "work-ticket",
    category: "Tickets",
    title: "Working a ticket: statuses, comments, GitHub",
    where: "Tickets → open any ticket",
    when: "The ticket panel is the working surface — status, conversation and code in one place.",
    steps: [
      "Move status with Transition: OPEN → IN PROGRESS → IN REVIEW → RESOLVED → CLOSED. Reopening a closed ticket needs an admin or manager.",
      "Comment to keep the discussion on the record; watch a ticket to be notified of every change.",
      "Use the checklist for sub-steps, and link related tickets so the relationship survives.",
      "On the Dev tab, pick the GitHub repo/branch/PR — or create a branch named for the ticket — when your admin has connected GitHub."
    ],
    keywords: ["ticket", "status", "transition", "comment", "watcher", "checklist", "github", "branch", "pr", "reopen", "resolve", "close"]
  },
  {
    id: "verification-badges",
    category: "Tickets",
    title: "What the verification badge on a security finding means",
    where: "Tickets → open a ticket carrying findings → the Security tab",
    when: "You resolved a ticket with security findings on it and want to know whether the fix has actually been confirmed.",
    steps: [
      "Open the ticket and go to its Security tab. Each finding shows a badge for what a scanner has observed, which is separate from the status you set.",
      "“Awaiting proof” — you marked it fixed and no qualifying scan has run yet. It still counts as open until one does.",
      "“Verified fixed” — a later scan by the same tool, on the same repository and branch, no longer reports it. The box names the scan and the commit that proved it.",
      "“Reopened by scan” — that scan still reports it, so the fix did not hold. If auto-reopen is on for your workspace the ticket was reopened and the SLA clock restarted.",
      "“Unverified” — nothing has run in the grace window. Nothing has been proven either way, and no ticket was reopened because of it: this usually means the scan job itself stopped running."
    ],
    notes:
      "The footer under each finding shows when it was first seen, how many scans have reported it and the run it came from. A repeat scan raises that count rather than adding another copy of the same finding.",
    keywords: ["verified", "verification", "awaiting proof", "unverified", "reopened", "badge", "finding", "security", "fix", "proof", "scan"]
  },
  {
    id: "reopen-digest",
    category: "Tickets",
    title: "The “a fix did not hold” email, and why you got it",
    where: "Your inbox, and the ticket it links to under Tickets",
    when: "A scan found a security finding still present after the ticket claiming to fix it was resolved or closed.",
    steps: [
      "The mail names which scan, which commit, which findings survived and how long they have been open — enough to act without opening anything first.",
      "Follow the link to the ticket. If auto-reopen is on it is already back in progress with the SLA clock restarted; if it is off it is exactly where it was and somebody has to move it by hand.",
      "The ticket also carries a system comment with the same evidence, so the record survives the email.",
      "Not sure why you were included? It goes to whoever closed the ticket, its current assignee and everyone who logged time against it, copying the closer's manager and the routed module's owner."
    ],
    notes:
      "It is called “A fix did not hold” in Workspace settings → Email channels, where a super admin can mute it like any other message under the same category-by-role grid. Muting the mail does not switch off the verification itself, and the in-app bell still fires.",
    keywords: ["reopen", "reopened", "digest", "email", "regression", "fix", "did not hold", "security", "scan", "sla"]
  },

  /* ── Change management ───────────────────────────────────────────────────────────────────── */
  {
    id: "raise-change",
    category: "Change management",
    title: "Raising a change request",
    where: "Sidebar → Change Management → New change",
    when: "Any production-affecting work that needs assessment, approval and a scheduled window.",
    steps: [
      "Pick the type: Standard (pre-approved routine), Normal, Emergency, or Major (Normal escalated — forces a backout plan and a post-implementation review).",
      "Fill the risk assessment COMPLETELY — every parameter. A half-filled form under-reports risk, so submission requires all of it.",
      "The score bands the change (Low/Medium/High); the band decides whether a backout plan is mandatory.",
      "Write the implementation, test and communication plans — Draft with AI can propose text you accept per section.",
      "Schedule it against the calendar; blackout windows are shown so you can dodge them. Then submit for approval."
    ],
    notes: "A change IS a ticket underneath — comments, attachments, watchers and audit come with it. Keys look like HICS-TS-20260819-0001.",
    screenshot: "changes.png",
    keywords: ["change", "raise", "cab", "risk", "assessment", "backout", "emergency", "standard", "major", "schedule", "blackout"]
  },
  {
    id: "approve-change",
    category: "Change management",
    title: "Approving a change",
    roles: APPROVERS,
    where: "Change Management → the change → Approvals",
    when: "Approval is the requester's manager, or a super admin — never the requester.",
    steps: [
      "Open the change and review the risk band, the plans and the schedule.",
      "Approve, or reject with the objection written down — a rejection opens a NEW round rather than overwriting, so the objection survives the rework.",
      "After approval the runbook stays editable: recording that step 4 failed is work that happens during implementation."
    ],
    notes: "A change cannot move to Implementing while a predecessor is open — the refusal names the blocker.",
    keywords: ["change", "approve", "reject", "approval", "cab", "review", "implementing"]
  },

  /* ── Dashboards & reports ────────────────────────────────────────────────────────────────── */
  {
    id: "home-dashboard",
    category: "Dashboards & reports",
    title: "Reading your home dashboard",
    where: "Sidebar → Home",
    when: "Everyone opens to what's theirs: an engineer sees today's timeline and unlogged time, a manager sees the queue and SLA timers.",
    steps: [
      "The date filter at the top drives EVERY card — change it once and hours, tickets and comparisons all follow.",
      "Comparisons read against the previous equal-length period, so “vs last period” means what it says.",
      "The day timeline shows one lane per person you are entitled to see; the setup checklist retires itself as you finish it."
    ],
    screenshot: "dashboard.png",
    keywords: ["dashboard", "home", "date filter", "cards", "timeline", "week", "overview"]
  },
  {
    id: "insights-reports",
    category: "Dashboards & reports",
    title: "Insights, exports and scheduled reports",
    roles: APPROVERS,
    where: "Sidebar → Insights; exports from the report screens",
    when: "Velocity, SLA compliance, cycle-time distribution and workload — computed from the same rows the approvals ran against.",
    steps: [
      "Open Insights and set the range; every chart follows it.",
      "Export a 22-column CSV or a real Excel workbook from the report screens.",
      "Schedule a dashboard to email daily/weekly/monthly — recipients need no account, and the report is built with YOUR access, stopping if you leave."
    ],
    screenshot: "insights.png",
    keywords: ["insights", "report", "export", "csv", "excel", "schedule", "velocity", "sla", "analytics"]
  },
  {
    id: "goals",
    category: "Dashboards & reports",
    title: "Goals that measure themselves",
    where: "Sidebar → Goals",
    when: "OKRs whose progress is computed from six wired sources — closed tickets, approved hours and friends — rather than typed in.",
    steps: [
      "Create a goal, pick what it targets (project, portfolio or tickets) and the measure.",
      "Progress updates itself as the underlying work moves; a goal with no wired source says so instead of pretending.",
      "Review the trend on the goal — the history is kept, not just the current number."
    ],
    screenshot: "goals.png",
    keywords: ["goals", "okr", "target", "progress", "objectives"]
  },

  /* ── People & roles ──────────────────────────────────────────────────────────────────────── */
  {
    id: "create-users",
    category: "People & roles",
    title: "Creating and managing users",
    roles: ADMIN,
    where: "Sidebar → User management (admin section)",
    when: "Adding people, changing roles, deactivating leavers.",
    steps: [
      "Add a user with name, email and role — they receive a one-time password and must change it on first sign-in.",
      "Bulk-add via CSV upload when onboarding a team.",
      "Deactivate instead of delete: history is preserved, sign-in is blocked. Force-logout ends someone's sessions immediately.",
      "With SCIM configured, your identity provider creates and deactivates accounts automatically — see the SSO article."
    ],
    keywords: ["user", "create", "invite", "deactivate", "csv", "bulk", "password", "force logout", "manage users"]
  },
  {
    id: "roles",
    category: "People & roles",
    title: "Roles, permissions and switching role",
    where: "Profile menu → Switch role (when you hold more than one)",
    when: "Five roles — SUPER ADMIN, ADMIN, MANAGER, TEAM LEAD, EMPLOYEE — each a fixed permission set the pages enforce.",
    steps: [
      "Employees log time and raise tickets; team leads and managers also approve and see their people's work.",
      "Admins manage users, projects and most settings; the super admin holds workspace-wide settings, billing and AI controls.",
      "Hold more than one role? The profile menu gains Switch role — the app re-scopes instantly, no sign-out needed."
    ],
    keywords: ["roles", "permissions", "rbac", "switch role", "admin", "manager", "employee", "access"]
  },

  /* ── AI ──────────────────────────────────────────────────────────────────────────────────── */
  {
    id: "ask-ai",
    category: "AI",
    title: "Ask AI: your workspace, questioned",
    where: "Sidebar → Ask AI",
    when: "Questions about YOUR tickets, hours, changes, projects and people — it reads the workspace as you, with your permissions.",
    steps: [
      "Ask in plain language: “where did my hours go last week?”, “break my tickets down by status, with a chart”.",
      "Type / in the box to open the capability menu — everything your role allows, filter by typing, Enter to pick.",
      "“What can it do?” (top right) lists every capability and which ones your role locks.",
      "Rate answers with the thumbs — ratings feed the workspace's quality datasets.",
      "The one thing it writes is a DRAFT timesheet entry, which you review and submit yourself."
    ],
    notes: "It answers only about this product and workspace — no web search, no outside knowledge. Off-topic questions get a polite fixed refusal.",
    keywords: ["ask ai", "assistant", "chat", "question", "slash", "capabilities", "chart"]
  },
  {
    id: "requirements-studio",
    category: "AI",
    title: "Requirements Studio: idea → PRD → tickets",
    where: "Sidebar → Requirements Studio",
    when: "Turning an idea, or a client's existing PRD/BRD document, into a structured spec and then the tickets and goals that build it.",
    steps: [
      "Start a document and answer the AI interview — or upload the PRD the client already wrote and review what it extracted.",
      "Edit any answer; the document is yours, the interview is scaffolding.",
      "Generate the requirements document, then create the proposed tickets and goals from it — each one a suggestion you accept individually."
    ],
    // `requirements.png`, NOT `studio.png` — the latter is a capture of Workflow Studio, a
    // different page reached from a different sidebar entry. Two products in this workspace are
    // called something Studio and the filenames do not disambiguate them, so the article that
    // describes Requirements Studio names the capture that shows it.
    screenshot: "requirements.png",
    keywords: ["requirements", "prd", "brd", "spec", "interview", "studio", "generate tickets"]
  },
  {
    id: "practice-update",
    category: "AI",
    title: "The weekly practice update",
    roles: SA,
    where: "Sidebar → Practice update (super admin)",
    when: "A leadership update nobody fills in: counted from the workspace, drafted around the figures, reviewed before it sends.",
    steps: [
      "Generate the week — figures are counted, prose is drafted; the two are kept apart so a model outage still yields a complete update.",
      "Edit the written sections in the rich-text editor; Refine with AI keeps formatting.",
      "Your draft survives navigation and refreshes — only Regenerate or Discard clears it.",
      "Send. The exact HTML that went out is archived under History, with preview."
    ],
    screenshot: "practice-update.png",
    keywords: ["practice update", "weekly", "digest", "leadership", "report", "email"]
  },
  {
    id: "ai-teammates",
    category: "AI",
    title: "AI teammates and workflows",
    roles: ADMIN,
    where: "Sidebar → Agents, and Workflows",
    when: "Named assistants that compose capabilities the workspace already runs — scoped, budgeted, and off by default.",
    steps: [
      "Create a teammate, name it, and scope it to specific capabilities and projects.",
      "Everything it proposes lands on the AI suggestions page as reviewable rows — accept or reject each individually; there is deliberately no apply-everything.",
      "Runs are priced on the same ledger as human work, against the same AI budget."
    ],
    screenshot: "agents.png",
    keywords: ["agents", "teammates", "workflows", "automation", "propose", "suggestions"]
  },
  {
    id: "ai-settings",
    category: "AI",
    title: "AI settings: keys, budgets and quality",
    roles: SA,
    where: "Workspace settings → AI",
    when: "Every AI capability is off until you switch it on here, and every call runs on YOUR provider key under YOUR budget.",
    steps: [
      "Add providers under AI providers — Anthropic, or any OpenAI-compatible endpoint (OpenAI, Groq, Mistral, Ollama…), each with its own key and model.",
      "Order them: every call tries the top enabled provider and falls through on failure. Test fires a real tiny request.",
      "Set the monthly budget ceiling — enforced live, per call.",
      "Flip each capability's own switch; nothing calls out until you do.",
      "The quality loop lives here too: captured interactions, golden datasets, prompt versions and eval runs."
    ],
    screenshot: "settings-ai.png",
    keywords: ["ai settings", "byok", "provider", "key", "budget", "ollama", "anthropic", "openai", "quality", "evals", "prompt"]
  },

  /* ── Workspace settings ──────────────────────────────────────────────────────────────────── */
  {
    id: "settings-map",
    category: "Workspace settings",
    title: "Workspace settings: what lives where",
    roles: SA,
    where: "Sidebar → Workspace settings",
    when: "The map, so you open the right tab first time.",
    steps: [
      "Branding — name, logo, colours. Reminders & schedule — nudge times and working days.",
      "Email channels / Mail server / Email intake — what sends, how it sends (SMTP), what arrives (IMAP → tickets).",
      "Ticketing / Planning / Change management — types, workflows, rules, matrices.",
      "AI / Chat integrations / Security & DevOps / Face verification — capabilities, chat platforms, git + CI + malware scanning, identity checks.",
      "Single sign-on (with SCIM) / Billing / Public API / MCP server — identity, plan, machine access.",
      "Maintenance / Storage & logs / BCC & forms — operations."
    ],
    keywords: ["settings", "workspace", "tabs", "where", "configure", "admin"]
  },
  {
    id: "sso-setup",
    category: "Workspace settings",
    title: "Single sign-on and SCIM",
    roles: SA,
    where: "Workspace settings → Single sign-on",
    when: "Connecting Google, Microsoft/Entra, any SAML IdP or LDAP — and letting the IdP create and close accounts (SCIM).",
    steps: [
      "The connection board shows all five at a glance: Live, Ready (saved but off), Half configured, or Not set up.",
      "Open a provider's card and enter YOUR OWN app registration — there is no shared client.",
      "Use Test connection, then prove it: “Require SSO only” stays locked until a real person has signed in that way — the only check that cannot lock everyone out.",
      "SCIM lives on the same tab: generate the bearer token (shown once), give it and the base URL to your IdP."
    ],
    keywords: ["sso", "saml", "oidc", "google", "microsoft", "entra", "ldap", "scim", "provisioning", "require sso"]
  },
  {
    id: "email-setup",
    category: "Workspace settings",
    title: "Email: sending, templates and intake",
    roles: SA,
    where: "Workspace settings → Mail server / Email channels / Email intake",
    when: "Outbound mail, the 39 editable templates, and the mailbox that turns bug reports into tickets.",
    steps: [
      "Mail server: your SMTP credentials override the install defaults; the connection test sends a real message.",
      "Email channels & templates: per-template enable, preview, test-send, revert and delivery analytics.",
      "Email intake: an IMAP mailbox polled for inbound mail — each message becomes a routed ticket; routing rules decide the project."
    ],
    keywords: ["email", "smtp", "imap", "templates", "intake", "mail", "delivery", "bounce"]
  },
  {
    id: "security-devops",
    category: "Workspace settings",
    title: "Security & DevOps: GitHub, CI and malware scanning",
    roles: SA,
    where: "Workspace settings → Security & DevOps",
    when: "Connecting code, ingesting scanner findings, and gating uploads.",
    steps: [
      "Git provider: bring your own GitHub OAuth App; tickets then get repo/branch/PR pickers.",
      "CI webhooks: GitHub Actions, GitLab, Jenkins and friends push test runs and security findings. A finding is routed by the file it names — see Route findings by file path below — so it lands on the module that owns the code rather than on whoever happens to be first in the list.",
      "Malware scanning: the switch scans EVERY upload before it is stored. It fails closed — with it on and the scanner down, uploads are refused — so use Test scanner beside it before flipping."
    ],
    // The TAB, not the insights page. This article named `security.png` for a while, which is the
    // "Security & DevOps insights" screen — where findings are READ, not where any of the switches
    // above live — so a reader following the steps was looking at a picture of somewhere they were
    // not. `settings-security-devops.png` is a real capture of this tab, taken by
    // tests/e2e/screenshots.spec.ts alongside every other product shot so it is anonymised and
    // refreshed rather than going stale as a hand-cropped one-off.
    screenshot: "settings-security-devops.png",
    keywords: ["security", "devops", "github", "oauth", "ci", "webhook", "virus", "malware", "scan", "clamav", "findings"]
  },
  {
    id: "sonarqube-eslint",
    category: "Workspace settings",
    title: "Connecting SonarQube and ESLint",
    roles: SA,
    where: "Workspace settings → Security & DevOps → Security & CI ingestion",
    when: "You already run SonarQube or ESLint and want their results tracked, deduplicated, routed and verified like every other finding.",
    steps: [
      "Press Generate token (or Rotate token) on the Security & CI ingestion card and copy it. Every URL below is authenticated with `Authorization: Bearer <token>` — nothing else.",
      "Copy “SonarQube quality-gate webhook” and paste it into SonarQube under Administration → Configuration → Webhooks, adding the same Authorization header there. Sonar's payload is stored exactly as it sends it — there is nothing to translate.",
      "Copy “SonarQube issues webhook” and have your pipeline POST the response from Sonar's /api/issues/search to it, unmodified. A VULNERABILITY becomes a SAST finding; a BUG or CODE_SMELL becomes a code-quality one.",
      "Copy “ESLint findings webhook” and POST `eslint --format json` output to it. Send `rootPath` (your CI workspace directory) alongside it, or two runners will report the same file with different absolute paths and nothing will deduplicate.",
      "Optional: Workspace settings → Ticketing → “Block resolve on failing quality gate”, so a ticket cannot be resolved while the latest gate on its linked branch is failing."
    ],
    notes:
      "Quality and lint results are excluded from every security figure — the risk score, the by-severity chart and the weekly security digest — and that separation is enforced in code, so connecting a linter cannot make your security posture look like it collapsed overnight. They still deduplicate, route to modules and get verified by the next scan exactly as a vulnerability does. ESLint findings are never filed above MEDIUM severity.",
    keywords: ["sonarqube", "sonar", "eslint", "lint", "quality gate", "code smell", "ci", "webhook", "findings", "ingestion", "token"]
  },
  {
    id: "finding-routing",
    category: "Workspace settings",
    title: "Routing findings to the right project, module and submodule",
    roles: SA,
    where: "Workspace settings → Security & DevOps → Route findings by repository / by file path",
    when: "Auto-created security tickets are landing in the wrong project, or on the wrong person.",
    steps: [
      "“Route findings by repository”: add a repository pattern and the project its findings belong in. Rules are evaluated in order, lowest first, and the first match wins; anything unmatched falls back to the project set on the ingestion card.",
      "“Route findings by file path”: add a path pattern with the module — and optionally the submodule — that owns it. Same ordering, same first-match-wins rule. `*` stays inside one path segment, `**` crosses them, and a trailing `/` means that directory and everything under it.",
      "Set a default assignee for that module under Workspace settings → Email intake → “Module auto-assignment” — the same rule email intake already uses is what a matched finding's ticket is assigned through.",
      "Use “Test a path” below the rules: type a repository (e.g. `acme/web-app`) and a file path (e.g. `apps/api/src/services/billing-rate.service.ts`), press Test, and it runs the same resolver the ingestion does — showing the project, module and submodule it would pick and which rule decided it. It changes nothing.",
      "Use the Active switch on a row to take a rule out of the running without deleting it."
    ],
    notes:
      "Configure this after upgrading to 5.0.0. Before it, auto-created security tickets were assigned through whichever module on the fallback project happened to have an assignee rule — arbitrary, and now removed. Without path rules those tickets fall through to CODEOWNERS (where you have enabled it) or arrive unassigned. The repository rules also decide where a ticket auto-created from a failed CI run opens, matched against the repository named in that run's pull-request URL; such a ticket carries no module (a failed run names no file) and is never auto-assigned.",
    keywords: ["routing", "route", "findings", "repository", "module", "submodule", "path", "glob", "pattern", "assignee", "project", "test a path"]
  },
  {
    id: "verified-remediation",
    category: "Workspace settings",
    title: "Verified remediation: making a scan confirm a fix",
    roles: SA,
    where: "Workspace settings → Security & DevOps → Verified remediation",
    when: "You want “resolved” on a security ticket to mean a scanner agreed, not that somebody said so.",
    steps: [
      "Turn on “Require a scan to confirm a fix”. Findings on a ticket that is resolved or closed then become a claim awaiting proof, and keep counting as unresolved until a scan settles them.",
      "Set the “Grace window” — 7, 14, 30 or 60 days — for how long a claim waits for a qualifying scan before it is marked unverified. Fourteen days is the default.",
      "Decide separately whether to turn on “Reopen tickets on CI regression”. Verification on with auto-reopen off is a supported setup: you are told what happened and your tickets are left where they are.",
      "Check that the tool you rely on actually runs on that repository and branch — proof only counts from the same tool, the same repository and branch, and the same kind of finding.",
      "Watch the “Awaiting proof” tile on Security insights: findings sitting there are claimed fixes nobody has confirmed."
    ],
    notes:
      "A missing scan is never treated as a failure. If nothing qualifying runs inside the window the finding is marked unverified and the assignee is nudged in their bell — no ticket is reopened, because absence of proof is not proof that the fix failed.",
    keywords: ["verified", "verification", "remediation", "reopen", "regression", "proof", "grace window", "scan", "security", "fix", "auto-reopen"]
  },
  {
    id: "billing-plans",
    category: "Workspace settings",
    title: "Billing, plans and seat limits",
    roles: SA,
    where: "Workspace settings → Billing",
    when: "Your tier, seats and upgrades. Limits are enforced live on every request, not at renewal.",
    steps: [
      "The card shows your plan and seat usage; Starter is free to ten users.",
      "Upgrade to Team ($8/seat/month) or Enterprise through the buttons — payment is handled by Stripe Checkout the first time.",
      "Already subscribed? The buttons read “Switch to …” instead, and the change is applied to your existing subscription with proration rather than starting a second one.",
      "AI usage is never billed by us: you pay your model provider directly, under the budget you set on the AI tab."
    ],
    notes:
      "A tier change emails your workspace's super admins a receipt. A seat count changing on its own does not — that is not a plan change.",
    keywords: ["billing", "plan", "tier", "seats", "upgrade", "stripe", "payment", "enterprise", "starter", "team"]
  },
  {
    id: "billing-portal-invoices",
    category: "Workspace settings",
    title: "Changing your card, cancelling, and finding an invoice",
    roles: SA,
    where: "Workspace settings → Billing",
    when: "A card expired, finance wants a copy of last month's invoice, or you are cancelling.",
    steps: [
      "Press “Manage billing” at the top of the Plan & billing card. It hands you to Stripe's own customer portal, signed in as your workspace.",
      "In the portal: update the payment method, change the billing address and tax details, download past invoices, or cancel the subscription.",
      "Stripe's return link brings you back to Workspace settings when you are done.",
      "For a quick look without leaving the app, scroll to “Recent invoices” on the same card: the last twelve, each with a “View” link that opens Stripe's hosted invoice page in a new tab.",
      "The button only appears once your workspace has a Stripe customer — a Starter workspace that has never subscribed has nothing to manage. It stays available after a subscription ends, so you can still reach your invoice history."
    ],
    notes:
      "Invoices are rendered and stored by Stripe, not by us, so what your finance team downloads is the document of record. If you land back here from a checkout, the page shows a confirmation and refreshes twice — the second refresh covers the few seconds Stripe's webhook can lag behind the redirect.",
    keywords: ["invoice", "invoices", "receipt", "card", "payment method", "cancel", "cancellation", "portal", "stripe", "billing", "refund", "vat", "tax"]
  },

  /* ── Platform & operations ───────────────────────────────────────────────────────────────── */
  {
    id: "install-sop",
    category: "Platform & operations",
    title: "SOP: installing and updating TimeSphere",
    roles: SA,
    where: "The repository — README and the install/update scripts",
    when: "Standing up a new instance, or upgrading a running one.",
    steps: [
      "Prereqs: Node 24, MySQL 8+. One command: the installer script sets up dependencies, database, migrations and seed.",
      "Or containers: Docker Compose (overlays for an external DB and HTTPS) or the Helm chart with autoscaling for Kubernetes.",
      "Configure apps/api/.env — database URL, JWT secrets, SMTP defaults; optional STORAGE_ROOT moves uploads.",
      "Update: run the update script — it migrates the database, rebuilds, and verifies the server reports the new version before finishing.",
      "Every release ships its notes in the bundle: What's new works air-gapped, and the upgrade announcement lands in every bell."
    ],
    notes: "The same codebase runs single-org on-premise and multi-org SaaS — the tenant count is configuration, not a fork.",
    keywords: ["install", "installation", "setup", "sop", "update", "upgrade", "docker", "helm", "kubernetes", "env", "database", "migration", "deploy"]
  },
  {
    id: "platform-admin",
    category: "Platform & operations",
    title: "The platform admin console",
    roles: SA,
    where: "/platform-admin — its own sign-in, separate from the workspace",
    when: "Running the SaaS side: organizations, plan tiers, domains and cross-org analytics.",
    steps: [
      "Organizations: create, suspend and archive tenants — each gets a physically separate database.",
      "Plan tiers: edit every entitlement live — seats, AI budget ceilings, allowed SSO providers and chat platforms per tier.",
      "Domains: add a customer's custom domain and verify it by DNS TXT record.",
      "Analytics: aggregate numbers only — outbound mail health, adoption, never row-level tenant content."
    ],
    keywords: ["platform admin", "console", "organizations", "tenants", "plan tiers", "domains", "multi-tenant", "saas"]
  },
  {
    id: "platform-admin-provision",
    category: "Platform & operations",
    title: "Bring a new customer workspace online",
    roles: SA,
    where: "/platform-admin → Organizations → New organization, then Provision",
    when: "A customer has signed a contract (self-serve trials provision themselves at /signup).",
    steps: [
      "New organization: name, slug and plan tier. This is only a registry row — nothing exists yet.",
      "Provision: enter the customer's first administrator — email, name and an initial password. This creates their physically separate database, migrates it and seeds that one super-admin account.",
      "The confirmation shows their sign-in address (https://<slug>.<your root domain>) and whether the welcome email carrying it was sent.",
      "Hand over the initial password out-of-band — it is never emailed. They are asked to replace it at first sign-in.",
      "Tell them to create a second super admin on day one (Admin → Users) — you cannot add one for them later."
    ],
    notes: "If the confirmation says the welcome email could not be sent, outbound mail is not configured yet — pass the link on yourself. Subdomains only resolve when ROOT_DOMAIN is set on the deployment; without it every address serves the default workspace.",
    keywords: ["provision", "new customer", "tenant", "workspace", "onboarding", "welcome email", "super admin", "sign-in url", "root domain"]
  },
  {
    id: "platform-admin-rescue",
    category: "Platform & operations",
    title: "Rescue a locked-out workspace administrator",
    roles: SA,
    where: "/platform-admin → Organizations → Rescue admin (on an active workspace)",
    when: "A customer's only administrator cannot sign in and Forgot password is no use — their outbound mail is broken, or the mailbox is what they lost.",
    steps: [
      "Confirm who is asking through a channel you trust — you are about to hand out access to their entire workspace.",
      "Rescue admin: enter the administrator's email. Only an existing super admin of that workspace can be reset from here; everyone else is reset by their own admins.",
      "Read the one-time password to them. It is shown once, stored only as a hash, and never emailed or logged.",
      "They sign in with it and are prompted to choose their own password. Every previous session of that account is already signed out.",
      "If the lockout is an SSO misconfiguration instead, use Restore password login — it turns password sign-in back on without touching anyone's password."
    ],
    notes: "The reset is written to the customer's own audit log, attributed to your platform-admin account — they can see it happened.",
    keywords: ["locked out", "rescue", "reset password", "super admin", "forgot password", "sso lockout", "restore password login", "one-time password"]
  },
  {
    id: "platform-admin-own-password",
    category: "Platform & operations",
    title: "Change the platform admin password (and why the console nags you)",
    roles: SA,
    where: "/platform-admin → Change password (sidebar), or the amber banner across the top",
    when: "Immediately after a fresh install, and whenever an operator leaves.",
    steps: [
      "The console ships with a bootstrap sign-in whose password is printed in the repository. While that password is still in use, an amber banner stays across every console page.",
      "Change password: enter the current one and a new one of at least 12 characters.",
      "Every other console session is signed out at that moment; yours stays.",
      "The banner disappears as soon as the change is accepted."
    ],
    keywords: ["platform admin password", "seeded password", "bootstrap", "rotate", "change password", "banner", "hardening"]
  },
  {
    id: "platform-admin-retention",
    category: "Platform & operations",
    title: "The trial retention programme",
    roles: SA,
    where: "/platform-admin → Trial retention",
    when: "Running the commercial side of the SaaS: who is lapsing, what we say to them, and what happens to their data.",
    steps: [
      "The policy sets the sequence: a check-in on day 10 of the trial, 'your trial has ended' the day it ends, then reminders 30, 60, 80 and 90 days later. The last reminder is the final notice.",
      "After the retention window (90 days by default) the workspace and its database are deleted permanently — unless the customer converted to a paid plan, restored it themselves, or you put it on hold.",
      "Auto-delete after the window is a kill switch. Turn it off and the reminders still go while nothing is ever dropped automatically.",
      "The queue shows every workspace that ever started as a trial, its six-dot sequence (filled = sent, hollow = skipped as stale, pulsing = due on the next pass), the deletion date, and the reason a deletion is or is not going to happen.",
      "Dry run now shows what the daily 09:30 pass would do. A simulated date is always a dry run — it can never send or delete.",
      "Per workspace you can send any stage now, hold the deletion while a conversation is in progress, or delete under the policy immediately — which asks you to type the slug."
    ],
    notes: "A paying customer is never deleted by this programme, whatever the clock says: converting nulls the trial and the schedule stops. Every send, hold, restore and deletion is written to the control-plane audit trail under Settings.",
    keywords: ["retention", "trial", "lapsed", "churn", "delete", "90 days", "reminders", "we miss you", "hold", "dry run", "policy", "data deletion"]
  },
  {
    id: "platform-admin-emails",
    category: "Platform & operations",
    title: "Platform emails: edit, preview, test and track",
    roles: SA,
    where: "/platform-admin → Platform emails",
    when: "Changing what the platform says to customers, or working out why a message did not arrive.",
    steps: [
      "Templates: pick one, edit the subject and body, and watch the preview — it is rendered by the server with sample values, so it is exactly what a customer receives.",
      "Send test mails the template to any address with the sample values. It is filed as a test and never counted as a delivery.",
      "Revert puts a template back to the shipped version. A warning appears if your edited version stopped using a variable the shipped one uses.",
      "Analytics: sent against failed per day over 90 days, per-template totals, and the grouped reasons deliveries failed.",
      "Delivery log: every message, with the body as it went out, and a Resend button that sends that exact message again."
    ],
    notes: "These are the emails the DEPLOYMENT sends (retention, the signup code, the relay test), not the ones a workspace sends — those are in each workspace's own Settings → Email templates. Configure the relay under Platform → Settings → Mail server; without one, every platform email is recorded as skipped.",
    keywords: ["platform emails", "email templates", "preview", "test send", "resend", "delivery log", "email analytics", "smtp", "relay", "bounce"]
  },
  {
    id: "platform-admin-settings",
    category: "Platform & operations",
    title: "Platform settings: mail, admins, sessions and the audit trail",
    roles: SA,
    where: "/platform-admin → Settings",
    when: "Setting up the deployment, adding a colleague to the console, or answering \"who did that?\".",
    steps: [
      "Mail server: the SMTP account the platform sends from. Falls back to the SMTP_* variables in apps/api/.env when left empty. Send test proves the relay, the From address and the reply-to.",
      "Platform admins: add a colleague (they get a generated one-time password, shown once) or deactivate one. The last active admin cannot be deactivated, and you cannot deactivate yourself.",
      "My sessions: everywhere your own account is signed in, with an End session for each.",
      "Audit trail: every action taken on a tenant from outside it — provisioning, rescues, retention decisions, settings changes — plus what customers did through the retention emails."
    ],
    keywords: ["platform settings", "smtp", "mail server", "platform admins", "sessions", "audit trail", "control plane", "who did that"]
  },
  {
    id: "platform-admin-backups",
    category: "Platform & operations",
    title: "Backups: what is kept, and how to restore one",
    roles: SA,
    where: "/platform-admin → Backups",
    when: "A workspace was deleted under the retention policy and the customer wants it back, or you need to hand somebody their data.",
    steps: [
      "A snapshot is taken automatically, immediately before the retention programme drops a workspace — only if a Snapshot directory is set under Trial retention → The policy.",
      "The page lists every snapshot with its size, its workspace and whether it can be restored. It also probes the host for mysqldump and mysql: if either is missing, that is why a directory is empty or a Restore is disabled.",
      "Download hands you the .sql file. Restore recreates the database, imports the dump, and reopens the workspace in its grace state with the deletion held — it never signs anyone in or takes a payment.",
      "A restore is refused if the workspace still has a database. Overwriting a live tenant is not reachable from this console.",
      "Delete removes a snapshot from disk. If its workspace is already gone, that is the last copy — there is no undo."
    ],
    notes: "These are retention snapshots, not platform backups: they only ever cover customers who lapsed and were deleted. Backing up live workspaces is your database's job — see docs/NEW_ORGANIZATION_SETUP.md § 7. After a restore, run npm run db:migrate:tenants if the platform has moved on since the dump was taken.",
    keywords: ["backup", "backups", "snapshot", "mysqldump", "restore", "recover", "deleted workspace", "download", "sql dump", "data recovery"]
  },
  {
    id: "platform-admin-scheduled-backups",
    category: "Platform & operations",
    title: "Scheduled backups: cadence, destinations and retention",
    roles: SA,
    where: "/platform-admin \u2192 Backups \u2192 Scheduled backups",
    when: "Setting up automatic backups for a customer, or working out why one did not run.",
    steps: [
      "What each plan allows is a CEILING, not a setting: Starter has no automatic backups, Team weekly with one destination, Enterprise daily with several plus test restores. A workspace picks its own cadence and the scheduler clamps it to the tier on every tick, so a downgrade takes effect without anyone editing a policy.",
      "Destinations: add an S3-compatible bucket (Amazon, R2, Backblaze, Wasabi, Spaces, MinIO), Azure Blob container, Google Drive folder, OneDrive/SharePoint folder, SFTP server or a local directory. Credentials are encrypted at rest and never sent back to the screen \u2014 leaving a field blank on an edit keeps what is stored.",
      "Press Test on a destination before relying on it. The result is recorded, never enforced: a bucket unreachable from your laptop can be perfectly reachable from the API host.",
      "Configure gives one workspace its schedule, its destination, its retention rules and who is alerted. Retention is Keep-newest-N, Keep-by-age, or Grandfather-Father-Son \u2014 GFS keeps ONE object per slot and tags it, rather than storing four copies.",
      "Dry run the pass shows what the 09:05 hourly scheduler would do right now, including any policy that has drifted above its tier.",
      "Back up now runs one immediately. Test restore (Enterprise) downloads a backup, checks its SHA-256 against what was written, imports it into a scratch database, counts the tables and drops it."
    ],
    notes: "Nothing is ever deleted before a newer backup has succeeded, and the newest backup is never pruned however old it is. Alerts go through the PLATFORM relay rather than the workspace's own mail \u2014 the workspace's SMTP may be the thing that is broken. mysqldump and mysql must exist on the API host; the Backups page probes for them and says so.",
    keywords: ["scheduled backups", "s3", "azure", "google drive", "onedrive", "sftp", "retention", "gfs", "grandfather father son", "cadence", "daily", "weekly", "alerts", "slack", "test restore", "pitr", "destination"]
  },
  {
    id: "platform-admin-maintenance",
    category: "Platform & operations",
    title: "Put every workspace into maintenance at once",
    roles: SA,
    where: "/platform-admin → Maintenance",
    when: "A database migration, a host move, or anything that takes the whole deployment down for a while.",
    steps: [
      "Arm a window: pick when it starts and ends, write what people will read, and choose the workspaces. Leaving every box clear reaches every workspace that can be signed into.",
      "This is not a separate lockout: it writes each workspace’s OWN maintenance setting, so customers get exactly what their own administrator’s window produces — everyone below super admin signed out, the maintenance page, and open tabs redirected within about fifteen seconds by the app’s heartbeat.",
      "Notify people in-app writes the notification everyone currently online already receives. Email each workspace’s super admins sends the notice from the PLATFORM relay, because a workspace going offline may take its own mail with it.",
      "Every workspace lists the live state read from each tenant database — in maintenance, scheduled, open, or unreachable with the reason.",
      "Lift on N clears the window everywhere it is armed, in one action. A single workspace can also be armed or lifted from its own row.",
      "Broadcast history records who armed what, over how many workspaces, and which ones did not take it. Open a row for the per-workspace outcome.",
      "While a platform window holds, the workspace's OWN maintenance controls are read-only: their administrators can see the schedule and who set it, but cannot move or cancel it. The server refuses the write as well as the screen, and it releases itself the moment you clear it."
    ],
    notes: "A workspace whose database is unreachable never stops the rest of the fleet — it is reported by name with its error instead of being counted as a success. Super admins are not locked out of their own workspace during a window, so a customer can still work while their people cannot. The read-only lock exists because a deployment-wide window any one tenant could switch off is not a window: the tenant that clears it takes a live database into the migration the window was protecting.",
    keywords: ["maintenance", "maintenance window", "downtime", "lockout", "outage", "broadcast", "fleet", "redirect", "heartbeat", "notify", "planned maintenance", "all organizations"]
  },
  {
    id: "platform-admin-monitoring",
    category: "Platform & operations",
    title: "Monitor one customer’s instance",
    roles: SA,
    where: "/platform-admin → Monitoring",
    when: "A customer reports it is slow, or you want to know which workspace is growing fastest.",
    steps: [
      "The fleet table reads every workspace database through its own connection string: size, tables, estimated rows, how long the probe took, and any alerts its numbers imply. Filter by Alerting, Maintenance or Unreachable.",
      "Inspect opens one workspace. Overview lists what needs attention — alerts are derived from the numbers on the page, and each one states the threshold it crossed.",
      "Database: schema size split into data and indexes, the largest tables, and the MySQL server’s own counters. Anything labelled server-wide belongs to the box, which other workspaces may share — do not read it as this customer’s fault.",
      "Server health, Service status, Past incidents and API performance are the SAME figures the customer sees in their own Maintenance tab, so a support call has one set of numbers rather than two.",
      "The window control (7 / 30 / 90 days) applies to the status page, its incidents and the API charts together.",
      "Schema: every table with its size, rows, fragmentation and index count, the widest composite indexes, and the statements running right now — as shapes, with every literal stripped before it left the API. Two operations live here: Refresh statistics (ANALYZE) is online and safe at any time; Reclaim space (OPTIMIZE) rebuilds a table and is refused unless that workspace is inside an ACTIVE maintenance window, because a rebuild blocks writes to it while it runs.",
      "Growth: hourly samples kept for a bit over a year — data and index size, rows, and how long the probe took — with a rate, a percentage change and a projection. Sample now takes a reading immediately, which is what to press on a fresh install where an empty chart looks exactly like a broken one."
    ],
    notes: "Row counts are InnoDB estimates, not exact counts — an exact count needs a full table scan, which is not worth doing to draw a chart. The fleet is read one workspace at a time on purpose: opening forty database connections at once is a self-inflicted outage on the server the whole platform runs on.",
    keywords: ["monitoring", "grafana", "database performance", "slow", "metrics", "alerts", "server health", "status page", "incidents", "api performance", "p95", "error rate", "buffer pool", "connections", "tenant health", "fragmentation", "optimize", "analyze", "growth", "capacity"]
  },
  {
    id: "platform-admin-advisor",
    category: "Platform & operations",
    title: "The AI advisor, and what it is allowed to do",
    roles: SA,
    where: "/platform-admin → Settings → AI advisor to set it up; → Monitoring → a workspace → Advisor to use it",
    when: "You have forty workspaces of numbers and want the reading rather than the readings.",
    steps: [
      "Set it up with the PLATFORM's own provider and key — never a workspace's. Borrowing a customer's would spend their money on somebody else's problem and route one tenant's operational detail through another tenant's vendor. A self-hosted OpenAI-compatible endpoint (Ollama, LM Studio) is a first-class choice if fleet metrics must not leave your network.",
      "The key is write-only: the console is told whether one is set, never what it is, and leaving the field blank on an edit keeps the stored one.",
      "Ask the advisor from a workspace's Advisor tab. It is never triggered on a timer — an advisor that runs on its own produces a queue nobody reads and a bill somebody pays. There is a daily ceiling, shown next to the number used today.",
      "What it is shown: sizes, counts, rates, growth, the thresholds already crossed, and statement SHAPES with every literal stripped. What it is never shown: a row, a column value, a person, an address, or anything a workspace's administrator typed.",
      "What it may propose: actions from a fixed list. Two of them run something — Refresh statistics and Reclaim space — and both go through the same guarded endpoint you would use by hand, including its refusal to rebuild a table outside a maintenance window. Anything else it invents is dropped rather than shown.",
      "Close every advisory: Acted on it, or Dismiss with a reason. The reason is required, and it is the point."
    ],
    notes: "Dismissals are kept alongside the ones that were right, because the value of an advisor is not the sentence it produced today but whether its sentences were right — which is only answerable if the wrong ones are still sitting next to them. A malformed or refusing answer produces no advice rather than an error: \"nothing worth flagging\" is a legitimate result.",
    keywords: ["ai advisor", "advisor", "suggestions", "recommendations", "guardrails", "human in the loop", "ollama", "byok", "platform ai", "dismiss", "findings"]
  }
];

/** True when this article is visible to the given role. Absent `roles` means everyone. */
export function helpArticleVisible(article: HelpArticle, role: RoleName): boolean {
  return !article.roles || article.roles.includes(role);
}

export function visibleHelpArticles(role: RoleName): HelpArticle[] {
  return HELP_ARTICLES.filter((a) => helpArticleVisible(a, role));
}

/**
 * The one search both surfaces use. Deliberately boring: lower-cased substring scoring with the
 * title worth most, then keywords, then body text. No stemming, no fuzz — an FAQ search that
 * returns something surprising is worse than one that misses a typo, and every term here was
 * chosen to be typed exactly ("SCIM", "SOP", "approve").
 */
export function searchHelpArticles(query: string, role: RoleName): HelpArticle[] {
  const visible = visibleHelpArticles(role);
  const q = query.trim().toLowerCase();
  if (!q) return visible;

  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  const scored = visible
    .map((a) => {
      const title = a.title.toLowerCase();
      const body = `${a.when} ${a.where} ${a.steps.join(" ")} ${a.notes ?? ""}`.toLowerCase();
      let score = 0;
      for (const t of terms.length ? terms : [q]) {
        if (title.includes(t)) score += 5;
        if (a.keywords.some((k) => k.includes(t))) score += 3;
        if (a.category.toLowerCase().includes(t)) score += 2;
        if (body.includes(t)) score += 1;
      }
      return { a, score };
    })
    .filter((x) => x.score > 0);

  return scored.sort((x, y) => y.score - x.score).map((x) => x.a);
}
