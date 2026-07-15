/**
 * WHAT: the public marketing/landing page (hero, feature sections, pricing tiers, platform
 * guardrails, CTA) — no API calls, purely presentational.
 * WHY it must stay in sync with what's actually built: this is the one page most likely to
 * drift into overpromising (see the session history around this file — the Enterprise tier
 * once advertised "SCIM provisioning" and "per-department AI limits" that were never built).
 * Treat every claim here as something that must be checked against the real feature set before
 * merging a change, not just against what "sounds right" for a SaaS pricing page.
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
  FileText,
  GitBranch,
  Inbox,
  KeyRound,
  LayoutGrid,
  ListChecks,
  Lock,
  LogIn,
  Mail,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  TrendingUp,
  Users
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

const features = [
  {
    icon: CalendarCheck,
    title: "Smart timesheets",
    body: "Hierarchical project / module / submodule picker, overlap detection, daily cap warnings, and a rich task editor with attachments."
  },
  {
    icon: LayoutGrid,
    title: "Jira-style ticketing",
    body: "Kanban board with drag-and-drop and manager swimlanes, labels, cross-ticket links, a Dev tab for linking a repo/branch/PR, sub-task checklists, and SLA due-dates that escalate automatically."
  },
  {
    icon: Bot,
    title: "AI, bring your own key",
    body: "Auto-triage, duplicate detection, a writing assistant, comment summaries, and \"Ask AI\" search — on Anthropic, OpenAI, Groq, or your own local Ollama install."
  },
  {
    icon: Inbox,
    title: "Email-to-ticket intake",
    body: "Forward a bug report and AI reads the text and screenshots, classifies it, and opens a properly routed, prioritized ticket automatically."
  },
  {
    icon: TrendingUp,
    title: "Insights dashboard",
    body: "Velocity, SLA compliance, cycle-time distribution, workload heatmaps, and estimate-vs-actual — the numbers your standup actually needs."
  },
  {
    icon: ShieldCheck,
    title: "RBAC + audit trail",
    body: "Role-specific dashboards, permission-aware menus, and a tamper-evident audit log across every administrative and AI action."
  },
  {
    icon: Clock,
    title: "SLA + escalations",
    body: "Configurable approval and resolution SLAs for both timesheets and tickets. Breaches escalate up the chain automatically."
  },
  {
    icon: Bell,
    title: "In-app + email",
    body: "Every event hits an in-app toast and a branded HTML email, with per-user, per-category notification preferences."
  },
  {
    icon: Lock,
    title: "Session security",
    body: "httpOnly rotating sessions, an active-devices list you control, per-account lockout, and encrypted secrets at rest."
  },
  {
    icon: GitBranch,
    title: "Security & DevOps ingestion",
    body: "Your own CI POSTs SAST/DAST/secrets/supply-chain findings to a per-org webhook — this app never runs a scanner itself. VAPT reports upload as structured JSON. Every ticket gets a Security tab with a PDF export and, optionally, a close-out digest email."
  },
  {
    icon: Users,
    title: "Reporting-line views",
    body: "An org-chart tree on the Team page and \"Group by manager\" Kanban swimlanes, both built from the same reporting-line data — no extra setup, no separate permission model."
  },
  {
    icon: CheckCircle2,
    title: "CI gate on Resolved",
    body: "An optional, off-by-default guardrail: a ticket can't move to Resolved while its latest ingested CI run is failing — visible as a red badge on the Kanban card before anyone even opens it."
  },
  {
    icon: KeyRound,
    title: "Public API & webhooks",
    body: "Bearer-key access to list/create tickets and list timesheets, plus HMAC-signed outbound webhooks on ticket and timesheet events — the integration surface for Zapier, Make, or your own scripts."
  },
  {
    icon: GitBranch,
    title: "Live GitHub connection",
    body: "Bring your own GitHub OAuth App and the ticket Dev tab lists live repos, branches, and pull requests to pick from — no TimeSphere-operated client ever touches your repositories."
  }
];

const guardrails = [
  {
    icon: KeyRound,
    title: "Bring your own key, any provider",
    body: "Point AI features at Anthropic, OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, or a self-hosted Ollama/LM Studio install. Your key is encrypted at rest and never sent back to the browser once saved — switch providers without touching a line of code."
  },
  {
    icon: Sparkles,
    title: "Nothing runs until you say so",
    body: "A master switch plus a separate toggle per AI capability — triage, duplicate detection, writing assistant, email intake, and more each have their own on/off. Flip nothing on, and the app never calls out to any model."
  },
  {
    icon: Eye,
    title: "Low-confidence work waits for a human",
    body: "Every AI classification carries a confidence score. Below your configured threshold, a ticket is flagged \"needs review\" instead of silently auto-assigned — and email-sourced suggestions are held to an even stricter bar, since that content comes from outside your organization."
  },
  {
    icon: ShieldCheck,
    title: "Untrusted input can't hijack the model",
    body: "Inbound email content is explicitly delimited and framed as data, not instructions, before it ever reaches an AI model — so a crafted \"ignore previous instructions\" email can't talk your triage pipeline into misclassifying itself past review."
  },
  {
    icon: Coins,
    title: "A budget cap that actually stops spend",
    body: "Every AI call is cost-estimated and logged against a configurable monthly budget. Once the cap is hit, AI features pause gracefully instead of running up a surprise bill."
  },
  {
    icon: FileText,
    title: "Every AI decision is auditable",
    body: "The AI Activity Log shows every AI-touched ticket, its confidence, and a thumbs up/down feedback control — so admins can see exactly what the model decided and how often it was right."
  }
];

const platformGuardrails = [
  {
    icon: Building2,
    title: "A database of your own",
    body: "Every organization's tickets, timesheets, and AI history live in a dedicated database — not a shared table filtered by a tenant ID. There's no query to get wrong, because there's no shared connection for one to cross."
  },
  {
    icon: LogIn,
    title: "Sign in your way",
    body: "Password, Google, Microsoft, or SAML — each organization's own admin turns on exactly the methods their team uses, entirely independent of every other organization on the platform, down to requiring SSO-only if they choose."
  },
  {
    icon: SlidersHorizontal,
    title: "Plan tiers with real teeth",
    body: "Seat limits and AI budget ceilings are enforced live on every request, not just described in a pricing table — and a platform operator can raise either one for a specific organization without waiting on a deploy."
  }
];

const workflow = [
  {
    icon: FileText,
    title: "Report",
    body: "Work comes in three ways: a teammate logs time, a teammate opens a ticket, or an email lands in the intake mailbox."
  },
  {
    icon: Bot,
    title: "Triage",
    body: "AI suggests type, priority, and module — confidently-classified items move on, uncertain ones wait for a human."
  },
  {
    icon: ShieldCheck,
    title: "Approve",
    body: "Managers see only their reports' submissions, each with a per-project SLA timer counting down."
  },
  {
    icon: Sparkles,
    title: "Escalate",
    body: "Missed SLAs raise to the next manager up automatically — nobody has to notice a breach manually."
  },
  {
    icon: BarChart3,
    title: "Analyze",
    body: "Velocity, cycle time, hotspots, and workload roll up into one insights dashboard for planning and reviews."
  }
];

const pricingTiers: Array<{
  name: string;
  price: string;
  cadence: string;
  description: string;
  highlight?: boolean;
  cta: string;
  bullets: string[];
}> = [
  {
    name: "Starter",
    price: "$0",
    cadence: "per seat / month",
    description: "Small teams getting timesheets and tickets out of spreadsheets and inboxes.",
    cta: "Start free",
    bullets: [
      "Up to 10 active users",
      "Timesheets + ticketing core",
      "Manager approvals + basic SLA",
      "Google sign-in (SSO)",
      "CSV exports"
    ]
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
      "Google + Microsoft sign-in (SSO)",
      "AI features, bring your own key",
      "Admin-configured monthly AI budget cap",
      "Email-to-ticket intake + Kanban board",
      "Insights dashboard + PDF/CSV exports",
      "Audit log + role-based access"
    ]
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "billed annually",
    description: "Compliance-heavy orgs with hundreds of contributors.",
    cta: "Talk to sales",
    bullets: [
      "Everything in Team",
      "Google, Microsoft, and SAML SSO — SSO-only mode available",
      "Your own dedicated database, never shared with another tenant",
      "Platform-adjustable seat and AI-budget limits for your organization",
      "Dedicated support + uptime SLA"
    ]
  }
];

export function Landing() {
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <nav className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3 font-bold">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">T</span>
            <span className="truncate">TimeSphere</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href="#features" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">Features</a>
            <a href="#ai" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">AI</a>
            <a href="#platform" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">Platform</a>
            <a href="#pricing" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground md:inline">Pricing</a>
            <Button asChild size="sm" className="sm:h-10 sm:px-4 sm:text-sm">
              <Link to="/login">Sign in <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl" />
          <div className="absolute -right-24 top-12 h-[28rem] w-[28rem] rounded-full bg-accent/20 blur-3xl" />
        </div>
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-5 sm:py-16 lg:grid-cols-[1.1fr_0.9fr]">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="flex flex-col justify-center">
            <Badge variant="info" className="w-fit gap-1 px-3 py-1 text-xs">
              <Sparkles className="h-3 w-3 shrink-0" />
              <span>Timesheets, ticketing, and BYOK AI in one workspace</span>
            </Badge>
            <h1 className="mt-4 max-w-3xl text-3xl font-black leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Work your team logs. AI that <span className="bg-gradient-to-r from-primary via-info to-accent bg-clip-text text-transparent">earns your trust</span>.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 sm:text-lg sm:leading-8 text-muted-foreground">
              One portal for daily time logs, Jira-style tickets, SLA-driven escalations, and an AI layer that triages,
              summarizes, and answers questions — gated behind toggles, budget caps, and a human-review gate your
              security team will actually sign off on.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link to="/login">Open the portal <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
                <a href="#pricing">See pricing</a>
              </Button>
            </div>
            <div className="mt-8 grid grid-cols-1 gap-x-6 gap-y-2 text-xs text-muted-foreground sm:flex sm:flex-wrap sm:items-center">
              <span className="inline-flex min-w-0 items-center gap-1"><CheckCircle2 className="h-3 w-3 shrink-0 text-success" /><span className="truncate">SOC2-friendly audit log</span></span>
              <span className="inline-flex min-w-0 items-center gap-1"><CheckCircle2 className="h-3 w-3 shrink-0 text-success" /><span className="truncate">Bring-your-own AI key</span></span>
              <span className="inline-flex min-w-0 items-center gap-1"><CheckCircle2 className="h-3 w-3 shrink-0 text-success" /><span className="truncate">AES-256 encrypted secrets</span></span>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.55 }}>
            <Card className="overflow-hidden p-0">
              <div className="bg-gradient-to-br from-primary via-info to-accent p-5 text-primary-foreground">
                <p className="text-sm font-semibold opacity-85">Live productivity command center</p>
                <p className="mt-2 text-3xl font-black tracking-tight">1,284h logged</p>
                <p className="text-sm opacity-85">This week, across 14 active projects</p>
              </div>
              <div className="grid gap-3 p-5">
                {[
                  ["Product Platform", 82, "success"],
                  ["Client Delivery", 71, "info"],
                  ["Internal Ops", 60, "warning"]
                ].map(([name, value, tone]) => (
                  <div key={name as string} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-semibold">{name}</p>
                      <Badge variant={tone as "success" | "info" | "warning"} className="shrink-0">{value}%</Badge>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-muted">
                      <div
                        className={`h-2 rounded-full ${tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-info"}`}
                        style={{ width: `${value}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>AI flagged 2 tickets this week as "needs review" instead of guessing.</span>
                </div>
              </div>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* AI trust / guardrails */}
      <section id="ai" className="border-y border-border bg-muted/30 py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">AI you can actually deploy</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">AI that helps your team, on your terms</h2>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">
              Every capability below is opt-in, provider-agnostic, and built to survive a security review — not
              bolted on as an afterthought.
            </p>
          </div>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {guardrails.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="border-border/70 shadow-none">
                <CardContent className="pt-6">
                  <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Multi-tenant platform guardrails */}
      <section id="platform" className="py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">One platform, every organization isolated</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">Built for real organizations, not just one</h2>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">
              Run it as your own on-prem deployment, or as a multi-organization SaaS platform — the same codebase,
              structurally isolated per tenant either way.
            </p>
          </div>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {platformGuardrails.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="border-border/70 shadow-none">
                <CardContent className="pt-6">
                  <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section id="features" className="py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">What you get</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">Everything to run timesheets and tickets at scale</h2>
          </div>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="border-border/70 shadow-none">
                <CardContent className="pt-6">
                  <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-y border-border bg-muted/30 py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">How it flows</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">Report → triage → approve → escalate → analyze</h2>
            <p className="mt-3 text-sm text-muted-foreground">Designed so the right person — or the model, when it's confident — sees the right action at the right time.</p>
          </div>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
            {workflow.map((step, index) => (
              <Card key={step.title}>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-sm font-black text-primary">
                      {index + 1}
                    </div>
                    <step.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                  <CardTitle className="mt-3 text-base">{step.title}</CardTitle>
                  <CardDescription>{step.body}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Insights preview */}
      <section id="insights" className="py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-5 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">See it, don't dig for it</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">One dashboard for velocity, SLA, and where work gets stuck</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
              Ticket velocity, SLA compliance trend, cycle-time distribution, a per-assignee workload heatmap, and
              estimate-vs-actual variance roll up automatically from the same tickets and timesheets your team is
              already logging — no separate reporting tool, no manual rollup.
            </p>
            <ul className="mt-5 grid gap-2.5 text-sm">
              {[
                "Velocity: created vs. resolved, week over week",
                "SLA compliance % trend, so breaches show up before a client asks",
                "Workload heatmap by assignee, to catch overload before it burns someone out",
                "Optional cost-per-ticket and leaderboard views, off by default"
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
          <Card className="overflow-hidden p-0">
            <CardContent className="grid gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-bold">SLA compliance, last 6 weeks</p>
                <Badge variant="success" className="shrink-0">94%</Badge>
              </div>
              <div className="flex h-24 items-end gap-1.5 sm:gap-2">
                {[62, 71, 68, 80, 88, 94].map((value, index) => (
                  <div key={index} className="flex flex-1 flex-col items-center gap-1">
                    <div className="w-full rounded-t-sm bg-info" style={{ height: `${value}%` }} />
                    <span className="text-[10px] text-muted-foreground">W{index + 1}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 grid gap-2">
                {[
                  ["Auth module", 12, "warning"],
                  ["Billing API", 7, "info"],
                  ["Mobile UI", 4, "success"]
                ].map(([name, count, tone]) => (
                  <div key={name as string} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${tone === "warning" ? "bg-warning" : tone === "info" ? "bg-info" : "bg-success"}`} />
                      <span className="truncate">{name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{count} open tickets</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-y border-border bg-muted/30 py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">Pricing</p>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-4xl">Simple plans that scale with your team</h2>
            <p className="mt-3 text-sm text-muted-foreground">Start free, add AI when you're ready, upgrade when SSO and escalations matter.</p>
          </div>
          <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
            {pricingTiers.map((tier) => (
              <Card
                key={tier.name}
                className={tier.highlight ? "relative border-primary/60 shadow-glow" : "shadow-none"}
              >
                {tier.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="default" className="gap-1 px-3 py-1"><Star className="h-3 w-3" />Most popular</Badge>
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-lg">{tier.name}</CardTitle>
                  <CardDescription>{tier.description}</CardDescription>
                  <div className="mt-4 flex items-end gap-1">
                    <span className="text-4xl font-black tracking-tight">{tier.price}</span>
                    <span className="pb-1 text-xs text-muted-foreground">{tier.cadence}</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="grid gap-2.5 text-sm">
                    {tier.bullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-2">
                        <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${tier.highlight ? "text-primary" : "text-success"}`} />
                        <span>{bullet}</span>
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
          <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-muted-foreground">
            AI usage is metered per feature and capped by an admin-configured monthly budget on every plan — see
            Workspace Settings → AI once you're in.
          </p>
        </div>
      </section>

      {/* Trust strip */}
      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-5">
        <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { title: "Daily accountability", icon: <CalendarCheck className="h-5 w-5 text-primary" />, body: "Built so people log time in two minutes, not twenty." },
            { title: "Approval clarity", icon: <ShieldCheck className="h-5 w-5 text-primary" />, body: "Managers see only what's theirs, with SLA timers baked in." },
            { title: "Traceable AI", icon: <GitBranch className="h-5 w-5 text-primary" />, body: "Every AI decision is logged, scored, and reviewable — never a black box." },
            { title: "Audit confidence", icon: <ListChecks className="h-5 w-5 text-primary" />, body: "Every action recorded. Auditors get a tamper-evident log, finance gets clean CSV." }
          ].map((item: { title: string; icon: ReactNode; body: string }) => (
            <div key={item.title} className="flex gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10">{item.icon}</div>
              <div className="min-w-0">
                <h3 className="font-bold">{item.title}</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border px-4 py-8 text-center text-xs text-muted-foreground sm:px-5">
        © {new Date().getFullYear()} TimeSphere. Built for teams who care about operational clarity.
      </footer>
    </div>
  );
}
