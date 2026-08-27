/**
 * WHAT: the pitch — a standalone public page at `/pitch` that explains what TimeSphere is, who
 * it's for, why it exists, how it makes money, where it runs, and what makes it hard to copy.
 * Structured as numbered slides so it reads top-to-bottom in a browser and also survives being
 * printed or screen-shared in a meeting.
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
 * WHY SLIDE NUMBERS AND COUNTS ARE DERIVED: the previous version had a slide headed "Four things
 * that aren't a weekend's work" above a list of five, and "Three things, honestly labelled" above
 * a list of four. In a document whose entire pitch is "we don't overstate", a headline that can't
 * count is the most expensive kind of small error. Numbers now come from `SLIDES` and from the
 * arrays themselves, so they cannot drift again.
 *
 * WHO renders this: `App.tsx`'s `/pitch` (public, unauthenticated) route.
 */
import {
  ArrowRight,
  Bot,
  Building2,
  CircleDollarSign,
  FileCheck2,
  FlaskConical,
  GanttChartSquare,
  Layers,
  Lock,
  ServerCog,
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
import { Reveal, useScrollProgress, useSectionSpy } from "../components/marketing/Reveal";
import { ScreenshotFrame } from "../components/marketing/ScreenshotFrame";
import { AuthorityLadder } from "../components/marketing/AuthorityLadder";
import { AuroraBackdrop } from "../components/marketing/AuroraBackdrop";
import { handleSpotlight } from "../components/marketing/spotlight";

/**
 * The running order. It drives the slide numbers, the jump-to navigation and the scroll-spy, so
 * inserting a slide is one edit rather than four.
 *
 * `nav` is short on purpose: the full labels total wider than the content column, which left the
 * rail permanently mid-scroll on a desktop — reading as clipped rather than as scrollable. The
 * long form still heads each slide, where there is room for it.
 */
const SLIDES = [
  { id: "cover", label: "The pitch", nav: "Pitch" },
  { id: "problem", label: "The problem", nav: "Problem" },
  { id: "audience", label: "Who it's for", nav: "Audience" },
  { id: "product", label: "The product", nav: "Product" },
  { id: "deployment", label: "Where it runs", nav: "Hosting" },
  { id: "moat", label: "Why it's hard to copy", nav: "Moat" },
  { id: "ai", label: "The AI position", nav: "AI" },
  { id: "agentic", label: "The agentic layer", nav: "Teammates" },
  { id: "revenue", label: "How it makes money", nav: "Revenue" },
  { id: "next", label: "What's next", nav: "Next" },
  { id: "close", label: "In one line", nav: "One line" }
] as const;

type SlideId = (typeof SLIDES)[number]["id"];

/** "01", "02"… Position in `SLIDES` is the single source of a slide's number. */
const slideNumber = (id: SlideId) => String(SLIDES.findIndex((slide) => slide.id === id) + 1).padStart(2, "0");

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
    icon: GanttChartSquare,
    title: "The only planner that can measure itself",
    body: "Every project tool in this category compares a plan against another plan, because estimates are the only thing it holds. This one owns the approved, rate-snapshotted timesheet too — so the workload board puts planned hours, actually-logged hours and contracted capacity on one axis, and a budget forecast is priced from the same rates a client-facing attestation reads.",
    why: "A planning vendor cannot bolt this on: they would need timesheet capture, an approval chain and rate history in production first. A timesheet vendor has the data and no plan to compare it against. The fusion is the product, and it is only available to whoever owns both halves."
  },
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
    body: "Every AI capability is off until switched on, and all of them run against the customer's own provider key under a budget the product enforces per call. We never resell inference.",
    why: "It removes the single most common blocker to AI adoption in a regulated buyer: 'where does our data go, and what will this cost?' Both answers are the customer's own."
  },
  {
    icon: Building2,
    title: "Isolation you can point at",
    body: "A database per organization, not a shared table with a tenant column. There is no query to get wrong, because there is no shared connection for one to cross.",
    why: "It's an architecture decision that's expensive to retrofit. Anyone starting from a shared schema has to rebuild their data layer to match this claim."
  },
  {
    icon: Workflow,
    title: "An agentic layer that adds no new power",
    body: "Teammates and flows compose capabilities that already exist, under the same review, undo and audit path as every other AI change. Switching one on grants nothing new — it only names who runs what, at what budget, with what authority.",
    why: "Most products bolt agents on as a second write-path with its own permissions to audit. Composition means the security review done once covers the agents too — and the same provenance chain explains every run."
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
    detail: "Dedicated database, SAML and SSO-only mode, capacity planning, custom workflows, the AI copilot, adjustable seat and AI-budget ceilings, support with an uptime SLA. This is where compliance-heavy buyers land.",
    tone: "Expansion"
  },
  {
    label: "Not charged: AI usage",
    detail: "Customers bring their own provider key and pay that provider directly. Refusing the inference markup removes the objection that kills most AI upsells, and keeps our margin independent of token prices.",
    tone: "Deliberate"
  }
];

/** What ships in the box today, as a spread rather than a wall of bullets. */
const SURFACES = [
  { title: "Plan", body: "Gantt with four dependency types, baselines, critical path, portfolios, capacity, budgets, and a risk score from six measured signals." },
  { title: "Track", body: "Timesheets and Jira-style ticketing on the same rows, with saved views, custom fields and admin-defined workflows." },
  { title: "Intake", body: "Email, Slack, Teams, Google Chat, Telegram and public request forms — all landing as routed, prioritized tickets." },
  { title: "Connect", body: "GitHub repo, branch and PR pickers; webhooks from GitLab, Bitbucket, Gitea, Forgejo and Azure DevOps; an optional CI gate on Resolved." },
  { title: "Report", body: "Insights, a 22-column CSV, a real Excel workbook, and dashboards scheduled to people with no account — with one date filter driving every card on the home page, compared against the previous equal-length period." },
  { title: "Prove", body: "Approved, identity-verified work as a signed attestation PDF, shareable by link, priced from the rate that applied at approval." },
  { title: "Brief", body: "A weekly leadership update nobody fills in: products, POCs, bugs, security and training, each initiative carrying an owner, an arithmetic status colour and what moved — counted from this workspace, drafted around the figures, reviewed before it sends." },
  { title: "Specify", body: "An AI interview turns an idea, or a PRD the client already wrote, into a structured requirements document — and then into the tickets and goals that build it." },
  { title: "Govern", body: "Change management with risk derived from impact × likelihood, the workspace's own approval chain, and a register that reports its own change-failure rate and approval turnaround." },
  { title: "Automate", body: "Named AI teammates and reviewable flows — assembled from capabilities the workspace already runs, propose-by-default, priced per run on the same ledger as human work." }
];

/** Deployment posture. All of it is a property of the repository, not a plan. */
const DEPLOYMENT = [
  {
    title: "One codebase, two shapes",
    body: "A single-organization on-premise install is the same code as multi-organization SaaS, with the tenant count set to one — not a stripped fork that drifts behind the hosted build."
  },
  {
    title: "Nothing calls home",
    body: "Your AI provider key, your GitHub OAuth app, your Google and Microsoft clients, your database. No vendor-operated model client ever sits between a customer and their data."
  },
  {
    title: "Ships the way ops expects",
    body: "A one-command installer, Docker Compose with overlays for an external database and HTTPS, and a Helm chart with autoscaling. Air-gapped installs read release notes from the bundled changelog."
  }
];

/** Where the product goes next. Labelled as intent, never as shipped. */
const NEXT = [
  {
    title: "Ambient identity verification",
    body: "Face checks are hands-free inside the dialog today — the camera starts itself, captures at the best frame, and the liveness challenge fires on the movement. Continuous background scanning is the obvious next step and is deliberately not built: a camera running unprompted during ordinary work is a different consent posture, and that is a customer's decision to opt into rather than ours to assume.",
    status: "Deliberately gated on consent design"
  },
  {
    title: "Retrieval for Ask AI",
    body: "Today Ask AI stuffs the most recently updated tickets into the prompt and never uses the question to choose which ones. A ticket outside that window is invisible, and no amount of prompt tuning fixes that — it needs real retrieval.",
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
  const active = useSectionSpy(SLIDES.map((slide) => slide.id));
  const progress = useScrollProgress();

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-xl print:hidden">
        <nav aria-label="Primary" className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-4">
          <Link to="/" className="focus-ring flex min-w-0 items-center gap-3 rounded-md font-bold">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">T</span>
            <span className="truncate">TimeSphere</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/"
              className="focus-ring hidden rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground sm:inline"
            >
              Product
            </Link>
            <Button asChild size="sm">
              <Link to="/login">Sign in <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </nav>

        {/* The deck's table of contents. It scrolls INSIDE its own container rather than wrapping,
            so ten slides read as one continuous rail at every width and the page itself never
            gains a horizontal scrollbar. */}
        <nav aria-label="Slides" className="border-t border-border/70">
          <ul className="scrollbar-thin mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 py-2 sm:px-5">
            {SLIDES.map((slide) => (
              <li key={slide.id}>
                <a
                  href={`#${slide.id}`}
                  aria-current={active === slide.id ? "true" : undefined}
                  className={`focus-ring inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    active === slide.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <span className="tabular-nums opacity-70">{slideNumber(slide.id)}</span>
                  {slide.nav}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5">
          <div className="h-full origin-left bg-primary" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </header>

      <main>
        {/* -------------------------------------------------------- Cover */}
        <Slide id="cover" backdrop>
          <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700">
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
              ].map(([title, body], index) => (
                <div
                  key={title}
                  style={{ animationDelay: `${150 + index * 90}ms` }}
                  className="rounded-xl border border-border bg-card p-4 transition motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-backwards motion-safe:hover:-translate-y-1"
                >
                  <p className="text-sm font-bold">{title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </Slide>

        {/* -------------------------------------------------------- Problem */}
        <Slide id="problem" tinted>
          <Reveal>
            <SlideTitle icon={Target} title="Teams run two systems and reconcile them by hand" />
          </Reveal>
          <div className="mt-6 grid gap-8 lg:grid-cols-2 lg:items-center">
            <div className="grid gap-4">
              {[
                ["The numbers disagree", "A ticket gets closed in one tool; the time lands against something else in the other. Before every invoice somebody exports both and argues with a spreadsheet."],
                ["Proof is an assertion", "Asked to justify an invoice, most teams produce a CSV they generated themselves. It proves nothing a client couldn't have written."],
                ["AI is banned or ungoverned", "Either it's blocked because nobody can answer where the data goes, or it's on with no budget, no audit, and no way to tell whether it's any good."],
                ["Isolation is a promise", "Most multi-tenant SaaS filters a shared table by tenant ID. One missing WHERE clause is a cross-customer breach, and buyers have learned to ask."]
              ].map(([title, body], index) => (
                <Reveal key={title} delay={index * 70}>
                  <Point title={title} body={body} />
                </Reveal>
              ))}
            </div>
            <Reveal delay={120}>
              <ScreenshotFrame
                src="/product/insights.png"
                alt="The Insights dashboard: velocity, SLA compliance, cycle-time distribution and workload."
                caption="Analytics computed from the same rows the approvals ran against."
              />
            </Reveal>
          </div>
        </Slide>

        {/* -------------------------------------------------------- Audience */}
        <Slide id="audience">
          <Reveal>
            <SlideTitle icon={Users} title="Three buyers, one shared shape" />
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              All three bill or account for time against work someone else will scrutinise. That's the wedge.
            </p>
          </Reveal>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {AUDIENCES.map((item, index) => (
              <Reveal key={item.who} delay={index * 80} className="h-full">
                <Card className="h-full transition hover:border-primary/40 hover:shadow-lg motion-safe:hover:-translate-y-1">
                  <CardHeader className="pb-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
                      <item.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <CardTitle className="mt-3 text-base">{item.who}</CardTitle>
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
              </Reveal>
            ))}
          </div>
        </Slide>

        {/* -------------------------------------------------------- Product */}
        <Slide id="product" tinted>
          <Reveal>
            <SlideTitle icon={Workflow} title="Report → triage → approve → escalate → analyze → prove" />
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              Six stages, one dataset — and the last one is the one competitors don't have. Below is what ships in
              the box today: {SURFACES.length} surfaces, all of them reading and writing the same rows.
            </p>
          </Reveal>
          {/* The count above is derived for the reason this file's header gives: a deck that claims
              "we don't overstate" cannot afford a headline that miscounts the list under it. */}
          <div onPointerMove={handleSpotlight} className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACES.map((surface, index) => (
              <Reveal key={surface.title} delay={index * 60} className="h-full">
                <div className="spotlight-card h-full overflow-hidden rounded-xl border border-border bg-card p-4 transition hover:border-primary/40 motion-safe:hover:-translate-y-1">
                  <p className="text-xs font-bold uppercase tracking-wider text-primary">{surface.title}</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{surface.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Reveal>
              <ScreenshotFrame src="/product/tickets.png" alt="The Tickets list with intake and AI review badges." caption="Tickets, already triaged and routed." />
            </Reveal>
            <Reveal delay={90}>
              <ScreenshotFrame src="/product/dashboard.png" alt="The dashboard with weekly hours, daily rhythm and a day timeline." caption="A dashboard that changes shape by role." />
            </Reveal>
            {/* The last stage of the six, given its own row: it is the one the paragraph above
                claims competitors do not have, and a claim like that is better shown than asserted. */}
            <Reveal>
              <ScreenshotFrame
                src="/product/practice-update.png"
                alt="The weekly practice update: counted figures for the week, then initiative tables for products, POCs and training with owners and status colours, over editable written sections."
                caption="The weekly leadership update — counted, then drafted, then reviewed."
              />
            </Reveal>
            <Reveal delay={90}>
              <ScreenshotFrame
                src="/product/changes.png"
                alt="The change management register with in-flight and high-risk counts, change failure rate, approval turnaround, and a twelve-week raised-against-closed chart."
                caption="A change register that reports on itself."
              />
            </Reveal>
          </div>
        </Slide>

        {/* -------------------------------------------------------- Deployment */}
        <Slide id="deployment">
          <Reveal>
            <SlideTitle icon={ServerCog} title="It runs on their infrastructure, or on ours" />
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              The buyers most likely to pay for proof are the ones least likely to accept a black box. Self-hosting is
              not a concession here; it's the same build.
            </p>
          </Reveal>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {DEPLOYMENT.map((item, index) => (
              <Reveal key={item.title} delay={index * 80} className="h-full">
                <Card className="h-full transition hover:border-primary/40 hover:shadow-lg motion-safe:hover:-translate-y-1">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{item.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Slide>

        {/* -------------------------------------------------------- Moat */}
        <Slide id="moat" tinted>
          <Reveal>
            <SlideTitle icon={Lock} title={`${MOATS.length} things that aren't a weekend's work`} />
          </Reveal>
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            {MOATS.map((item, index) => (
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
                    <p className="mt-3 border-l-2 border-primary/40 pl-3 text-sm leading-6">
                      <span className="font-semibold">Why it holds: </span>
                      <span className="text-muted-foreground">{item.why}</span>
                    </p>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Slide>

        {/* -------------------------------------------------------- AI */}
        <Slide id="ai">
          <Reveal>
            <SlideTitle icon={FlaskConical} title="Everyone added AI. Almost nobody can tell you if it works." />
          </Reveal>
          <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-center">
            <div className="grid gap-4">
              {[
                ["The industry default", "Ship a feature, collect thumbs up and down, read none of it. Feedback becomes a column nothing queries — we know, because that's exactly what this product did before the loop was built."],
                ["What we do instead", "Record what the model was asked and answered. Turn real failures into ground truth. Change prompts without a deploy. Replay the set and score it. A prompt change becomes a number, not an opinion."],
                ["The safety property", "A bad prompt cannot break a feature. The runtime falls back to the built-in one and records that it fell back — so the failure is visible instead of silent."]
              ].map(([title, body], index) => (
                <Reveal key={title} delay={index * 70}>
                  <Point title={title} body={body} />
                </Reveal>
              ))}
            </div>
            <Reveal delay={120}>
              <ScreenshotFrame
                src="/product/settings-ai.png"
                alt="The AI tab of Workspace Settings, showing provider configuration, capability toggles, budget and the quality cards."
                caption="One screen: provider, budget, every toggle, and measured quality."
              />
            </Reveal>
          </div>
        </Slide>

        {/* -------------------------------------------------------- Agentic */}
        <Slide id="agentic" tinted>
          <Reveal>
            <SlideTitle icon={Bot} title="AI teammates you can name, scope, and switch off" />
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              Six ready teammates — Triage, Planner, Risk watch, Security desk, Reporter, Load balancer — assembled only
              from capabilities this workspace already runs. Adding one grants no new power, and every one arrives off.
            </p>
          </Reveal>
          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div className="grid gap-4">
              {[
                ["No seat, no mailbox, no exceptions", "A teammate has its own identity in the audit trail and can be assigned work like anyone else. It holds no paid seat, cannot sign in, and its address sits on a domain reserved never to resolve — so no digest can be posted to it."],
                ["Exactly one owner per capability", "Switching a teammate on is refused if another already covers something in its bundle, and the refusal names it. \u201cWhich teammate does this?\u201d always has exactly one answer."],
                ["Flows you can read, replay, and refuse", "The Workflow Studio writes automation as a list you review top to bottom. Replay against your own recent triggers calls no model and writes nothing; a flow with a problem cannot be switched on, and the reason is quoted."],
                ["Priced on the same ledger as human work", "Each card shows today's spend against its own daily ceiling, under your monthly budget and the platform cap — plus its recent runs: status, trigger, step count, and whether it was clamped."]
              ].map(([title, body], index) => (
                <Reveal key={title} delay={index * 70}>
                  <Point title={title} body={body} />
                </Reveal>
              ))}
            </div>
            <Reveal delay={120}>
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs font-bold uppercase tracking-wider text-primary">The authority ladder</p>
                <AuthorityLadder className="mt-4 w-full" />
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  A flow can never do more than its most restricted step — and the card names that step.
                </p>
              </div>
            </Reveal>
          </div>
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Reveal>
              <ScreenshotFrame
                src="/product/agents.png"
                alt="The AI teammates roster with six named teammates, their capabilities, runs and spend."
                caption="The roster — each card is the whole truth about one teammate."
              />
            </Reveal>
            <Reveal delay={90}>
              <ScreenshotFrame
                src="/product/studio.png"
                alt="The Workflow Studio: a flow's authority banner and a quoted reason why it cannot be switched on."
                caption="A flow that cannot go live says why — the gate is the feature."
              />
            </Reveal>
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {[
              ["Goals that measure themselves", "Wire an objective to approved hours, billed spend, tickets closed, on-time rate, SLA escalations or project risk — progress reports itself, an override keeps the receipt, and \u201cno data yet\u201d is words, never 0%."],
              ["An Inbox, and a brief that counts", "Notifications become a queue: done, snooze, and a snoozed item comes back on its own. Today's brief is counted from the same definitions the pages behind it use — nothing in it is generated."]
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border border-border bg-card p-4 transition hover:border-primary/40">
                <p className="text-xs font-bold uppercase tracking-wider text-primary">{title}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </Slide>

        {/* -------------------------------------------------------- Revenue */}
        <Slide id="revenue" tinted>
          <Reveal>
            <SlideTitle icon={CircleDollarSign} title="Per seat, with the AI markup deliberately left on the table" />
          </Reveal>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {REVENUE.map((item, index) => (
              <Reveal key={item.label} delay={index * 80} className="h-full">
                <Card className="h-full transition hover:border-primary/40 hover:shadow-lg motion-safe:hover:-translate-y-1">
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
              </Reveal>
            ))}
          </div>
          <Reveal delay={100}>
            <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/30 p-5">
              <p className="text-sm leading-7 text-muted-foreground">
                <span className="font-semibold text-foreground">The expansion path is structural, not promotional.</span> A team
                starts free, hits the ten-seat ceiling, and moves to Team — the limit is enforced on every request, so growth
                converts on its own. Compliance requirements, not a sales cycle, are what pull an account to Enterprise: SAML,
                SSO-only, and a dedicated database are the things a security review asks for by name.
              </p>
            </div>
          </Reveal>
        </Slide>

        {/* -------------------------------------------------------- Roadmap */}
        <Slide id="next">
          <Reveal>
            <SlideTitle icon={TrendingUp} title={`${NEXT.length} things, honestly labelled`} />
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              None of these is shipped. They're listed as intent so nobody mistakes them for the product.
            </p>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {NEXT.map((item, index) => (
              <Reveal key={item.title} delay={index * 70} className="h-full">
                <Card className="h-full transition hover:border-warning/50 motion-safe:hover:-translate-y-1">
                  <CardHeader className="pb-3">
                    <Badge variant="warning" className="w-fit">{item.status}</Badge>
                    <CardTitle className="mt-2 text-base">{item.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Slide>

        {/* -------------------------------------------------------- Close */}
        <section id="close" className="scroll-mt-32 break-inside-avoid border-t border-border bg-gradient-to-br from-primary via-info to-accent">
          <div className="mx-auto max-w-4xl px-4 py-16 text-center text-primary-foreground sm:px-5">
            <p className="text-xs font-bold uppercase tracking-[0.2em] opacity-80">{slideNumber("close")} — In one line</p>
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
      </main>

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
  id,
  tinted = false,
  backdrop = false,
  children
}: {
  id: SlideId;
  tinted?: boolean;
  /**
   * Mounts the animated aurora behind this slide. The COVER only, deliberately: this page is
   * printed and screen-shared as often as it is scrolled, and a moving field behind twelve slides
   * of dense argument is a distraction rather than a design. One at the top sets the tone.
   */
  backdrop?: boolean;
  children: ReactNode;
}) {
  const meta = SLIDES.find((slide) => slide.id === id);
  return (
    // break-inside-avoid keeps a slide from being split across two sheets when someone prints the
    // deck, which is the most likely way it reaches a meeting room. scroll-mt-32 clears BOTH sticky
    // rows of the header — the brand bar and the slide rail — so a jump link doesn't land with the
    // slide's own number hidden underneath them.
    //
    // `isolate` scopes the backdrop's negative z-index to this section. Without it the browser
    // resolves `-z-10` against the ROOT stacking context and the page wrapper's own background
    // paints straight over it — see the note in Landing.tsx's hero, where that cost two blurred
    // orbs that had never once been visible.
    <section
      id={id}
      className={`relative isolate scroll-mt-32 break-inside-avoid overflow-hidden border-b border-border ${tinted ? "bg-muted/30" : ""}`}
    >
      {backdrop && (
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute -left-32 -top-24 h-[26rem] w-[26rem] rounded-full bg-primary/15 blur-3xl" />
          <div className="absolute -right-24 top-0 h-[26rem] w-[26rem] rounded-full bg-info/15 blur-3xl" />
          <AuroraBackdrop className="absolute inset-0" intensity={0.75} />
        </div>
      )}
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-5 sm:py-20">
        <p className="mb-6 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-primary">
          <span className="tabular-nums">{slideNumber(id)}</span>
          <span aria-hidden className="h-px w-8 bg-primary/40" />
          <span className="text-muted-foreground">{meta?.label}</span>
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
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="text-2xl font-black leading-tight tracking-tight sm:text-3xl">{title}</h2>
    </div>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 transition hover:border-primary/40">
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}
