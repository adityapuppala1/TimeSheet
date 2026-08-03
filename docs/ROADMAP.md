# Product Roadmap

This is a living reference for where TimeSphere is headed, written against what's actually
built today (verified against the codebase, not aspirational) — see the README's feature
table and [Multi-tenancy](../README.md#multi-tenancy) section for the current state in full
detail. Every idea here is described in terms of the existing choke points it would extend
(`ai.service.ts`, `GlobalAISettings`, `PlanTierLimit`, the workers pipeline) rather than a
parallel system, because that consistency is itself part of what makes this codebase
maintainable.

## What already differentiates this product

Worth stating plainly before listing what's next, because these are structural choices, not
easy to retrofit into a competitor later:

- **Physically isolated per-tenant database**, not a shared table filtered by
  `organizationId`. Every other SaaS pattern in this space (Jira, Linear, most timesheet
  tools) uses row-level multi-tenancy. The practical consequence: an org's AI provider key,
  AI spend, SSO config, and every row of ticket/timesheet data live in a database connection
  no other tenant's request ever opens — see [README § AI, and every other per-org setting,
  cannot leak across tenants](../README.md#ai-and-every-other-per-org-setting-cannot-leak-across-tenants-by-construction-not-by-filter).
- **BYOK across 10+ LLM vendors** (Anthropic native, plus any OpenAI-compatible endpoint —
  OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, local
  Ollama/LM Studio) with per-call cost estimation, an `AIUsageLog` audit trail, and a
  configurable monthly budget ceiling enforced live. Most competitors either bundle one
  vendor's AI at a markup or have no AI at all.
- **Live plan-tier enforcement**, not just at signup — seat limits and AI budget ceilings are
  re-read on every relevant request (`services/plan-limits.service.ts`), so a platform admin
  changing a limit takes effect immediately, not on next billing cycle.
- **Tickets and timesheets are one system**, not two products bolted together — this is what
  makes workload heatmaps, cost-per-ticket, and estimate-vs-actual variance possible at all,
  because the same database holds both "the work" and "the time spent on it."

## Next-feature themes

Each is framed as an extension of an existing mechanism, not a new one.

### AI workflow automation

Audited 2026-07-17: none of the four items below existed yet (`ModuleAssigneeRule` is intake-
routing only, not a general ticket rules engine; `answerWorkspaceQuestion` is ticket-backlog-only,
not Insights-grounded; no anomaly detection or on-demand status report existed). Phased so each
step ships/tests/ships before the next starts, same discipline as the DevOps cluster above.

*Phase A — reuses existing infra, no new external credentials:*
- [x] **Rules engine on ticket fields** — new `TicketRule` model (condition: project/label/
  priority/source/senderDomain match; action: assign/label/notify), evaluated at the same choke
  point `ModuleAssigneeRule` already runs at (ticket-creation path), generalizing rather than
  replacing it. Admin CRUD lives in Workspace Settings → Ticketing.
- [x] **AI-suggested auto-assignment** — deterministic ranking (not an LLM call — see
  `ticket.controller.ts`'s `/suggest-assignee` route doc comment for why) from historical workload +
  expertise, rendered as a suggestion chip on ticket creation.
- [x] **Timesheet anomaly detection** — `GET /team/timesheet-anomalies`, opt-in manager insight
  (sustained overtime ≥55h/week, implausible daily total >16h) surfaced as a card on the Team page —
  informational only, same human-review posture low-confidence email triage already uses.
- [x] **AI-drafted status reports** — on-demand "generate a stakeholder update" for one project
  (`ai.service.ts#generateStatusReport`, `POST /reports/status-report`), triggerable from the
  Reports page rather than only firing on a schedule. Gated by its own `statusReportEnabled` toggle.

### Conversational analytics
- [x] Extended `answerWorkspaceQuestion` (previously ticket-backlog Q&A only) with a scoped
  analytics snapshot (open count, velocity this week vs last, open SLA breaches, top-5 workload,
  cost totals if `enableCostAnalytics` is on) computed synchronously and passed as grounding
  context — not a tool-calling loop, since the aggregates are cheap enough to just include up
  front at this data volume. "Ask AI" (`workspaceSearchEnabled`) can now answer questions like
  "what's our SLA breach count" grounded in real numbers, not just the raw ticket list.

### Integrations
- [x] **Public REST API + outbound webhooks** — already shipped (`public-api.controller.ts`,
  `webhook-dispatch.service.ts`) — see [docs/API.md § Public API](API.md#public-api).
- [ ] **Calendar sync** (Google/Outlook) — deadline-aware scheduling, reads the SLA due dates that
  already exist on tickets. Needs the org's own Google/Microsoft OAuth App credentials (same BYOK
  model as SSO/GitHub — no TimeSphere-operated client ever touches a customer's calendar). Not
  built yet — the Workspace Settings → Integrations tab has a placeholder card pointing here.
- [x] **SCIM provisioning** — inbound SCIM 2.0 (`scim.controller.ts`, `/api/scim/:orgSlug/v2/Users`),
  pairing with the SAML/LDAP SSO that already exists per-org (SSO authenticates; this provisions).
  Covers create/list-with-filter/get/patch-deactivate/delete on the Users resource; Groups and the
  ServiceProviderConfig discovery endpoint aren't implemented. Same per-org bearer-token model as
  the DevOps ingestion webhooks (Workspace Settings → Integrations), admin-generated and rotatable.
  Live-tested end-to-end against a hand-built SCIM client (create/list/get/patch/delete all
  verified) since no real IdP credentials are available in this environment — the wire format
  matches RFC 7644 exactly, so a real IdP (Okta, Azure AD/Entra) integration is just pointing it
  at the base URL, not further code changes.

### Monetization readiness
- [x] Self-serve Stripe billing wired to the existing `PlanTierLimit` model — turns the previous
  "a platform admin manually assigns a tier" flow (still available, unchanged) into a real
  upgrade funnel: `billing.controller.ts`'s `POST /billing/checkout-session` (org's own
  SUPER_ADMIN) creates a Stripe Checkout session; `POST /billing/webhook` (control-plane only,
  mounted pre-`express.json()` for raw-body signature verification) updates
  `Organization.planTier` on `checkout.session.completed`/`customer.subscription.updated`/
  `customer.subscription.deleted`. Platform-wide Stripe config (`PlatformBillingSettings`) is
  admin-set from the Plan tiers console, not BYOK per-org. No real Stripe account is available in
  this environment, so full payment-flow testing wasn't possible — but the checkout-session route
  was verified end-to-end up to the live Stripe API call (org/customer lookup, price resolution),
  and the webhook signature verification was fully tested using Stripe SDK's own test-signature
  helper (`stripe.webhooks.generateTestHeaderString`): valid signatures processed correctly
  (200, `Organization.planTier` updated), tampered and missing signatures correctly rejected
  (401). Pointing it at a real Stripe account is a config change, not a code change.

### Engineering & DevOps integration suite

The biggest thematic gap today: TimeSphere tracks *the ticket* and *the time spent on it*, but
has no visibility into *the code that resolved it*. This theme closes that loop — git activity,
CI results, and security findings all flow onto the same ticket a developer is already working
in, and flow back out as automated ticket-state changes. Grounded in what already exists:
`User.managerId` (self-relation, already powers escalations/approvals/Team page) *is* the
TL/manager mapping — no new org-chart model needed, just new surfaces reading it. `Project` →
`ProjectModule` → `ProjectSubmodule` is the existing work-breakdown hierarchy a repo/branch maps
onto. `TicketLink` (`BLOCKS`/`DUPLICATE`/`RELATES`) is the existing cross-ticket-relationship
primitive a "caused a regression in" link would reuse.

**1. Git repo & branch mapping**
- New tenant-scoped tables: `Repository` (org's connected repos — provider, URL, default
  branch), `TicketBranch` (many-to-many: a ticket can have 0+ branches, e.g. a fix that spans a
  feature branch and a hotfix), `PullRequest` (linked PR: number, URL, status, author, linked
  ticket via branch-name convention `TICKET-123-...` or an explicit link action).
- Ingestion: a GitHub/GitLab/Bitbucket **App/webhook integration** (same shape as the existing
  Slack/Teams/Google Chat webhook receivers in `chat-webhook.controller.ts` — signature-verified
  per provider, org resolved from the webhook's configured URL, not a subdomain). Push, branch-
  create, and PR events land here.
- UI: a new **Dev** tab on the ticket detail sheet (alongside the existing Comments/Checklist/
  Linked/Files/Time logged/Activity tabs) — branch chips with CI/PR status badges, "create
  branch" quick-action that copies a conventionally-named branch string to clipboard.

**2. Auto testing on branch/PR push**
- New table: `TestRun` (ticket-linked via its branch/PR, provider — GitHub Actions/GitLab
  CI/Jenkins/CircleCI —, status, pass/fail counts, duration, log URL).
- Ingestion: CI systems POST a completion webhook (or TimeSphere polls the provider's API on a
  `node-cron` worker, same pattern as `chat-telegram.worker.ts`'s poll-not-webhook choice for
  platforms without one). A failing run on a ticket's branch surfaces as a red badge on the
  ticket card in the Kanban board — visible without opening the ticket.
- Workflow rule: a ticket **cannot move to `RESOLVED`** if its latest linked `TestRun` is
  failing (enforced server-side in the existing `ticketStatusTransitions` gate in
  `ticket.controller.ts`, the same choke point that already enforces the Kanban's legal-move
  rules) — configurable per-org (some teams want this as a hard gate, others as a warning).

**3. Security assessment suite — VAPT / DAST / SAST / SSAT / SSCT**

Five distinct assessment types, deliberately **ingest-only and tool-agnostic** rather than
TimeSphere running any scanner itself — the same architectural choice as everything else in
this cluster (TimeSphere aggregates and acts on signals from tools the org already runs, it
doesn't become a scanning vendor). This also sidesteps the real infra/liability lift of actively
executing pentest-class tooling (DAST/VAPT) against a customer's live systems, which needs
explicit authorization TimeSphere has no standing to grant on a customer's behalf.

| Type | What it checks | How it lands in TimeSphere |
|---|---|---|
| **SAST** — Static Application Security Testing | Source code itself, no execution (Semgrep, CodeQL, SonarQube, etc.) | Webhook POST from CI on every PR/push |
| **DAST** — Dynamic Application Security Testing | The running app, black-box (OWASP ZAP, Burp, etc.) | Webhook POST from a CI stage or the customer's own DAST pipeline |
| **SSAT** — Secrets & Sensitive-data Scanning | Hardcoded credentials/API keys/tokens committed to the repo (Gitleaks, TruffleHog, etc.) | Webhook POST from CI, same shape as SAST |
| **SSCT** — Software Supply Chain Testing | SBOM, dependency provenance, package integrity/typosquatting/compromised packages — broader than a plain CVE-only dependency check (Syft/Grype, Socket, npm audit's advisory feed, etc.) | Webhook POST from CI, generates/attaches an SBOM artifact link |
| **VAPT** — Vulnerability Assessment & Penetration Testing | A periodic, human-led assessment (not per-PR — this app's own VAPT report in [README § Security](../README.md#security) is exactly this pattern) | A structured report (PDF/JSON) uploaded through Workspace Settings, parsed into the same `SecurityFinding` rows as the automated types |

- **Data model**: one generalized `SecurityFinding` table (ticket-linked where applicable, plus
  a repo/branch/PR reference) with a `type` enum (`SAST`/`DAST`/`SSAT`/`SSCT`/`VAPT`), `tool`,
  `severity`, `cwe`/rule ID, `file`/`line` where relevant, and `status`
  (`OPEN`/`ACKNOWLEDGED`/`FIXED`/`ACCEPTED_RISK`) — one table because a PR report needs to
  render all five types side by side, not five separate query shapes.
- **Auto-ticket creation**: a CRITICAL/HIGH finding of any type on a merged PR auto-creates a
  `SECURITY`-type ticket (severity mapped to priority, auto-assigned via the existing
  `ModuleAssigneeRule` mechanism) — high-confidence by construction (the scanning tool already
  did the classification), so this skips the AI-triage `needsReview` gate that email/chat intake
  needs; a finding is not an ambiguous natural-language message.
- **Per-PR structured security report**: the actual deliverable the user asked for — one report
  per PR aggregating every finding type above (plus the linked `TestRun` status from theme #2),
  rendered as an in-app page on the ticket's **Dev** tab and exportable as a PDF using the
  `pdfkit` dependency already in `apps/api/package.json` (currently only used for timesheet
  exports — this reuses that same code path rather than adding a second PDF library). Sections:
  a one-line risk verdict, findings grouped by type and severity, the SBOM link (SSCT), test
  status (from theme #2), and a "what changed since the last report on this ticket" diff so a
  reviewer isn't re-reading unchanged findings on every push.

**3a. Ticket-close security digest email**

When a ticket carrying at least one linked `SecurityFinding`/`TestRun` transitions to `CLOSED`
(the existing `PATCH /:id/status` route in `ticket.controller.ts` — the one choke point every
status change already funnels through, so this is one more notification branch there, not a new
code path), TimeSphere sends a structured summary of that ticket's security/test status — not
the org's whole security posture, just what's relevant to *this* ticket:

- **To**: the user who closed the ticket, and their manager (`req.user.manager`, read via the
  existing `User.managerId` self-relation — no new org-chart data needed).
- **Cc**: every `ADMIN`/`SUPER_ADMIN` in **that ticket's own tenant database** — never platform
  admins, never another org's admins. This falls out of the existing architecture for free
  rather than needing an explicit check: the query that finds "this org's admins" runs through
  the tenant-scoped `prisma` proxy described in
  [README § Multi-tenancy](../README.md#multi-tenancy), which physically cannot see another
  org's `User` table — there is no cross-tenant admin list to accidentally include.
- **Content**: the same per-PR report data as above, scoped to this one ticket's linked
  branch/PR/findings — not a digest of every open finding across the org, so a closer's manager
  isn't cc'd on unrelated projects' security noise.
- **Configurability**: a new toggle in `GlobalNotificationSettings` (next to the existing
  per-category email opt-ins already in Workspace Settings), off by default until an org
  connects at least one scan source — consistent with every other notification category's
  admin-configurable, opt-in-by-default-only-when-relevant pattern.
- **Delivery**: reuses `dispatchNotification`/`mail-templates.ts` exactly as every other
  ticket-lifecycle email does today (assignment, status change, comments) — one new template
  (`ticket.security_digest`), no new mail infrastructure.

**3b. Competitive parity & AI differentiation (Black Duck / OpenText Fortify benchmark)**

Researched 2026-07-15 against Black Duck SCA and OpenText Fortify (Remediation Aviator) — see
that session's chat for full source links. Verdict: the ingest-only, tool-agnostic architecture
above is already a better fit for a mid-market SaaS than either vendor's scanner-bundled
platform, and `autoReopenEnabled`/`ciFailureTriageEnabled`/`ModuleAssigneeRule`-based assignment
already match features both vendors sell as premium add-ons. The real gaps are SARIF ingestion
friction, exploitability-aware risk scoring, an analytics surface, and SBOM/license depth. Phased
so each phase ships, tests green, and is usable standalone before the next starts — no phase
depends on a later one being done to be valuable on its own.

*Phase 1 — fast wins, reuse existing patterns (ingestion + assignment):*
- [ ] **SARIF ingestion adapter** — `POST /api/devops/:orgSlug/findings/sarif` (or content-type
  sniffing on the existing `/findings` route) accepts a raw SARIF 2.1.0 document and maps its
  `runs[].results[]` into the existing `SecurityFinding` shape — GitHub Code Scanning,
  `codeql-action`, `semgrep --sarif`, and Azure DevOps' native scan output all land with zero
  hand-written `jq` translation, closing the single biggest onboarding-friction gap vs.
  GitHub/Azure's built-in code scanning.
- [ ] **Finding-level auto-reopen** — extend `autoReopenEnabled`'s trigger beyond failing
  `TestRun`s to "a new/reintroduced finding lands against a RESOLVED/CLOSED ticket's linked
  repo+branch," mirroring Black Duck's Jira-plugin `BOM_EDIT`-triggered reopen. Same
  `security-report.service.ts` function (`maybeAutoReopen` or equivalent), one more call site.
- [x] **Severity/policy-based ticket auto-creation** — already shipped: any CRITICAL/HIGH finding
  with no `ticketKey` match auto-creates a `SECURITY`-type ticket (`maybeAutoCreateTicketForFinding`
  in `security-report.service.ts`), assignee resolved through the existing `ModuleAssigneeRule`
  chain, same `dispatchTransactional` notify path already wired. Verified during this phase's
  research pass — no new code needed here.
- [ ] **CODEOWNERS/last-committer assignment fallback** — when no `ModuleAssigneeRule` matches a
  finding's `filePath`, resolve an assignee via the repo's `CODEOWNERS` file or the last
  committer on that file (both fetched through the existing `GitConnection` OAuth token, cached
  per repo) before falling back to unassigned. This is the concrete "assign to the relevant
  person" ask — closer to GitHub's own code-scanning alert assignment than either vendor's
  Jira-plugin approach.

*Phase 2 — analytics surface (net-new page, medium effort, depends on Phase 1's data existing):*
- [x] **Security & DevOps analytics page** (`/app/security-insights`, `REPORTS_VIEW`-gated):
  findings-over-time trend (8-week `AreaChart`), open-by-severity breakdown, mean-time-to-remediate
  (approximated from `updatedAt - createdAt` — no dedicated resolvedAt column on `SecurityFinding`
  yet), top repositories by open-finding count, SAST/DAST/SSAT/SSCT/VAPT split (`BarChart`) — built
  on the `StatCard`/`computeTrend` shared components, backed by `GET /reports/security-insights`.
  Nav entry + command-palette entry added alongside the existing Insights page.
- [x] **Org-wide risk score** — weighted, age-decayed formula (critical×10/high×5/medium×2/low×1,
  halving influence every 30 days a finding stays open, floored at 25%) as a Dashboard `StatCard`
  for admins, plus its own tile on the Security insights page.

*Phase 3 — AI differentiation (the actual moat: TimeSphere owns timesheet + org data neither
vendor has):*
- [x] **AI exploitability triage on findings** — sibling toggle to `ciFailureTriageEnabled`
  (`GlobalAISettings.findingTriageEnabled`), scoped to `SecurityFinding` rows (CRITICAL/HIGH
  only, bounding spend): `ai.service.ts#classifySecurityFinding` classifies TRUE_POSITIVE/
  FALSE_POSITIVE/NEEDS_REVIEW + suggests a fix, same shape as Fortify Aviator but built on the
  existing BYOK pipeline. Writes onto the `SecurityFinding` row itself (new `aiVerdict`/
  `aiExploitability`/`aiFixSuggestion`/`aiTriagedAt` columns) so it shows regardless of whether
  the finding has a ticket, plus posts as a ticket comment when it does. Renders on the ticket
  Security tab.
- [x] **Velocity-aware assignee suggestion** — when a CODEOWNERS line lists several people,
  `pickFastestAssignee` (security-report.service.ts) picks whoever has historically resolved
  security-linked tickets fastest (mean `Ticket.createdAt`→`resolvedAt` across their own
  RESOLVED/CLOSED tickets carrying a `SecurityFinding`), falling back to the first candidate on a
  cold start. Neither Black Duck nor Fortify can do this because neither owns ticket-resolution
  history — this is the product's real differentiator.
- [x] **AI weekly security digest** — new `workers/security-weekly-digest.worker.ts` (Monday
  08:30, 30 min after the per-user digest), generalizing `weekly-digest.worker.ts`'s pattern:
  open-findings trend, newly-critical items this week, resolved-this-week, risk-score delta,
  tickets stuck past SLA, top repos — one org-wide email to every ADMIN/SUPER_ADMIN. Two-layer
  gated like the existing weekly digest (`GlobalAISettings.securityWeeklyDigestEnabled` decides
  whether it runs at all, `GlobalNotificationSettings.emailSecurityWeeklyDigest` whether it
  actually emails), skips weeks with nothing to report.
- [x] **SBOM ingestion** (`POST /api/devops/:orgSlug/sbom`, SPDX/CycloneDX, new `SbomComponent`
  table) — a basic "dependency inventory + known-CVE cross-reference" view (ecosystem parsed
  from `purl`, CVE cross-referenced from CycloneDX's `vulnerabilities[].affects` where present),
  surfaced on the Security insights page. Deliberately not attempting Black Duck's full
  license-obligation-text depth (low ROI for this product's target market — legal-team-grade
  tooling most mid-market customers won't use).

**4. AI auto bug/issue detection + auto-reopen** ✅ shipped (Phase 4, 2026-07-16)
- [x] **Error-tracking ingestion + fingerprint-based auto-reopen** —
  `POST /api/devops/:orgSlug/error-events` accepts Sentry/Rollbar's outbound webhook shape (or a
  raw `{source, fingerprint, message, stackTrace?, level?, ticketKey?}` payload from any other
  system). A new event with no explicit `ticketKey` still auto-reopens a RESOLVED/CLOSED ticket
  if its `fingerprint` matches the fingerprint stored on that ticket from an earlier event (new
  `Ticket.errorFingerprint` column, first-write-wins) — reuses the exact same
  `maybeReopenTicketOnRegression` + `IngestionSettings.autoReopenEnabled` gate every other
  regression trigger in this app already goes through, so "the same crash came back" needed zero
  new state-machine logic. When a `stackTrace` is supplied, reuses `maybePostCiFailureTriageComment`
  (the existing CI-failure AI triage, gated by `GlobalAISettings.ciFailureTriageEnabled`) rather
  than building a second AI classifier for what's structurally the same "summarize this failure
  text" task.
- [x] **AI PR-review summary** — already shipped in an earlier phase
  (`ai.service.ts#summarizePullRequest`, `GlobalAISettings.aiPrReviewSummaryEnabled`,
  `git-webhook.controller.ts`'s PR-opened handler) — confirmed still working, no new code needed.

**5. TL/Manager mapping — new surfaces on existing data**
- An **org-chart / reporting-line view** (Team page today shows direct reports + escalations in
  two flat tables — extend with a tree view using the existing `manager`/`reports` self-relation,
  no schema change).
- **Kanban swimlanes by reporting line** — group the existing ticket board by
  `assignee.managerId` so a manager sees their team's work grouped, without a new permission
  model (reuses `ticketProjectScope` + the existing manager/team-lead visibility rules already
  enforced server-side).

**UI/UX approach for this whole cluster**: everything above surfaces on components that already
exist — the ticket detail sheet gets one more tab, the Kanban card gets a couple more status
badges, the Team page gets a tree view alongside its existing tables, Workspace Settings gets one
more settings card (**Integrations → Git & CI**, next to the existing Email intake/Chat
integrations cards, same layout/toggle pattern). No new page-level navigation is needed except a
single new **Dev** tab — consistent with the "don't add features, add to what's already load-
bearing" principle the rest of this codebase follows.

### Monetization readiness
Self-serve billing (Stripe) wired to the existing `PlanTierLimit` model. Today tiers are an
in-app flag a platform admin sets manually (see README's Multi-tenancy section) — no payment
processor exists. This is what turns the current "manually assign a tier" flow into an actual
upgrade/downgrade self-serve funnel.

## Tier mapping

Reuses the exact mechanism already in place — a feature is either an **org-admin toggle**
(Workspace Settings, same pattern as every existing AI/SSO/chat-integration toggle) gated by
what the org's plan tier allows, or a **platform-admin-only lever** (plan-tier config, same
`PlanTierLimit` table AI budget/seats/SSO-providers/chat-platforms already use today).

| Feature | Free / Starter | Team | Enterprise |
|---|---|---|---|
| Rules-engine auto-assignment/labeling | — | ✓ (capped rule count) | ✓ (unlimited) |
| AI-suggested auto-assignment | — | ✓ | ✓ |
| Timesheet anomaly detection | — | — | ✓ |
| AI-drafted status reports | — | ✓ | ✓ |
| Conversational analytics ("Ask AI" over Insights) | — | ✓ (capped queries/mo, same budget-ceiling pattern as today's AI features) | ✓ |
| Public API + webhooks | — | Read-only API | Full API + webhooks |
| Calendar sync | — | ✓ | ✓ |
| SCIM provisioning | — | — | ✓ |
| Git repo/branch/PR mapping | — | ✓ (1 repo) | ✓ (unlimited) |
| Auto testing status on tickets | — | ✓ | ✓ |
| SAST / SSAT (secrets) ingestion | — | ✓ | ✓ |
| DAST / SSCT (supply chain) ingestion | — | — | ✓ |
| VAPT report upload + parsing | — | — | ✓ |
| Auto security-finding tickets | — | — | ✓ |
| Per-PR structured security report (PDF) | — | ✓ (SAST/SSAT only) | ✓ (all 5 types) |
| Ticket-close security digest email | — | — | ✓ |
| AI CI-failure triage + auto-reopen | — | — | ✓ (opt-in toggle, see above) |
| AI PR-review summaries | — | ✓ (capped/mo, same budget-ceiling pattern) | ✓ |
| Org-chart / reporting-line views | ✓ | ✓ | ✓ (no gating — reads data every tier already has) |

**Planning layer (V6).** Every row below is enforced live by `plan-limits.service.ts` against the
control-plane `PlanTierLimit` columns, and every one **fails closed** — the capability is refused
unless the tier grants it. The one deliberate exception to the fail-open pattern used elsewhere:
unlike face verification, a lapsed plan never blocks anybody from doing their job here. A
downgraded org loses the Gantt *view*; every ticket, date, booking and budget stays in the
database, readable and intact.

| Planning feature | Starter | Team | Enterprise |
|---|---|---|---|
| Work-item hierarchy, dates, dependencies, Gantt | — | ✓ | ✓ |
| Calendar, My work | ✓ (My work only) | ✓ | ✓ |
| Portfolios | — | 1 | unlimited |
| Saved views | — | ✓ | ✓ |
| Resource management (capacity, bookings, workload) | — | — | ✓ |
| Project budgets, burn, forecast, estimate accuracy | — | ✓ | ✓ |
| Approvals on work items (incl. external reviewers) | — | ✓ | ✓ |
| Proofing / annotation | — | ✓ | ✓ |
| Request forms | — | 5 | unlimited |
| Blueprints | — | 5 | unlimited |
| Custom fields | — | 10 | unlimited |
| Custom workflows | — | — | ✓ |
| Custom dashboards | — | 3 each | unlimited |
| Scheduled report delivery | — | ✓ | ✓ |
| Project risk scoring | — | ✓ | ✓ |
| AI planning copilot (risk narrative, plan breakdown) | — | — | ✓ |

Two rows are worth explaining because they look inconsistent and are not:

- **My work** is available on every tier and needs no setup. It is a personal queue over dates
  that already exist, so gating it would leave most users with a nav entry that does nothing.
- **Project risk scoring** is on Team even though the *AI copilot* is Enterprise. The score is
  arithmetic — it works with AI switched off entirely. Only the plain-English narrative needs a
  model, and that is what the Enterprise row buys.


Every row above governs cost/usage the same way `GlobalAISettings.monthlyBudgetUsd` +
`AIUsageLog` already do for existing AI features — no new governance model needed, just new
things flowing through the existing meter.

## Explicitly out of scope for now

Captured here so it isn't silently forgotten, not because it's undesirable:

- Native mobile app — no current signal this is blocking a deal; revisit if requested.
- Data residency / region selection — relevant once there's an actual EU/regulated customer.
- Per-org custom domains beyond subdomain routing — nice-to-have, not structural.

## Related: production-readiness backlog (from the July 2026 deep audit)

Tracked here so nothing surfaced during the security/responsive audit gets silently lost.
**Resolved** items are kept (not deleted) so the history of what was found and fixed stays
visible — this file is a living reference, not a changelog.

**Resolved:**
- ~~Multer uploads silently lost tenant context above ~500KB~~ (2026-07-29) — **a real,
  previously-shipping production bug**, found while building face verification and confirmed to
  affect routes that predate it. `middleware/tenant.ts` establishes the tenant via
  `tenantContext.run(ctx, () => next())`, but multer parses the body off the request STREAM, and
  Node only propagates an AsyncLocalStorage store into callbacks scheduled from inside the
  context — a stream event emitted from the socket's own I/O context is not one. Small uploads
  were already buffered and kept the store; larger ones needed extra socket reads and lost it,
  so the first `prisma.*` access threw "No tenant context is active". Measured: a 31KB avatar
  succeeded, an 876KB avatar returned **HTTP 500** — meaning every real phone-camera photo was
  failing on a route whose own limit allows 5MB (ticket attachments allow 25MB). Fixed with
  `middleware/upload.ts#preserveTenantContext`, which captures the store before multer and
  re-enters it for the rest of the chain; applied to all six multer call sites (avatar, ticket
  attachments, both timesheet-with-files routes, both face routes). Verified: 875KB and 3.5MB
  avatars now return 200.
- ~~Face (identity) verification~~ (2026-07-29) — new feature, see
  [docs/FACE_VERIFICATION.md](FACE_VERIFICATION.md). Server-side face matching (browser is a
  dumb camera; a client that decides its own verification outcome is not a control), with
  anti-spoof + liveness so a printed photo can't defeat it. Off by default, master switch plus
  per-user opt-in, calibrated threshold (different people 0.23-0.67, same person ~0.83, default
  0.75), consent-gated enrollment with the shown wording stored verbatim, encrypted embeddings,
  images served only through an authenticated route (never the unauthenticated `/uploads` mount),
  and an enforced retention/purge worker. Uses `@vladmandic/human`'s node-wasm build so there is
  no native compile step and the Alpine image builds unchanged. Verified by 12 unit tests plus an
  18-check live HTTP script (`npm run verify:face:e2e -w apps/api`) covering gate-blocks-submit,
  enroll, verify, replay rejection, wrong-face rejection, RBAC and deletion.
- ~~`doctor` false-failed on any MySQL password containing `@`~~ (2026-07-29) — reported from a
  real second machine: `npm run setup` died with
  `nothing is listening on 161233@localhost:3306`. Root cause: `parseHostPort` used
  `/@([^:/]+):(\d+)/`, which grabs the FIRST `@`, so a password like `Hics@161233` made the host
  parse as `161233@localhost`. Verified against Prisma directly that the `.env` was actually
  **correct** — an unencoded `@` in a password returns P1000 (auth reached the server), not P1001
  (host unreachable), proving Prisma splits userinfo at the last `@` like every WHATWG parser.
  So the pre-flight check was the only broken thing, and it blocked setup before the real
  connection was ever tried. Rewritten to split the DSN the same way Prisma does, and it now
  prints the resolved host/port/database so a misparse can't hide again.
- ~~`doctor` couldn't tell you where MySQL actually was~~ (2026-07-29) — same report, broader
  problem: "whenever I'm running on different systems I get this." The doctor now reports
  OS/arch/Node, scans ports 3306/3307/3308/3309 and reads each listener's **MySQL handshake
  packet** to confirm it's really MySQL/MariaDB (and print its version) rather than just "a port
  is open", and — when the configured port is dead but another one is alive — says exactly which
  port to switch to. When nothing is running at all it detects what's installed (Windows
  services, XAMPP/WAMP paths, `brew services`, `systemctl` units) and prints the start command
  for that specific machine. New opt-in `npm run doctor:fix-env -w apps/api` applies the port
  correction to `.env` automatically, rewriting only `host:port` and preserving credentials,
  database names, comments, quoting and CRLF line endings byte-for-byte (verified with a
  round-trip test on both CRLF and LF fixtures — an earlier draft of this fix silently converted
  edited lines to LF, producing a mixed-ending file, which is exactly the sort of thing an
  auto-editor must not do).
- ~~Docker one-click installer couldn't use an external MySQL server~~ (2026-07-29) — previously,
  bringing your own MySQL server to the Docker install path meant manually editing
  `docker-compose.yml` yourself (removing the `mysql` service, rewriting the DSNs). Both
  installers now ask "Where should the database live?" up front; choosing your own server
  prompts for host/port/user/password/db-names, URL-encodes the credentials into
  `DATABASE_URL`/`CONTROL_DATABASE_URL` (verified round-trip-correct against a password
  containing `@:/#%`), and switches to a new standalone `docker-compose.external-db.yml` (same
  `api`/`web` services, no bundled `mysql` service or its `depends_on`) for every subsequent step.
  Re-running the installer later against the same `.env` detects the choice automatically (via
  `MYSQL_ROOT_PASSWORD`'s presence/absence) without re-prompting. The manual/local install path
  already supported any real MySQL server with zero changes needed — this closes the equivalent
  gap on the Docker path specifically.
- ~~`install.ps1` silently broken under real Windows PowerShell 5.1~~ (2026-07-29) — a genuine,
  previously-undetected bug: the script contains non-ASCII characters (em-dashes) and had no
  UTF-8 BOM, so Windows PowerShell 5.1 (`powershell.exe`, the OS-bundled default every real user
  actually has — not PowerShell 7's `pwsh`) defaulted to the system codepage instead of UTF-8 and
  corrupted string parsing, producing `Missing closing '}'`/`string is missing the terminator`
  errors before the script could even start. Invisible to CI because
  `.github/workflows/ci.yml`'s validation step used `shell: pwsh`, which doesn't have this
  encoding-detection quirk — confirmed by actually invoking the real script end-to-end, not just
  re-reading it. Fixed by adding a UTF-8 BOM to `install.ps1`; CI now also validates under
  `shell: powershell` (Windows PowerShell 5.1) so this class of bug can't regress silently again.
- ~~Wrong port checked for MySQL conflicts~~ (2026-07-29) — both `install.ps1` and `install.sh`
  checked host port 3306 for conflicts, but `docker-compose.yml` actually publishes MySQL on host
  port 3307 (deliberately, so it never collides with a local/XAMPP MySQL on the default 3306).
  The check was checking a port Compose never binds and would never flag the port that actually
  matters. Fixed in both scripts.
- ~~`install.sh` CRLF line endings with no `.gitattributes`~~ (2026-07-29) — the committed blob is
  LF, but any Windows user with `git config core.autocrlf true` (Git for Windows' own suggested
  default) gets a CRLF working-tree copy on checkout, which breaks bash outright
  (`$'\r': command not found` / "bad interpreter"). Added `.gitattributes` forcing `*.sh text
  eol=lf`, verified by forcing a fresh checkout on a machine with `autocrlf=true` and confirming
  the result is LF.
- ~~Misleading "docker compose not available" error message~~ (2026-07-29) — both scripts'
  catch-all message for a failed `docker compose version` check told users to "update Docker
  Desktop," which is misleading in the actual most-common case: Docker Desktop is installed but
  not yet running. Reworded to lead with that likelier cause in both scripts.
- ~~Dependency vulnerability remediation~~ (2026-07-29) — `npm audit` went from 12 vulnerabilities
  (6 high, 4 moderate, 2 low) to 0. `morgan`/`linkify-it`/`dompurify`/`postcss`/`uuid` fixed via
  plain `npm audit fix`; `sharp` bumped 0.34→0.35.3 (libvips CVEs, functionally re-verified via a
  script exercising `processAvatar()` directly against synthetic EXIF-bearing images); `ldapts`
  bumped to `^8.2.0` (root `package.json` already wanted this, but `apps/api/package.json`'s own
  range was stale at `^7.3.1`, silently overriding it — a real pre-existing inconsistency, not
  just an outdated lockfile).
- ~~react-router v7→v8 migration~~ (2026-07-29) — the last remaining `npm audit` advisory
  (`react-router-dom`'s CSRF-bypass CVE) required a full migration since `react-router-dom` was
  discontinued at v8, not just deprecated: moved all 15 `apps/web/src` files importing it to
  `react-router` directly, plus the version floor it requires (Vite 6→8, React 19.1→19.2.8).
  Caught and fixed a stale-Vite-dependency-cache runtime regression (blank page,
  `require_react is not a function`) along the way that neither `tsc` nor `vite build` surfaced —
  only a real browser run did; see `docs/NEW_ORGANIZATION_SETUP.md` §3a for the full writeup.
  Full Playwright suite re-run before and after: identical pass/fail counts both times.
- ~~Docker non-root user~~ (2026-07-29) — `apps/api/Dockerfile`'s final stage now creates and
  runs as an unprivileged `app` user instead of the container default root, with `--chown` on
  every `COPY` and `/app/uploads` pre-created with correct ownership before the compose volume
  mounts over it. Not build-verified against a real `docker compose up` yet (no Docker available
  in the environment this was made in) — do that before relying on it in production.
- ~~First unit/integration test suite~~ (2026-07-29) — `apps/api/tests/` (Vitest): 38 unit tests
  (no real DB, mocked LLM SDK/Stripe/control-plane client) covering AI service gating +
  `classifyTicket`, the Stripe webhook's signature verification and all three event branches, and
  SCIM auth/request-parsing; 7 integration tests against a real throwaway MySQL database
  (created/migrated/seeded via the existing `seedTenant()`/dropped per run) covering SCIM's real
  seat-limit/duplicate-email/status-transition behavior and the webhook's real
  `Organization.planTier` persistence. A first representative pass, not exhaustive coverage —
  `security-report.service.ts` and 10 of the 13 AI capability functions still have none, and none
  of it runs in `.github/workflows/ci.yml` yet.
- ~~Touch-target sizing sweep~~ — every icon-button previously sized `h-6`/`h-7 w-6`/`w-7`
  (24–28px) across Tickets (checklist/links/attachments), Users, the rich-text-editor toolbar,
  the file-dropzone remove button, and workspace-settings routing-rule rows is now `h-9 w-9`
  (36px), closer to the ~44px mobile tap-target guideline while staying visually compact in
  dense table rows.
- ~~SLA-sweep write ordering~~ — `sla.service.ts`/`ticket-sla.service.ts` now write the breach
  marker (`slaBreachAt`) atomically together with the `Escalation`/`TicketEscalation` row it
  implies (`prisma.$transaction`), not as a separate write beforehand — a crash between the two
  can no longer permanently mark a breach "handled" with no escalation ever created.
- ~~`GlobalAISettings.autoTriageAutoApply`~~ — now wired end-to-end: the ticket-create dialog
  reads this toggle and pre-fills the AI triage suggestion directly (with a visible
  "auto-applied by AI" indicator, still editable) instead of requiring an Accept click, exactly
  matching what the settings UI's description always promised.
- ~~Auto-ticket creation from CRITICAL/HIGH findings~~, ~~AI CI-failure triage~~, and
  ~~deterministic auto-reopen on regression~~ (theme #4 above) — all implemented: a fallback
  project (Workspace Settings → Security & DevOps) turns an unattached CRITICAL/HIGH finding
  into a ticket; a FAILED test run with a `failureText` excerpt gets an AI root-cause comment
  (`ciFailureTriageEnabled`, its own AI budget-gated toggle); a FAILED run referencing a
  RESOLVED/CLOSED ticket reopens it (`autoReopenEnabled`, deterministic, no AI, always
  audit-logged + notifies the assignee) — all three verified live against a running instance.
- ~~TL/Manager mapping — new surfaces on existing data~~ (part of theme #5) — an org-chart tree
  view now lives on the Team page (`GET /api/team/org-chart`), reading the existing
  `User.managerId` self-relation with no new schema; privileged roles see the whole company,
  everyone else sees their own subtree, system reporter-of-record accounts filtered out.
- ~~Kanban swimlanes by reporting line~~ (the other half of theme #5) — `TicketKanban.tsx` now
  has a "Group by manager" toggle that builds per-manager swimlanes (`buildSwimlanes`, keyed by
  `assignee.manager`, with an "Unassigned / no manager" fallback lane) and keeps drag-and-drop
  working across lanes via `${laneKey}::${status}` droppable IDs.
- ~~VAPT report upload + parsing~~ — `POST /security-ingestion/vapt-report` accepts a
  structured JSON report (assessor + findings) from Workspace Settings → Security & DevOps and
  creates `SecurityFinding` rows with `type: "VAPT"`, optionally attached to a ticket by key —
  deliberately JSON-only, not arbitrary PDF parsing (unreliable across report layouts).
- ~~Wide-table → mobile card-view fallback~~ — the Tickets list and Team page's escalations/
  direct-reports tables now pair a `hidden sm:table` desktop table with an `sm:hidden` card-list
  view carrying the same data, matching the pattern already used elsewhere in the app.
- ~~Expanded Playwright responsive coverage~~ — `tests/e2e/responsive.spec.ts` now covers 9
  routes (added `/app/history`, `/app/team`, `/app/users`, `/app/settings`), a tab-overflow
  regression check (`assertEveryTabIsReachable`) for Workspace Settings and the ticket detail
  sheet, and a new `platform-admin console` describe block for `/platform-admin/*`.
- ~~Git repo/branch/PR mapping~~ (scoped) — implemented as **manual** linking first: a new
  `TicketBranch` model (repository/branch/prUrl/prStatus, free text) surfaces on a **Dev** tab
  in the ticket detail sheet, same CRUD pattern as the existing Links panel.
- ~~Live git-provider App integration~~ (GitHub) — `GitConnection` model + a standard GitHub
  OAuth App flow (each org brings its own client id/secret, same bring-your-own-app-registration
  model `OrgSsoConfig` uses for Google/Microsoft SSO — see `services/git-provider.service.ts`'s
  header for why org identity travels through a signed `state` param rather than the Host
  header, mirroring `sso.service.ts` exactly). Once connected, the Dev tab's "Pick from GitHub"
  section lists live repos/PRs instead of typing a branch in by hand, still writing into the
  same `TicketBranch` row. **Scope note**: read-only REST calls only (list repos/branches/PRs)
  — no push/PR-event webhook receiver yet, so a `TicketBranch` row still doesn't auto-update
  when a PR merges on GitHub's side; that auto-sync-on-webhook slice is the natural next step,
  deliberately left out of this pass to keep it independently reviewable/testable. GitLab/
  Bitbucket are unbuilt — GitHub was the first provider implemented.
- ~~Auto testing on branch/PR push~~ (the workflow-rule half of theme #2 — `TestRun` ingestion
  itself already existed) — `GlobalTicketSettings.blockResolveOnFailingTests` (off by default,
  Workspace Settings → Ticketing) blocks a ticket's `PATCH /:id/status` transition to `RESOLVED`
  when its single latest ingested `TestRun` is `FAILED`; the Kanban card also shows a red
  "CI failing" badge (`TicketKanban.tsx`) sourced from the same `testRuns` include on the list
  endpoint, so a failing build is visible without opening the ticket.
- ~~Public REST API + outbound webhooks~~ (theme "Integrations", called out as "the single
  biggest structural gap today") — `ApiKey` (named, revocable, READ/WRITE-scoped bearer keys)
  gates `GET/POST /api/public/v1/*` (list/get/create tickets, list timesheets); `OutboundWebhook`
  fires an HMAC-SHA256-signed (`X-TimeSphere-Signature`, same trust model as GitHub/Stripe
  webhooks) JSON POST on `ticket.created`/`ticket.status_changed`/`ticket.closed`/
  `timesheet.submitted`/`timesheet.approved`. Both configured from Workspace Settings →
  **Public API**; see `docs/API.md`'s "Public API" section for the full contract.

- ~~Push/PR-event webhook receiver~~ for the GitHub integration above —
  `controllers/git-webhook.controller.ts` (`POST /api/git/webhook/:orgSlug`, a **per-repo**
  webhook the admin adds manually on GitHub since a plain OAuth App has no org-wide webhook the
  way a GitHub App does — the shared secret is generated from Workspace Settings → Security &
  DevOps → Git provider). `push` and `pull_request` events auto-create/update `TicketBranch`
  rows by matching a ticket-key-shaped token (e.g. `WEB-123`) in the branch name — same
  Jira/GitHub "smart commit" convention every similar integration uses, not a TimeSphere-specific
  scheme. Verified live: real `X-Hub-Signature-256` HMAC verification (valid + invalid cases),
  push events creating a `TicketBranch`, PR-opened/merged events updating `prUrl`/`prStatus`.
- ~~AI PR-review summaries~~ (part of theme #4) — `ai.service.ts#summarizePullRequest`
  (`aiPrReviewSummaryEnabled`, off by default) posts an AI-authored summary comment on the
  matched ticket when a PR's `pull_request` webhook fires with `action: "opened"` — same
  untrusted-content delimiting `classifyCiFailure` gives CI log text, since PR title/description
  are GitHub-supplied, not authenticated-user-supplied. A failure (AI disabled, budget cap, bad
  token) is caught and logged, never turns a successful branch sync into a failed webhook
  delivery — verified live via a deliberately-invalid access token.
- ~~Public API write scope beyond ticket creation~~ — `PATCH /api/public/v1/tickets/:key/status`
  (re-enforces the same `ticketStatusTransitions` legality rule and `blockResolveOnFailingTests`
  CI gate the authenticated route does) and `POST /api/public/v1/tickets/:key/comments`, both
  WRITE-scope-gated and attributed to the API key's creator. Verified live: illegal transition
  rejected (422), CI gate enforced identically to the authenticated route, READ-scope key
  rejected on both new routes (403).

**Still open:**
- **GitLab/Bitbucket OAuth** — the GitHub OAuth flow above is provider #1; the same
  `GitConnection`/`services/git-provider.service.ts` shape generalizes, but the other two
  providers' REST APIs and OAuth quirks haven't been implemented yet.
- **Timesheet writes via the public API** — creating a timesheet entry legitimately needs the
  same overlap-detection/SLA-deadline logic `timesheet.controller.ts#saveTimesheet` already
  owns; this is a `saveTimesheet` extraction, not new logic, and was deliberately left for that
  follow-up rather than duplicated under time pressure (see `public-api.controller.ts`'s header
  comment).
- ~~Wiring the new `apps/api/tests/` suite into CI~~ — done 2026-07-29 in the V4 documentation
  pass: `.github/workflows/ci.yml` now runs the unit tier before DB setup (fastest failure
  signal) and the integration tier after the seeded MySQL service container, ahead of
  Playwright.
- **Expanding unit-test coverage beyond AI/billing/SCIM** — `security-report.service.ts` (the
  security-findings ingestion/triage/auto-reopen logic) and 10 of the 14 `ai.service.ts`
  capability functions have no dedicated tests yet; the mocking patterns in
  `apps/api/tests/unit/*.test.ts`'s header comments generalize directly.

### Verification-log pagination + the biometric accuracy roadmap (2026-07-30)

- ~~The verification log had no pagination~~ — `GET /face/attempts` is now paginated
  **server-side** (`?page=&pageSize=`, returning `{ rows, total, page, pageSize }`; the old
  `?take=` is still accepted). This is the one log in the app that grows without bound — a row
  per attempt, forever, per covered employee — so the DataTable pattern of "fetch everything and
  page in the browser" would have quietly shown only the newest slice while claiming to be the
  full log. The UI reuses DataTable's exact footer shape (`Showing X-Y of N`, page-size select,
  prev/next) so it reads like every other table. The dashboard project rollup got client-side
  pagination too (bounded data already in memory — a server round trip per page would buy
  nothing). Verified live: `Showing 1-20 of 69` → next → `Showing 21-40 of 69`, plus e2e
  assertions that page 2 returns a genuinely different slice and the total is stable across
  pages (a no-op `skip` is the classic silent pagination bug).

### Phase A + B of the biometric roadmap — shipped (2026-07-30)

- ~~Single-template enrollment was the accuracy ceiling~~ — **multi-template enrollment**: the
  client captures a burst (pressed frame + ~3 more over a second), every usable frame becomes a
  `FaceEnrollmentTemplate`, and verification takes the best score across all of them. Only ever
  helps a genuine user; the impostor bar is unchanged. Verified live: 3 templates stored,
  `templatesCompared: 3` on the next verify.
- ~~An unusable frame was reported as `NO_MATCH`~~ — new **`LOW_QUALITY`** outcome from a quality
  gate that runs *before* matching, returning the one thing to change. Excluded from the failure
  streak, the review flag, and the lockout — a retake is not a failed identity check. This is the
  fix for "the biometric is not user friendly".
- **Per-user adaptive threshold** — after 8+ passes, judged against 3 sd below their own mean,
  **clamped to never fall below the workspace setting** (loosening would admit a lookalike
  *because* the real user is inconsistent) and capped at 0.95. `effectiveThreshold` is stored per
  attempt, since a similarity can't be interpreted later without it.
- **Rolling best-frame capture + live coaching** (Phase B) — the hands-free loop now scores each
  frame locally, keeps the best of the lock window, and shows pre-upload hints ("Move a little
  closer", "Make sure you're alone in the frame") instead of a binary verdict after the fact.
- **Operational metrics** — `GET /face/stats` now returns retake rate, a non-match proxy, average
  quality, and client-perceived time-to-verify p50/p95, surfaced as tiles with their targets
  inline. `durationMs` is reported by the browser because only the client can measure what the
  human actually waited for.

Two bugs the tests caught in this work, both preserved as regression tests:
- The quality gate was a **weighted sum** where the dimensions are AND conditions — good exposure
  and framing outvoted a fatal face size (1.8% of frame scored 0.51 and passed). Now per-dimension
  floors; the score survives only for ranking/telemetry.
- Exposure was measured over the **whole frame**, so a well-lit person in a dark room was told
  "too dark"; and **framing was disqualifying**, which refuses usable captures since the model
  crops to the face box. Now: face-region exposure, and centring is a client nudge only.

**Deliberately not doing (all phases):** iBeta Level 3 (an IDV-vendor problem, not an
employee-verification one), training our own face model (worse results, and it makes us the
holder of a biometric training set), and continuous/always-on monitoring (converts a
proportionate check into surveillance and destroys the privacy positioning). **An LLM must never
be the matcher** — non-deterministic, unauditable in a dispute, and it would mean shipping faces
to a third party.

**Positioning:** face recognition is table stakes — Jibble/Connecteam/Truein/Hubstaff all ship
it, some on free tiers. The defensible wedge is **verified work, not verified attendance**:
identity bound to the unit of billable work *and* to its approval, which an attendance product
structurally cannot do because it has no work object. Supporting claims: dispute-ready evidence
packs, and biometrics never reaching a third-party processor.

### Phase C, D, E of the biometric roadmap — shipped (2026-07-30)

The three remaining phases of the plan above, all implemented in one pass and verified by the
extended e2e suite plus 11 new unit tests (81/81 total) and the new PAD self-test harness.

- ~~Real injection defence relied only on a device-label regex~~ — **capture provenance**: the
  client now reports `neutralCapturedAt`/`gestureCapturedAt` (its own clock) alongside the two
  challenge frames, and the server compares them against the challenge's actual `issuedAt`
  (`assessProvenance` in `face.service.ts`). Flags reversed frames, implausibly fast frame
  intervals (<500ms), a capture claiming to predate its own challenge by more than the 2-minute
  clock-skew tolerance (the strongest single replay indicator available), and gross client/server
  clock disagreement. Like every other timing/device signal here, **it's a review flag, never a
  block** — client clocks are self-reported and trivially falsifiable. Verified live: an honest
  capture stays unflagged, a capture backdated 5 minutes before its challenge is flagged with a
  note naming the mismatch, and neither changes the immediate outcome.
  - *Not done from the original Phase C sketch:* a signed capture nonce and WebAuthn/passkey as a
    second factor on approvals — timing provenance covers the same replay scenario with no new
    client cryptography, so the added complexity wasn't justified yet; revisit if real-world
    replay attempts show up that timing alone doesn't catch.
- ~~No AI layer, and threshold tuning was manual histogram-reading~~ — **policy copilot**
  (`GET /face/policy-recommendation`): a threshold recommendation computed **arithmetically** from
  this workspace's own passed/rejected similarity clusters (widest-gap method, refuses below 30
  judged attempts or when the clusters overlap — that's an enrollment problem, not a tuning one).
  An optional LLM narration of the same numbers layers on top
  (`GlobalAISettings.facePolicyCopilotEnabled`) — it explains the number, never sets it, and is
  `null` when AI is off. **Auto-triage of honest failures** (`autoTriageHonestFailures`, opt-in):
  clears review flags only on `NO_FACE`/`MULTIPLE_FACES`/`LOW_QUALITY`/`CHALLENGE_FAILED`
  outcomes with zero virtual-camera or provenance suspicion, where the same person passed within
  the hour — runs nightly as stage 6 of the `face-retention` worker, or on demand via
  `POST /face/auto-triage`. Every auto-resolved row is stamped `autoResolvedReason` so the audit
  trail shows it was software, not a human, that closed it.
  - *Not done from the original Phase D sketch:* image-inclusive AI adjudication mode. Left out
    deliberately — it crosses the "biometrics never reach a third party" line this feature's
    privacy positioning depends on, and the metadata-only AI review summary (shipped earlier)
    already covers the "help a human triage a flagged attempt" need without that trade-off.
- ~~No customer-facing claim beyond "a check happened"~~ — the **identity evidence pack**
  (`GET /face/evidence/timesheet/:id`): one timesheet, every identity check bound to it
  (submitter's and approver's, with scores/thresholds/provenance), the consent record(s), and the
  policy in effect at export time — the artefact this feature's whole competitive positioning
  rests on, since attendance-only products have no work object to bind a check to. Excludes
  embeddings and filesystem paths, same rule as `/face/export`.
  - *Not done from the original Phase E sketch:* an accredited iBeta/ISO 30107-3 lab test. What
    shipped instead is `scripts/verify-face-pad.ts`, a repeatable **self-test** that synthesises a
    screen-replay and a printed-photo presentation in-process and asserts a genuine capture still
    passes. Documented explicitly, in the script itself and here, as **not** a certification —
    synthetic digital proxies are strictly easier to spoof than physical artefacts built to an
    accredited lab's cost budget, so a pass here means "the obvious cheap attacks are caught,"
    never "certified." That distinction matters enough to repeat: don't represent this script's
    output as a lab result to a customer's security team.

**Still open, deliberately:**
- **A signed capture nonce / WebAuthn as a second approval factor** — superseded for now by
  timing provenance (see above); revisit only if evidence shows a gap it doesn't cover.
- **Accredited PAD/IAD certification** (iBeta Level 1/2, `ISO/IEC 30107-3`, `CEN/TS 18099`) — the
  one place competitors with dedicated IDV infrastructure are genuinely ahead; requires a physical
  lab, not something an in-repo script can produce.
- **Challenge direction enforcement, the frame-consistency floor, and Playwright camera-flow
  coverage** — carried over unchanged from the Phase A+B entry above.

### Responsive pass + two rate-limiter root causes (2026-07-30)

- ~~Dashboard and Face-verification settings weren't small-screen friendly~~ — fixed at the
  root rather than per page: `Card` now carries `min-w-0 max-w-full`, because a grid/flex ITEM
  defaults to `min-width: auto`, so any card holding intrinsically-wide content (the timeline's
  min-width scroller, the score histogram) silently stretched its ancestor grids past the phone
  viewport instead of scrolling inside its own container. Also: two `CardHeader`s used `flex`
  without `flex-row` (CardHeader's base is `flex-col`, so they centered instead of splitting —
  visible in the user's own desktop screenshot), the timeline's edge hour labels now anchor
  inward instead of hanging half outside, its date control has a stable width, and the review
  log's mobile cards regained the virtual-camera/network signal icons the table already had.
  Verified by screenshotting `/app` and the face settings tab at 375px and 768px before/after,
  not by reasoning about classes.
- ~~"Random" mid-session 429s / features appearing to break~~ — the blanket limiter was 300/min
  **per IP**, and one office NAT is one IP while a single page load fans out ~10 React Query
  fetches plus 30s dashboard polling. Raised to 900/min; the strict per-route limiters (auth,
  face, webhooks) still guard the sensitive paths.
- ~~The "hamburger drawer" Playwright flake, documented as a mystery for weeks~~ — root-caused,
  not re-documented: `/api/auth/login`'s limiter counted **successful** logins, and
  `responsive.spec.ts` signs in per test across five viewport projects (~75 logins), so
  late-suite specs 429'd on login and failed as "element not visible" — which is exactly why it
  always passed in isolation. Now `skipSuccessfulRequests: true`, so only failed attempts count
  (the real brute-force surface, with the per-account lockout doing the precise work). Same bug
  would have locked out the 21st colleague signing in behind a shared NAT.
- **New `tests/e2e/helpers/face-gate.ts`** — specs that build timesheet/ticket fixtures now
  suspend face enforcement and restore the exact prior values. Without it, enabling the app's
  own flagship feature silently breaks the suite with 428s that surface as unrelated UI
  failures (found the hard way).

### Dashboard follow-ups + hands-free verification (2026-07-29, same-day fixes)

- ~~Day timeline rendered empty in UTC+N timezones~~ — a shipped timezone bug: "today's" key
  was built via `toISOString()` (UTC), which resolves local midnight to the PREVIOUS day in
  any UTC+N timezone, so the banner said hours were logged while the timeline showed nothing.
  Day matching now uses local-calendar keys end to end (`localDateKey`/`workDateParts`), and
  the regression is pinned by a real e2e test (`tests/e2e/dashboard.spec.ts`) that creates an
  entry for today and asserts the block renders.
- ~~Timeline was today-only~~ — added a date picker (native input + prev/next + "Today") that
  walks any day present in the loaded list (the latest 100 entries).
- ~~DialogTitle warning kept appearing~~ — second source found: the ticket detail sheet opens
  BEFORE its data loads, and its visible `SheetTitle` only renders with the data — so during
  the skeleton phase the open sheet had no title. An sr-only title now covers the untitled
  phase and unmounts when the real one takes over.
- **Hands-free ("Face ID feel") verification** — the dialog auto-starts the camera, and on
  Chromium (Shape Detection API) auto-fires the shutter once a single centered face holds
  still ~1s, with a two-attempt ceiling before falling back to the manual button; the server
  pre-warms the ML models at boot when the feature is enabled so the first check skips the
  cold load. Client detection only times the shutter — matching stays server-side. True
  Hello/Face-ID hardware (IR depth, secure enclave) is a platform boundary browsers can't
  cross; documented honestly in FACE_VERIFICATION.md, including why WebAuthn is a complement
  (device credential), not a substitute (identity check).

### Dashboard redesign + request-path latency fix (2026-07-29)

- ~~Every notification-bearing action stalled for seconds~~ — root cause: `dispatchNotification`
  awaited real SMTP round-trips (1–3s per recipient) inside user request paths, and
  `dispatchOutboundWebhooks` awaited external endpoints (up to 5s); a face verify that notified
  four reviewers measured **8.7s** wall-clock. Both side-effect legs are now detached (the
  in-app Notification row and all DB writes stay awaited; `sendMail` can't throw and records
  every attempt in EmailLog either way). Measured after: timesheet submit **49ms**, ticket
  status change **50ms**, with the emails confirmed SENT ~2s post-response. The ticket-closed
  security digest was detached the same way.
- ~~Radix `DialogContent requires a DialogTitle` console warnings~~ — the command palette's
  dialog now carries an sr-only title (and clears `aria-describedby`).
- ~~Dashboard~~ — rebuilt as a Trackline-inspired overview: three hero cards (segmented
  week-by-status bar with labeled value rows, single-series weekday activity chart with a
  computed week-over-week insight strip, tick-meter progress toward the 40h week + month
  approval rate), a **today timeline** placing the user's real entries on a real clock (the
  server's overlap rejection guarantees a collision-free single track), and a per-project
  month rollup with approval progress and open-ticket counts — all from data the page already
  loaded, no new endpoints. Status colors only ever appear with text labels and 2px segment
  gaps (the green↔amber pair sits in the CVD warn band, acceptable only with exactly that
  secondary encoding — validated with a palette checker, not eyeballed).

### Face verification hardening (2026-07-29, from the post-ship review plan)

The full plan (Enterprise packaging → trust surfaces → anti-injection → review analytics) was
implemented in one pass; the phases below record what each piece was *for*. Everything verified
by the extended live suite (`npm run verify:face:e2e`, 39 checks) plus 16 new unit tests.

**Done:**
- ~~Enterprise-only packaging~~ — `PlanTierLimit.faceVerificationEnabled` (seeded `true` only
  for ENTERPRISE), platform-admin toggle, and the deliberate failure-direction split:
  enable/enroll/verify fail **closed** (403), enforcement fails **open** — a lapsed payment
  must never lock a workforce out of logging time. Downgrade starts a 30-day grace window
  (admins notified), after which the retention worker purges all biometric data and disables
  the feature.
- ~~The trust gap~~ — "Identity verified" badges on timesheet rows, the approvals queue
  (including an explicit *covered-but-unverified* state so absence is never ambiguous), and
  ticket headers; consumed attempts are now actually **bound** to the record they protected
  (`bindVerificationToRecord` — previously the ids were never linked, so no join existed).
- ~~Nobody learns from a blocked submission~~ — enrollment-required notifications (in-app +
  templated email) fired from the settings PATCH, the per-user flag flip, and a deduped daily
  reminder; plus the dashboard first-run checklist whose face item stays visible through
  dismissal while enrollment genuinely blocks a workflow.
- ~~Coverage holes~~ — ticket **status transitions** gated under `requireForTicket` (comments
  and edits deliberately never gated), timesheet **approval** gated on the approver under new
  `requireForApproval` (rejection deliberately ungated — it moves no money), org-scoped image
  storage (`face/<orgId>/<userId>/`), and a dedicated 60/min rate limit on `/api/face/*`.
- ~~Anti-injection (the virtual-camera replay gap)~~ — challenge–response liveness: a random
  server-chosen head movement (single-use, 90s) measured as a pose delta between two frames,
  axis-based rather than direction-based until real-camera calibration data justifies sign
  enforcement (the deltas are persisted per attempt for exactly that purpose). Plus
  virtual-camera device-label and network-novelty **signals** — recorded and flagged for human
  review, never blocking, because both are client-influenced.
- ~~Evidence surfaces~~ — the match-score histogram (`GET /face/stats`) admins tune the
  threshold against, AI review briefs (`faceReviewSummaryEnabled`, metadata-only prompt),
  the deterministic weekly identity digest, overdue-review nudges, and self-service
  data-subject export (`GET /face/export`).

**Still open (deliberately):**
- **Challenge direction enforcement** — turn-left vs turn-right sign checking, once persisted
  `challengeYawDelta` data from real cameras establishes the sign convention safely.
- **Frame-consistency floor** — `frameSimilarity` between the neutral and gesture frames is
  recorded but not enforced; same-person similarity under a strong head turn needs real
  calibration before a floor won't brick honest users.
- **Playwright camera-flow coverage** — Chromium's `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-video-capture` can feed a canned video into the real dialog; today the
  camera UI itself is exercised only manually (the server pipeline is covered by the live
  suite).
- **Dedicated face worker pool / object storage** — the Large-tier deployment shape in
  [DEPLOYMENT.md § Sizing](DEPLOYMENT.md#sizing-measured-not-guessed); an ingress split, not a
  code change, so tracked rather than built.

### Dogfooding the security ingestion pipeline in TimeSphere's own CI (2026-07-30)

The ingest-only security architecture (`devops-webhook.controller.ts`, documented for customers
in [SECURITY_DEVOPS_INTEGRATIONS.md](SECURITY_DEVOPS_INTEGRATIONS.md)) had never been exercised
against TimeSphere's own source — `.github/workflows/ci.yml` ran zero security scanning. Phase 1
of a broader "make the SaaS smarter" plan (workflows/security/scanning/branch automation/AI —
full plan reasoning kept alongside this entry, not just the outcome):

- ~~No security scanning of the app's own code~~ — new `security-scan-dogfood` job runs CodeQL
  and Semgrep (both SARIF → `POST /:orgSlug/findings/sarif`, zero new backend code needed —
  `mapSarifToFindingInputs` already existed and had never been exercised for real), `npm audit`
  (new `scripts/ci/npm-audit-to-findings.mjs` mapper → the native findings-batch endpoint, since
  npm audit has no SARIF output), and a CycloneDX SBOM (`POST /:orgSlug/sbom` — the parser was
  real, just never fed real data). The existing `build-test-ubuntu` job now also reports its own
  pass/fail as a `TestRun` (`POST /:orgSlug/test-runs`).
- Entirely opt-in and safe-by-default: the whole job is gated on
  `secrets.TIMESPHERE_INGEST_TOKEN != ''`, so it's a no-op on every fork and on this repo until an
  admin deliberately generates a token (Workspace Settings → Security → CI/CD ingestion → rotate
  token) and adds `TIMESPHERE_INGEST_TOKEN`/`TIMESPHERE_INGEST_URL`/`TIMESPHERE_ORG_SLUG` as repo
  secrets, pointed at a real deployed instance. `continue-on-error: true` on the whole job — this
  is informational dogfooding, never a merge gate.
- No new `GlobalAISettings` toggle needed: `findingTriageEnabled` and `securityWeeklyDigestEnabled`
  already fire automatically the moment real findings land, since `ingestFindingsBatch` calls the
  AI-triage and auto-ticket-creation functions unconditionally per finding. This is genuinely the
  first time that pipeline runs against real, non-synthetic findings.

**The rest of the same plan (Phases 2/3) shipped the same day — see the next two entries below.**
Still open: deeper AI (cross-signal bug-pattern digest, AI-reasoned assignee suggestion, a
stale-ticket nudge, and — last, most conservative — inline AI PR review comments beyond the
existing PR summary).

### Phase 2: closing the automation gaps (2026-07-30)

- ~~Branch linking only worked git → ticket~~ — new `POST /tickets/:id/branches/auto` creates a
  real branch via the existing (previously read-only) GitHub OAuth integration
  (`git-provider.service.ts#createGitHubBranch`), named `<ticket-key>/<slugified-title>`. The `/`
  separator is deliberate, not cosmetic: hyphen-joining the key straight into the slug (the
  obvious choice) makes `git-webhook.controller.ts`'s ticket-key regex greedily swallow the WHOLE
  branch name as one token whenever a title happens to end in digits (a version, an incident
  number — not rare in bug titles), silently breaking the auto-link back. Verified against exactly
  that failure case before shipping. Degrades gracefully in two ways: no GitHub connection, or no
  `repository` supplied, returns the suggested name only (client fills the manual-link form); a
  fallback branch also works with zero GitHub connection at all.
- ~~A CI failure with no ticket at all just sat in the log~~ —
  `maybeAutoCreateTicketForCiFailure` (opt-in, `IngestionSettings.autoCreateTicketOnCiFailureEnabled`,
  off by default) closes the gap `maybeReopenTicketOnRegression` never covered (that one only acts
  on an *existing* ticket). Flaky-test guard, verified end-to-end: a repeat failure on the same
  provider+branch within 24h gets a comment on the ticket already created instead of a duplicate;
  a failure already flagged as likely-flaky (AI CI-failure triage, when a failure-log excerpt was
  supplied) skips creating a ticket on its first sighting at all.
- ~~Outbound webhooks were fire-and-forget with no retry~~ — a failed delivery now persists as a
  `WebhookDelivery` row (payload included, since a retry minutes later can't reconstruct "what the
  ticket looked like at dispatch time" from current state) and `workers/webhook-retry.worker.ts`
  (every 5 minutes) retries with backoff (1m/5m/15m/60m, ~80 minutes of coverage) before marking
  it `exhausted`. No new job-queue dependency — same cron-sweep pattern every other worker here
  already uses. Workspace Settings → Public API shows each webhook's pending/exhausted deliveries
  with a manual "Retry now." Verified live: a webhook pointed at an unreachable host correctly
  records the failure with the real network error, and manual retry re-attempts it.

### Phase 3: unified ticket lineage (2026-07-30)

- ~~Ticket ↔ branch/PR ↔ CI run ↔ security finding were four separate panels~~ — new
  `ticket-lineage.service.ts` (`GET /tickets/:id/lineage`) merges them into one chronological
  timeline, same shared-builder pattern as `buildTicketSecurityReport`. Pure read-side aggregation
  — no new ingestion, every row already existed and was already linked by `ticketId`. New
  "Lineage" tab in the ticket detail sheet. This is the literal "map" the original ask ("logging
  and mapping") was pointing at. Verified live: a ticket carrying a linked branch/PR, a `PASSED`
  test run, and a `HIGH` finding all merge into one correctly-ordered, correctly-toned timeline.
  Deliberately does not include webhook-delivery events yet — a *successful* delivery is never
  persisted anywhere per-event (only the aggregate status on the webhook row), so "every webhook
  event fired about this ticket" isn't reconstructable without logging every attempt, not just
  failures; revisit if that gap turns out to matter in practice.

### Phase 4: deeper AI, shipped conservatively (2026-07-31)

The last phase of the smarter-SaaS plan — held back deliberately from the 2026-07-30 pass since
it's the highest-uncertainty tier (prompt quality, cost, and — for the last item — real
false-positive risk to developer trust). All four gated behind their own opt-in toggle, all off
by default, same "narrate/suggest, never decide/act" discipline as every earlier AI feature here.

- ~~No cross-signal "what keeps breaking" view~~ — `generateBugPatternDigest` +
  `workers/bug-pattern-digest.worker.ts` (monthly, 1st @ 09:00): recurring CI failures by
  provider/branch, tickets accumulating the most failed test runs, and security-finding hotspots
  by repository, cross-referenced into one narrative. Monthly rather than weekly — a trend needs
  a longer window than a week to mean anything. Same "given numbers only" prompt discipline as
  every other digest.
- ~~Assignee suggestions were unexplained numbers~~ — `explainAssigneeSuggestion` narrates
  (never re-ranks) the existing deterministic `GET /tickets/suggest-assignee` ranking, in one
  sentence, when a ticket title is available for context.
- ~~Nothing nudged a stale ticket beyond the SLA breach notification~~ — a dismissible AI-suggested
  next action, surfaced from the *existing* SLA sweep (`ticket-sla.service.ts`) as its own
  notification (`ticket.stale_nudge`) rather than a new cron job, so an AI failure never affects
  whether the real breach notification goes out.
- ~~PR review was summary-only~~ — `reviewPullRequestDiff` posts actual per-line comments on a
  PR's diff (`git-provider.service.ts#postGitHubPullRequestReview`, `event: "COMMENT"` —
  commentary alongside a human review, never a merge-blocking verdict). Separate toggle from the
  existing summary feature on purpose. Shipped deliberately conservative: skips diffs over 15
  files or 150 changed lines (falls back to summary-only), caps 5 comments per PR, and — the
  actual anti-hallucination gate — every returned `(path, line)` is validated against the PR's
  real diff hunks before being trusted; a claimed line that was never part of the diff is
  silently dropped rather than posted (GitHub's own API would 422 on it anyway, so this is
  defense in depth, not the only check). Covered by unit tests specifically for this validation
  and for the size-cap skip, since this is the one feature in the whole plan with real
  developer-trust risk if the safety net is subtly wrong.
- Found and fixed two adjacent gaps while wiring the toggles in: `facePolicyCopilotEnabled`
  (from the 2026-07-30 face-verification session) and `emailSecurityWeeklyDigest` had toggles
  that worked server-side but were never actually reachable from Workspace Settings' UI —
  added alongside this phase's own four new toggles rather than left to rot further.

Verified: 85/85 unit tests (4 new, targeting the diff-validation logic specifically), full
Playwright suite, both workspaces lint clean. Live-verified the AI-reasoned assignee suggestion's
graceful-degradation path end-to-end against this dev environment's actual (non-functional)
AI credentials — confirmed it degrades to `narrative: null` without breaking the underlying
deterministic suggestions, rather than erroring the whole request. The bug-pattern digest and
stale-ticket nudge share the identical `preflight`/`callChat` failure path, structurally verified
the same way (lint, unit-adjacent review) rather than independently live-triggered, since neither
has a manual-trigger endpoint the way `/face/auto-triage` does.

## Verified Work Attestation + billing correctness (2026-07-31)

A strategy review concluded the defensible position isn't "better Jira" or "better Harvest" but
owning the complete auditable chain: *work performed* → *time spent* → *code that resolved it* →
*proof of who did it* → *approval*. Most of that chain already existed. This phase built the
artifact that makes it sellable to a services business, plus the billing correctness it depends on.

### Workspace Settings is now SUPER_ADMIN-only

- ~~Any logged-in user could open `/app/settings`~~ — the route had **no guard at all**, and both
  the sidebar and the command palette linked it unconditionally (non-super-admins got a read-only
  view). Now gated three ways that must stay in sync: `RequireRole` on the route, `role:
  "SUPER_ADMIN"` on both nav entries, and `requireSuperAdmin` on the backing GETs.
- **The trap this had to avoid:** three ordinary pages call settings endpoints — an EMPLOYEE's
  ticket create-dialog reads one AI flag, a MANAGER's Insights page reads two ticketing flags.
  Locking those routes naively breaks both pages. They now read a deliberately tiny
  `GET /settings/effective-flags` projection (three booleans, any role); `/git/*` is left at
  `requireAuth` because the ticket Dev tab depends on it.
- The `readOnly` prop threaded through all 14 settings cards is **kept** even though it's now
  always `false`, so restoring a read-only tier is a one-line change rather than re-threading a
  prop through 14 components.

### Billing correctness (the foundation, fixed first)

- ~~Cost was recomputed live from each user's CURRENT rate, and counted DRAFT + REJECTED
  timesheets~~ — so a raise retroactively rewrote what past work cost, and hours nobody had
  accepted were billed. Now: an optional **per-project rate override** (the real agency case —
  "Client A pays more than Client B for the same person"), and a **rate snapshot frozen onto the
  timesheet at approval time**, in the same write that sets APPROVED.
- **Historical rows are deliberately NOT backfilled.** Inventing "the rate at the time" from
  today's rate would make a dispute artifact assert something untrue; those hours are reported as
  explicitly *unrated* instead. "We don't know" and "it was free" are not the same statement — the
  old `?? 0` fallback conflated them.
- Approval **never blocks** on missing billing config (`billedRateSource: "NONE"`), because
  breaking the core approval workflow to serve a reporting feature is the wrong trade.
- Also fixed while here: `totalCostUsd`/`avgCostPerTicket` were computed from the **top-25 slice**
  rather than all tickets, so both headline numbers were wrong in any workspace with >25 costed
  tickets. The duplicated formula in `ai.controller.ts` now shares `computeTimesheetCost`, so
  "Ask AI" can no longer quote a different total than the Insights page.
- ⚠️ **Cost totals drop in existing workspaces.** That's the correction, not a regression — the
  Insights panel now carries a caption naming the excluded draft/rejected hours.

### The attestation itself

- `attestation.service.ts` builds a per-project × date-range artifact: approved hours grouped by
  ticket, contributors, approvals, per-entry rate/amount, and identity-verification flags for both
  the submitter (`context: TIMESHEET`) and the approver (`context: APPROVAL`).
- **Persisted, not generated on demand** (`WorkAttestation`): a dispute artifact must re-render
  identically months later even after a user is renamed or a ticket retitled. Frozen `payload`
  plus a canonical-JSON SHA-256 `payloadHash` for tamper evidence. **Immutable** — no update path;
  correcting one means voiding it (with a reason) and issuing a new one. Nothing is ever deleted.
- **Strips every biometric internal**, mirroring the identity evidence pack's existing rule: no
  embeddings, image paths, similarity scores, thresholds, or IP addresses. It carries the
  *conclusion* of an identity check ("verified"), never the evidence behind it — and links to the
  existing `/face/evidence/timesheet/:id` route for internal admins who need the internals. That
  endpoint was left completely untouched.
- Refuses to issue when a period **mixes currencies**, rather than silently summing them.
- Access is `REPORTS_VIEW` + per-project scoping (not the coarse `requireAdmin` the face evidence
  pack uses); voiding is stricter (`SUPER_ADMIN`), since invalidating an artifact a client may
  already hold is a different class of action from producing one.

**Verified:** 97/97 unit tests (12 new covering rate precedence, exact-decimal money math, and the
unrated-vs-zero distinction), plus a 23-check live pass covering the off-by-default gate, preview
not persisting, the full biometric-stripping rule, PDF rendering, project scoping, and void-not-
delete. Both workspaces lint clean; migration is purely additive and applied to all tenants.

### Public share links (shipped, off by default)

The "client verifies it themselves, without an account" path — the thing that separates this from
emailing a PDF. Built last and gated hardest, because it is the **only unauthenticated read
surface in the application**.

- Token handling copies `ApiKey` exactly: 256-bit random, **SHA-256 stored only**, plaintext shown
  once at creation and never recoverable. A database leak yields no usable links.
- Creation is `SUPER_ADMIN` **and** requires `enableAttestationSharing`, a toggle deliberately
  separate from `enableAttestations` — publishing to a public URL is a different decision from
  producing an internal artifact, and an admin should have to make it explicitly.
- Expiry is **mandatory** (default 30d, max 90d); a link that never expires is a permanent public
  exposure. Revoking sets `revokedAt` — the row is retained, never deleted.
- **Expired, revoked, voided, and never-existed all return an identical generic 404**, so probing
  can't distinguish "wrong token" from "token that was once real."
- Attestation ids never appear in the URL, so nothing is enumerable by walking ids. Own rate
  limiter (30/min), `noindex` + `no-store`, and every view counted and audited with a null actor.
- `SUMMARY` scope (the default) withholds **all** per-entry rows — a client learns the work
  happened and was verified, without receiving a per-person breakdown of the vendor's staff and
  their rates. `FULL` is opt-in per link.
- A voided attestation cannot be shared at all.
- The viewer (`/shared/attestation/:token`) lives deliberately outside `/app`: the reader has no
  session, so it must never hit the app shell or redirect to login. It uses a plain `fetch`, not
  the authenticated axios instance.

Verified by a 21-check live pass: the separate gate, super-admin-only minting, write-once token,
unauthenticated read succeeding, SUMMARY withholding per-person detail, the uniform-404 rule
across every failure mode, and revoke-retains-the-row.

## Platform polish + the AI improvement loop (2026-07-31)

### Workspace navigation, backend health, and the attestation PDF

- ~~15 nav items in one flat list~~ — grouped under **Work / Team / Analytics / Administration /
  Configuration** headings. Deliberately **static headings, not collapsible sections**: hiding admin
  nav behind a disclosure costs a click on every visit to save vertical space the sidebar already
  has, and `responsive.spec.ts` asserts the Workspace-settings link is visible at >=1024px with no
  interaction. A section whose items are all filtered out by permission is omitted entirely,
  heading included. The platform-admin console is deliberately left ungrouped — three items don't
  need wayfinding.
  *(Auto-slide-in on small screens and auto-close on menu click already worked; not rebuilt.)*
- ~~A dead backend left the UI silently lying~~ — new escalating health gate: a warning strip on the
  first failed probe, a full blocking overlay after three, auto-recovering the moment the API
  answers again. It **overlays rather than unmounts**, so in-progress form state survives an outage.
  Deliberately escalating rather than blocking immediately — one dropped request is usually a
  sleeping laptop or a rolling deploy, not an outage worth destroying someone's work over.
  - **Gotcha found:** `/health` is not under `/api`, and the Vite dev proxy only forwards `/api` —
    a browser probe to bare `/health` would have been served by Vite and returned a **healthy 200
    while the API was down**. Added `GET /api/health` alongside it.
  - Also closed two adjacent gaps: axios had **no timeout** (a dead backend hung until the
    browser's own very long default gave up) and the app had **no error boundary at all**, so any
    render throw blanked the page with no explanation and no recovery path.
- ~~The attestation PDF clipped~~ — it drew one continuous flow with **no page-break guards**, so
  any attestation longer than a page silently dropped the rest of the work it was attesting to.
  Rewritten into `attestation-pdf.service.ts` with real page breaks, repeating table headers,
  fixed-position columns (it previously indented with literal spaces, which drifts with name
  width), a proper VOID banner, per-page footers, and thousands-separated money. It also now calls
  `doc.font()` — **no PDF in this repo had ever used bold**, so hierarchy came only from size and
  colour, which prints washed out. Covered by layout tests that deliberately overflow the page,
  since the clipping bug is invisible on happy-path sample data.

### LangChain / LangGraph — evaluated, recommendation is **not yet**

Researched against the actual code rather than the marketing:

- All 18 AI capabilities are **single-shot** prompt->response. Not one calls `callChat` twice;
  nothing chains one capability's output into another.
- **Zero tool-calling** anywhere. **Zero retrieval/RAG** — the only embeddings in the system are the
  encrypted face templates, which are deliberately not searchable.
- The hand-rolled `callChat` already provides multi-provider BYOK, structured output on both
  provider paths, vision, budget enforcement, per-feature toggles and usage logging in ~200
  auditable lines.

Wrapping 18 single-shot calls in LangChain would replace working, minimal, auditable code with a
heavy dependency for no functional gain. The genuine gaps in the current layer — no retry/backoff,
no request timeout — are tens of lines, not a framework.

**The one thing that would change this verdict:** `answerWorkspaceQuestion` stuffs the 150
most-recently-updated tickets into the prompt, truncates each description to 200 chars, and **never
uses the question text to decide which tickets to include** — so ticket #151 is invisible and no
prompt tuning can fix it. Making "Ask AI" correct at scale is a retrieval problem, and *that* is
where LangGraph (retrieve -> rerank -> answer -> verify) would earn its place. Even then, a MySQL
full-text prefilter plus reranking may be sufficient. Revisit only when that project is committed to.

### The AI improvement loop — the gap this phase opens up

The LangSmith "improve agents autonomously" loop (Build -> Test -> Deploy -> Monitor -> Govern) maps
onto this product almost exactly, and **the loop is broken at precisely one joint**:

| Loop corner | Status here |
|---|---|
| **Govern** | Already the strongest corner — BYOK multi-provider gateway with live budget ceilings |
| **Build** | 18 capabilities, all wired and in use |
| **Monitor** | Feedback *collected* — and discarded |
| **Test** | Does not exist |
| **Deploy** | Prompts hardcoded; changing one word requires a redeploy |

`Ticket.aiFeedback` is written by exactly one endpoint and **read nowhere in `apps/api/src`** —
verified by exhaustive grep. An admin clicking thumbs-down writes four bytes that nothing will ever
look at again. `AIUsageLog` has no correctness column at all, only cost. There is no dataset,
golden set, eval, or prompt-version concept anywhere.

Being built next, phased: capture what the AI produced -> surface accuracy honestly (headline metric
is **parse-failure rate**, which is unbiased and already happening but currently thrown away, *not*
thumbs-up rate, which has severe selection bias) -> golden datasets from real thumbs-down cases ->
prompt versioning without a deploy -> an eval runner.

#### Shipped (2026-07-31) — all five phases

| Phase | What landed | Where |
|---|---|---|
| P0 | `AIInteraction` capture behind two off-by-default toggles, plus `ai-retention.worker.ts` | `c885e5a` |
| P1 | "AI quality" card, parse-failure rate first, coverage shown next to every human-derived number | `915b815` |
| P2 | `AIDataset` / `AIDatasetItem`, promoted from real failures only | `637a848` |
| P3 | `AIPromptTemplate` / `AIPromptVersion`, allowlisted, never-throw fallback | `de177b8` |
| P4 | `AIEvalRun` / `AIEvalResult` + `ai-eval.worker.ts`, three budget layers | `a4165f5` |

Decisions worth remembering, because each one closed off a plausible-looking alternative:

- **Datasets are promoted, never authored.** An item always comes from a real captured interaction.
  Hand-invented test cases drift toward what someone imagines users do, and a prompt tuned against
  fiction gets worse in production while the score improves. Items copy their inputs rather than
  joining to the interaction, because the retention sweep deletes it in ~30 days and a golden set
  that decays is worse than none — it shrinks silently and the numbers move for invisible reasons.
- **Prompt editing is allowlisted, and that allowlist is a security boundary.** Every `jsonSchema`
  capability is excluded twice over: its output must parse (`classifyTicket` throws 502, and email
  and chat intake depend on it), and its prompt carries the `<untrusted-*>` delimiter blocks that
  defend against injected content from email, chat, CI logs and PR diffs. Auditing this was a clean
  split — every prompt carrying an untrusted-content block is also a `jsonSchema` one, so the two
  exclusion rules agree exactly. The face capabilities are excluded for a third reason: they sit
  inside the biometric compliance regime.
- **The runtime cannot be broken by a bad prompt.** `resolvePrompt` returns the built-in prompt for
  every failure and records `promptFallbackReason` on the interaction. That guarantee is what makes
  the feature safe to expose at all.
- **Evals call the same capability functions production calls.** There is deliberately no "eval
  mode" that skips `preflight`/`assertWithinBudget` — such a path would drift from the real one and
  you'd be measuring something you don't ship. This caught a real bug during the build: the LLM
  judge originally called `callChat` directly and could have spent outside the budget.
- **Structured scoring is a fraction, not a boolean,** and excludes the model's self-reported
  confidence — scoring confidence rewards being confidently wrong as much as being right.
- **A run stopped by the budget is `PARTIAL`, not `FAILED`.** The scores it produced are real.

Known limits, stated rather than papered over: `pr_inline_review` captures no params (diffs are too
large to store), so it can't be evaluated; a dataset item whose capability signature later changes
is recorded as *not replayed* rather than scored zero, because a zero would be a false claim about
the model; and the enqueue-time budget refusal is covered by unit tests only, since exercising it
live would mean writing a budget onto a real workspace's settings.

## Deployment self-sufficiency: version identity, one-command install/update, maintenance mode (2026-08-03)

The through-line of this phase: a deployment an admin can run WITHOUT the development team on
call. Install proves itself, updates roll back by themselves, the app announces its own upgrades,
and planned downtime is a scheduled workflow instead of a Slack apology.

### Version identity + update awareness

- One `VERSION` file at the repo root is the single source: the API reads it at boot (env-var
  override for containers, walk-up fallback for dev), Vite bakes it into the bundle
  (`__APP_VERSION__`), and Docker builds stamp GIT_SHA/BUILD_DATE. The version rides on the
  existing `/api/health` poll, so "the server was upgraded under you — refresh" costs zero extra
  requests, never nags dev bundles, and clears itself on rollback.
- **What's new** page renders GitHub Release notes (markdown from a remote source → always
  through `safeHtml`), with an admin-only update card. The update check is server-cached an hour,
  single-flight, and can never throw — a GitHub outage degrades to "no information", not errors.

### Install/update scripts that prove themselves

- `install.sh` / `install.ps1` detect OS, Docker, K8s (offered, never assumed) and external
  databases (preflighted with exact CREATE/GRANT statements printed on failure), then run a named
  verification suite — reported version matches, admin login works, SPA serves — and exit 1
  loudly if any check fails. CI runs the installer end-to-end (`TS_AUTO=1`) on every push.
- `update.sh` / `update.ps1`: backup (`--all-databases` — tenant DBs provisioned after install
  included) → checkout tag → rebuild → **verify → auto-rollback code-only on failure**. The
  additive-migrations policy is what makes old-code-on-new-schema a safe rollback target; the
  dump exists for disasters and is never auto-restored. `migrate:tenants` runs after health so
  the whole tenant fleet gets the new migrations, not just the default DB.

### Maintenance mode (see ARCHITECTURE.md §3.8)

- Enforcement lives at exactly two choke points — `requireAuth` (every authenticated route) and
  `establishSession` (every login method, password + all four SSO flavors) — as
  **503 + `code: "MAINTENANCE"`**, which the client treats as "show the maintenance page", never
  as an outage or a bad session. The check is cached 10s per tenant and **fails open**: a broken
  settings lookup degrades to a working app, never a locked-out workforce. SUPER_ADMIN is exempt
  — someone has to do the maintenance and turn it off.
- "Who's online" is `Session.lastSeenAt` within 15 minutes (stamped by a throttled fire-and-forget
  write in `requireAuth`), deduped to people — not `expiresAt`, which counts everyone who logged
  in this month. Force-logout is server-side session revocation; the 401 → refresh-fail →
  login-refused → `/maintenance` chain needs zero client cooperation, which is what makes it a
  control rather than a suggestion.
- The e2e spec deliberately never calls force-logout (it would revoke the shared auth snapshots
  every later spec depends on — the one-owner-per-snapshot trap, at suite scale); the SUPER_ADMIN
  exemption living in the SQL WHERE clause is pinned by a unit test instead, and the spec restores
  the workspace in `finally` so a failed assertion can never leave the demo workspace locked.

### Follow-up (same phase): server health + per-user login visibility

- `GET /api/maintenance/health` (SUPER_ADMIN) renders a live vitals card on the Maintenance tab:
  CPU as a real two-sample delta, memory, `fs.statfs` disk, tenant/control DB pings, event-loop
  lag, and a component checklist. Honesty rules are explicit in the service header: everything is
  measured on the instance that answered (named by host+pid, one replica's view behind a LB),
  Windows load averages are null rather than fake zeros, and the endpoint can never throw —
  a health check that 500s when unhealthy defeats itself.
- User management now shows presence (same 15-min `lastSeenAt` window, one sessions query for
  the whole page), `firstLoginAt` (stamped exactly once in `establishSession`, deliberately not
  backfilled — null means "unknown", not a guess) and `lastLoginAt`, plus per-user force-logout
  (only a SUPER_ADMIN may target a SUPER_ADMIN). The e2e proves the revocation chain on a
  throwaway drill user it creates and asserts-cleans-up itself — seeded accounts' sessions are
  never revoked, for the same snapshot-ownership reason as above.

### Follow-up (same phase): the revocation must be SEEN, and three layout truths

- **A 15s `GET /auth/heartbeat`** (deliberately tiny — not `/me`, which rebuilds the whole
  profile payload) plus a session-ended dialog: a force-logout now lands on the target's open
  tab within seconds — modal, one exit, straight to /login. The same beat keeps idle-but-open
  tabs honest in the online panels, and pulls locked-out users onto /maintenance within a beat
  of the window starting. The api layer fires `onSessionEnded` exactly once per session (a
  burst of parallel 401s must produce ONE dialog), only when a session actually existed (the
  signed-out boot probe must stay silent).
- **Scheduled maintenance now interrupts once**: a modal pop-up (localStorage, once per window
  per browser — rescheduling re-warns) on top of the persistent banner. Direct product
  feedback: nobody reads passive chrome mid-task.
- **The layout-break bug was CSS root-cause, not Radix**: `overflow-x: clip` on `html` blocks
  body→viewport overflow propagation, so any Radix scroll lock (`overflow: hidden` on body)
  turned BODY into the clip box and detached every `position: sticky` element — measured as the
  sidebar sitting at `y = -scrollY` the moment a menu opened. Clip lives on body alone now
  (propagates to the viewport, preserving the phone hardening), `scrollbar-gutter: stable`
  kills the scrollbar-width jump, and the topbar/table menus are `modal={false}` besides.
- **14px root font** is the answer to "it only looks right at 80% zoom" — every Tailwind size
  in the app is rem-based, so one declaration rescales the whole UI to 87.5%; breakpoints are
  unaffected (media queries resolve against the browser default, not the html font size).
- The maintenance router's limiter went 30 → 240/min per IP after the e2e caught it starving
  the status poll: during a real window an entire office polls through ONE NAT egress IP —
  30/min saturates at ~10 locked-out colleagues, which would have made the lockout page fail
  exactly when it matters. Found as a test flake, fixed as a production bug.
- **Removing the html clip UNMASKED a real tablet bug the suite had been blind to**: with
  `overflow: clip` on the root, `documentElement.scrollWidth` reports no overflow, so the
  "no horizontal overflow" checks were partially defeated the whole time (the same masking the
  WorkspaceSettings grid comment describes). The honest measurement immediately failed three
  tablet tests and led to the actual defect: DataTable's root is a grid, grid items default to
  `min-width: auto`, so the desktop-table wrapper sized itself to the TABLE's min-content width
  — its `overflow-auto` never engaged and wide tables were clipped edge-off-screen with no
  scrollbar at 768px. One `grid-cols-[minmax(0,1fr)]` on DataTable's root fixed every consumer
  at once. Lesson pinned: a passing overflow test under a root-level clip proves nothing.

### Follow-up (same phase): eight polish items in one pass (2026-08-03)

User-reported, each fixed at the cause:

- **Maintenance page** rebuilt as a living screen — counter-rotating gears, drifting orbs, a
  blueprint grid, window-progress bar — all CSS/framer-motion, zero image assets. The
  e2e-asserted strings were treated as a contract and kept.
- **Timesheet ticket picker** is a cmdk combobox now; the `value` it filters on is
  deliberately `key + title` so "OPS-381" and "lineage" both find the row.
- **Maintenance email** moved into the branded template registry (shell/heading/infoCard) and
  the Email templates page catalog. One escaping authority: the template escapes everything,
  callers pass raw text — the alternative (caller pre-escapes) double-escaped on the first try.
- **Tour targets**: DESTINATION_COPY gained an optional per-route feature `selector`
  (data-tour anchors on seven pages; semantic `main table` where a DataTable IS the feature);
  `main h1` demoted to fallback. Direct feedback: highlighting the title told people where
  they were, never what to look at.
- **Security PDF** rebuilt to the attestation house style: verdict banner whose color is the
  answer, severity strip, CI-run line, descriptions/CWE/AI-triage (all previously dropped),
  methodology appendix, Page N of M. Renderer extracted to its own service + 3 structural
  tests (the 60-finding overflow case included).
- **Server-health details** became labeled icon tiles — the one-line text footer was exactly
  the unscannable thing the rest of the panel exists to avoid.
- **Test workflow**: `test:e2e:quick` (desktop functional loop) + `test:e2e:responsive`
  (4 viewport projects, 2 workers — measured 4.8 min vs ~9 serial). Parallelising the
  FUNCTIONAL suite was explicitly rejected and the reason documented in the README: specs
  share one DB and deliberately mutate workspace-wide state (maintenance lockout, session
  revocation); the failure mode of overlap looks nothing like its cause.

---

## V6 — the planning layer: TimeSphere as a project-management platform

**Why this theme.** Every previous phase deepened *execution* — tickets, timesheets, SLAs,
DevOps/security ingestion, BYOK AI, multi-tenancy. Evaluated against Wrike (the closest
feature-complete comparator), the gap is not any single missing button: it is that there is no
way to express **the plan**. No hierarchy above a flat ticket, no dates other than the
SLA-derived `dueAt`, no Gantt, no capacity, no intake forms, no approvals on deliverables, no
fields or statuses a customer can name themselves, no dashboard they can build.

**Why it's tractable here.** The hard half is already built, and in a way a pure PM tool cannot
match. Wrike has to *estimate* effort; TimeSphere has real approved hours per person per project
per day, with a rate snapshot captured at approval (`Timesheet.billedRate`, `billedAmount`). That
makes workload heatmaps, budget burn, forecast-to-complete and estimate-variance **measured
rather than entered** — the same "tickets and timesheets are one system" advantage this document
already claims, cashed in.

**The constraint on the whole programme:** an org that upgrades and touches nothing must behave
exactly as it did on V5. Every table new, every added column nullable or defaulted, every
capability inert until an admin opts in, the full Playwright suite passing unedited at each phase
boundary.

### Phase 1 — foundation (2026-08-03)

Schema, entitlements and the admin surface. No user-visible feature beyond one settings tab —
deliberately, so the riskiest part (a schema touching `Ticket`, `Project`, `User` and
`TicketLink` on live multi-tenant data) lands and is verified on its own.

- [x] **Work item = `Ticket`, not a new table.** `parentId` (self-relation), `startDate`/
  `endDate`, `isMilestone`, `progressPct`, `sortOrder`, `baseline*`, `workflowStatusId`. The
  existing `estimatedHours` **is** effort — no second field. A parallel `Task` table would have
  duplicated comments/attachments/watchers/links/checklists/timesheet-linkage and forced every
  report to `UNION`.
- [x] **Custom workflows via `WorkflowStatus.legacyStatus`** — the compatibility hinge. Admin
  statuses each declare which built-in `TicketStatus` they write, so the ~40 existing readers of
  `Ticket.status` keep working *and keep being correct* without knowing custom statuses exist.
  Replacing the enum with an FK was rejected: rewriting every one of those call sites on a live
  product buys nothing a user can see. `WorkStatusCategory` adds CANCELLED, which the built-in
  enum cannot express.
- [x] **Custom fields as rows, not JSON on `Ticket`** — saved views filter on them and dashboards
  group by them, which a JSON column on a large MySQL table cannot serve. One validation choke
  point (`custom-field.service.ts#normaliseValue`) because four write paths will depend on it.
- [x] Portfolio, saved views, resource bookings + capacity, project budget, request forms,
  blueprints, approvals, proofing, dashboards, report subscriptions, and the `AiProposal` /
  `AiProposalChange` / `ProjectRiskSnapshot` trio — schema only this phase.
- [x] **Entitlements fail closed, with no fail-open counterpart** (unlike face verification).
  Six capabilities + five quotas on `PlanTierLimit`, defaulting restrictive, read per request.
  A downgraded org loses the *view*; every ticket, date and booking stays readable.
- [x] Planning design tokens (light + dark) in `index.css` + a named `plan`/`capacity`/`risk`
  palette in `tailwind.config.ts`, all derived from existing hues so the timeline reads as the
  same product. The capacity ramp is one hue at five lightnesses **except** the top step, which
  crosses to destructive — "over capacity" is a categorically different state from "busy", and
  that is the one place a hue change carries meaning.

**The upgrade-safety finding that shaped the migration.** `prisma/seed.ts` is a one-time
bootstrap: `migrate deploy` runs on every boot and `migrate:tenants` walks every tenant DB, but
**nothing re-runs the seed** — and it must not, since it does `rolePermission.deleteMany` +
`createMany`. So a new permission key added to `@timesheet/shared` would have reached fresh
installs and silently 403'd for every existing customer. Every permission, the system Default
workflow, and the settings singleton are therefore backfilled by guarded SQL **inside** the
migration, mirroring `seed.ts`. Consequence: `install.sh`/`install.ps1`/`update.sh`/`update.ps1`
needed **zero changes** — one-click install and one-click upgrade both work as they are.

Verified: 54-migration replay into a genuinely empty database (the check DATABASE.md mandates,
because dev-DB success is a weaker claim); backfill run twice to prove idempotence; fresh-install
seed producing byte-identical grants to the upgrade path; 762 existing tickets backfilled with
`status` and `workflowStatus.legacyStatus` agreeing on every row; entitlement gate returning 403
with an upgrade message on a downgraded tier while `/tickets`, `/reports` and `/timesheets` kept
answering 200; 223 unit tests and all 145 Playwright tests across five viewport projects green
with no spec edited.

### Phase 2 — planning & views (2026-08-03)

The plan becomes visible and editable. Everything below is inert until an admin turns planning on.

- [x] **The schedule engine** (`services/plan-schedule.service.ts`) — working-day arithmetic,
  four dependency types + lag, critical path with float, effort-weighted progress roll-up,
  baseline slip, and cycle detection for both graphs (dependencies and hierarchy). A pure core
  with a thin DB shell, because every interesting scheduler bug is arithmetic that renders
  plausibly rather than throwing. 27 unit tests pin it, including the Mon-Fri-is-5-days
  inclusive-span rule that is the classic "every Gantt bar is a day too long" defect.
- [x] **It computes, it never auto-schedules.** Explicit dates always win; a contradiction is
  reported as a `violation` and the typed date still renders. There is no undo for "the tool
  moved forty dates overnight", and a scheduler people stop trusting is worse than none.
- [x] **Timeline (Gantt)** — hand-built SVG, not a library. Every option ships its own design
  system, assumes it owns the data layer, or is unmaintained; the genuinely hard parts already
  live server-side, leaving `x = f(date)`. Tree pane, zoom (day/week/month), drag-to-move,
  edge-drag-to-resize, dependency arrows as orthogonal elbows (bezier curves become an
  unreadable tangle at 50 edges), baseline as an outline never a fill, hatched "not scheduled"
  bars, today marker, critical-path emphasis. Below `lg` it becomes a list rather than a
  shrunken chart.
- [x] **Calendar, My work, Portfolio** — the calendar distinguishes a real schedule from an
  SLA-only date, because on day one that is the only date most tickets have. My work buckets
  server-side (one definition of "overdue", shared with the dashboard and the reminder emails)
  and puts a blocked item in exactly one bucket. Portfolio derives every number — schedule from
  the same solver, burn from the `Timesheet.billedAmount` snapshots an attestation reads.
- [x] **View switcher on the existing Tickets page**, not a competing "planning" page: the
  filters someone already set carry across List / Board / Timeline / Calendar.
- [x] **Ticket "Plan" tab** — where an item gets its FIRST dates. The timeline can only move a
  bar that already has some, and letting a hatched placeholder be dragged would mean looking at
  a plan quietly commits to one.
- [x] Portfolios, project budget/planned window, `plan:write` separated from `tickets:write`
  (editing a description and moving the delivery schedule are different rights).
- [~] Saved views — API and storage only; no UI shipped. Corrected in phase 6, same as proofing.

**Two things the browser found that no test would have.** The timeline first opened as a wall of
identical one-day stubs — 41 of 45 items were unscheduled, and the four bars carrying a real plan
were invisible in the noise. Unscheduled work is now hidden by default behind a "Show N
unscheduled" toggle, keeping ancestors of scheduled items so the tree stays connected. Separately,
going from two view buttons to four pushed the Tickets header past 390px; because
`body { overflow-x: clip }` hides that rather than scrolling it, the symptom was the page header
silently dragged off-screen — the same failure mode already documented for the Workspace Settings
grid track. The responsive sweep caught it, and `/app/my-work`, `/app/timeline` and
`/app/portfolio` are now in that sweep permanently.

Verified: 250 unit tests (+27), 70 desktop and 90 responsive Playwright tests across five
viewports, plus a new `planning.spec.ts` covering the settings/entitlement AND, the Default
workflow still matching `ticketStatusTransitions`, cycle refusal naming the offending items, the
date round-trip including the inclusive-span rule, and the roll-up never reporting a fake
forecast.

### Phase 3 — resource & budget (2026-08-03)

The phase that uses the asset no competitor has.

- [x] **Planned, actual and capacity on one axis** (`services/workload.service.ts`). Wrike and
  the rest hold only estimates, so they compare a plan against another plan. This app has
  approved timesheets with a rate snapshot, so the board shows a booking, the hours actually
  logged against it, and the person's real capacity together. "Ana is booked at 110%" is a
  forecast; "booked at 110% and logged 46 hours" is evidence.
- [x] **Bookings are per WORKING day**, capacity scales to the working days actually in a bucket,
  and time off reduces what is *available* rather than counting as load — a week of leave reads
  as "unavailable", not "fully booked", or planners fill it. 24 unit tests pin exactly these,
  because each failure is silent: spreading a booking over calendar days inflates the whole
  company's load by 40% and the board still looks plausible.
- [x] **Overlaps are reported, never refused.** Double-booking is sometimes deliberate, and a
  system that rejects the second booking forces planners to record something untrue. 100% is not
  flagged either — fully booked is the intended state, and flagging it lights up the whole board
  on a well-planned sprint.
- [x] **One definition of money** (`services/budget.service.ts`), called by both the portfolio
  roll-up and the project panel. Burn is summed from the rate snapshots a Verified Work
  Attestation reads, so an internal dashboard and a client-facing document cannot disagree.
  Forecast returns null below 5% progress or zero spend. Unrated hours are counted separately,
  never priced as zero.
- [x] **Estimate accuracy** — finished work only, reported as a median. Turns the hours this app
  already collects into better estimates next time.

**Two dev-environment lessons worth keeping.** The workload heatmap first rendered with invisible
cells: the Vite dev server had been running since before the phase-1 `tailwind.config.ts` edit, so
`bg-capacity-*` never existed in the dev CSS and `text-white` sat on a white card. A production
build had them all along — Tailwind config changes need a dev-server restart, and the timeline
looked fine throughout only because its colours are inline SVG `fill` attributes rather than
utility classes.

Separately, `test:e2e:responsive` runs four projects across two workers, which are separate OS
processes; two of them suspended the face-verification gate and the first to finish restored it
while the other was still creating fixtures. Intermittent, and it always pointed at whatever the
fixture was for. `tests/e2e/helpers/face-gate.ts` now reference-counts through a lock directory so
only the last holder restores — verified by re-running the four projects and confirming the
settings came back exactly as they were.

Verified: 274 unit tests (+24), 78 desktop and 94 responsive Playwright tests, all green.

### Phase 4 — intake & approvals (2026-08-03)

Work starts arriving from outside the workspace, and leaves it for sign-off.

- [x] **Dynamic request forms** with conditional questions, published to a public URL that needs
  no account. The rule engine is a pure core: a question may only be shown based on a question
  ABOVE it, which makes circular conditions impossible by construction rather than something to
  detect at runtime, and makes the form readable top to bottom.
- [x] **The rule that matters most**: required is only enforced on a question that was actually
  SHOWN, and answers to hidden questions are DROPPED. Rejecting them would fail an honest
  submitter whose browser posted a stale answer after they changed an earlier choice; accepting
  them would let anyone POST past a branch they were routed away from. Dropping is the only
  option that is both forgiving to people and closed to abuse.
- [x] **Blueprints** with relative day offsets and index-based references, previewable before
  instantiation, and derivable from a project that already ran.
- [x] **Approval chains** — sequential or parallel, internal or external. One rejection is
  terminal, one approval is only a step, and a guest reviewer gets a single-use token rather than
  a half-real `User` row that would enter every permission check forever.
- [~] **Proofing** — pin and region comments anchored to normalised coordinates, so an annotation
  lands on the same spot on a phone, a 4K monitor and a PDF export. **Corrected in phase 6: the
  schema, service and four routes shipped; the UI did not.** The workspace toggle was reachable
  and labelled, so this read as delivered while there was no way for a user to place a pin. See
  the phase 6 entry.

**The public surface tripled, from one endpoint to four**, so the posture the attestation viewer
established was applied deliberately to all of them: unguessable tokens, no enumerable ids, and
one generic 404 for bad/revoked/spent alike. The request-form endpoint is the only place a
stranger can WRITE, and carries its own per-form rate limit on top of the per-IP one — per-IP
alone is useless against a distributed flood and punishes an office behind a single NAT.

Verified: 310 unit tests (+34), 22 planning e2e tests, 84 desktop and 98 responsive Playwright
tests, all green. A 32-assertion API smoke covered the security posture specifically — no
internal fields in a public payload, hidden answers dropped, single-use links, generic 404s,
sequential ordering, and rejection terminality.

### Phase 5 — the AI planning copilot, human-in-the-loop by construction (2026-08-03)

- [x] **`AiProposal` / `AiProposalChange`** — the envelope every planning AI feature writes
  through. Nothing applies itself. A reviewer accepts or rejects each row, sees the before → after
  diff, and can save decisions and come back.
- [x] **Stale-state detection**, which is the part that makes it safe rather than merely careful.
  Every UPDATE row carries the state it was computed from; application refuses any row whose
  current value has moved, because applying would silently revert whoever moved it. Rows apply
  independently, so one refusal does not discard the eleven a person approved. Writable fields are
  an allowlist, so a proposed `status` or `reporterId` change cannot be applied whatever the
  prompt produced.
- [x] **Project risk scoring** — six measured signals, stated weights summing to 100, full
  breakdown stored with the score. **Deterministic and available with AI switched off entirely.**
  19 unit tests pin what the score MEANS, not just that it runs: that no signal can exceed its
  weight, that blocked work is a share rather than a count, that a small amount of rework is
  normal, and that the same inputs always give the same number.
- [x] **Risk narrative + plan breakdown** — the only two model calls. The narrative explains a
  score it cannot change; the breakdown proposes tasks it cannot create. Both go through the
  existing `preflight`/`callChat` choke point, so budget ceilings, per-feature toggles, usage
  logging and the prompt-version trail all apply unchanged.
- [x] **Nightly snapshot worker** via `runForEveryOrg`, which also sweeps expired proposals — a
  schedule suggestion computed against last week's plan is worse than no suggestion.

**The judgement that shaped the whole phase**: it would have been much easier to let the copilot
write. Everything here — the envelope, the per-row diff, the staleness check, the allowlist,
the deliberate absence of an apply-all button — exists because there is no undo for "the assistant
moved every date in Q3", and a tool that does that once is never trusted again.

**Deferred, deliberately**: custom dashboards with a widget library, scheduled report delivery,
and the schedule/resource copilots. The dashboards and scheduled reports are conventional CRUD
over data that already exists and are carried into phase 6; the two extra copilots reuse this
exact envelope and are a prompt plus a change-builder each, so the expensive part is already
built.

Verified: 329 unit tests (+19), 26 planning e2e tests (+4), full desktop and responsive suites.

### Phase 6 — dashboards, delivery, and what the verification pass found (2026-08-03)

- [x] **Custom dashboards** over a **closed** widget catalogue. Closed was the whole design
  decision, and it was made twice over. Once for meaning: if a client can define its own tile,
  "open items" gets defined once per dashboard and two tiles wearing the same label quietly
  disagree — and the person who notices is in a board meeting. Once for security: a user-supplied
  widget definition is a query-injection surface reachable by anyone who can save a layout. The
  cost is that a new metric needs a server change. That is the right trade for a number somebody
  will make a decision on.
- [x] **Four widget shapes, not fourteen widget components** — `STAT`, `SERIES`, `BREAKDOWN`,
  `TABLE`. The tenth widget type needed no new UI at all.
- [x] **Sharing publishes a layout, never data.** Every widget resolves against **the viewer's**
  project scope, so two people opening the same shared dashboard can legitimately see different
  numbers, and publishing one can never leak a project the viewer could not already open.
- [x] **A widget that cannot compute says so** — `unavailable`, never a zero. "No overdue work"
  and "I could not check" are opposite messages and look identical as `0`. Each tile resolves in
  its own try/catch, so one bad tile cannot take the page down.
- [x] **Scheduled delivery** — daily/weekly/monthly email to recipients with no account, because
  the stakeholder who wants this report is exactly the person who will never log in. Resolved **as
  the subscription's owner**, and **self-deactivating when that owner leaves**: a departed
  employee's report still mailing figures outward for months is the failure worth designing
  against. `lastSentAt` guards the cadence, so a restart or a double-fired cron re-sends nothing.
- [x] **Feature-aware product tour**, docs, the full V6 tier matrix, `VERSION` → 2.0.0.

**The verification pass was the most valuable part of this phase, and it did not go the way the
plan assumed.** Three defects surfaced, all in code already recorded as shipped.

- [x] **25 planning routes did not enforce the entitlement they belonged to.** The layer had
  consistently gated CREATE and UPDATE and missed almost every read plus a scattering of writes.
  With every planning switch off you could not create a request form but you **could delete one**,
  resend an approval email to an external reviewer, accept a submission, delete a blueprint, or
  record decisions on an AI proposal. The reads mattered for a second reason: `assertPlanningEnabled`
  also checks the tier, so an ungated read is a **downgraded org still receiving the capability it
  stopped paying for**. All 25 now fail closed with the message naming which switch is off; the
  three deliberate exceptions (`/plan/my-work`, the dashboards router, and the token-authorised
  public approval routes) are documented as exceptions in the code rather than left to look like
  more of the same oversight.
- [x] **The ticket detail sheet grew two permanent tabs.** "Plan" and "Approvals" rendered
  unconditionally on the single most-used screen in the product. The panels themselves degrade
  properly to a "this is off, here is the switch" explainer — which is right when planning is on
  and a sub-feature is not, and wrong for a workspace that enabled none of it and now gets two
  tabs advertising features it does not have, on every ticket it opens. The triggers are now gated
  on the same flags the panels check.
- [x] **Proofing and saved views had shipped as backend only** — schema, service and routes
  existed and worked, with no UI for either. Proofing was the worse of the two because Workspace
  Settings carried a labelled "Proofing & annotation" toggle, so it read as a delivered feature
  while there was no way for a user to place a pin. Both UIs are now built: `ProofingPanel.tsx`
  (click the image to drop a pin, one-level threads, resolve as a toggle rather than a delete) and
  `SavedViewsBar.tsx` (named filter sets on the tickets page, personal or shared). The phase 2 and
  phase 4 entries above are marked `[~]` to record that they were over-reported at the time.

  **How this went unnoticed is the lesson worth keeping.** Every proofing route had tests through
  the API and every one passed. Nothing asserted that a route was reachable from the product, so
  four working endpoints with no caller looked exactly like a finished feature. The two specs
  added here drive the UI rather than the endpoint, which is the only version of the test that
  would have caught it.

**One honest exception to "toggles off changes nothing".** The nav diff against V5 found exactly
one new entry that appears with every switch off: **My work**. That is deliberate — a personal
queue over ticket dates that already exist, useful on the lowest tier with no setup — but it made
the sweeping claim in the changelog false, so the claim was narrowed to what is true rather than
the feature quietly gated to protect the sentence.

**Upgrade safety, verified rather than asserted.** The property a customer's upgrade depends on is
invisible in development, where every database is born with the new migrations already in it. So
it was tested directly: a database built to the last V5 migration, populated with V5-era roles,
the exact eleven V5 permission keys and tickets across three statuses — then upgraded. The five
new permissions landed on the **existing** roles, every V5 grant was untouched, all tickets mapped
onto the default workflow with `status` and `legacyStatus` agreeing on every row, no existing
column moved, and every new toggle came up off. Re-running the migration was a clean no-op, which
is what makes an interrupted deploy recoverable.

Verified: 329 unit tests; 188 passing Playwright tests (10 skipped) across all five viewport projects; a 54-migration replay into an empty database; a V5-to-V6 upgrade simulation with V5-era data; and a live toggles-off probe of every planning route.

## Operator surfaces + the face-verification repair (2026-08-03)

Four pieces of work that share a theme: each one existed already and did not answer the question
people were actually asking of it.

### Face verification — diagnosed from the data, not from assumptions

It was failing more often than it was passing, and the cause was not where anyone would have
looked. The attempt log said so plainly once it was read:

| Outcome | Count |
|---|---|
| **CHALLENGE_FAILED** | **107** |
| PASSED | 69 *(every one at similarity exactly 1.000)* |
| NOT_ENROLLED | 40 |
| NO_FACE | 37 |
| MULTIPLE_FACES | 21 |
| NO_MATCH | 10 *(0.52–0.82)* |

- [x] **The head-turn challenge was the largest cause, not the face match.** Recorded yaw deltas on
  the failures were 0.02–0.26 radians against a 0.35 requirement, while the passes reached
  0.56–0.74 — so the sensor was fine and people were genuinely under-turning. The instruction was
  static text and the gesture frame was grabbed on a fixed 3-second countdown, which caught anyone
  who turned early and relaxed, or who was still moving. It is now a live meter that fills as the
  head turns, firing at the **peak** of the rotation. The requirement is unchanged and the server
  still measures it independently; the client is simply told the threshold so the meter cannot
  promise something the enforcement then refuses.
- [x] **The adaptive per-user threshold could ratchet out of reach permanently.** It is computed
  from that user's own passing history — and seeded or automated rows score exactly 1.000, which no
  live camera produces. An earlier fix caught the entirely-synthetic case (variance exactly zero)
  but not the realistic mixed one, where variance looks healthy and the mean has been dragged to
  ~0.98. Because only passes feed the distribution, somebody locked out this way had **no route
  back from inside the product**. Non-live scores are now excluded before anything is computed.
- [x] **Enrollment stored one pose four times.** The "burst" was four frames 280ms apart; nobody
  moves meaningfully in under a second. Replaced with a guided four-position wizard. It never says
  "left" — Human's yaw sign is uncalibrated in this codebase, so it asks for one side and then the
  other and enforces only that they are opposite. Naming a direction we cannot verify would mean
  telling half the users they did it wrong when they did it right.
- [x] **Hands-free capture worked only in Chromium.** It relied on `window.FaceDetector`, which
  Firefox and iOS Safari do not implement — so on most phones every frame was taken manually at a
  moment of the user's choosing, which is exactly how blurry off-angle frames reached the server.
  Now driven by the shared tracker, which also measures blur: a large, centred, confidently-detected
  face can still be motion-blurred, and that is what silently becomes a low similarity score.

**No Python, no new service, and that was a decision rather than a default.** A separate ML service
would mean a second runtime, a second model, and embeddings mathematically incomparable with the
262 already stored — the `FACE_MODEL_VERSION` guard exists precisely to stop that comparison
happening by accident, and the cost would be that everybody re-enrols for no accuracy gain. The
browser now runs the same library the server already used, loading **only** detection and head
pose (2.1MB, lazily, from our own origin so air-gapped installs keep working). The embedding and
the match stay server-side, because a client that decides its own verification outcome is not a
security control.

### User management, AI usage, and a status page

- [x] **User management** gained filters, real pagination and bulk actions. Two silent bugs
  surfaced on the way in: `GET /users` was capped at 50 rows and feeds every picker in the product,
  so orgs past fifty people had dropdowns that omitted most of them; and the shared table's card
  layout repeats each column header per row, so a select-all checkbox rendered once per card.
- [x] **Per-feature AI token consumption**, cumulative and daily. Reported in tokens rather than
  dollars: the cost figure is an estimate from a price table that moves, and is simply wrong for
  BYOK customers with negotiated rates.
- [x] **A status page with a memory** — 13 feature-level probes every five minutes, a day-by-day
  strip, uptime, and a recorded incident log. The existing Server health panel reports the box as
  measured right now; this reports the features over time, which is what somebody means by "was it
  down on Tuesday". A day is coloured by its **worst** check, because averaging is how a two-hour
  outage becomes a 96%-green day, and a day with no samples is grey rather than green, because
  reporting absence of monitoring as success is the one lie a status page must never tell.

**The recurring lesson across all four.** Every one of these was a case of a surface that answered
a *nearby* question convincingly enough that nobody noticed it was the wrong one — a health panel
that reported CPU when the question was "can I submit", a usage panel that reported spend when the
question was "spend on what", a user list that searched a page while appearing to search a company,
and a face check that reported "no match" when the actual failure was a head turn nobody could see
the target of. In each case the fix started by reading what the system had already recorded rather
than by reasoning about what it should do.

Verified: 331 unit tests; 221 Playwright tests across five viewports plus Firefox (Gecko) and WebKit (Safari); a 54-migration replay into an empty database; a V5-to-V6 upgrade simulation; the multi-tenant migration runner against two real tenant databases; and a live incident drill.
