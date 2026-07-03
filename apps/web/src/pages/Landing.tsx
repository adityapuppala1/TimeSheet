import { motion } from "framer-motion";
import {
  ArrowRight,
  BarChart3,
  Bell,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FileText,
  Mail,
  ShieldCheck,
  Sparkles,
  Star,
  Users
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

const features = [
  {
    icon: ShieldCheck,
    title: "RBAC + audit trail",
    body: "Role-specific dashboards, route guards, permission-aware menus, and tamper-evident audit logs across every action."
  },
  {
    icon: CalendarCheck,
    title: "Smart timesheets",
    body: "Hierarchical project / module / submodule picker, time-overlap detection, daily cap warnings, rich task editor, drag-drop attachments."
  },
  {
    icon: BarChart3,
    title: "Operational analytics",
    body: "Themed Recharts dashboards for hours, utilization, status mix, and per-project breakdowns. CSV + PDF exports."
  },
  {
    icon: Users,
    title: "Manager hierarchy",
    body: "Direct-report mappings, escalations that climb the chain, and a 'My Team' view with SLA badges per person."
  },
  {
    icon: Clock,
    title: "SLA + escalations",
    body: "Configurable per-project approval SLA. Breaches escalate up automatically and notify both ends with full context."
  },
  {
    icon: Bell,
    title: "In-app + email",
    body: "Every event hits an in-app toast and a branded HTML email. Per-user preferences for each channel."
  }
];

const workflow = [
  {
    icon: FileText,
    title: "Log",
    body: "Employees capture work with rich text, attachments, and live hour totals — entries can't exceed daily caps."
  },
  {
    icon: ShieldCheck,
    title: "Approve",
    body: "Managers see only their reports' submissions. Each approval has a per-project SLA timer."
  },
  {
    icon: Sparkles,
    title: "Escalate",
    body: "Missed SLAs raise to manager-of-manager (or workspace admin). Originals get notified — no silent drops."
  },
  {
    icon: BarChart3,
    title: "Analyze",
    body: "Aggregate hours by project, activity, status, and team. Export for finance, ops, or compliance reviews."
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
    description: "Small teams getting timesheets out of spreadsheets.",
    cta: "Start free",
    bullets: [
      "Up to 10 active users",
      "Daily timesheet logging + approvals",
      "Email reset + login security",
      "Basic CSV exports"
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
      "Manager hierarchy + escalations",
      "Per-project SLA + deadline reminders",
      "In-app + branded email notifications",
      "Per-user notification preferences",
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
      "SAML / SSO + SCIM provisioning",
      "Custom retention + data residency",
      "Dedicated support + uptime SLA",
      "Procurement & MSA support"
    ]
  }
];

export function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <nav className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3 font-bold">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">T</span>
            TimeSphere
          </div>
          <div className="flex items-center gap-2">
            <a href="#features" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground sm:inline">Features</a>
            <a href="#workflow" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground sm:inline">Workflow</a>
            <a href="#pricing" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground sm:inline">Pricing</a>
            <Button asChild>
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
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 lg:grid-cols-[1.1fr_0.9fr]">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="flex flex-col justify-center">
            <Badge variant="info" className="w-fit gap-1 px-3 py-1 text-xs">
              <Sparkles className="h-3 w-3" />
              SaaS for enterprise time tracking
            </Badge>
            <h1 className="mt-4 max-w-3xl text-4xl font-black leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Timesheets your team will <span className="bg-gradient-to-r from-primary via-info to-accent bg-clip-text text-transparent">actually use</span>.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
              A polished portal for daily work logs, manager approvals, SLA-driven escalations, in-app + email notifications,
              and audit-grade reporting — wired to the role-based access your governance team already expects.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/login">Open the portal <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <a href="#pricing">See pricing</a>
              </Button>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />SOC2-friendly audit log</span>
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />Role-based access</span>
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" />Branded HTML emails</span>
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
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{name}</p>
                      <Badge variant={tone as "success" | "info" | "warning"}>{value}%</Badge>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-muted">
                      <div
                        className={`h-2 rounded-full ${tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-info"}`}
                        style={{ width: `${value}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  <Mail className="mr-1 inline h-3 w-3 text-primary" />
                  Branded approval emails sent for every submission.
                </div>
              </div>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* Features grid */}
      <section id="features" className="border-y border-border bg-muted/30 py-16">
        <div className="mx-auto max-w-7xl px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">What you get</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Everything to run timesheets at scale</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
      <section id="workflow" className="py-16">
        <div className="mx-auto max-w-7xl px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">How it flows</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Log → approve → escalate → analyze</h2>
            <p className="mt-3 text-sm text-muted-foreground">Designed so the right person sees the right action at the right time.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {workflow.map((step, index) => (
              <Card key={step.title}>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-sm font-black text-primary">
                      {index + 1}
                    </div>
                    <step.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardTitle className="mt-3 text-base">{step.title}</CardTitle>
                  <CardDescription>{step.body}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-y border-border bg-muted/30 py-16">
        <div className="mx-auto max-w-7xl px-5">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">Pricing</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Simple plans that scale with your team</h2>
            <p className="mt-3 text-sm text-muted-foreground">Start free, upgrade when SLA + escalations matter.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
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
        </div>
      </section>

      {/* Trust strip */}
      <section className="mx-auto max-w-7xl px-5 py-14">
        <div className="grid gap-6 lg:grid-cols-3">
          {[
            { title: "Daily accountability", icon: <CalendarCheck className="h-5 w-5 text-primary" />, body: "Built so people log time in two minutes, not twenty." },
            { title: "Approval clarity", icon: <ShieldCheck className="h-5 w-5 text-primary" />, body: "Managers see only what's theirs, with SLA timers and rejection reasons baked in." },
            { title: "Audit confidence", icon: <FileText className="h-5 w-5 text-primary" />, body: "Every action recorded. Auditors get tamper-evident export, finance gets clean CSV." }
          ].map((item: { title: string; icon: ReactNode; body: string }) => (
            <div key={item.title} className="flex gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10">{item.icon}</div>
              <div>
                <h3 className="font-bold">{item.title}</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border px-5 py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} TimeSphere. Built for teams who care about operational clarity.
      </footer>
    </div>
  );
}
