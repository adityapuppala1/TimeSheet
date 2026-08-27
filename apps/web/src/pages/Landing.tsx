/**
 * WHAT: the public marketing page — hero, the "one record" argument, a product tour with real
 * screenshots, a filterable capability grid, the AI-trust story, platform guarantees, pricing
 * (summary cards + a full comparison modal) and an FAQ. No API calls; purely presentational.
 *
 * WHY IT MUST STAY HONEST: this is the one page most likely to drift into overpromising. It has
 * done exactly that before — the Enterprise tier once advertised "SCIM provisioning" and
 * "per-department AI limits" that were never built. Treat every claim here as something to check
 * against the real feature set before merging, not against what "sounds right" for a SaaS page.
 * The same rule governs components/marketing/PricingDialog.tsx. There are deliberately no customer
 * logos, testimonials or usage statistics anywhere on this page: there are none to cite.
 *
 * WHY THE TIER BADGES ARE DERIVED: a card that says "Enterprise" while `PLAN_TIER_LIMITS` grants
 * the capability to Team (or the reverse) is the exact failure PricingDialog.tsx was rewritten to
 * prevent — those gates FAIL CLOSED, so an over-generous badge means a customer is refused at the
 * moment they try to use what they bought. `lowestTierFor` reads the same constant the control
 * plane seeds, so the two cannot disagree.
 *
 * WHY THE SCREENSHOTS ARE GENERATED, NOT PASTED: /product/*.png come from
 * tests/e2e/screenshots.spec.ts, which re-shoots them from the running app. Hand-taken marketing
 * images go stale silently and keep selling a screen that has since been redesigned.
 *
 * ANIMATION BUDGET: CSS transitions and one IntersectionObserver per section (see
 * components/marketing/Reveal.tsx). No animation library — the previous version imported
 * framer-motion to translate two elements by 14px on mount.
 *
 * WHO renders this: `App.tsx`'s `/` (public, unauthenticated) route.
 */
import { PLAN_TIER_LIMITS, type PlanTier, type PlanTierLimits } from "@timesheet/shared";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarCheck,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Clock,
  Coins,
  Eye,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  GanttChartSquare,
  Gauge,
  GitBranch,
  GitPullRequest,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  LogIn,
  Menu,
  MessagesSquare,
  Presentation,
  Scale,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  Wallet,
  WifiOff,
  Workflow,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { PricingDialog } from "../components/marketing/PricingDialog";
import { Reveal, useScrollProgress, useSectionSpy } from "../components/marketing/Reveal";
import { ScreenshotFrame } from "../components/marketing/ScreenshotFrame";
import { AuthorityLadder } from "../components/marketing/AuthorityLadder";
import { AuroraBackdrop } from "../components/marketing/AuroraBackdrop";
import { CONNECTOR_COUNT, ConnectorMarquee } from "../components/marketing/ConnectorMarquee";
import { StatBand } from "../components/marketing/StatBand";
import { handleSpotlight } from "../components/marketing/spotlight";

/** Any lucide glyph. Typed off a concrete one so the icon fields stay checked without importing
 *  lucide's internal component type. */
type Icon = typeof Clock;

/* ------------------------------------------------------------------ *
 * Content lives as data at the top so a claim can be audited without
 * reading JSX, and so nothing gets buried mid-markup where a review
 * would miss it.
 * ------------------------------------------------------------------ */

/** Every boolean capability gate on a plan. Keeps `lowestTierFor` from being handed a seat count. */
type CapabilityGate = {
  [K in keyof PlanTierLimits]: PlanTierLimits[K] extends boolean ? K : never;
}[keyof PlanTierLimits];

const TIER_ORDER: PlanTier[] = ["STARTER", "TEAM", "ENTERPRISE"];
const TIER_LABEL: Record<PlanTier, string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };

/** The cheapest plan that actually switches a capability on, read from the enforced limits. */
function lowestTierFor(gate: CapabilityGate): string {
  const tier = TIER_ORDER.find((candidate) => PLAN_TIER_LIMITS[candidate][gate]);
  return tier ? TIER_LABEL[tier] : TIER_LABEL.ENTERPRISE;
}

/** The product tour. Each entry points at a real captured screen. */
const TOUR = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    title: "Everyone opens to what's theirs",
    body: "An engineer sees today's timeline and what's still unlogged. A manager sees the queue waiting on them and which SLA timers are running down. Same page, different job — nobody hunts through menus for their own work.",
    image: "/product/dashboard.png"
  },
  {
    id: "tickets",
    label: "Tickets",
    icon: LayoutGrid,
    title: "Tickets that arrive already sorted",
    body: "List and Kanban, checklists, cross-ticket links, and a Dev tab wired to your real repositories. Items that came in by email or chat carry an intake badge, and AI-classified ones show a Review badge until a human agrees.",
    image: "/product/tickets.png"
  },
  {
    id: "insights",
    label: "Insights",
    icon: TrendingUp,
    title: "The numbers a standup actually needs",
    body: "Velocity, cycle-time distribution, SLA compliance, workload heatmaps, estimate-versus-actual. Computed from the same rows the approvals ran against, so the dashboard and the invoice can't disagree.",
    image: "/product/insights.png"
  },
  {
    id: "timesheet",
    label: "Timesheet",
    icon: CalendarCheck,
    title: "Logging time that fights back",
    body: "Project, module and submodule pickers, overlap detection, daily-cap warnings, and a rich task editor with attachments — plus a running total, so the entry is right before it's submitted rather than after a manager sends it back.",
    image: "/product/timesheet.png"
  },
  {
    id: "security",
    label: "Security",
    icon: ShieldCheck,
    title: "Findings become tickets with owners",
    body: "Your CI posts SAST, DAST, secrets and supply-chain findings to your own webhook. They land as triaged, routed tickets with a risk rollup — this product never runs a scanner itself, so nothing new gets access to your code.",
    image: "/product/security.png"
  },
  {
    id: "settings-ai",
    label: "AI controls",
    icon: SlidersHorizontal,
    title: "One screen that governs every model call",
    body: "Your key, your provider, your budget ceiling, and a separate switch for each AI capability. Plus the quality loop: what the AI actually said, what a human said it should have said, and whether the last prompt change helped.",
    image: "/product/settings-ai.png"
  },
  {
    id: "goals",
    label: "Goals",
    icon: Target,
    title: "Progress that measures itself",
    body: "Wire an objective to something the workspace already records — approved hours, billed spend, tickets closed, on-time rate, SLA escalations, project risk — and it reports its own progress. An override keeps the receipt: who, when, why, and what the measurement said at that moment.",
    image: "/product/goals.png"
  },
  {
    id: "agents",
    label: "AI teammates",
    icon: Bot,
    title: "A roster, not a black box",
    body: "Six ready teammates — Triage, Planner, Risk watch, Security desk, Reporter, Load balancer — each named, scoped to capabilities this workspace already runs, and off until you switch it on. Its work lands on the same ledger as everyone else's: what it did, what it cost, what human time it displaced.",
    image: "/product/agents.png"
  },
  {
    id: "studio",
    label: "Workflow Studio",
    icon: Workflow,
    title: "Automation you can read",
    body: "A trigger, then steps, written as a list you can review — with a canvas beside it that can never disagree. Every flow states the authority it actually resolves to, you can replay it against your own recent triggers before it goes live, and a flow with a problem cannot be switched on: the reason is quoted on the card.",
    image: "/product/studio.png"
  },
  {
    id: "practice-update",
    label: "Weekly update",
    icon: Presentation,
    title: "The Monday email nobody has to write",
    body: "Products, POCs, bug work, security and training — each initiative with an owner, a status colour and what actually moved, over figures counted from this workspace rather than typed into a form. The prose is drafted around those figures and every field is yours to edit before it sends; with AI off, the whole document still renders from the facts alone.",
    image: "/product/practice-update.png"
  },
  {
    id: "requirements",
    label: "Requirements",
    icon: FileText,
    title: "A spec, then the tickets that build it",
    body: "An AI interview turns an idea — or a PRD you already have — into a structured document: scope, features, architecture, timeline. It asks about what is missing rather than inventing it, exports as a client-grade PDF or Word file, and turns into real tickets and goals in the same workspace.",
    image: "/product/requirements.png"
  },
  {
    id: "changes",
    label: "Changes",
    icon: ClipboardCheck,
    title: "Changes reviewed before they ship",
    body: "Request, assess, approve and review. Risk is derived from impact × likelihood rather than typed by whoever raised it, the approval chain is the workspace's own, and the register reports its own change-failure rate, emergency rate and approval turnaround.",
    image: "/product/changes.png"
  }
];

/** The five lenses the capability grid filters by. Order is the order of the chips. */
const FEATURE_GROUPS = ["Plan & forecast", "Track the work", "Report & prove", "AI, governed", "Platform & security"] as const;
type FeatureGroup = (typeof FEATURE_GROUPS)[number];

interface Feature {
  icon: Icon;
  title: string;
  body: string;
  group: FeatureGroup;
  /** Present only when the capability is genuinely plan-gated in `PLAN_TIER_LIMITS`. */
  gate?: CapabilityGate;
}

const FEATURES: Feature[] = [
  {
    icon: GanttChartSquare,
    group: "Plan & forecast",
    gate: "ganttEnabled",
    title: "Plans, timelines and dependencies",
    body: "A real Gantt: hierarchy, four kinds of scheduling dependency with working-day lag, milestones, baselines and the critical path. Drag a bar to move it. If a date contradicts a dependency it says so and leaves your date alone — nothing is ever rescheduled behind your back, because there is no undo for a plan."
  },
  {
    icon: Gauge,
    group: "Plan & forecast",
    gate: "resourceMgmtEnabled",
    title: "Capacity you can check, not guess",
    body: "The workload board puts planned hours, actually-logged hours and contracted capacity on one axis, with bookings by working day and leave that reduces availability. That middle column is what a pure planning tool cannot show you: everything else in this category compares a plan against another plan, because estimates are all it holds."
  },
  {
    icon: Wallet,
    group: "Plan & forecast",
    title: "Budgets priced from real rates",
    body: "Burn and forecast-at-completion computed from the same approved rate snapshots a client-facing Verified Work Attestation reads, so an internal dashboard and a document a client might dispute can never disagree. The forecast stays blank until there is enough data to mean anything."
  },
  {
    icon: ShieldAlert,
    group: "Plan & forecast",
    title: "Project risk, scored from measured signals",
    body: "A 0–100 score built from schedule slip against baseline, budget forecast, blocked work, over-allocation, SLA breaches and rework — with the weights stated, the breakdown stored, and a snapshot taken nightly so you can see the trend. It works with AI switched off entirely; only the written summary needs a model."
  },
  {
    icon: Inbox,
    group: "Plan & forecast",
    gate: "approvalsEnabled",
    title: "Intake, blueprints and approvals",
    body: "Publish a request form to a link that needs no account; every submission becomes a ticket immediately. Save a project's shape as a blueprint and stamp it out against any start date. Route work items through sequential or parallel approvals, including external reviewers who get a single-use link rather than a half-real account."
  },
  {
    icon: Target,
    group: "Plan & forecast",
    gate: "goalsEnabled",
    title: "Goals whose progress reports itself",
    body: "Objectives and key results wired to something this workspace already records — approved hours, billed spend from rate snapshots, tickets closed, on-time delivery, SLA escalations. The number is computed, not typed into a status meeting. Where nothing comparable exists it says “not measurable yet” rather than showing 0%, and an override keeps the receipt: who set it, when, why, and what the measurement said at that moment."
  },
  {
    icon: Bot,
    group: "Plan & forecast",
    gate: "aiPmCopilotEnabled",
    title: "AI teammates you can name, scope and switch off",
    body: "Named agents assembled from the AI capabilities already running here, each owning its own — one capability, one owner, so two of them can never quietly do the same job. A teammate holds no licensed seat, cannot sign in, and has no mailbox. Every run shows what it was allowed to do, what it did, and what it cost, against a daily spend ceiling you set."
  },
  {
    icon: Workflow,
    group: "Plan & forecast",
    gate: "aiPmCopilotEnabled",
    title: "Workflows that state what they are allowed to do",
    body: "A trigger, then steps: an AI capability, a deterministic action, a condition, or a point where a named person must approve. A flow can never do more than its most restricted step, and the moment one step reads text from outside your workspace every later change becomes a suggestion instead of an action. Replay it against your own recent history before switching it on — the replay calls no model and writes nothing."
  },
  {
    icon: Scale,
    group: "Plan & forecast",
    gate: "aiPmCopilotEnabled",
    title: "What the AI cost, on the same books as human work",
    body: "Every agent run is recorded the way a timesheet is: attributed to a project, timed, and priced from real usage rather than estimated. Where your own approved hours give a baseline for comparable work, the human time it stood in for is measured too — and where they do not, it says so instead of guessing. Spend is broken out per teammate and per workflow, beside the total."
  },
  {
    icon: Target,
    group: "Plan & forecast",
    gate: "goalsEnabled",
    title: "Goals that measure themselves",
    body: "Objectives and key results wired to numbers the workspace already records — approved hours, billed spend from rate snapshots, tickets closed, on-time rate, SLA escalations, average project risk. \u201cNo data yet\u201d reads as words, never as 0%, and an override keeps the receipt: who, when, why, and what the measurement said at that moment."
  },
  {
    icon: LayoutDashboard,
    group: "Plan & forecast",
    title: "Dashboards you assemble, delivered by email",
    body: "Build a view from a fixed catalogue of tiles and schedule it daily, weekly or monthly to people who have no account. A shared dashboard stores a layout, never data — so each viewer still sees only what their own access allows, and delivery stops on its own if the sender leaves."
  },

  {
    icon: CalendarCheck,
    group: "Track the work",
    title: "Smart timesheets",
    body: "Hierarchical project / module / submodule picker, a searchable ticket picker, overlap detection, daily cap warnings, and a rich task editor with attachments. Mistaken drafts can be deleted; approved hours can't, because they're part of the billing record."
  },
  {
    icon: LayoutGrid,
    group: "Track the work",
    title: "Jira-style ticketing",
    body: "Kanban with drag-and-drop and manager swimlanes, labels, cross-ticket links, sub-task checklists, saved views, custom fields, and SLA due-dates that escalate on their own. Admin-defined statuses each declare which built-in state they behave like, so reports and exports never drift."
  },
  {
    icon: GitPullRequest,
    group: "Track the work",
    title: "Tickets that know about your repository",
    body: "Pick a repo, branch or pull request live from a connected GitHub account, or let a webhook match a branch named WEB-123-fix-login back to its ticket — GitLab, Bitbucket, Gitea, Forgejo and Azure DevOps post to the same receiver. An optional gate refuses to let a ticket reach Resolved while its latest CI run is failing."
  },
  {
    icon: MessagesSquare,
    group: "Track the work",
    title: "Report it where it was noticed",
    body: "Forward an email, or raise it from Slack, Microsoft Teams, Google Chat or Telegram — each becomes a properly routed, prioritized ticket and the bot answers in the thread it came from. Attached screenshots are read too. External content is explicitly framed as data, never as instructions."
  },
  {
    icon: Clock,
    group: "Track the work",
    title: "SLA + escalations",
    body: "Configurable approval and resolution SLAs for both timesheets and tickets. Breaches escalate up the reporting line automatically — nobody has to notice one manually."
  },
  {
    icon: Inbox,
    group: "Track the work",
    title: "An inbox, not just a bell",
    body: "Notifications become a queue you work through: mark done, snooze until later today, tomorrow or next week — a snoozed item comes back on its own. Today's brief counts what actually needs you — due, blocked, awaiting sign-off — from the same definitions the pages behind them use. Nothing in it is generated."
  },
  {
    icon: WifiOff,
    group: "Track the work",
    title: "It tells you when it's down",
    body: "The app polls its own backend. One dropped request shows a quiet warning; a real outage pauses the interface rather than letting you type into a void. It resumes on its own, keeping what you had entered."
  },

  {
    icon: FileCheck2,
    group: "Report & prove",
    title: "Verified Work Attestations",
    body: "A signed, page-numbered PDF of approved, identity-verified work for a project and period — hours, contributors, approvers and the rate that applied at approval — that you can hand a client, or share as a link they open without an account."
  },
  {
    icon: TrendingUp,
    group: "Report & prove",
    title: "Insights dashboard",
    body: "Velocity, SLA compliance, cycle-time distribution, bug hotspots by module, workload heatmaps, reopen rate and estimate-vs-actual, with cost analytics built on the rate that applied when each entry was approved."
  },
  {
    icon: FileSpreadsheet,
    group: "Report & prove",
    title: "Exports that survive an audit",
    body: "One query behind a 22-column CSV, a PDF, and a real Excel workbook with a summary sheet, frozen headers and typed cells — plus nine ways to group the same rows on screen. Every export states its row cap rather than truncating quietly, and a figure with nothing on file reads as a dash, never as zero."
  },
  {
    icon: ScanFace,
    group: "Report & prove",
    gate: "faceVerificationEnabled",
    title: "Optional identity verification",
    body: "Face checks at clock-in, ticket progression and approval, with a guided four-pose enrollment and a head-movement challenge the server chooses at random. The browser only detects and frames; matching, liveness and anti-spoof scoring stay server-side, templates are encrypted, retention is configurable, and no image ever leaves your server."
  },
  {
    icon: ShieldCheck,
    group: "Report & prove",
    title: "RBAC + audit trail",
    body: "Role-specific dashboards, permission-aware menus, and a tamper-evident audit log across every administrative and AI action — the same log a ticket's Activity tab reads. Workspace settings are Super Admin only."
  },
  {
    icon: GitBranch,
    group: "Report & prove",
    title: "Security & DevOps ingestion",
    body: "Your CI POSTs SAST/DAST/secrets/supply-chain findings to a per-organization webhook. VAPT reports upload as structured JSON. Every ticket gets a Security tab with a verdict and a PDF export. Nothing here runs a scanner — this product is the inbox, not the tool."
  },

  {
    icon: Bot,
    group: "AI, governed",
    title: "AI, bring your own key",
    body: "Auto-triage, duplicate detection, a writing assistant, comment summaries, drafted status reports and \"Ask AI\" search — on Anthropic, OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, your own local Ollama, or any OpenAI-compatible endpoint you point it at."
  },
  {
    icon: FlaskConical,
    group: "AI, governed",
    title: "An AI you can actually improve",
    body: "Capture what the model was asked and what it answered, correct real failures into a golden set, edit prompts without a deploy, then replay the set and score the change. \"Is the new prompt better?\" becomes a number."
  },
  {
    icon: Bot,
    group: "AI, governed",
    title: "AI teammates with names, budgets and no seat",
    body: "Assemble a teammate from capabilities this workspace already runs — or take one of six ready ones. It has its own identity in the audit trail, holds no paid seat, cannot sign in, has no mailbox, and arrives switched off. Its card shows exactly what it may do, what it has run, and what today cost."
  },
  {
    icon: Workflow,
    group: "AI, governed",
    title: "A Workflow Studio you can review",
    body: "A trigger, then steps, as a list you read top to bottom — with a drag-and-drop canvas beside it that can never disagree with the rule. A flow states the authority it really resolves to, replay shows what would have happened against your own recent triggers, and a flow with a problem cannot be switched on — the reason is quoted."
  },
  {
    icon: Sparkles,
    group: "AI, governed",
    gate: "aiPmCopilotEnabled",
    title: "A copilot that proposes, never applies",
    body: "The planning assistant returns reviewable rows you accept or reject one at a time. There is no apply-everything button, and a proposal whose underlying value changed since it was generated is refused rather than quietly overwriting whoever edited it."
  },

  {
    icon: KeyRound,
    group: "Platform & security",
    title: "Public API & webhooks",
    body: "Named, revocable bearer keys scoped read or write, over listing and creating tickets, moving their status, commenting, and listing timesheets — a status change obeys exactly the transition rules the UI does. Outbound webhooks are HMAC-SHA256 signed with automatic retry."
  },
  {
    icon: Activity,
    group: "Platform & security",
    title: "A status page with a memory",
    body: "Every feature is probed every five minutes — sign-in, timesheets, tickets, reports, email, AI, planning — with a day-by-day history and a recorded incident log. It answers the question a CPU graph structurally cannot: was it down on Tuesday, when I could not submit? A day is coloured by its worst check, because averaging is how a two-hour outage becomes a 96%-green day."
  },
  {
    icon: Bell,
    group: "Platform & security",
    title: "Notifications you can actually tune",
    body: "Every event hits an in-app toast and a branded HTML email, governed by a category-by-role matrix rather than one global switch. Muting a category removes only the email — the in-app bell always fires — and welcome, password-reset and intake replies are marked as always sent, because silencing those breaks sign-in."
  },
  {
    icon: Lock,
    group: "Platform & security",
    title: "Session security",
    body: "Rotating httpOnly sessions with reuse detection, an active-devices list you control, sign-out-everywhere, per-account lockout on top of per-IP limits, and AES-256 encrypted secrets at rest. File reads need a signed, expiring, organization-bound grant."
  },
  {
    icon: Presentation,
    group: "Report & prove",
    gate: "practiceUpdateEnabled",
    title: "A weekly update leadership actually reads",
    body: "One consolidated view of the week: an executive summary, then products, POCs, bug work, security and training — each initiative with an owner, a 🟢/🟡/🔴 status and what actually moved. Nobody fills in a form; initiatives are your own active projects, sorted by what their people logged against them. The status colour is arithmetic, never a model's opinion, so a red is reproducible in the meeting where somebody asks why. The figures are counted and the prose is drafted around them — with AI off, every section still renders from the facts it would have been written from. You review and edit before it sends, and only a super admin sets who receives it."
  },
  {
    icon: CalendarRange,
    group: "Report & prove",
    title: "One date filter, the whole home page",
    body: "Pick today, a week, a month or any range: the hero cards, the daily rhythm, progress, the workforce snapshot, productivity, project utilisation and the day timeline all answer for that period, each naming the period it is showing. Comparisons are against the previous equal-length window, because a fortnight measured against yesterday reads as a collapse every time. Filtered server-side rather than in the browser — the entry list truncates, so a client-side range quietly under-reports anything older than the newest page."
  },
  {
    icon: FileText,
    group: "Report & prove",
    title: "Documents you would hand to a client",
    body: "The timesheet report, the requirements document, the verified work attestation and the security assessment all render through one house style: a watermark, a running header, tables that repeat their header across a page break and measure their own row heights, and colour-coded status pills. Markdown a model wrote inside a spec renders as headings, lists and real tables rather than printing its own syntax, and a chart in a document draws as a chart."
  },
  {
    icon: SlidersHorizontal,
    group: "Platform & security",
    title: "Run it where you want",
    body: "One codebase, two shapes: a single-organization on-premise install or the multi-organization SaaS path. A one-command installer, Docker Compose overlays for an external database and HTTPS, and a Helm chart with autoscaling. The What's-new page falls back to the bundled changelog, so an air-gapped install still knows what it's running."
  }
];

/** The AI-trust story. This is the section that closes security reviews, so it stays specific. */
const AI_GUARDRAILS = [
  {
    icon: KeyRound,
    title: "Bring your own key, any provider",
    body: "Point AI features at Anthropic, OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, or a self-hosted Ollama/LM Studio. Your key is encrypted at rest and never sent back to the browser once saved — switch providers without touching code."
  },
  {
    icon: Sparkles,
    title: "Nothing runs until you say so",
    body: "A master switch plus a separate toggle for each AI capability, all off by default. Flip nothing on and the app never calls out to any model, on any plan."
  },
  {
    icon: Eye,
    title: "Low-confidence work waits for a human",
    body: "Every classification carries a confidence score. Below your threshold it's flagged \"needs review\" rather than silently auto-assigned — and email- and chat-sourced suggestions are held to a stricter bar, because that content comes from outside your organization."
  },
  {
    icon: ShieldCheck,
    title: "Untrusted input can't hijack the model",
    body: "Content from email, chat, CI logs and pull requests is explicitly delimited and framed as data before it reaches a model, so a crafted \"ignore previous instructions\" message can't talk your triage pipeline past review."
  },
  {
    icon: Coins,
    title: "A budget cap that actually stops spend",
    body: "Every call is cost-estimated and logged against a monthly budget, with a hard platform ceiling on top of whatever you set. At the cap, AI features pause gracefully instead of running up a surprise bill — including the evaluation runner, which is refused up front if it wouldn't fit."
  },
  {
    icon: FlaskConical,
    title: "Prompt changes are measured, not guessed",
    body: "Correct real failures into a golden set, change a prompt without shipping a release, then replay the set and score it. A broken prompt can't break a feature: the runtime falls back to the built-in one and records that it did."
  },
  {
    icon: Scale,
    title: "An authority ladder, not a free hand",
    body: "Every capability resolves to observe, propose or apply — and a run that reads text from outside the workspace drops to proposing for the rest of its life, however it was configured. A flow can never do more than its most restricted step, and the card names that step."
  },
  {
    icon: ShieldAlert,
    title: "One capability, one owner",
    body: "Switching a teammate on is refused if another already covers something in its bundle — and the refusal names it, so \u201cwhich teammate does this?\u201d always has exactly one answer. The roster and the settings screen point at the same single place authority is set."
  },
  {
    icon: Activity,
    title: "On the record, end to end",
    body: "Every run is followable: the trigger, each step, what the model was asked, what changed, and what it cost — on the same audit ledger as human work, under the teammate's own name. Retiring one keeps its history, because past runs point at it."
  }
];

const PLATFORM = [
  {
    icon: Building2,
    title: "A database of your own",
    body: "Every organization's tickets, timesheets and AI history live in a dedicated database — not a shared table filtered by a tenant ID. There's no query to get wrong, because there's no shared connection for one to cross."
  },
  {
    icon: LogIn,
    title: "Sign in your way",
    body: "Password, Google, Microsoft, SAML or a direct LDAP bind — each organization's own admin enables exactly the methods their team uses, independent of every other organization, down to requiring SSO-only. Inbound SCIM 2.0 provisioning keeps the directory in charge of who exists."
  },
  {
    icon: SlidersHorizontal,
    title: "Plan limits with real teeth",
    body: "Seat limits and AI budget ceilings are enforced live on every request, not just described in a pricing table — and can be raised for one organization without waiting on a deploy."
  }
];

const WORKFLOW = [
  { icon: FileText, title: "Report", body: "Work arrives four ways: someone logs time, someone opens a ticket, an email lands in the intake mailbox, or a message is raised from chat." },
  { icon: Bot, title: "Triage", body: "AI proposes type, priority and module. Confident items move on; uncertain ones wait for a person." },
  { icon: ShieldCheck, title: "Approve", body: "Managers see only their reports' submissions, each with a per-project SLA timer counting down." },
  { icon: Sparkles, title: "Escalate", body: "Missed SLAs raise to the next manager up automatically." },
  { icon: BarChart3, title: "Analyze", body: "Velocity, cycle time, hotspots and workload roll into one dashboard for planning and reviews." },
  { icon: FileCheck2, title: "Prove", body: "Approved, identity-verified work becomes an attestation PDF a client can check." }
];

/** The two things that arrive, and the five things that read them. The argument of the whole page. */
const ONE_RECORD = {
  sources: ["A logged hour", "A ticket", "An email or chat report", "A form submission"],
  readers: ["Manager approval", "The SLA timer", "Cost, budget and forecast", "Insights and exports", "The client's attestation PDF"]
};

const PRICING = [
  {
    name: "Starter",
    price: "$0",
    cadence: "per seat / month",
    description: "Small teams getting timesheets and tickets out of spreadsheets and inboxes.",
    cta: "Start free",
    bullets: ["Up to 10 active users", "Timesheets + ticketing core", "Manager approvals + basic SLA", "Google sign-in", "CSV exports"]
  },
  {
    name: "Team",
    price: "$8",
    cadence: "per seat / month",
    description: "The default for growing engineering and consulting teams.",
    highlight: true,
    cta: "Start 14-day trial",
    bullets: [
      "Unlimited users",
      "Google + Microsoft sign-in",
      "Timeline, intake, approvals and proofing",
      "AI features, bring your own key",
      "Named AI teammates + the Workflow Studio",
      "Goals with measured progress (25 active)",
      "AI quality loop: golden sets, prompt versions, evals",
      "Email, Slack and Telegram intake + Kanban board",
      "Insights, attestations, PDF/CSV/Excel exports + report analytics",
      "Audit log + role-based access"
    ]
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "billed annually",
    description: "Compliance-heavy organizations with hundreds of contributors.",
    cta: "Talk to sales",
    bullets: [
      "Everything in Team",
      "Google, Microsoft, SAML and LDAP — SSO-only available",
      "SCIM 2.0 provisioning + custom workflows",
      "Capacity planning, the AI copilot and identity verification",
      "Your own dedicated database",
      "Platform-adjustable seat and AI-budget limits",
      "Dedicated support + uptime SLA"
    ]
  }
];

const FAQ = [
  {
    q: "Do you charge for AI usage?",
    a: "No. You bring your own provider key and pay that provider directly. We never resell inference, and the monthly budget cap is enforced on every call so a misconfigured automation can't run up a bill."
  },
  {
    q: "Does anything leave our servers?",
    a: "AI prompts go to whichever provider you configured, and nowhere else. Face verification is the strict exception: images and embeddings never leave your server at all, and the AI features that touch identity review are sent metadata only — never a face."
  },
  {
    q: "Can we turn AI off entirely?",
    a: "Yes, and it ships that way. There's a master switch plus a toggle per capability, all off by default. With them off, the app never contacts a model."
  },
  {
    q: "What can the AI actually change on its own?",
    a: "Only what you grant per capability, on a ladder — observe, propose, or apply — and a run that reads text from outside the workspace (an email, a chat message, a scanner finding) drops to proposing for the rest of that run. Every change lands as a reviewable row with undo, on the same audit ledger as human work, under the teammate's own name."
  },
  {
    q: "How is this different from Jira plus a timesheet tool?",
    a: "The hours and the tickets are the same records, so approvals, SLA timers, cost and attestations all read from one source. You don't reconcile two systems, and a client-facing proof of work doesn't require exporting from both."
  },
  {
    q: "Can we run it on our own infrastructure?",
    a: "Yes. The same codebase deploys as a single-organization on-premise install or as multi-organization SaaS — Docker Compose with overlays for an external database and HTTPS, or a Helm chart with autoscaling. Nothing calls home: your AI key, your OAuth apps, your database."
  },
  {
    q: "What happens when the backend goes down?",
    a: "The app notices and says so. One dropped request shows a warning strip; a sustained outage pauses the interface rather than accepting input that would be silently lost. It resumes on its own, without a reload, and keeps what you had typed."
  }
];

const NAV_SECTIONS = [
  { id: "tour", label: "Tour" },
  { id: "features", label: "Features" },
  { id: "ai", label: "AI" },
  { id: "platform", label: "Platform" },
  { id: "pricing", label: "Pricing" },
  { id: "faq", label: "FAQ" }
];

/* ------------------------------------------------------------------ */

export function Landing() {
  const [pricingOpen, setPricingOpen] = useState(false);
  const [tourId, setTourId] = useState(TOUR[0].id);
  const [group, setGroup] = useState<FeatureGroup | "all">("all");
  const [menuOpen, setMenuOpen] = useState(false);

  const activeTour = TOUR.find((t) => t.id === tourId) ?? TOUR[0];
  const activeSection = useSectionSpy(NAV_SECTIONS.map((s) => s.id));
  const progress = useScrollProgress();
  const shownFeatures = group === "all" ? FEATURES : FEATURES.filter((f) => f.group === group);

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
        <nav aria-label="Primary" className="mx-auto max-w-7xl px-4 sm:px-5">
          <div className="flex items-center justify-between gap-3 py-3 sm:py-4">
            <Link to="/" className="focus-ring flex min-w-0 items-center gap-3 rounded-md font-bold">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">T</span>
              <span className="truncate">TimeSphere</span>
            </Link>

            <div className="hidden items-center gap-1 md:flex">
              {NAV_SECTIONS.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  aria-current={activeSection === section.id ? "true" : undefined}
                  className={`focus-ring relative rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                    activeSection === section.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {section.label}
                  {/* The underline is always mounted and scales from 0, so the highlight slides in
                      rather than blinking — and collapses to nothing under reduced motion. */}
                  <span
                    aria-hidden
                    className={`absolute inset-x-3 -bottom-px h-0.5 origin-left rounded-full bg-primary transition-transform duration-300 ${
                      activeSection === section.id ? "scale-x-100" : "scale-x-0"
                    }`}
                  />
                </a>
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Link
                to="/pitch"
                className="focus-ring hidden rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground lg:inline"
              >
                Why we built it
              </Link>
              <Button asChild size="sm" className="sm:h-10 sm:px-4 sm:text-sm">
                <Link to="/login">Sign in <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                aria-controls="mobile-nav"
                aria-label={menuOpen ? "Close the menu" : "Open the menu"}
                className="focus-ring grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground md:hidden"
              >
                {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Collapsed with a 0fr→1fr grid row rather than max-height: the panel animates to its
              real height, so adding a link later can't leave the last one clipped. */}
          <div
            id="mobile-nav"
            className={`grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out md:hidden ${
              menuOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            }`}
          >
            <ul className="min-h-0 pb-2">
              {[...NAV_SECTIONS, { id: "pitch", label: "Why we built it" }].map((section) => (
                <li key={section.id}>
                  {section.id === "pitch" ? (
                    <Link
                      to="/pitch"
                      onClick={() => setMenuOpen(false)}
                      className="focus-ring block rounded-md px-3 py-2.5 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {section.label}
                    </Link>
                  ) : (
                    <a
                      href={`#${section.id}`}
                      onClick={() => setMenuOpen(false)}
                      className="focus-ring block rounded-md px-3 py-2.5 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {section.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </nav>
        {/* Reading progress. Driven off scrollTop rather than a scroll-linked animation because
            `animation-timeline` is not yet safe to rely on across the browsers this app tests. */}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-transparent">
          <div className="h-full origin-left bg-primary" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </header>

      <main>
        {/* ----------------------------------------------------------- Hero */}
        {/*
          `isolate` is LOAD-BEARING, not decoration. The backdrop layer below is `-z-10`, and a
          negative z-index paints inside its nearest ancestor STACKING CONTEXT — which, without
          this, was `<html>`, three levels up. CSS paints negative-z descendants of the root before
          the backgrounds of in-flow blocks, so `<div class="min-h-screen bg-background">` painted
          straight over the whole layer. That is why the two blurred orbs this section has shipped
          with were invisible on a rendered page: not too subtle, covered. `isolate` makes the
          section its own stacking context, so `-z-10` now means "behind this section's content"
          rather than "behind the page".
        */}
        <section className="relative isolate overflow-hidden">
          <div className="pointer-events-none absolute inset-0 -z-10">
            {/* The two blurred orbs stay UNDERNEATH the canvas deliberately: they are the floor for
                anyone the aurora does not mount for — reduced motion, no WebGL, a blocked context —
                so that case reads as a designed gradient rather than a flat band. */}
            <div className="absolute -left-32 -top-32 h-[30rem] w-[30rem] rounded-full bg-primary/20 blur-3xl" />
            {/* This was `bg-accent/20`. Nobody had ever seen it — see the stacking-context note above
                — and the first render after the fix showed why it could not stay: the accent is
                amber, and amber at 20% over a near-white page is khaki, which put a dirty smudge on
                the right of the hero. Both orbs now sit on the same two stops as the aurora and the
                gradient headline, which is the palette this page is documented to use. */}
            <div className="absolute -right-24 top-12 h-[30rem] w-[30rem] rounded-full bg-info/15 blur-3xl" />
            <AuroraBackdrop className="absolute inset-0" intensity={0.9} />
          </div>
          <div className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-5 sm:py-20">
            <Badge
              variant="info"
              className="mx-auto flex w-fit gap-1 px-3 py-1 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
            >
              <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
              <span>Plan the work, track the tickets, measure the hours — one workspace</span>
            </Badge>
            <h1 className="mx-auto mt-5 max-w-4xl text-3xl font-black leading-tight tracking-tight motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700 sm:text-5xl lg:text-6xl">
              The plan, and{" "}
              {/* Teal→blue only. Running the gradient through `accent` (amber) meant that when the
                  phrase wrapped, the second line ended gold — which reads as a warning state, not
                  emphasis. A two-stop ramp survives wrapping at any width. */}
              <span className="bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">what actually happened</span>.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700 motion-safe:delay-150 motion-safe:fill-mode-backwards sm:text-lg sm:leading-8">
              Gantt timelines, portfolios, capacity and budgets — sitting on top of the tickets your team works and the
              hours they actually log. A project tool has to estimate effort. This one measures it, because the plan and
              the timesheet are the same system. And when routine work is ready to hand off, named AI teammates take it —
              scoped, budgeted, and off by default.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700 motion-safe:delay-300 motion-safe:fill-mode-backwards sm:flex-row">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link to="/login">Open the portal <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => setPricingOpen(true)}>
                Compare plans
              </Button>
            </div>
            <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              {["SOC2-friendly audit log", "Bring-your-own AI key", "AES-256 encrypted secrets", "A database per organization"].map(
                (claim) => (
                  <li key={claim} className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
                    {claim}
                  </li>
                )
              )}
            </ul>

            <Reveal className="mt-12" delay={80}>
              {/* A slight lift on hover so the shot reads as a live surface rather than a poster. */}
              <div className="transition-transform duration-500 motion-safe:hover:-translate-y-1">
                <ScreenshotFrame
                  src="/product/dashboard.png"
                  alt="The TimeSphere dashboard: this week's logged hours by state, a daily rhythm chart, week and month progress, and a day timeline of entries."
                  priority
                  caption="The real dashboard — every screenshot on this page is generated from the running app."
                />
              </div>
            </Reveal>
          </div>

          {/* A trust strip that carries what we can actually evidence. Every name on it is a
              shipped connector with a controller and a settings surface behind it — the customer
              logos this device usually holds are the one thing docs/MARKETING_PAGES.md forbids. */}
          <div className="mx-auto max-w-6xl px-4 pb-14 sm:px-5">
            <p className="mb-3 text-center text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Connects to what you already run
            </p>
            <ConnectorMarquee />
          </div>
        </section>

        {/* ----------------------------------------------------------- Problem */}
        <Section className="border-y border-border bg-muted/30">
          <Reveal>
            <div className="grid items-center gap-8 lg:grid-cols-[1.5fr_1fr]">
              <SectionHeading
                eyebrow="The problem"
                title="Two systems that never agree"
                subtitle="Most teams run tickets in one tool and hours in another. The moment a client asks what they're paying for, somebody exports both and reconciles them by hand — and the numbers don't match, because a ticket was closed in one place and the time was logged against something else in the other."
              />
              {/* Decorative, so empty alt + hidden from AT: the paragraph beside it says everything. */}
              <img
                src="/marketing/time-management.png"
                alt=""
                aria-hidden
                loading="lazy"
                decoding="async"
                width={600}
                height={600}
                className="mx-auto hidden w-full max-w-xs lg:block"
              />
            </div>
          </Reveal>

          <Reveal delay={80} className="mt-10">
            <div className="grid items-center gap-4 lg:grid-cols-[1fr_auto_1.1fr_auto_1fr]">
              <FlowColumn title="What arrives" items={ONE_RECORD.sources} />
              <FlowArrow />
              <div className="rounded-xl border-2 border-primary bg-background p-5 text-center shadow-glow">
                <p className="text-xs font-bold uppercase tracking-wider text-primary">One record</p>
                <p className="mt-2 text-lg font-black tracking-tight">The hours and the ticket are the same rows</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Nothing is copied between systems, so there is nothing to reconcile and nothing to disagree about.
                </p>
              </div>
              <FlowArrow />
              <FlowColumn title="What reads it" items={ONE_RECORD.readers} tone="primary" />
            </div>
          </Reveal>

          {/* Three of these four are derived from arrays on this page, so they cannot drift out of
              step with what it claims — see the note at the top of StatBand for why they are facts
              about the product rather than the usual traction figures. */}
          <Reveal delay={140} className="mt-10">
            <StatBand
              stats={[
                {
                  value: FEATURES.length,
                  label: "capabilities shipping today",
                  hint: "Counted from the grid below. Nothing on this page is on a roadmap."
                },
                {
                  value: CONNECTOR_COUNT,
                  label: "systems it plugs into",
                  hint: "Identity, chat, mail, source control, CI, billing and AI — every one a shipped connector."
                },
                {
                  value: 1,
                  label: "database per organisation",
                  hint: "Not a tenant column. Your workspace is provisioned its own MySQL schema."
                },
                {
                  value: 0,
                  label: "shared application tables",
                  hint: "The control plane holds the registry — organisations, plans, SSO — and no work data at all."
                }
              ]}
            />
          </Reveal>
        </Section>

        {/* ----------------------------------------------------------- Tour */}
        <Section id="tour">
          <Reveal>
            <SectionHeading
              center
              eyebrow="Product tour"
              title={`${TOUR.length} screens, and what each one is for`}
              subtitle="Captured from the running application, not mocked up."
            />
          </Reveal>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {TOUR.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTourId(item.id)}
                aria-pressed={tourId === item.id}
                aria-controls="tour-panel"
                className={`focus-ring inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                  tourId === item.id
                    ? "border-primary bg-primary text-primary-foreground shadow-glow"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground motion-safe:hover:-translate-y-0.5"
                }`}
              >
                {/* aria-hidden matters here: these buttons are matched by accessible name in
                    tests/e2e/marketing.spec.ts, and an icon must not contribute to it. */}
                <item.icon className="h-4 w-4" aria-hidden />
                {item.label}
              </button>
            ))}
          </div>
          <div id="tour-panel" className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.35fr] lg:items-center">
            {/* Keyed on the tab so the copy re-enters with the screenshot instead of swapping
                underneath a shot that is still decoding. */}
            <div key={activeTour.id} className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
              <p className="text-xs font-bold uppercase tracking-wider text-primary">{activeTour.label}</p>
              <h3 className="mt-2 text-xl font-black tracking-tight sm:text-2xl">{activeTour.title}</h3>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{activeTour.body}</p>
              <Button asChild variant="outline" size="sm" className="mt-5">
                <Link to="/login">See it with your data <ArrowRight className="h-4 w-4" /></Link>
              </Button>
            </div>
            {/* Keyed so React swaps the <img> rather than mutating one in place — otherwise the
                previous screenshot lingers on screen until the new file finishes decoding. */}
            <ScreenshotFrame
              key={activeTour.id}
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
              src={activeTour.image}
              alt={`${activeTour.label} — ${activeTour.title}`}
            />
          </div>
        </Section>

        {/* ----------------------------------------------------------- Workflow */}
        <Section className="border-y border-border bg-muted/30">
          <Reveal>
            <SectionHeading center eyebrow="How it flows" title="From a report to a client-verifiable receipt" />
          </Reveal>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            {WORKFLOW.map((step, index) => (
              <Reveal key={step.title} delay={index * 60}>
                <div className="group relative h-full rounded-xl border border-border bg-background p-4 transition hover:border-primary/50 hover:shadow-lg motion-safe:hover:-translate-y-1">
                  <span className="absolute -top-3 left-4 grid h-6 w-6 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground transition-transform motion-safe:group-hover:scale-110">
                    {index + 1}
                  </span>
                  <step.icon className="mt-2 h-5 w-5 text-primary" aria-hidden />
                  <p className="mt-2 text-sm font-bold">{step.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </Section>

        {/* ----------------------------------------------------------- Features */}
        <Section id="features">
          {/* The count is derived, not written out: a hardcoded "Fifteen" silently becomes a lie the
              first time someone adds a card — on the one page whose header says every claim must be
              audited against the code. */}
          <Reveal>
            <SectionHeading
              center
              eyebrow="Everything included"
              title="Built for the whole loop, not one slice of it"
              subtitle={`${FEATURES.length} capabilities that ship today. Nothing here is on a roadmap.`}
            />
          </Reveal>

          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {(["all", ...FEATURE_GROUPS] as const).map((option) => {
              const count = option === "all" ? FEATURES.length : FEATURES.filter((f) => f.group === option).length;
              const selected = group === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGroup(option)}
                  aria-pressed={selected}
                  className={`focus-ring inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition sm:text-sm ${
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  {option === "all" ? "Everything" : option}
                  <span className={`tabular-nums ${selected ? "text-primary/70" : "text-muted-foreground/70"}`}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Re-keyed on the filter so the surviving cards re-enter as a set — without it, changing
              the filter mutates a grid in place and reads as a glitch rather than a response.

              The pointer handler lives on the GRID, not on each of the cards. One listener that
              finds the card under the pointer costs one subscription for the whole section instead
              of one per card, and it keeps working when the filter re-keys the list underneath it. */}
          <div key={group} onPointerMove={handleSpotlight} className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shownFeatures.map((feature, index) => (
              <Card
                key={feature.title}
                style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
                className="spotlight-card group h-full overflow-hidden transition hover:border-primary/40 hover:shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-backwards motion-safe:hover:-translate-y-1"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      <feature.icon className="h-5 w-5" aria-hidden />
                    </span>
                    {feature.gate && (
                      <Badge variant="muted" title={`Available from the ${lowestTierFor(feature.gate)} plan up`}>
                        {lowestTierFor(feature.gate)}+
                      </Badge>
                    )}
                  </div>
                  <CardTitle className="mt-3 text-base">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-6 text-muted-foreground">{feature.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>

        {/* ----------------------------------------------------------- AI trust */}
        <Section id="ai" className="border-y border-border bg-muted/30">
          <Reveal>
            <SectionHeading
              center
              eyebrow="The AI question"
              title="Every objection your security team is about to raise"
              subtitle="Answered with a mechanism, not a promise."
            />
          </Reveal>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AI_GUARDRAILS.map((item, index) => (
              <Reveal key={item.title} delay={index * 60} className="h-full">
                <Card className="h-full bg-background transition hover:border-primary/40 hover:shadow-lg motion-safe:hover:-translate-y-1">
                  <CardHeader className="pb-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
                      <item.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <CardTitle className="mt-3 text-base">{item.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
          <Reveal delay={80} className="mt-10">
            <div className="grid gap-8 lg:grid-cols-[1.35fr_1fr] lg:items-center">
              <ScreenshotFrame
                src="/product/settings-ai.png"
                alt="Workspace settings, AI tab: provider and model selection, per-capability toggles, monthly budget, and the quality, datasets, prompts and evaluations cards."
              />
              <div>
                <h3 className="text-xl font-black tracking-tight">One screen, every switch, one budget</h3>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                  This is the whole AI control surface, and it's Super Admin only. Each capability has its own toggle, the
                  budget ceiling is checked on every call, and the quality cards below it tell you whether the AI is
                  actually getting better — parse-failure rate first, because it's measured rather than volunteered.
                </p>
              </div>
            </div>
          </Reveal>
          <Reveal delay={80} className="mt-10">
            <div className="grid gap-8 lg:grid-cols-[1fr_1.35fr] lg:items-center">
              <div>
                <h3 className="text-xl font-black tracking-tight">And when you hand work over, you hand it to a name</h3>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                  A teammate is a named identity on the audit ledger — no seat, no sign-in, no mailbox — assembled from
                  capabilities you already govern above. What it may do resolves down a ladder, and reading anything from
                  outside the workspace drops the rest of its run to proposing:
                </p>
                <AuthorityLadder className="mt-5 w-full max-w-md" />
              </div>
              <ScreenshotFrame
                src="/product/agents.png"
                alt="The AI teammates roster: six named teammates, each showing what it may do, its recent runs, and what today cost."
                caption="The roster — each card is the whole truth about one teammate."
              />
            </div>
          </Reveal>
        </Section>

        {/* ----------------------------------------------------------- Platform */}
        <Section id="platform">
          <Reveal>
            <SectionHeading center eyebrow="Multi-tenant by construction" title="Isolation you can point at" />
          </Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PLATFORM.map((item, index) => (
              <Reveal key={item.title} delay={index * 70} className="h-full">
                <Card className="h-full transition hover:border-primary/40 hover:shadow-lg motion-safe:hover:-translate-y-1">
                  <CardHeader className="pb-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
                      <item.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <CardTitle className="mt-3 text-base">{item.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Section>

        {/* ----------------------------------------------------------- Pricing */}
        <Section id="pricing" className="border-y border-border bg-muted/30">
          <Reveal>
            <SectionHeading
              center
              eyebrow="Pricing"
              title="Priced per seat. AI billed by your provider, not by us."
              subtitle="No usage markup, ever — you hold the key."
            />
          </Reveal>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {PRICING.map((tier, index) => (
              <Reveal key={tier.name} delay={index * 80} className={tier.highlight ? "lg:-my-3" : ""}>
                <Card
                  className={`flex h-full flex-col transition hover:shadow-xl motion-safe:hover:-translate-y-1 ${
                    tier.highlight ? "border-primary shadow-lg shadow-primary/10" : ""
                  }`}
                >
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{tier.name}</CardTitle>
                      {tier.highlight && <Badge>Most popular</Badge>}
                    </div>
                    <div className="mt-3 flex items-baseline gap-1.5">
                      <span className="text-4xl font-black tracking-tight">{tier.price}</span>
                      <span className="text-xs text-muted-foreground">{tier.cadence}</span>
                    </div>
                    <CardDescription className="mt-2">{tier.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col">
                    <ul className="grid flex-1 gap-2">
                      {tier.bullets.map((bullet) => (
                        <li key={bullet} className="flex items-start gap-2 text-sm">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                          <span className="text-muted-foreground">{bullet}</span>
                        </li>
                      ))}
                    </ul>
                    <Button asChild className="mt-6 w-full" variant={tier.highlight ? "default" : "outline"}>
                      <Link to="/login">{tier.cta}</Link>
                    </Button>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
          <div className="mt-6 text-center">
            <Button variant="ghost" onClick={() => setPricingOpen(true)}>
              See the full feature comparison <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </Section>

        {/* ----------------------------------------------------------- FAQ */}
        <Section id="faq">
          <Reveal>
            <SectionHeading center eyebrow="Questions" title="The ones that actually get asked" />
          </Reveal>
          <div className="mx-auto mt-10 grid max-w-3xl gap-3">
            {FAQ.map((item, index) => (
              <Reveal key={item.q} delay={index * 50}>
                {/* Native <details>: it is keyboard- and screen-reader-correct for free, and it
                    still works if the JS chunk for this route never arrives. */}
                <details className="group rounded-lg border border-border bg-card p-4 transition open:shadow-sm hover:border-primary/40">
                  <summary className="focus-ring cursor-pointer list-none rounded text-sm font-bold marker:content-none">
                    <span className="flex items-center justify-between gap-3">
                      {item.q}
                      <ChevronDown
                        aria-hidden
                        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-180"
                      />
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">{item.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </Section>

        {/* ----------------------------------------------------------- CTA */}
        <section className="border-t border-border bg-gradient-to-br from-primary via-info to-accent">
          <div className="mx-auto max-w-4xl px-4 py-16 text-center text-primary-foreground sm:px-5">
            <img
              src="/marketing/team-spirit.png"
              alt=""
              aria-hidden
              loading="lazy"
              decoding="async"
              width={600}
              height={600}
              className="mx-auto mb-6 hidden w-44 sm:block"
            />
            <h2 className="text-2xl font-black tracking-tight sm:text-4xl">Stop reconciling two systems.</h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 opacity-90 sm:text-base">
              Log the hours, run the tickets, prove the work — and turn AI on only where you decide it earns its place.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" variant="secondary" className="w-full sm:w-auto">
                <Link to="/login">Open the portal <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="w-full border-white/40 bg-transparent text-primary-foreground hover:bg-white/10 sm:w-auto"
              >
                <Link to="/pitch">Read the full story</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-5">
          <div className="flex items-center gap-2 font-bold text-foreground">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs text-primary-foreground">T</span>
            TimeSphere
          </div>
          <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <a href="#tour" className="focus-ring rounded hover:text-foreground">Tour</a>
            <a href="#features" className="focus-ring rounded hover:text-foreground">Features</a>
            <a href="#pricing" className="focus-ring rounded hover:text-foreground">Pricing</a>
            <a href="#faq" className="focus-ring rounded hover:text-foreground">FAQ</a>
            <Link to="/pitch" className="focus-ring rounded hover:text-foreground">Why we built it</Link>
            <Link to="/login" className="focus-ring rounded hover:text-foreground">Sign in</Link>
          </nav>
          <p className="text-xs">
            Enterprise timesheets &amp; ticketing. Illustrations by{" "}
            <a href="https://storyset.com" target="_blank" rel="noreferrer" className="focus-ring rounded underline hover:text-foreground">
              Storyset
            </a>
            .
          </p>
        </div>
      </footer>

      <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Layout primitives, local to this page. They exist to keep the section
 * markup above readable, not to be reused elsewhere.
 * ------------------------------------------------------------------ */

function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    // scroll-mt clears the sticky nav, so an anchor link doesn't land with the heading hidden
    // underneath it.
    <section id={id} className={`scroll-mt-20 ${className ?? ""}`}>
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-5 sm:py-20">{children}</div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
  center = false
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : ""}>
      <p className="text-xs font-bold uppercase tracking-wider text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">{title}</h2>
      {subtitle && <p className="mt-3 text-sm leading-7 text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/** One side of the "one record" schematic. */
function FlowColumn({ title, items, tone = "muted" }: { title: string; items: string[]; tone?: "muted" | "primary" }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="mt-3 grid gap-2">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm">
            <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "primary" ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
            <span className="text-muted-foreground">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Points down while the schematic is stacked, right once it becomes three columns. */
function FlowArrow() {
  return (
    <ArrowRight
      aria-hidden
      className="mx-auto h-5 w-5 shrink-0 rotate-90 text-primary/60 lg:rotate-0"
    />
  );
}
