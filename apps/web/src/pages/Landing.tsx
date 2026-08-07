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
  CheckCircle2,
  ChevronDown,
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
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Wallet,
  WifiOff,
  X
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
    icon: Bot,
    title: "One screen that governs every model call",
    body: "Your key, your provider, your budget ceiling, and a separate switch for each AI capability. Plus the quality loop: what the AI actually said, what a human said it should have said, and whether the last prompt change helped.",
    image: "/product/settings-ai.png"
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
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl" />
            <div className="absolute -right-24 top-12 h-[28rem] w-[28rem] rounded-full bg-accent/20 blur-3xl" />
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
              the timesheet are the same system.
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
        </section>

        {/* ----------------------------------------------------------- Problem */}
        <Section className="border-y border-border bg-muted/30">
          <Reveal>
            <SectionHeading
              center
              eyebrow="The problem"
              title="Two systems that never agree"
              subtitle="Most teams run tickets in one tool and hours in another. The moment a client asks what they're paying for, somebody exports both and reconciles them by hand — and the numbers don't match, because a ticket was closed in one place and the time was logged against something else in the other."
            />
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
        </Section>

        {/* ----------------------------------------------------------- Tour */}
        <Section id="tour">
          <Reveal>
            <SectionHeading
              center
              eyebrow="Product tour"
              title="Six screens, and what each one is for"
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
              the filter mutates a grid in place and reads as a glitch rather than a response. */}
          <div key={group} className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shownFeatures.map((feature, index) => (
              <Card
                key={feature.title}
                style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
                className="group h-full transition hover:border-primary/40 hover:shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-backwards motion-safe:hover:-translate-y-1"
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
          <p className="text-xs">Enterprise timesheets &amp; ticketing.</p>
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
