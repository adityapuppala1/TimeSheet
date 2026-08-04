/**
 * WHAT: the public marketing page — hero, product tour with real screenshots, feature grid, the
 * AI-trust story, platform guarantees, pricing (summary cards + a full comparison modal), FAQ.
 * No API calls; purely presentational.
 *
 * WHY IT MUST STAY HONEST: this is the one page most likely to drift into overpromising. It has
 * done exactly that before — the Enterprise tier once advertised "SCIM provisioning" and
 * "per-department AI limits" that were never built. Treat every claim here as something to check
 * against the real feature set before merging, not against what "sounds right" for a SaaS page.
 * The same rule governs components/marketing/PricingDialog.tsx.
 *
 * WHY THE SCREENSHOTS ARE GENERATED, NOT PASTED: /product/*.png come from
 * tests/e2e/screenshots.spec.ts, which re-shoots them from the running app. Hand-taken marketing
 * images go stale silently and keep selling a screen that has since been redesigned.
 *
 * WHO renders this: `App.tsx`'s `/` (public, unauthenticated) route.
 */
import { motion } from "framer-motion";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarCheck,
  CheckCircle2,
  Clock,
  Coins,
  Eye,
  FileCheck2,
  FileText,
  FlaskConical,
  GitBranch,
  Activity,
  GanttChartSquare,
  Gauge,
  Inbox,
  Wallet,
  KeyRound,
  LayoutGrid,
  Lock,
  LogIn,
  ScanFace,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  WifiOff
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { PricingDialog } from "../components/marketing/PricingDialog";
import { ScreenshotFrame } from "../components/marketing/ScreenshotFrame";

/* ------------------------------------------------------------------ *
 * Content lives as data at the top so a claim can be audited without
 * reading JSX, and so nothing gets buried mid-markup where a review
 * would miss it.
 * ------------------------------------------------------------------ */

/** The product tour. Each entry points at a real captured screen. */
const TOUR = [
  {
    id: "dashboard",
    label: "Dashboard",
    title: "Everyone opens to what's theirs",
    body: "An engineer sees today's timeline and what's still unlogged. A manager sees the queue waiting on them and which SLA timers are running down. Same page, different job — nobody hunts through menus for their own work.",
    image: "/product/dashboard.png"
  },
  {
    id: "tickets",
    label: "Tickets",
    title: "Tickets that arrive already sorted",
    body: "List and Kanban, checklists, cross-ticket links, and a Dev tab wired to your real repositories. Items that came in by email carry an intake badge, and AI-classified ones show a Review badge until a human agrees.",
    image: "/product/tickets.png"
  },
  {
    id: "insights",
    label: "Insights",
    title: "The numbers a standup actually needs",
    body: "Velocity, cycle-time distribution, SLA compliance, workload heatmaps, estimate-versus-actual. Computed from the same rows the approvals ran against, so the dashboard and the invoice can't disagree.",
    image: "/product/insights.png"
  },
  {
    id: "timesheet",
    label: "Timesheet",
    title: "Logging time that fights back",
    body: "Project, module and submodule pickers, overlap detection, daily-cap warnings, and a rich task editor with attachments — plus a running total, so the entry is right before it's submitted rather than after a manager sends it back.",
    image: "/product/timesheet.png"
  },
  {
    id: "security",
    label: "Security",
    title: "Findings become tickets with owners",
    body: "Your CI posts SAST, DAST, secrets and supply-chain findings to your own webhook. They land as triaged, routed tickets with a risk rollup — this product never runs a scanner itself, so nothing new gets access to your code.",
    image: "/product/security.png"
  },
  {
    id: "settings-ai",
    label: "AI controls",
    title: "One screen that governs every model call",
    body: "Your key, your provider, your budget ceiling, and a separate switch for each AI capability. Plus the quality loop: what the AI actually said, what a human said it should have said, and whether the last prompt change helped.",
    image: "/product/settings-ai.png"
  }
];

const FEATURES: Array<{ icon: typeof Clock; title: string; body: string }> = [
  {
    icon: GanttChartSquare,
    title: "Plans, timelines and dependencies",
    body: "A real Gantt: hierarchy, four kinds of scheduling dependency with working-day lag, milestones, baselines and the critical path. Drag a bar to move it. If a date contradicts a dependency it says so and leaves your date alone — nothing is ever rescheduled behind your back, because there is no undo for a plan."
  },
  {
    icon: Gauge,
    title: "Capacity you can check, not guess",
    body: "The workload board puts planned hours, actually-logged hours and contracted capacity on one axis. That middle column is what a pure planning tool cannot show you: everything else in this category compares a plan against another plan, because estimates are all it holds."
  },
  {
    icon: Wallet,
    title: "Budgets priced from real rates",
    body: "Burn and forecast-at-completion computed from the same approved rate snapshots a client-facing Verified Work Attestation reads, so an internal dashboard and a document a client might dispute can never disagree. The forecast stays blank until there is enough data to mean anything."
  },
  {
    icon: Inbox,
    title: "Intake, blueprints and approvals",
    body: "Publish a request form to a link that needs no account; every submission becomes a ticket immediately. Save a project's shape as a blueprint and stamp it out against any start date. Route work items through sequential or parallel approvals, including external reviewers who get a single-use link rather than a half-real account."
  },
  {
    icon: CalendarCheck,
    title: "Smart timesheets",
    body: "Hierarchical project / module / submodule picker, overlap detection, daily cap warnings, and a rich task editor with attachments. Mistaken drafts can be deleted; approved hours can't, because they're part of the billing record."
  },
  {
    icon: LayoutGrid,
    title: "Jira-style ticketing",
    body: "Kanban with drag-and-drop and manager swimlanes, labels, cross-ticket links, a Dev tab for linking a repo, branch or PR, sub-task checklists, and SLA due-dates that escalate on their own."
  },
  {
    icon: Bot,
    title: "AI, bring your own key",
    body: "Auto-triage, duplicate detection, a writing assistant, comment summaries and \"Ask AI\" search — on Anthropic, OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, or your own local Ollama."
  },
  {
    icon: FlaskConical,
    title: "An AI you can actually improve",
    body: "Capture what the model was asked and what it answered, correct real failures into a golden set, edit prompts without a deploy, then replay the set and score the change. \"Is the new prompt better?\" becomes a number."
  },
  {
    icon: Inbox,
    title: "Email-to-ticket intake",
    body: "Forward a bug report and AI reads the text and screenshots, classifies it, and opens a properly routed, prioritized ticket. External content is explicitly framed as data, never as instructions."
  },
  {
    icon: FileCheck2,
    title: "Verified Work Attestations",
    body: "A structured PDF of approved, identity-verified work for a project and period — hours, contributors, approvers and rates — that you can hand a client, or share as a link they open without an account."
  },
  {
    icon: TrendingUp,
    title: "Insights dashboard",
    body: "Velocity, SLA compliance, cycle-time distribution, workload heatmaps and estimate-vs-actual, with cost analytics built on the rate that applied when each entry was approved."
  },
  {
    icon: ScanFace,
    title: "Optional identity verification",
    body: "Face verification at clock-in and approval, with liveness and anti-spoof checks. Templates are encrypted, retention is configurable, and no image or embedding ever leaves your server."
  },
  {
    icon: ShieldCheck,
    title: "RBAC + audit trail",
    body: "Role-specific dashboards, permission-aware menus, and a tamper-evident audit log across every administrative and AI action. Workspace settings are Super Admin only."
  },
  {
    icon: Clock,
    title: "SLA + escalations",
    body: "Configurable approval and resolution SLAs for both timesheets and tickets. Breaches escalate up the reporting line automatically — nobody has to notice one manually."
  },
  {
    icon: GitBranch,
    title: "Security & DevOps ingestion",
    body: "Your CI POSTs SAST/DAST/secrets/supply-chain findings to a per-organization webhook. VAPT reports upload as structured JSON. Every ticket gets a Security tab with a PDF export."
  },
  {
    icon: KeyRound,
    title: "Public API & webhooks",
    body: "Bearer-key access to list and create tickets and list timesheets, plus HMAC-signed outbound webhooks with automatic retry — the integration surface for Zapier, Make, or your own scripts."
  },
  {
    icon: WifiOff,
    title: "It tells you when it's down",
    body: "The app polls its own backend. One dropped request shows a quiet warning; a real outage pauses the interface rather than letting you type into a void. It resumes on its own, keeping what you had entered."
  },
  {
    icon: Activity,
    title: "A status page with a memory",
    body: "Every feature is probed every five minutes — sign-in, timesheets, tickets, reports, email, AI, planning — with a day-by-day history and a recorded incident log. It answers the question a CPU graph structurally cannot: was it down on Tuesday, when I could not submit? A day is coloured by its worst check, because averaging is how a two-hour outage becomes a 96%-green day."
  },
  {
    icon: Bell,
    title: "In-app + email",
    body: "Every event hits an in-app toast and a branded HTML email, with per-user, per-category notification preferences."
  },
  {
    icon: Lock,
    title: "Session security",
    body: "Rotating httpOnly sessions, an active-devices list you control, per-account lockout, and AES-256 encrypted secrets at rest."
  }
];

/** The AI-trust story. This is the section that closes security reviews, so it stays specific. */
const AI_GUARDRAILS = [
  {
    icon: KeyRound,
    title: "Bring your own key, any provider",
    body: "Point AI features at Anthropic, OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, or a self-hosted Ollama/LM Studio. Your key is encrypted at rest and never sent back to the browser once saved — switch providers without touching code."
  },
  {
    icon: Sparkles,
    title: "Nothing runs until you say so",
    body: "A master switch plus a separate toggle for each AI capability, all off by default. Flip nothing on and the app never calls out to any model, on any plan."
  },
  {
    icon: Eye,
    title: "Low-confidence work waits for a human",
    body: "Every classification carries a confidence score. Below your threshold it's flagged \"needs review\" rather than silently auto-assigned — and email-sourced suggestions are held to a stricter bar, because that content comes from outside your organization."
  },
  {
    icon: ShieldCheck,
    title: "Untrusted input can't hijack the model",
    body: "Content from email, chat, CI logs and pull requests is explicitly delimited and framed as data before it reaches a model, so a crafted \"ignore previous instructions\" message can't talk your triage pipeline past review."
  },
  {
    icon: Coins,
    title: "A budget cap that actually stops spend",
    body: "Every call is cost-estimated and logged against a monthly budget. At the cap, AI features pause gracefully instead of running up a surprise bill — including the evaluation runner, which is refused up front if it wouldn't fit."
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
    body: "Password, Google, Microsoft or SAML — each organization's own admin enables exactly the methods their team uses, independent of every other organization, down to requiring SSO-only."
  },
  {
    icon: SlidersHorizontal,
    title: "Plan limits with real teeth",
    body: "Seat limits and AI budget ceilings are enforced live on every request, not just described in a pricing table — and can be raised for one organization without waiting on a deploy."
  }
];

const WORKFLOW = [
  { icon: FileText, title: "Report", body: "Work arrives three ways: someone logs time, someone opens a ticket, or an email lands in the intake mailbox." },
  { icon: Bot, title: "Triage", body: "AI proposes type, priority and module. Confident items move on; uncertain ones wait for a person." },
  { icon: ShieldCheck, title: "Approve", body: "Managers see only their reports' submissions, each with a per-project SLA timer counting down." },
  { icon: Sparkles, title: "Escalate", body: "Missed SLAs raise to the next manager up automatically." },
  { icon: BarChart3, title: "Analyze", body: "Velocity, cycle time, hotspots and workload roll into one dashboard for planning and reviews." },
  { icon: FileCheck2, title: "Prove", body: "Approved, identity-verified work becomes an attestation PDF a client can check." }
];

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
      "AI features, bring your own key",
      "AI quality loop: golden sets, prompt versions, evals",
      "Email-to-ticket intake + Kanban board",
      "Insights, attestations, PDF/CSV exports",
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
      "Google, Microsoft and SAML — SSO-only available",
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
    q: "What happens when the backend goes down?",
    a: "The app notices and says so. One dropped request shows a warning strip; a sustained outage pauses the interface rather than accepting input that would be silently lost. It resumes on its own, without a reload, and keeps what you had typed."
  }
];

/* ------------------------------------------------------------------ */

export function Landing() {
  const [pricingOpen, setPricingOpen] = useState(false);
  const [tourId, setTourId] = useState(TOUR[0].id);
  const activeTour = TOUR.find((t) => t.id === tourId) ?? TOUR[0];

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <nav className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <Link to="/" className="flex min-w-0 items-center gap-3 font-bold">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">T</span>
            <span className="truncate">TimeSphere</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <a href="#tour" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">Tour</a>
            <a href="#features" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">Features</a>
            <a href="#ai" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">AI</a>
            {/* Restored: the rewrite kept the `#platform` section id and its scroll-mt but dropped
                the only link pointing at it, leaving an anchor target nothing referenced. */}
            <a href="#platform" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground lg:inline">Platform</a>
            <a href="#pricing" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">Pricing</a>
            <Link to="/pitch" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground lg:inline">Why we built it</Link>
            <Button asChild size="sm" className="sm:h-10 sm:px-4 sm:text-sm">
              <Link to="/login">Sign in <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </div>
      </nav>

      {/* ------------------------------------------------------------- Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl" />
          <div className="absolute -right-24 top-12 h-[28rem] w-[28rem] rounded-full bg-accent/20 blur-3xl" />
        </div>
        <div className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-5 sm:py-20">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <Badge variant="info" className="mx-auto w-fit gap-1 px-3 py-1 text-xs">
              <Sparkles className="h-3 w-3 shrink-0" />
              <span>Plan the work, track the tickets, measure the hours — one workspace</span>
            </Badge>
            <h1 className="mx-auto mt-5 max-w-4xl text-3xl font-black leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              The plan, and{" "}
              {/* Teal→blue only. Running the gradient through `accent` (amber) meant that when the
                  phrase wrapped, the second line ended gold — which reads as a warning state, not
                  emphasis. A two-stop ramp survives wrapping at any width. */}
              <span className="bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">what actually happened</span>.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              Gantt timelines, portfolios, capacity and budgets — sitting on top of the tickets your team works and the
              hours they actually log. A project tool has to estimate effort. This one measures it, because the plan and
              the timesheet are the same system.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link to="/login">Open the portal <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => setPricingOpen(true)}>
                Compare plans
              </Button>
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />SOC2-friendly audit log</span>
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />Bring-your-own AI key</span>
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />AES-256 encrypted secrets</span>
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />A database per organization</span>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.15 }} className="mt-12">
            <ScreenshotFrame
              src="/product/dashboard.png"
              alt="The TimeSphere dashboard: this week's logged hours by state, a daily rhythm chart, week and month progress, and a day timeline of entries."
              priority
              caption="The real dashboard — every screenshot on this page is generated from the running app."
            />
          </motion.div>
        </div>
      </section>

      {/* ------------------------------------------------------------- Problem */}
      <Section className="border-y border-border bg-muted/30">
        <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <SectionHeading eyebrow="The problem" title="Two systems that never agree" />
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              Most teams run tickets in one tool and hours in another. The moment a client asks what they're paying for,
              somebody exports both and reconciles them by hand — and the numbers don't match, because a ticket was
              closed in one place and the time was logged against something else in the other.
            </p>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              TimeSphere keeps them as one record. An approval, an SLA timer, a cost report and a client-facing
              attestation all read the same rows, so there is nothing to reconcile and nothing to disagree about.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ["One source of truth", "Hours and tickets are the same records, not two exports."],
              ["Proof, not assertions", "Approved, identity-verified work becomes a PDF a client can check."],
              ["AI you can audit", "Every decision logged, scored and correctable."],
              ["Limits that hold", "Seats and AI spend enforced per request, not per pricing page."]
            ].map(([title, body]) => (
              <div key={title} className="rounded-lg border border-border bg-background p-4">
                <p className="text-sm font-bold">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------- Tour */}
      <Section id="tour">
        <SectionHeading
          center
          eyebrow="Product tour"
          title="Six screens, and what each one is for"
          subtitle="Captured from the running application, not mocked up."
        />
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {TOUR.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTourId(item.id)}
              aria-pressed={tourId === item.id}
              className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                tourId === item.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.35fr] lg:items-center">
          <div>
            <h3 className="text-xl font-black tracking-tight sm:text-2xl">{activeTour.title}</h3>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{activeTour.body}</p>
            <Button asChild variant="outline" size="sm" className="mt-5">
              <Link to="/login">See it with your data <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
          {/* Keyed so React swaps the <img> rather than mutating one in place — otherwise the
              previous screenshot lingers on screen until the new file finishes decoding. */}
          <ScreenshotFrame key={activeTour.id} src={activeTour.image} alt={`${activeTour.label} — ${activeTour.title}`} />
        </div>
      </Section>

      {/* ------------------------------------------------------------- Workflow */}
      <Section className="border-y border-border bg-muted/30">
        <SectionHeading center eyebrow="How it flows" title="From a report to a client-verifiable receipt" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {WORKFLOW.map((step, index) => (
            <div key={step.title} className="relative rounded-xl border border-border bg-background p-4">
              <span className="absolute -top-3 left-4 grid h-6 w-6 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {index + 1}
              </span>
              <step.icon className="mt-2 h-5 w-5 text-primary" />
              <p className="mt-2 text-sm font-bold">{step.title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- Features */}
      <Section id="features">
        {/* The count is derived, not written out: a hardcoded "Fifteen" silently becomes a lie the
            first time someone adds a card — on the one page whose header says every claim must be
            audited against the code. */}
        <SectionHeading
          center
          eyebrow="Everything included"
          title="Built for the whole loop, not one slice of it"
          subtitle={`${FEATURES.length} capabilities that ship today. Nothing here is on a roadmap.`}
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="h-full transition hover:border-primary/40 hover:shadow-lg">
              <CardHeader className="pb-3">
                <feature.icon className="h-5 w-5 text-primary" />
                <CardTitle className="mt-2 text-base">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{feature.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- AI trust */}
      <Section id="ai" className="border-y border-border bg-muted/30">
        <SectionHeading
          center
          eyebrow="The AI question"
          title="Every objection your security team is about to raise"
          subtitle="Answered with a mechanism, not a promise."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {AI_GUARDRAILS.map((item) => (
            <Card key={item.title} className="h-full bg-background">
              <CardHeader className="pb-3">
                <item.icon className="h-5 w-5 text-primary" />
                <CardTitle className="mt-2 text-base">{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-[1.35fr_1fr] lg:items-center">
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
      </Section>

      {/* ------------------------------------------------------------- Platform */}
      <Section id="platform">
        <SectionHeading center eyebrow="Multi-tenant by construction" title="Isolation you can point at" />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {PLATFORM.map((item) => (
            <Card key={item.title} className="h-full">
              <CardHeader className="pb-3">
                <item.icon className="h-5 w-5 text-primary" />
                <CardTitle className="mt-2 text-base">{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- Pricing */}
      <Section id="pricing" className="border-y border-border bg-muted/30">
        <SectionHeading
          center
          eyebrow="Pricing"
          title="Priced per seat. AI billed by your provider, not by us."
          subtitle="No usage markup, ever — you hold the key."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {PRICING.map((tier) => (
            <Card
              key={tier.name}
              className={`flex h-full flex-col ${tier.highlight ? "border-primary shadow-lg shadow-primary/10 lg:-my-3" : ""}`}
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
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      <span className="text-muted-foreground">{bullet}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild className="mt-6 w-full" variant={tier.highlight ? "default" : "outline"}>
                  <Link to="/login">{tier.cta}</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="mt-6 text-center">
          <Button variant="ghost" onClick={() => setPricingOpen(true)}>
            See the full feature comparison <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </Section>

      {/* ------------------------------------------------------------- FAQ */}
      <Section>
        <SectionHeading center eyebrow="Questions" title="The ones that actually get asked" />
        <div className="mx-auto mt-10 grid max-w-3xl gap-3">
          {FAQ.map((item) => (
            <details key={item.q} className="group rounded-lg border border-border bg-card p-4 open:shadow-sm">
              <summary className="cursor-pointer list-none text-sm font-bold marker:content-none">
                <span className="flex items-center justify-between gap-3">
                  {item.q}
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-90" />
                </span>
              </summary>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- CTA */}
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

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-5">
          <div className="flex items-center gap-2 font-bold text-foreground">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs text-primary-foreground">T</span>
            TimeSphere
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <a href="#tour" className="hover:text-foreground">Tour</a>
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#pricing" className="hover:text-foreground">Pricing</a>
            <Link to="/pitch" className="hover:text-foreground">Why we built it</Link>
            <Link to="/login" className="hover:text-foreground">Sign in</Link>
          </div>
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
