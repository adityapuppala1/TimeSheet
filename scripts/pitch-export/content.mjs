/**
 * The pitch deck's narrative, as data, for the two exporters beside this file.
 *
 * WHY THIS IS A SECOND COPY OF THE DECK'S WORDS, and what stops it rotting.
 *
 * `apps/web/src/pages/PitchDeck.tsx` holds its content inside JSX, mixed with lucide icon
 * components and Tailwind classes. A Node script cannot import that without dragging React and the
 * whole web build in, so the exports need the text in a plain form. The honest options were: leave
 * the exports out of the repo (then they go stale the first time anyone edits the deck), refactor
 * seven data arrays out of a 700-line page (a large change to a file this session has already
 * touched a lot), or duplicate the text with a guard.
 *
 * This is the third, and the guard is real: `tests/unit/pitch-export.test.ts` reads PitchDeck.tsx's
 * own `SLIDES` array out of the source and fails if any slide there has no section here. Adding a
 * slide to the deck therefore breaks the build until the exports learn about it — which is the
 * failure mode that actually matters. It does NOT catch a reworded paragraph; nothing short of the
 * refactor would, and that is stated here rather than implied by silence.
 *
 * If this file and the page drift far enough that the guard is not enough, the fix is to hoist the
 * seven arrays into `packages/shared` and have both read them. That is the right end state; this is
 * the version that ships today with its own limitation written down.
 */

export const DECK = {
  title: "TimeSphere",
  tagline: "Enterprise timesheets, ticketing & governed AI",
  headline: "The work happened. Prove it.",
  standfirst:
    "TimeSphere is one system for the hours a team logs, the tickets that work belongs to, and the evidence a client or auditor asks for afterwards — with an AI layer that runs on your own key, under your own budget, and can be measured rather than trusted.",
  pillars: [
    ["One record", "Hours and tickets are the same rows — nothing to reconcile."],
    ["One control surface", "Every AI capability, its budget, and its measured quality on one screen."],
    ["One database per customer", "Isolation as architecture, not as a WHERE clause."]
  ]
};

/**
 * Keyed by the slide ids in PitchDeck.tsx's `SLIDES`. The test beside these scripts asserts the two
 * sets match, so a slide cannot exist on the page and be missing from the exports.
 */
export const SLIDES = [
  {
    id: "cover",
    label: "The pitch",
    title: "The work happened. Prove it.",
    kind: "cover",
    body: DECK.standfirst,
    points: DECK.pillars
  },
  {
    id: "problem",
    label: "The problem",
    title: "Teams run two systems and reconcile them by hand",
    image: "insights.png",
    imageCaption: "Analytics computed from the same rows the approvals ran against.",
    points: [
      ["The numbers disagree", "A ticket gets closed in one tool; the time lands against something else in the other. Before every invoice somebody exports both and argues with a spreadsheet."],
      ["Proof is an assertion", "Asked to justify an invoice, most teams produce a CSV they generated themselves. It proves nothing a client couldn't have written."],
      ["AI is banned or ungoverned", "Either it's blocked because nobody can answer where the data goes, or it's on with no budget, no audit, and no way to tell whether it's any good."],
      ["Isolation is a promise", "Most multi-tenant SaaS filters a shared table by tenant ID. One missing WHERE clause is a cross-customer breach, and buyers have learned to ask."]
    ]
  },
  {
    id: "audience",
    label: "Who it's for",
    title: "Three buyers, one shared shape",
    points: [
      ["Software consultancies and agencies", "Bill by the hour against work a client can dispute. Reconciling a ticket tracker with a timesheet tool before every invoice is manual, slow, and the two never quite agree. → One record for both, and an attestation PDF the client can verify without an account."],
      ["In-house engineering teams with compliance load", "Auditors want to know who approved what and when. Security findings live in a scanner nobody reads. AI tools are banned because nobody can answer what they send where. → Tamper-evident audit log, findings that become owned tickets, and an AI layer on the team's own key under a hard budget."],
      ["Managed service and staff-augmentation firms", "Dozens of client organizations, each wanting isolation, their own SSO, and their own limits — usually answered with 'we filter by tenant ID, trust us'. → A physically separate database per organization, per-org SSO, and seat and spend ceilings enforced on every request."]
    ]
  },
  {
    id: "market",
    label: "How big it is",
    title: "A $30B envelope, sized down to something defensible",
    kind: "market"
  },
  {
    id: "product",
    label: "The product",
    title: "Report → triage → approve → escalate → analyze → prove",
    image: "tickets.png",
    imageCaption: "Ticketing and timesheets on the same rows.",
    points: [
      ["Plan", "Gantt with four dependency types, baselines, critical path, portfolios, capacity, budgets, and a risk score from six measured signals."],
      ["Track", "Timesheets and Jira-style ticketing on the same rows, with saved views, custom fields and admin-defined workflows."],
      ["Intake", "Email, Slack, Teams, Google Chat, Telegram and public request forms — all landing as routed, prioritized tickets."],
      ["Connect", "GitHub repo, branch and PR pickers; webhooks from GitLab, Bitbucket, Gitea, Forgejo and Azure DevOps; an optional CI gate on Resolved."],
      ["Report", "Insights, a 22-column CSV, a real Excel workbook, and dashboards scheduled to people with no account."],
      ["Prove", "Approved, identity-verified work as a signed attestation PDF, shareable by link, priced from the rate that applied at approval."],
      ["Brief", "A weekly leadership update nobody fills in — counted from this workspace, drafted around the figures, reviewed before it sends."],
      ["Specify", "An AI interview turns an idea, or a PRD the client already wrote, into a structured requirements document — and then into tickets and goals."],
      ["Govern", "Change management with risk from impact × likelihood, the workspace's own approval chain, and a register reporting its own change-failure rate."],
      ["Automate", "Named AI teammates and reviewable flows — propose-by-default, priced per run on the same ledger as human work."]
    ]
  },
  {
    id: "deployment",
    label: "Where it runs",
    title: "It runs on their infrastructure, or on ours",
    points: [
      ["One codebase, two shapes", "A single-organization on-premise install is the same code as multi-organization SaaS, with the tenant count set to one — not a stripped fork that drifts behind the hosted build."],
      ["Nothing calls home", "Your AI provider key, your GitHub OAuth app, your Google and Microsoft clients, your database. No vendor-operated model client ever sits between a customer and their data."],
      ["Ships the way ops expects", "A one-command installer, Docker Compose with overlays for an external database and HTTPS, and a Helm chart with autoscaling. Air-gapped installs read release notes from the bundled changelog."]
    ]
  },
  {
    id: "moat",
    label: "Why it's hard to copy",
    title: "Six things that aren't a weekend's work",
    image: "studio.png",
    imageCaption: "Requirements Studio — an interview that becomes tickets and goals.",
    points: [
      ["The only planner that can measure itself", "Every project tool compares a plan against another plan, because estimates are all it holds. This one owns the approved, rate-snapshotted timesheet too. A planning vendor cannot bolt this on; a timesheet vendor has the data and no plan to compare it against."],
      ["Proof as a first-class output", "A signed, page-numbered attestation of approved, identity-verified work, with the rate that applied at approval frozen into the record. Competitors need identity verification, approval workflow and rate history to exist together before they can ship the artefact at all."],
      ["An AI loop that closes", "Capture what the model was asked and answered, correct real failures into a golden set, version prompts without a deploy, then replay and score. This is infrastructure, not a feature."],
      ["Bring-your-own-key as the default", "Every AI capability is off until switched on, and runs against the customer's own provider key under a budget the product enforces per call. We never resell inference."],
      ["Isolation you can point at", "A database per organization, not a shared table with a tenant column. There is no query to get wrong, because there is no shared connection for one to cross."],
      ["An agentic layer that adds no new power", "Teammates and flows compose capabilities that already exist, under the same review, undo and audit path. Switching one on grants nothing new — it only names who runs what, at what budget, with what authority."]
    ]
  },
  {
    id: "ai",
    label: "The AI position",
    title: "Everyone added AI. Almost nobody can tell you if it works.",
    image: "settings-ai.png",
    imageCaption: "One screen governs every model call: key, provider, budget, and a switch per capability.",
    points: [
      ["Your key, your provider, your ceiling", "Every capability is off until switched on, and all of them run against the customer's own key under a budget enforced per call."],
      ["The quality loop", "What the AI actually said, what a human said it should have said, and whether the last prompt change helped."],
      ["Never resold", "Customers pay their provider directly. Our margin does not move with token prices."]
    ]
  },
  {
    id: "agentic",
    label: "The agentic layer",
    title: "AI teammates you can name, scope, and switch off",
    image: "agents.png",
    imageCaption: "Named teammates, scoped to capabilities the workspace already runs.",
    points: [
      ["Composition, not new power", "A teammate can only do what the workspace already allows. Switching one on grants nothing new."],
      ["Propose by default", "Every change is a reviewable row you accept or reject individually. There is deliberately no apply-everything button."],
      ["Priced per run", "On the same ledger as human work, against the same budget."]
    ]
  },
  {
    id: "revenue",
    label: "How it makes money",
    title: "Per seat, with the AI markup deliberately left on the table",
    points: [
      ["Per-seat subscription (Primary)", "$8 per seat per month on Team; Starter is free to ten users; Enterprise is annual and negotiated. Seat limits are enforced live, so growth converts rather than leaking."],
      ["Enterprise tier (Expansion)", "Dedicated database, SAML and SSO-only mode, capacity planning, custom workflows, the AI copilot, adjustable seat and AI-budget ceilings, support with an uptime SLA."],
      ["Not charged: AI usage (Deliberate)", "Customers bring their own provider key and pay that provider directly. Refusing the inference markup removes the objection that kills most AI upsells, and keeps our margin independent of token prices."]
    ]
  },
  {
    id: "next",
    label: "What's next",
    title: "Four things, honestly labelled",
    points: [
      ["Ambient identity verification — deliberately gated on consent design", "Face checks are hands-free inside the dialog today. Continuous background scanning is the obvious next step and is deliberately not built: a camera running unprompted during ordinary work is a different consent posture, and that is a customer's decision to opt into rather than ours to assume."],
      ["Retrieval for Ask AI — scoped, not started", "Today Ask AI stuffs the most recently updated tickets into the prompt and never uses the question to choose which ones. A ticket outside that window is invisible, and no amount of prompt tuning fixes that."],
      ["Evaluation-gated prompt rollout — next", "The pieces exist: golden sets, prompt versions, and a scoring runner. The next step is refusing to activate a prompt version that scores worse than the one it replaces."],
      ["Deeper billing surface — under consideration", "Rate snapshots and cost analytics are in. Invoicing on top of attestations is the obvious extension, and the record it would bill from already exists."]
    ]
  },
  {
    id: "close",
    label: "In one line",
    kind: "close",
    title: "One system for the hours, the work they belong to, and the proof afterwards.",
    body: "With an AI layer that runs on your key, under your budget, and can be measured rather than trusted."
  }
];

/**
 * The market slide's figures. Sourced values and their publishers travel with the export, because a
 * deck emailed without its sources is exactly the deck this slide was built to avoid being.
 */
export const MARKET = {
  categories: [
    { name: "Professional services automation", range: "$12.5B – $14.4B", cagr: "11–14.9%", sources: "Grand View Research · Fortune Business Insights · Mordor Intelligence" },
    { name: "IT service management", range: "$13.6B – $15.3B", cagr: "14–16.5%", sources: "Fortune Business Insights · Grand View Research" },
    { name: "Time tracking", range: "$3.9B – $6.1B", cagr: "13–17.4%", sources: "Research and Markets · Mordor Intelligence" }
  ],
  assumptions: [
    ["Category overlap", "−25%", "A PSA suite and an ITSM suite bill for some of the same work, so the three cannot simply be added."],
    ["Seat band served", "35%", "Organisations of roughly 10–500 seats — the band the three plan tiers are priced for."],
    ["Regions reachable", "45%", "English-speaking markets plus EMEA, self-hosted or single-tenant SaaS."],
    ["Share of SAM captured", "0.5%", "Deliberately set below one percent."]
  ],
  arithmetic: [
    "TAM = ($12.5 + $13.6 + $3.9)B × (1 − 25%) = $22.5B",
    "SAM = TAM × 35% × 45% = $3.54B",
    "SOM = SAM × 0.5% = $18M of annual spend"
  ],
  caveat:
    "2025 estimates. The firms disagree — time tracking alone is published anywhere from $3.9B to $18.3B for the same year, because each draws the category's edges differently. The LOW end of every range feeds the arithmetic above, and the four assumptions are ours, not sourced."
};

/** Which product screenshots ship with the exports, and what each one shows. */
export const GALLERY = [
  ["dashboard.png", "Dashboard — everyone opens to what's theirs"],
  ["timesheet.png", "Timesheet — logging time that fights back"],
  ["tickets.png", "Tickets — the same rows the hours belong to"],
  ["insights.png", "Insights — computed from the rows the approvals ran against"],
  ["changes.png", "Change management — risk, approvals and a register"],
  ["goals.png", "Goals — progress that reports itself"],
  ["security.png", "Security — findings that become owned tickets"],
  ["settings-ai.png", "AI controls — one screen governs every model call"],
  ["agents.png", "AI teammates — named, scoped, switchable"],
  ["studio.png", "Requirements Studio — an interview that becomes tickets"],
  ["requirements.png", "Requirements — the structured document it produces"],
  ["practice-update.png", "Weekly practice update — counted, drafted, reviewed"]
];
