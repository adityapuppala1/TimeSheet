/**
 * WHAT: the pitch — a standalone public page at `/pitch` that explains what TimeSphere is, who
 * it's for, why it exists, how it makes money, and what makes it hard to copy. Structured as
 * numbered slides so it reads top-to-bottom in a browser and also survives being printed or
 * screen-shared in a meeting.
 *
 * WHY IT'S A PAGE AND NOT A PDF: a deck goes out of date the day after it's exported, and then
 * three versions of it circulate. This reads from the same claims the landing page makes and uses
 * the same generated screenshots, so refreshing the product refreshes the pitch.
 *
 * THE ACCURACY RULE FROM Landing.tsx APPLIES HERE TOO, and harder — a landing page that
 * overpromises loses a trial; a deck that overpromises loses a deal at diligence. Every number
 * below is either a property of the code or is explicitly labelled as a target rather than a
 * result. Nothing here claims traction, revenue, or customers, because there aren't any to claim.
 *
 * WHO renders this: `App.tsx`'s `/pitch` (public, unauthenticated) route.
 */
import { motion } from "framer-motion";
import {
  ArrowRight,
  Building2,
  CircleDollarSign,
  FileCheck2,
  FlaskConical,
  Layers,
  Lock,
  Target,
  TrendingUp,
  Users,
  Workflow
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { ScreenshotFrame } from "../components/marketing/ScreenshotFrame";

/** Who this is for, and what specifically hurts for them today. */
const AUDIENCES = [
  {
    icon: Building2,
    who: "Software consultancies and agencies",
    pain: "Bill by the hour against work a client can dispute. Reconciling a ticket tracker with a timesheet tool before every invoice is manual, slow, and the two never quite agree.",
    fit: "One record for both, and an attestation PDF the client can verify without an account."
  },
  {
    icon: Users,
    who: "In-house engineering teams with compliance load",
    pain: "Auditors want to know who approved what and when. Security findings live in a scanner nobody reads. AI tools are banned because nobody can answer what they send where.",
    fit: "Tamper-evident audit log, findings that become owned tickets, and an AI layer that runs on the team's own key under a hard budget."
  },
  {
    icon: Layers,
    who: "Managed service and staff-augmentation firms",
    pain: "Dozens of client organizations, each wanting isolation, their own SSO, and their own limits — usually answered with 'we filter by tenant ID, trust us'.",
    fit: "A physically separate database per organization, per-org SSO configuration, and seat and spend ceilings enforced on every request."
  }
];

/** What makes this hard to copy. Each entry is a property of the build, not a marketing angle. */
const MOATS = [
  {
    icon: FileCheck2,
    title: "Proof as a first-class output",
    body: "Most tools stop at reporting. This one produces a signed, page-numbered attestation of approved, identity-verified work — with the rate that applied at approval frozen into the record, so a rate change next quarter can't rewrite last quarter's invoice.",
    why: "Competitors would need identity verification, approval workflow and rate history to exist together before they could ship the artefact at all."
  },
  {
    icon: FlaskConical,
    title: "An AI loop that closes",
    body: "Capture what the model was asked and answered, correct real failures into a golden set, version prompts without a deploy, then replay and score. Most products stop at 'we added AI' and collect thumbs-up ratings nothing ever reads.",
    why: "This is infrastructure, not a feature. It's the difference between an AI that's demoed once and one that measurably improves in production."
  },
  {
    icon: Lock,
    title: "Bring-your-own-key as the default",
    body: "Nineteen AI capabilities, every one off until switched on, all running against the customer's own provider key under a budget the product enforces per call. We never resell inference.",
    why: "It removes the single most common blocker to AI adoption in a regulated buyer: 'where does our data go, and what will this cost?' Both answers are the customer's own."
  },
  {
    icon: Building2,
    title: "Isolation you can point at",
    body: "A database per organization, not a shared table with a tenant column. There is no query to get wrong, because there is no shared connection for one to cross.",
    why: "It's an architecture decision that's expensive to retrofit. Anyone starting from a shared schema has to rebuild their data layer to match this claim."
  }
];

/** Revenue model. Deliberately explicit about what is NOT charged for. */
const REVENUE = [
  {
    label: "Per-seat subscription",
    detail: "$8 per seat per month on Team; Starter is free to ten users; Enterprise is annual and negotiated. Seat limits are enforced live, so growth converts rather than leaking.",
    tone: "Primary"
  },
  {
    label: "Enterprise tier",
    detail: "Dedicated database, SAML and SSO-only mode, adjustable seat and AI-budget ceilings, support with an uptime SLA. This is where compliance-heavy buyers land.",
    tone: "Expansion"
  },
  {
    label: "Not charged: AI usage",
    detail: "Customers bring their own provider key and pay that provider directly. Refusing the inference markup removes the objection that kills most AI upsells, and keeps our margin independent of token prices.",
    tone: "Deliberate"
  }
];

/** Where the product goes next. Labelled as intent, never as shipped. */
const NEXT = [
  {
    title: "Retrieval for Ask AI",
    body: "Today Ask AI stuffs the 150 most recently updated tickets into the prompt and never uses the question to choose which ones. Ticket 151 is invisible, and no amount of prompt tuning fixes that — it needs real retrieval.",
    status: "Scoped, not started"
  },
  {
    title: "Evaluation-gated prompt rollout",
    body: "The pieces exist: golden sets, prompt versions, and a scoring runner. The next step is refusing to activate a prompt version that scores worse than the one it replaces.",
    status: "Next"
  },
  {
    title: "Deeper billing surface",
    body: "Rate snapshots and cost analytics are in. Invoicing on top of attestations is the obvious extension, and the record it would bill from already exists.",
    status: "Under consideration"
  }
];

export function PitchDeck() {
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <nav className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl print:hidden">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <Link to="/" className="flex min-w-0 items-center gap-3 font-bold">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">T</span>
            <span className="truncate">TimeSphere</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Link to="/" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground sm:inline">
              Product
            </Link>
            <Button asChild size="sm">
              <Link to="/login">Sign in <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </div>
      </nav>

      {/* ---------------------------------------------------------- 01 Cover */}
      <Slide number="01" label="The pitch">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <Badge variant="info" className="w-fit">Enterprise timesheets, ticketing &amp; governed AI</Badge>
          <h1 className="mt-5 max-w-4xl text-3xl font-black leading-tight tracking-tight sm:text-5xl">
            {/* Two-stop ramp for the same reason as Landing's hero — see the comment there. */}
            The work happened. <span className="bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">Prove it.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-muted-foreground">
            TimeSphere is one system for the hours a team logs, the tickets that work belongs to, and the evidence a
            client or auditor asks for afterwards — with an AI layer that runs on your own key, under your own budget,
            and can be measured rather than trusted.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ["One record", "Hours and tickets are the same rows — nothing to reconcile."],
              ["One control surface", "Every AI capability, its budget, and its measured quality on one screen."],
              ["One database per customer", "Isolation as architecture, not as a WHERE clause."]
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border border-border bg-card p-4">
                <p className="text-sm font-bold">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </Slide>

      {/* ---------------------------------------------------------- 02 Problem */}
      <Slide number="02" label="The problem" tinted>
        <SlideTitle icon={Target} title="Teams run two systems and reconcile them by hand" />
        <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-center">
          <div className="grid gap-4">
            <Point
              title="The numbers disagree"
              body="A ticket gets closed in one tool; the time lands against something else in the other. Before every invoice somebody exports both and argues with a spreadsheet."
            />
            <Point
              title="Proof is an assertion"
              body="Asked to justify an invoice, most teams produce a CSV they generated themselves. It proves nothing a client couldn't have written."
            />
            <Point
              title="AI is banned or ungoverned"
              body="Either it's blocked because nobody can answer where the data goes, or it's on with no budget, no audit, and no way to tell whether it's any good."
            />
            <Point
              title="Isolation is a promise"
              body="Most multi-tenant SaaS filters a shared table by tenant ID. One missing WHERE clause is a cross-customer breach, and buyers have learned to ask."
            />
          </div>
          <ScreenshotFrame
            src="/product/insights.png"
            alt="The Insights dashboard: velocity, SLA compliance, cycle-time distribution and workload."
            caption="Analytics computed from the same rows the approvals ran against."
          />
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 03 Audience */}
      <Slide number="03" label="Who it's for">
        <SlideTitle icon={Users} title="Three buyers, one shared shape" />
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
          All three bill or account for time against work someone else will scrutinise. That's the wedge.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {AUDIENCES.map((item) => (
            <Card key={item.who} className="h-full">
              <CardHeader className="pb-3">
                <item.icon className="h-5 w-5 text-primary" />
                <CardTitle className="mt-2 text-base">{item.who}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Today</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.pain}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-primary">With TimeSphere</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.fit}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 04 Product */}
      <Slide number="04" label="The product" tinted>
        <SlideTitle icon={Workflow} title="Report → triage → approve → escalate → analyze → prove" />
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
          Six stages, one dataset. The last one is the one competitors don't have.
        </p>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <ScreenshotFrame src="/product/tickets.png" alt="The Tickets list with intake and AI review badges." caption="Tickets, already triaged and routed." />
          <ScreenshotFrame src="/product/dashboard.png" alt="The dashboard with weekly hours, daily rhythm and a day timeline." caption="A dashboard that changes shape by role." />
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 05 Moat */}
      <Slide number="05" label="Why it's hard to copy">
        <SlideTitle icon={Lock} title="Four things that aren't a weekend's work" />
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          {MOATS.map((item) => (
            <Card key={item.title} className="h-full">
              <CardHeader className="pb-3">
                <item.icon className="h-5 w-5 text-primary" />
                <CardTitle className="mt-2 text-base">{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
                <p className="mt-3 border-l-2 border-primary/40 pl-3 text-sm leading-6">
                  <span className="font-semibold">Why it holds: </span>
                  <span className="text-muted-foreground">{item.why}</span>
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 06 AI */}
      <Slide number="06" label="The AI position" tinted>
        <SlideTitle icon={FlaskConical} title="Everyone added AI. Almost nobody can tell you if it works." />
        <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-center">
          <div className="grid gap-4">
            <Point
              title="The industry default"
              body="Ship a feature, collect thumbs up and down, read none of it. Feedback becomes a column nothing queries — we know, because that's exactly what this product did before the loop was built."
            />
            <Point
              title="What we do instead"
              body="Record what the model was asked and answered. Turn real failures into ground truth. Change prompts without a deploy. Replay the set and score it. A prompt change becomes a number, not an opinion."
            />
            <Point
              title="The safety property"
              body="A bad prompt cannot break a feature. The runtime falls back to the built-in one and records that it fell back — so the failure is visible instead of silent."
            />
          </div>
          <ScreenshotFrame
            src="/product/settings-ai.png"
            alt="The AI tab of Workspace Settings, showing provider configuration, capability toggles, budget and the quality cards."
            caption="One screen: provider, budget, every toggle, and measured quality."
          />
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 07 Revenue */}
      <Slide number="07" label="How it makes money">
        <SlideTitle icon={CircleDollarSign} title="Per seat, with the AI markup deliberately left on the table" />
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {REVENUE.map((item) => (
            <Card key={item.label} className="h-full">
              <CardHeader className="pb-3">
                <Badge variant={item.tone === "Primary" ? "default" : item.tone === "Expansion" ? "info" : "muted"} className="w-fit">
                  {item.tone}
                </Badge>
                <CardTitle className="mt-2 text-base">{item.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{item.detail}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/30 p-5">
          <p className="text-sm leading-7 text-muted-foreground">
            <span className="font-semibold text-foreground">The expansion path is structural, not promotional.</span> A team
            starts free, hits the ten-seat ceiling, and moves to Team — the limit is enforced on every request, so growth
            converts on its own. Compliance requirements, not a sales cycle, are what pull an account to Enterprise: SAML,
            SSO-only, and a dedicated database are the things a security review asks for by name.
          </p>
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 08 Roadmap */}
      <Slide number="08" label="What's next" tinted>
        <SlideTitle icon={TrendingUp} title="Three things, honestly labelled" />
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
          None of these is shipped. They're listed as intent so nobody mistakes them for the product.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {NEXT.map((item) => (
            <Card key={item.title} className="h-full">
              <CardHeader className="pb-3">
                <Badge variant="warning" className="w-fit">{item.status}</Badge>
                <CardTitle className="mt-2 text-base">{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Slide>

      {/* ---------------------------------------------------------- 09 Close */}
      <section className="border-t border-border bg-gradient-to-br from-primary via-info to-accent">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center text-primary-foreground sm:px-5">
          <p className="text-xs font-bold uppercase tracking-[0.2em] opacity-80">09 — In one line</p>
          <h2 className="mt-4 text-2xl font-black leading-tight tracking-tight sm:text-4xl">
            The only timesheet system whose output a client can verify — and whose AI you can prove is getting better.
          </h2>
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
              <Link to="/">Back to the product page</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-5">
          <div className="flex items-center gap-2 font-bold text-foreground">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs text-primary-foreground">T</span>
            TimeSphere
          </div>
          <p className="text-xs">
            Every claim on this page maps to shipped code. Anything not yet built is labelled as intent.
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Slide primitives. Local to this page — the numbered-slide framing is
 * specific to the deck and shouldn't leak into the app's design system.
 * ------------------------------------------------------------------ */

function Slide({
  number,
  label,
  tinted = false,
  children
}: {
  number: string;
  label: string;
  tinted?: boolean;
  children: ReactNode;
}) {
  return (
    // break-inside-avoid keeps a slide from being split across two sheets when someone prints the
    // deck, which is the most likely way it reaches a meeting room.
    <section className={`break-inside-avoid border-b border-border ${tinted ? "bg-muted/30" : ""}`}>
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-5 sm:py-20">
        <p className="mb-6 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-primary">
          <span className="tabular-nums">{number}</span>
          <span aria-hidden className="h-px w-8 bg-primary/40" />
          <span className="text-muted-foreground">{label}</span>
        </p>
        {children}
      </div>
    </section>
  );
}

function SlideTitle({ icon: Icon, title }: { icon: typeof Target; title: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <h2 className="text-2xl font-black leading-tight tracking-tight sm:text-3xl">{title}</h2>
    </div>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}
