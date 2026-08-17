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
  cannot leak across tenants](../README.md#ai-and-every-other-per-org-setting-cannot-leak-across-tenants--by-construction-not-by-filter).
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
- [x] **MCP server** (2026-08-08) — `POST /api/mcp` (`controllers/mcp.controller.ts`,
  `middleware/mcp-auth.ts`, `services/mcp.service.ts`, `services/mcp-tools.ts`), 11 tools bounded by
  one user's permissions, off by default with writes off individually. The integration surface that
  needed no integration built for it: a customer points their own assistant at the URL. See the
  [dated entry below](#timesphere-as-an-mcp-server--read-only-until-asked-otherwise-2026-08-08) and
  [docs/API.md § MCP server](API.md#mcp-server).
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
- [x] **SARIF ingestion adapter** — shipped: `POST /api/devops/:orgSlug/findings/sarif`
  (`devops-webhook.controller.ts:271`), sharing its finding handler with the native-JSON
  `/findings` route (`:102`, `:154`) so the two cannot drift. Ticked 2026-08-08 after an audit
  found the item open against code that already existed.
  *As originally scoped:* — `POST /api/devops/:orgSlug/findings/sarif` (or content-type
  sniffing on the existing `/findings` route) accepts a raw SARIF 2.1.0 document and maps its
  `runs[].results[]` into the existing `SecurityFinding` shape — GitHub Code Scanning,
  `codeql-action`, `semgrep --sarif`, and Azure DevOps' native scan output all land with zero
  hand-written `jq` translation, closing the single biggest onboarding-friction gap vs.
  GitHub/Azure's built-in code scanning.
- [x] **Finding-level auto-reopen** — shipped: `maybeReopenTicketOnRegression` is now called on
  a new finding (`devops-webhook.controller.ts:138`) as well as on a failed test run (`:349`),
  which is exactly the "beyond failing TestRuns" this asked for. Ticked 2026-08-08.
  *As originally scoped:* — extend `autoReopenEnabled`'s trigger beyond failing
  `TestRun`s to "a new/reintroduced finding lands against a RESOLVED/CLOSED ticket's linked
  repo+branch," mirroring Black Duck's Jira-plugin `BOM_EDIT`-triggered reopen. Same
  `security-report.service.ts` function (`maybeAutoReopen` or equivalent), one more call site.
- [x] **Severity/policy-based ticket auto-creation** — already shipped: any CRITICAL/HIGH finding
  with no `ticketKey` match auto-creates a `SECURITY`-type ticket (`maybeAutoCreateTicketForFinding`
  in `security-report.service.ts`), assignee resolved through the existing `ModuleAssigneeRule`
  chain, same `dispatchTransactional` notify path already wired. Verified during this phase's
  research pass — no new code needed here.
- [x] **CODEOWNERS/last-committer assignment fallback** — shipped:
  `maybeAssignFindingViaCodeowners` (`security-report.service.ts:390`), called from the assignment
  chain at `:333`, with a `codeownersAssignEnabled` switch (`settings.controller.ts:575`).
  Ticked 2026-08-08.
  *As originally scoped:* — when no `ModuleAssigneeRule` matches a
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

Verified: 331 unit tests; **226 Playwright tests, 10 skipped, 0 failed** across seven projects —
five viewport sizes on Chromium plus Firefox (Gecko) and WebKit (Safari/iOS); a 54-migration
replay into an empty database; a V5-to-V6 upgrade simulation; the multi-tenant migration runner
against two real tenant databases; and a live incident drill that opened, accumulated and closed a
real outage record.

Two earlier runs of that suite reported failures and neither was a product defect — one was a
network interface change on the machine mid-run, the other was this session editing API source
while the suite was running, which restarted the server under it and produced 502s. Both are
recorded here rather than quietly dropped, because "the suite went red twice" is a fact about this
work, and the reason it is not a fact about the product is only knowable because each one was
re-run rather than assumed.

## Reports people can take away, and every date control rebuilt (2026-08-05)

Two programs in one pass: the reporting layer grew from "a CSV of whatever fits" into filterable,
grouped, multi-format exports with an analytics panel derived from the same query; and every date
input in the product — pickers, ranges, and the month calendar — was rebuilt on one accessible
foundation styled after Untitled UI's date components.

### Reports: three formats, one query, and numbers that refuse to guess

- [x] **Filterable exports in CSV, PDF and Excel.** All three formats — and the on-screen grouped
  report — are fed by one shared `buildTimesheetWhere` + include set, so the four surfaces cannot
  disagree about which rows a filter matches. CSV carries 22 columns (identity, hierarchy, hours,
  status, rate-snapshot billing, approval trail); Excel is a real workbook with a summary sheet,
  not a renamed CSV.
- [x] **The PDF stopped lying.** It renders a bounded number of rows for size, and previously did
  so silently — a truncated export that looks complete is worse than no export. Now the header and
  footer both state the cut, and every export route returns `X-Report-Truncated` /
  `X-Report-Rows-Included` / `X-Report-Total-Matching` headers so a machine consumer can tell too.
- [x] **A grouped report** (by person, project, activity, or day) with share-of-total columns,
  using largest-remainder rounding so the shares sum to exactly 100 rather than 99.9 or 100.1.
- [x] **Analytics against the entries: utilisation, approval latency, activity mix.** Utilisation
  compares logged hours to each person's *contracted* capacity; approval latency measures
  submitted→decided (which needed a `submittedAt` column backfilled by migration, because
  `updatedAt` moves for reasons that are not submission); activity mix shows where the hours went.
  The rule throughout is **null, never zero**: a person with no capacity on file has no
  utilisation figure rather than an alarming 0%, an entry that predates `submittedAt` has no
  latency rather than a fictional instant approval, and a cost without a rate snapshot is absent
  rather than free. Zero is a measurement; null is an admission — conflating them is how
  dashboards go quietly wrong.

### Every date control, rebuilt once, on React Aria

The ask was Untitled UI's calendar, range-picker and date-time components. Their package needs
Tailwind v4.3 and this app is on 3.4 — adopting it verbatim meant a framework migration across
every screen. The decision (taken with the user): build on the same primitive Untitled UI itself
uses — React Aria — and style it with this app's own HSL tokens. Same keyboard model, same
screen-reader semantics, dark mode for free, no migration.

- [x] **Three shared components** (`ui/calendar-primitives.tsx`, `ui/date-picker.tsx`,
  `ui/date-range-picker.tsx`): a single-date picker, a date-time picker whose slot column always
  includes the value it was handed (a picker that cannot express its own value is broken by
  construction), a segmented time field for free-form HH:mm entry, and a range picker with nine
  presets computed at open time — computing them at module load would freeze "today" overnight.
  All dates are `CalendarDate` (no time, no zone), the same class of fix as `localIsoDate()`.
- [x] **Fifteen inputs across ten files** replaced native date/time inputs: reports, analytics,
  history, workload, admin windows, attestation periods, the timesheet entry form, maintenance
  scheduling, ticket planning, and the dashboard timeline date.
- [x] **The month calendar restyled** to the reference's visual language with two deliberate,
  documented divergences: chips are coloured by delivery state (the product's meaningful axis, so
  a wall of amber reads as a review bottleneck from across the room), and the week starts Monday
  because every weekly figure in the app keys weeks to Monday — a calendar that disagrees with
  the reports about which week a Friday belongs to would be the worse infidelity. Scheduled work
  keeps its coloured chip; an SLA-only date keeps its dashed outline, because dressing a deadline
  as a plan is the exact lie this calendar exists to avoid.

**What the new tests caught before anyone else did.** The range picker's trigger label was derived
from the draft state, so choosing a range and pressing Cancel left the trigger describing a range
that had never been applied — my own new spec caught it on first run. WebKit found two more: month
headings were parsed with `new Date("August 2026")`, which Safari's engine correctly refuses
(every comparison against an invalid date is false, so the stepper always walked forward until it
disabled itself), and the popover re-anchored on every 5-vs-6-week-row height change, so clicks
queued forever behind a repositioning animation. The grid now has a fixed minimum height and the
test helper does integer month arithmetic. All three are the same lesson this file keeps
recording: dump the real DOM and read the real error before writing the fix.

**Verified:** the full seven-project gate — 258 tests, Chromium at five viewport sizes plus
Firefox and WebKit — ran 18.5 minutes: 246 passed, 11 deliberately skipped, one failed. The
failure was the suite auditing itself, and it is the best bug in this section: the onboarding-gate
spec asserted that **no** account has a null `onboardingCompletedAt`, which was true on the day of
the backfill migration and became false the day three real colleagues were added to the workspace.
An account created *after* the gate shipped is legitimately un-onboarded until its owner first
signs in — that is the gate doing its job, not a lockout — so the assertion now scopes itself to
accounts that predate the migration's own timestamp, which keeps it true forever while still
catching the only failure it exists to catch: a pre-gate account the backfill missed. Re-run
green. The three new accounts will meet the onboarding flow at first sign-in, which is what it is
for.

### Post-merge fixes: the first CD run, and face training that reports itself (2026-08-05)

Merging to `main` triggered the image-publish workflow for the first time ever — it fires only on
`main`, and `main` had never been pushed to — and its first run failed in `npm install` inside
both Dockerfiles. The root `postinstall` builds `packages/shared`, and the dependency layer holds
only manifests: no sources, no `tsconfig.base.json`. Reproduced locally in a scratch directory
holding exactly the five files that layer copies; the postinstall now skips itself, stating why,
when the shared sources are absent. The lesson worth keeping: a workflow that has never fired is
untested code, whatever CI says about the rest.

Two face fixes in the same pass: "View capture" opened the authenticated image route in a new tab
— no bearer token travels on a navigation, so every admin got a JSON 401 (the code's own comment
on `downloadEvidencePack` already stated the rule; the button predates it) — it now fetches the
blob with credentials and renders in-app, with an e2e that asserts the image actually decodes.
And enrollment became visible training: per-shot verdicts returned by the server, a persistent
training report, the face-model size on the card, and a retrain nudge for pre-wizard single-angle
enrollments — the measured cause of the 0.80–0.84 marginal scores. The verification-log failures
the user reported all predate the 2026-08-03 hardening (zero attempts since), so the fix for them
is retraining on the fixed pipeline, not another threshold change.

### Follow-up (same day): passwords nobody else knows, and an honest camera escape hatch

- [x] **Admin resets stopped defaulting to `Admin@12345`** — a default documented in this repo's
  own README is not a password. Resets now generate a random one-time password per person (shown
  to the admin exactly once, stored only as a hash; bulk resets return one per person with a
  copy-all dialog), and every admin-set password — creation, reset, CSV import — flags the account
  with a "choose your own password" banner until the person changes it. A banner and not a modal,
  because forced modals produce old-password-plus-a-"1", not better passwords. Verified end to end
  by API-level e2e: generated password signs in → flag is true → change-password → flag clears.
- [x] **Insecure-context face bypass** (super-admin toggle, default off): browsers refuse the
  camera on plain http and no server setting can lift that, so a LAN pilot could never complete a
  check. The bypass records every pass-through as a `SKIPPED_INSECURE` attempt (amber in the
  review log, own filter, audit entry) and is re-checked when the skip is spent, so switching it
  off closes the hole immediately. The client's "I can't open the camera" claim is unprovable
  server-side — the toggle trades enforcement for visibility, explicitly, and the doc says so.
- [x] Smaller: emailed links documented against `APP_BASE_URL` (a reset link built on localhost
  only opens on the server itself); a worked Microsoft 365 SMTP example in `.env.example`; the
  `npm run dev` startup proxy-error flood collapsed to one throttled line.

### HTTPS as a runbook, and a full-gate verification under it (2026-08-05)

The camera's secure-context requirement stopped being a documentation problem and became shipped
machinery: `scripts/make-lan-certs.{ps1,sh}` (mkcert CA + a certificate for every address the
machine answers on, dropped where both `npm run dev` and the new Caddy overlay already look) and
`docker-compose.https.yml` (LAN mode serving the mkcert pair; domain mode with automatic Let's
Encrypt). Replicating on a new machine is three commands, documented in DEPLOYMENT.md § "The
shipped runbook". The dev machine now serves https on localhost and its LAN address; the e2e
suite derives its base URL from the same signal vite uses (the cert files' existence), because a
suite pinned to http:// dies the moment the certs land — which is exactly how that lesson was
learned: the first post-cert gate was run while the flip was happening mid-run, and its "48 did
not run" was the suite talking TLS to a server still speaking http. An invalid run, discarded and
re-run rather than explained away.

The re-run under https: **251 passed, 11 skipped, 1 failed** — and the failure was real geometry,
not flake. The calendar grid's minimum height was sized to exactly six day-rows and no header, so
6-row months still overflowed it and the popover jumped ~28px on certain month transitions.
Chromium clicks through the wobble; WebKit's stability checker times out on it, but only under
load, which had made it read as flake twice before anyone measured it. Sized correctly (rows plus
header), the test passes 3/3 repeats on WebKit and all 13 picker tests stay green. Also this
pass: the acme tenant database was missing the morning's migration (`prisma migrate dev` only
touches the default DB — `migrate:tenants` is the step that walks every tenant, and the one-click
updater already runs it), and `fresh-checkout-org` was archived, silencing the per-worker skip.

### Follow-up: six git providers, one honest receiver — and three small truths (2026-08-05)

- [x] **Branch/PR auto-sync beyond GitHub**: GitLab, Bitbucket Cloud, Gitea, Forgejo and Azure
  DevOps now feed the same receiver — one shared webhook secret, each provider verified in its
  own dialect by a pure translation module (`git-webhook-providers.ts`, 9 unit tests) and synced
  by one provider-blind handler. Driven end-to-end in e2e: a GitLab push creates the Dev-tab row,
  a Gitea merged-PR upgrades the same row (never a second one), wrong credentials 401, unknown
  providers 404. Deliberately excluded, with reasons in the docs: AWS CodeCommit (AWS closed it
  to new customers July 2024) and SourceForge (no usable webhook API). Azure DevOps signs
  nothing, so its verification is stated as the weaker secret-in-transit scheme it is.
- [x] **A duplicate `npm run dev` now explains itself and exits** instead of leaving a half-dead
  stack per invocation (crashed API + a Vite on the next port proxying to the survivor).
- [x] **The face wizard's five buttons became the right two** — the capture surface was rendering
  a dead "Start" beside the wizard's real one, and two Cancels — and the training report now
  fits a 360px phone (rejection reasons wrap on their own line). Both verified by a new
  phone-width spec that opens the wizard and counts the buttons.

### Follow-up: two questions the product couldn't answer about itself (2026-08-07)

Shipped as 2.1.0. Both themes started as a user question that the code could not answer, and in
both cases the investigation found the real cause was somewhere other than where it was reported.

- [x] **"Stop emailing managers and super admins the daily reminder"** — the reminder worker had
  *always* targeted only `EMPLOYEE`/`TEAM_LEAD` (`getTargetUsers()`), so the reported symptom could
  not have come from where it appeared to. It came from `bccSuperAdminOnAllEmails`, which copies
  every super admin on **every outbound email in the app** — every employee's reminder, every day —
  below any per-category gate. Fixed by giving delivery a third layer, a per-role mute matrix
  (`GlobalNotificationSettings.emailRoleMutes`, stored as the mutes rather than the ticks so a null
  column reproduces today's behaviour with no backfill), and by teaching the audit BCC to honour
  the SUPER_ADMIN row of it. Verified against a running install: a muted manager received the
  in-app notification and **no** `EmailLog` row, an unmuted employee received both, and a second
  org with no mutes was unaffected.
- [x] **Six notification categories had no user interface.** `emailTicketAssigned`,
  `StatusChanged`, `Commented`, `SlaBreach`, `Escalation` and `ClosedDigest` were in
  `notificationPreferenceKeys` and enforced by `dispatchNotification`, but no screen rendered them
  — a direct DB write was the only way to change one. Found by diffing the shared key list against
  the UI's row list rather than by reading either. A type-level assertion in `WorkspaceSettings.tsx`
  now fails the build if a key ever lacks a row again, because the same class of gap is invisible
  by construction.
- [x] **Two screens could each look authoritative about the same switch** — the ticket-closed and
  weekly-security digests were toggleable from both Email channels and the Security/DevOps card.
  The second is now a status badge pointing at the first.
- [x] **"Why was it slow, and on which server?"** — new `ApiRequestSample` telemetry: opt-in,
  sampled, buffered, flushed in batches, route-pattern keyed, pruned nightly. `dbResponseTime` is
  real (an AsyncLocalStorage bucket filled by a Prisma `$allOperations` extension), not estimated.
  Two deliberate limits are documented rather than papered over: host CPU/RAM/disk come from a
  ~15s snapshot and so describe the machine *around* a request rather than during it, and the
  buffer drops-and-counts past its ceiling rather than growing. Verified on a running install —
  22 samples, 0 dropped, 0 failed, real percentiles and a real average DB time.
- [x] **The approvals queue showed less than it already had.** Module, submodule, notes and task
  description were on the wire the whole time and simply weren't rendered; the fix needed no schema
  change. Search, filters, date range, per-entry export and a mobile detail dialog were added
  around them. The 100-row cap was left alone but is now *stated* in the UI instead of silently
  implying there is nothing older.
- [x] **"Does 'Mark reviewed' retrain the face model?"** — no, and it never did: it clears the flag
  and records who looked. There is no adaptive re-enrollment anywhere in the product. Documented in
  CHANGELOG and docs/FACE_VERIFICATION.md because the expectation is reasonable and acting on it
  wastes real review time. Three genuine defects surfaced while confirming it: `LOW_QUALITY` was
  missing from the outcome filter, `SKIPPED_INSECURE` was persisted but absent from the outcome
  union, and `reviewNote` was storable by the API but unreachable from the UI.
- [x] **Smaller truths**: the timesheet form's failed submit looked like a dead button because
  every select is a custom control the form library holds no ref for, so its built-in error focus
  silently did nothing — now driven off `aria-invalid` instead, which survives fields being
  reordered.

**Process note, recorded because it cost real tokens:** two parallel agent dispatches were
malformed and silently launched duplicates of an already-running task instead of the intended one.
Both duplicates detected the collision themselves and stood down rather than shipping competing
implementations — one had already written a second `CREATE TABLE` migration that would have been
unapplyable. Nothing was lost, but the failure was silent at the dispatch site, which is the part
worth remembering.

### Security audit: authentication, authorization and tenant isolation (2026-08-07)

A full pass over auth, authorization and multi-tenant isolation, prompted by one question — "if two
organizations disagree about this value, can both be right at once?" — which turned out to have the
wrong answer in several places. Every fix below has a test that fails against the pre-fix code and
passes after; the negative results are recorded too, because "we looked and it was fine" is worth as
much here as a finding.

#### Fixed

- [x] **`/uploads` served every tenant's attachments unauthenticated.** `express.static` over the
  storage root, filenames of the form `${Date.now()}-${originalName}` (guessable, not a capability),
  and no organization segment at all — one flat directory for the whole platform. Confirmed by
  experiment, not by reading. Now HMAC-signed, expiring, org-bound URLs minted at the API boundary
  by wrapping `res.json`, so no controller can forget to sign one. Guest reviewers
  (`approval.controller.ts`) still work with no special case: their authorization is checked when
  the payload is built, and the signature carries that decision to a static request that has no
  session. Existing files were NOT moved; legacy flat paths still resolve.
- [x] **Biometric captures were readable at `/uploads/face/<orgId>/<userId>/<file>`**, in direct
  contradiction of `face.service.ts`'s own documented contract, bypassing the authorization on
  `GET /face/image/attempt/:id`. Guarded by path containment against the resolved face directory —
  not a `/face` string match, so it survives `STORAGE_FACE_DIR` relocation.
- [x] **Half-written uploads were publicly readable** — multer's temp destination was inside the
  served tree. Now a staging directory inside the non-public subtree.
- [x] **Login lockout was cross-tenant.** `failedLogins` keyed on email alone, and recorded a
  failure even for users that do not exist in the org — so five attempts against any org's login
  endpoint locked that address out of every org, unauthenticated and repeatable. Now keyed on
  `(orgId, email)` from the resolved tenant context, never from the request body.
- [x] **SMTP config leaked across tenants.** Five single-slot module variables held per-tenant mail
  config; org A's mail could go out carrying org B's From address, and the Mail-server banner showed
  another tenant's host, port, username and raw SMTP error with no race required. Now a per-org map
  with pool close-on-evict, and `invalidateMailTransportCache` scoped to its caller.
- [x] **Six ticket routes bypassed project scope.** `canModifyTicket` returns true for any
  `TICKETS_ASSIGN`/`TICKETS_MANAGE` holder, so a TEAM_LEAD on project A could retitle, transition,
  reassign, unassign or soft-delete any ticket in the workspace, and `GET /suggest-assignee`
  returned any project's member roster to a plain EMPLOYEE. All six now call `assertTicketVisible`,
  which the other 22 sub-resource routes already did.
- [x] **Project roster disclosure** — `GET /projects/:id/assignments` had `requireAuth` only while
  `visibilityScope()` sat unused in the same file. Any authenticated user could read name, email,
  status and role for any project. Predicate moved into the WHERE clause; 404 rather than 403, so
  whether a project exists is not itself disclosed.
- [x] **Sessions outlived their accounts.** `refresh()` never re-checked the user, and neither SCIM
  deprovision nor single-user delete revoked — so a removed account kept minting token pairs for the
  session's full life. Refresh now revokes on a deleted/inactive account rather than merely refusing.
- [x] **Admin password reset did not evict the attacker** it was being used against. Both admin paths
  now revoke every session, matching what the self-service and emailed-reset paths already did.
- [x] **Per-IP rate limiting was one shared bucket behind a proxy.** `trust proxy` was never set, so
  `req.ip` was the proxy's address for every caller and the 20/min login limiter throttled the
  planet as a unit. Now `TRUST_PROXY_HOPS`, a hop COUNT rather than a boolean — `trust proxy: true`
  believes the client-supplied left-most `X-Forwarded-For` entry and hands `req.ip` forgery to
  anyone who asks. Defaults to 0; **every proxied deployment must set it.**
- [x] **GitHub proxy routes were `requireAuth` only** and decrypt the org's OAuth token — any session
  could enumerate private repo names, branches and PR titles. Gated on `TICKETS_WRITE` rather than
  super-admin, because the ticket branch picker is the real consumer. Noted honestly in the code:
  all five seeded roles hold that permission, so this only bites tenants who have narrowed a role.
- [x] **Webhook replay**, where it is a real hole rather than theatre: GitHub and the five other git
  dialects (delivery-id required, deduped after HMAC verification so an unsigned caller cannot evict
  genuine ids) and Slack. Deliberately NOT added for SCIM, devops, Teams, Google Chat, GitLab or
  Azure DevOps — in each the credential travels with the request, so whoever captured a delivery can
  mint fresh ones and a nonce store proves nothing. Rotation is the control there.
- [x] **Guest and public tokens were stored in plaintext** — a database read disclosed live
  capabilities. Now SHA-256 digests, following `attestation-public.controller.ts`, with a 30-day
  expiry on guest approval links. Phase 1 of two deliberately: the plaintext columns and a fallback
  lookup are retained so a code rollback cannot strand every outstanding approval link.
- [x] **`POST /approvals/steps/:stepId/resend` minted a working guest link for any step id** with no
  scope check, contradicting its own file header. Now scoped, with an identical 404 for "no such
  step" and "not your project".
- [x] **`Math.random()` generated face image filenames** — not a cryptographic source, and those
  names were the only thing between an unauthenticated request and a biometric image.

#### Open — reported, not fixed

- [ ] **Phase 2 of token hashing**: drop `ApprovalStep.guestToken` / `RequestForm.publicToken` and
  the plaintext fallback, once the hashed columns have been live long enough that a rollback is no
  longer plausible.
- [x] **SSO/OAuth hardening** (2026-08-08), all three parts:
  - **`algorithms` now pinned** on both state verifies (`sso.service.ts`, `git-provider.service.ts`),
    and on the matching signs. Never exploitable with a string secret under jsonwebtoken 9 — the
    inferred set is HMAC-only — but it was the one place the rule `utils/security.ts` states for
    every other verify was not followed, and rules that hold "almost everywhere" are how the next
    key type sneaks in. `tests/unit/oauth-state-hardening.test.ts` mints an HS512 state with the
    same secret — accepted before, refused after — and 6 of its 8 cases fail pre-fix.
  - **The GitHub connect `state` is single-use.** It now carries a `jti` that
    `verifyGitConnectState` spends through `services/webhook-replay.ts`'s bounded TTL store, with
    the same identical error for "already spent" and "never valid". A state that leaked the way
    redirect URLs leak was replayable for its whole 10 minutes to bind an ATTACKER's GitHub token
    into the victim's workspace. PER PROCESS, with that module's stated caveats; a state minted
    before the claim existed is refused, so a connect in flight across a deploy costs one click.
  - **SAML `validateInResponseTo` is on, set to `always`.** node-saml's own InMemoryCacheProvider
    could not be used: `buildSamlClient` builds a fresh `SAML` per call, so the request id would be
    saved into an object already garbage by the time the ACS POST arrived and every login would
    fail. It is backed instead by a shared, org-scoped, 10-minute store in `sso.service.ts`.
    `always` rather than `ifPresent` because `ifPresent` is bypassed by deleting one attribute —
    and it breaks nothing, since IdP-initiated SSO is ALREADY impossible here (the ACS route
    refuses any POST without a RelayState we signed). `tests/unit/saml-response-replay.test.ts`
    drives the real flow — build the redirect, dig the AuthnRequest id back out of it, POST an ACS
    response — and all 9 of its cases fail against the pre-fix service, which has no store to
    check against at all.
    **Single process only** — an AuthnRequest issued by one Node process and answered at another
    would fail to validate. Unlike the webhook store that is a failed LOGIN, not a missed replay
    catch, and it is the first thing to revisit if this ever runs behind more than one process.
- [x] **Unauthenticated org-slug enumeration** (2026-08-08). Fixed in `middleware/tenant.ts`, NOT at
  the webhook entry points: the `/:orgSlug` receivers are the cheapest oracle but not the only one,
  since `resolveTenant` takes the slug from a `Host` header the caller equally controls — fixing
  only the receivers would leave the same walk available one route over. `resolveActiveOrgBySlug`
  now answers unknown / suspended / provisioning with one identical 404, and takes an optional
  `req` so the real 403/503 survives for a caller holding a valid access token whose `org` claim
  matches — signature only, since by definition the tenant database is not reachable on that path.
  `tests/unit/tenant-slug-enumeration.test.ts`: 7 of 10 cases fail against the pre-fix middleware.
  Stated honestly, and NOT claimed as fixed: an ACTIVE workspace still answers requests, so a
  correct slug reaches a login form and a wrong one does not. What is closed is the LIFECYCLE STATE
  of workspaces that are not serving traffic. The "DSN decrypt per guess" in the original finding
  was also overstated — the decrypt happens in `resolveTenant` only AFTER the status check passes,
  so it was never reached by a guess at an unknown or suspended slug.
- [x] **`GET /ai-proposals` was unscoped** (2026-08-08). `tickets:view` is held tenant-wide by every
  non-viewer role, so it gated nothing: any employee listing proposals saw every project's pending
  plan changes and the model's reasoning for projects they cannot open. Now filtered through
  `ticketProjectScope`, the same helper `GET /risk` in that file already used, with workspace-wide
  proposals (null `scopeProjectId`) matched on authorship so you still find what you requested.
  `tests/unit/ai-proposal-scope.test.ts` drives the real router and asserts the `where` reaching
  Prisma — 3 of its 5 cases fail against the pre-fix route.
- [ ] **The wider fetch-then-don't-check set** — same shape as the six ticket routes, but each needs
  a product decision on the intended boundary: `approval.controller.ts` `DELETE /:id` (hard delete
  straight from `req.params`, while both siblings scope correctly), ~~`ai-proposal.controller.ts`~~
  (**closed 2026-08-08** by the AI-surface audit below — apply/reject/decisions are scoped and the
  change rows are bound to the proposal in the URL), `request-form.controller.ts` (unscoped submission inbox under a
  permission EMPLOYEE holds), `timesheet.controller.ts` approve/reject (no `managerId` predicate —
  and its own `DELETE` sibling does check, so the file is inconsistent with itself), plus the
  `resource`, `ai` and `report` controllers.
- [x] **`GET /blueprints` is workspace-wide — and that is now decided, not merely suspected**
  (closed 2026-08-09). Originally listed as part of the set above, but `Blueprint` has NO project
  relation at all (`schema.prisma`): name, kind, payload, createdBy — nothing to scope it *by*, so
  it was never the same class of bug as the ticket routes. The product question it left open
  ("should a template library be visible to every role holding `tickets:view`?") got its answer
  when `/app/blueprints` shipped: the page deliberately lists at `tickets:view` (a viewer sees the
  shapes, with no dead buttons) and gates *using* one — propose, create, derive, delete — on
  `plan:write`, checked inside the page. The route comment in `App.tsx` states the split. A
  template library is reference material; instantiating it is a plan change.
- [x] **Unbounded module maps** (2026-08-08). Both swept on write — no timer, and no per-entry timer
  least of all, since one live timer per email an attacker types is the same unbounded growth
  wearing a different hat. Entries are re-inserted with a constant TTL, so insertion order IS
  expiry order and the first live key ends each scan. `failedLogins` gets a 15-minute window that
  doubles as the counter's decay (four failures a fortnight ago should not combine with one today),
  deliberately longer than the 5-minute lock so an entry always outlives the lock it holds;
  `lastSeenWrites` drops anything older than its own 5-minute throttle, past which the next request
  writes anyway. **No hard entry cap on `failedLogins`, on purpose**: every eviction rule hands an
  attacker the same primitive — flood the map until the victim's ARMED lockout is the one evicted.
  The bound is the TTL times what the rate limiters allow through. `tests/unit/auth-memory-sweeps.test.ts`
  (4 of 8 cases fail against the pre-fix maps; the other 4 pin that the lockout semantics and the
  liveness throttle did not move, alongside the untouched `auth-login-lockout.test.ts`).
- [x] **Minor (code)** (2026-08-08).
  - Slack's `url_verification` handshake is answered AFTER the tenant lookup and the signature
    check. Slack signs it like every other delivery, so verifying first costs nothing — while
    answering first made the route an unauthenticated reflector for attacker-chosen text, naming
    any workspace or none. Ordering consequence, stated: the integration must be saved with its
    signing secret BEFORE the URL is pasted into Slack's console.
  - The raw-body reads are `Buffer.isBuffer(...)`-guarded, not `?? Buffer.alloc(0)` — the sibling's
    `??` misses a parser that handed back a plain object, whose `.toString()` is "[object Object]"
    and whose `JSON.parse` is the same 500 one header earlier. Malformed JSON is now a 400.
  - The three length-pre-checked comparisons (`devops-webhook`, `scim`, `chat-webhook`) use
    `utils/security.ts#constantTimeEqual` — `git-webhook-providers.ts`'s `safeEqual` MOVED there
    rather than exported from it, so SCIM does not import the git module and there is still exactly
    one implementation. `tests/unit/shared-secret-compare.test.ts` observes the real
    `timingSafeEqual` calls (the difference is invisible in the response and flaky to time): 6 of
    12 cases fail against the pre-fix controllers, where a wrong-length guess never reached a
    constant-time comparison at all. The two fixed-length HMAC comparisons in the same request
    path (Slack's and GitHub's signature checks) were converted along with them — a hex digest's length
    leaks nothing, so that is tidiness, not a fix: it leaves ONE comparison idiom in the request
    path instead of two that a reader has to tell apart. `utils/file-url.ts`'s is deliberately
    untouched — different module, its own documented reasoning, and not part of this finding.
  - `tests/unit/webhook-request-hardening.test.ts` covers the first two: 7 of 10 cases fail before.
- [x] **`docs/ARCHITECTURE.md` section 5's "bypasses tenant resolution" table was stale** — split
  out of "Minor" and fixed 2026-08-07: the four missing routes (`/api/git/webhook/:orgSlug`,
  `/api/git/callback`, `/api/billing/webhook`, `/api/scim/:orgSlug/v2/Users*`) are listed, with a
  note on what is deliberately NOT bypassed.
- [ ] **Tenant connection ceiling**: `config/prisma.ts` permits 50 cached clients x 5 connections =
  250, against a MySQL `max_connections` of 151 (measured on the dev host). Roughly 30
  concurrently-active organizations exhausts it, and it will present as random query failures rather
  than as anything connection-shaped.
- [ ] **Adaptive match threshold rejects genuine users.** Measured: 3 of 10 real-browser `NO_MATCH`
  results scored at or above the configured 0.75 and were rejected by `effectiveMatchThreshold`'s
  per-user tightening, which can only ever tighten. With genuine live scores averaging 0.709, a user
  who has drifted upward can effectively never pass again. Re-check with `npm run eval:face`.

## TimeSphere as an MCP server — read-only until asked otherwise (2026-08-08)

The workspace could already be *called* by a script (the public REST API) and could already *call*
a model (`ai.service.ts`). What it could not do is let somebody's own assistant work with it —
"what's in my approval queue?", "log two hours against WEB for the payment refactor" — without a
human retyping the answer into a form. `POST /api/mcp` closes that: JSON-RPC over Streamable HTTP,
which is the transport the hosted clients this exists for actually take (they are configured with a
URL; they cannot spawn a process on this server, so stdio would have served only a developer's own
laptop).

**The direction is the thing to hold onto.** This is the server half. `ai.service.ts` is the app
calling a model and shares no code with it — the MCP server calls no model at all, spends nothing
from the AI budget, and works with AI switched off entirely.

- [x] **The credential is a person, not a key.** `middleware/public-api-auth.ts` authenticates an
  `ApiKey` to `{id, scope}` with no acting user, which a coarse read API can live with. Tools that
  ACT cannot: `requirePermission`, `ticketProjectScope`, `assertTicketVisible`, `canModifyTicket`,
  `team.controller.ts`'s `managerId` predicate and `project.controller.ts`'s `visibilityScope` all
  decide from `req.user`, so a caller without one would have to skip every one of them — and an MCP
  client that skips the RBAC model is an MCP client with more authority than the person who set it
  up. `McpCredential.userId` is therefore required, and `resolveMcpPrincipal` builds the identical
  `RequestUser` shape `requireAuth` does, role and permissions loaded in full. Offboarding is
  covered twice over: `ON DELETE CASCADE` on the account, and a per-request re-read that refuses a
  deactivated one without any row changing.
- [x] **The registry cannot leak a handler.** `MCP_TOOLS` is exported as `McpToolSpec[]`, a type
  with **no handler field**, so outside `services/mcp-tools.ts` there is nothing to call and
  `invokeMcpTool` is the only path — the same failure mode `assertTicketVisible`'s comment
  describes for sub-resource routes, closed by the compiler rather than by review. Enablement, the
  write latch, the permission (through the *same* `requirePermission` factory the REST routes use,
  not a second copy of the rule) and argument validation are all settled before a handler runs.
- [x] **Three closed defaults, and they cannot skew.** Master switch off, workspace write latch
  off, and per-tool defaults of *reads on, writes off* — that third one is what makes a write tool
  added by a **future** release arrive disabled in every existing workspace instead of switching
  itself on during an upgrade. One predicate, `isToolEnabled`, backs both `tools/list` and
  `tools/call`, so a tool cannot be hidden from the list yet still callable by a client that
  guessed its name.
- [x] **A disabled workspace answers 404, not 403** — checked *after* authentication, so only a
  credential holder learns the difference, and every auth failure (unknown, revoked, deactivated,
  maintenance) returns one identical 401 so the endpoint cannot enumerate tokens or users.
- [x] **A fresh server per request, stateless transport.** Tool availability is per workspace and
  the acting user is per credential, so the tool list is a function of who is asking; a long-lived
  shared `McpServer` would have to mutate its registry per request — one race from listing tenant
  A's tools to tenant B — and, built outside any request, would sit outside the `AsyncLocalStorage`
  tenant context `prisma` resolves through. Construction is pure object graph, no I/O.
- [x] **The tenant is not an argument.** Mounted after the blanket `resolveTenant`, exactly like
  the public REST API, so the client's own URL carries the workspace. No tool accepts an org id or
  slug — pinned by a test that walks every `inputSchema`, not by a convention.
- [x] **Denials are auditable, including the ones this app never sees.** The MCP SDK answers a
  `tools/call` for an unregistered name with its own protocol error before any handler runs, which
  would have made a probe at a switched-off tool the one refusal that left no trace.
  `recordUnavailableToolCalls` inspects the JSON-RPC body first and writes the `mcp.tool_denied`
  row; the client's answer is unchanged.
- [x] **Logging time creates a draft and never submits.** Submitting starts an approval SLA clock
  and, where configured, requires an identity check — not something an assistant should do on
  somebody's behalf. It also goes through `timesheet.controller.ts`'s own `saveTimesheet`, so the
  overlap, future-date and project-assignment refusals are the same ones the UI gets.
- [x] **Untrusted content is marked, and the marking is not claimed to be a fix.** This app ingests
  attacker-authored prose on purpose (a stranger emails support@, that becomes a Ticket), so
  ticket-reading tools carry `UNTRUSTED_CONTENT_NOTICE`, an output warning appended to the
  description, and MCP's `openWorldHint`. Stated in the code: a determined injection can still be
  read. The controls that hold regardless are the ones the model cannot argue with — read-only by
  default, per-tool opt-in, one person's permissions.

Tests: `tests/unit/mcp-server.test.ts`, 18 cases across dispatch, permissions, tenant isolation,
per-tool enablement, read-only mode and the injection posture — including three that are
*structural* rather than behavioural (every shared-data tool names a permission; no tool takes an
org parameter; reads default on and writes default off), so a twelfth tool added carelessly fails
the suite rather than shipping. Schema: `20260808120000_mcp_server`, two new tables, additive, no
backfill. Docs: [ARCHITECTURE.md §3.11](ARCHITECTURE.md#311-mcp-server--a-second-inbound-surface-that-acts-as-a-person),
[API.md](API.md#mcp-server), [DATABASE.md](DATABASE.md#mcp-server-tables-globalmcpsettings-mcpcredential),
[DEPLOYMENT.md](DEPLOYMENT.md#operating-the-mcp-server).

### Open — reported, not fixed

- [x] **`/api/mcp`'s rate limit is keyed on the IP, not the credential.** (closed 2026-08-08 —
  `middleware/ai-rate-limit.ts#mcpRateLimit`, mounted inside `mcpRouter` AFTER `mcpAuth` so
  `req.mcp.credentialId` exists. Keyed on the credential rather than the user so revoking one
  misbehaving client does not throttle that person's well-behaved ones. The coarse IP limiter in
  `app.ts` stays: a flood from one address and a runaway agent are different problems and neither
  limiter catches the other's.) ~~The original finding:~~ `app.ts` mounts a plain
  120/min limiter whose default `keyGenerator` is `req.ip` — which is exactly the wrong axis for
  the same reason `middleware/ai-rate-limit.ts` was rewritten in this release: two credentials
  behind one office NAT share an allowance, and one credential reaching the server from a laptop
  and a VPN gets two. The fix is the same shape (key on `req.mcp.credentialId`, IP as the
  fallback), and it is not done here only because the limiter is mounted in `app.ts` *before*
  `mcpAuth` has run, so the key is not available yet without reordering the mount.
- [ ] **A tool call is audited by name, not by argument.** `invokeMcpTool` writes
  `{ tool: name }` — so the log shows that `transition_ticket` ran, but not which ticket it moved.
  For a surface whose entire premise is "a language model acted as this person", "what did it
  actually do" is the question the audit row exists to answer. Deliberately not fixed blind:
  arguments include free text a model composed (`taskDescription`, comment bodies), and deciding
  what is safe to persist into `AuditLog` is a retention decision, not a one-line change.
- [x] **An MCP credential never expires.** (closed 2026-08-08 — `McpCredential.expiresAt`, checked
  in `resolveMcpPrincipal` rather than swept, so it takes effect the moment it passes and still
  works if a sweep is ever broken. NULL means never, which is every credential issued before the
  column existed — expiring working integrations retroactively on upgrade is the wrong direction
  for a mistake to fail in.) ~~The original finding:~~ There is `revokedAt` but no `expiresAt` — unlike the
  guest approval links, which took a 30-day expiry in the 2026-08-07 batch precisely because a
  long-lived capability nobody revisits is a capability nobody revokes. `lastUsedAt` makes a stale
  credential *visible* in the settings list, which is the cheap half; automatic expiry is a schema
  column plus a decision about what an expiring integration should do to the person relying on it.

## "Refine with AI" next to the fields people actually write in (2026-08-08)

The workspace already had a writing assistant, and it had the one flaw that matters: clicking it
**overwrote what you had written**. On a ticket description that is annoying. On a timesheet task
description — a record of work a manager approves and an auditor may later read — it is a
compliance problem, because the sentence that gets approved is one nobody chose.

- **The affordance is now per field and always a proposal.** `components/AiRefine.tsx` (a hook plus
  a trigger and a result panel, so a caller keeps its own layout) shows the suggestion beside the
  original, requires "Use this" or "Keep mine", and keeps the replaced value so Undo is real.
  Offered on: timesheet task description and notes, ticket title and description, ticket comments.
- **Routed through the existing choke point.** `refineText` in `ai.service.ts` runs the same
  `preflight` every capability runs — master switch, the `writingAssistantEnabled` toggle, the
  plan-clamped monthly budget — and logs to `AIUsageLog`/`AIInteraction` under its own
  `text_refine` feature, so it shows up in the usage panel and the activity log like everything
  else. No new settings column: it is the same admin decision over the same budget.
- **Its own prompt, not the writing assistant's.** Registered in the `SPECS` allow-list, so it is
  editable and versioned in Workspace Settings → Prompts. The default forbids adding facts,
  padding, restructuring, or making any claim stronger or weaker than the author made it, and
  `required: ["text"]` means no admin edit can drop the user's own words from it.
- **The model's answer is treated as untrusted input, because it is.** It comes back as plain text,
  is HTML-escaped character by character, and the assembled markup still goes through
  `sanitizeRichText` — the same allow-list as any stored rich text — before the client re-sanitizes
  with `safeHtml` to render the preview. `<script>`, `onerror` and `javascript:` end up as visible
  text the author can read and reject, never as markup. Pinned in `tests/unit/sanitize.test.ts` and
  `tests/unit/ai.service.test.ts`.
- **Honest when it cannot help.** `GET /ai/text/refine/availability` (deliberately above the AI
  router's 20/min limiter — it costs nothing and every form asks on mount) answers from the same
  `preflight`, so the button is disabled with the actual reason: AI off, budget exhausted, or field
  still empty. A timeout, a provider error and a 429 each say so rather than spinning forever.

### Security audit: the AI surface — prompt injection, leakage, abuse (2026-08-08)

A pass over everything that reaches a model, prompted by one property this product has and most
LLM-using apps do not: **it ingests attacker-authored prose on purpose.** A stranger emails
support@, `email-intake.service.ts` turns it into a Ticket, and eight AI features then read that
ticket. So the question throughout was not "could a prompt be injected" — it can, by design — but
"what can an injected answer actually make the app DO", and the fixes are structural rather than
extra sentences in a prompt. Every fix below has a test that fails against the pre-fix code and
passes after; the negative results are recorded too.

**The untrusted-content-to-prompt paths, enumerated.** Third-party text reaches a model through
exactly six doors: inbound email (`email-intake.service.ts:176` → `classifyTicket`), chat messages
on four platforms (`chat-intake.service.ts:107` → `classifyChatMessage`), CI failure logs
(`security-report.service.ts:505`/`:557` → `classifyCiFailure`), scanner findings
(`security-report.service.ts:663` → `classifySecurityFinding`), GitHub PR titles/descriptions/diffs
(`git-webhook.controller.ts:191`/`:210`), and — second-hand but most numerous — every feature that
reads stored ticket text afterwards (`ask_ai`, `comment_summary`, `duplicate_detection`,
`plan_breakdown`'s existing-titles context). The MCP server is NOT a seventh: `mcp-tools.ts` calls
no model, it exposes ticket content TO one, and it already marks the boundary
(`UNTRUSTED_CONTENT_NOTICE`) and bounds every tool by one user's permissions.

#### Fixed

- [x] **The closed set of ticket types was a request, not a guarantee.** `classifyTicket` and
  `classifyChatMessage` put `enum` in the JSON schema and then validated with `z.string()`. Only
  Anthropic's `output_config.format` enforces that enum; the OPENAI_COMPATIBLE path asks in prose
  and, when an endpoint rejects `response_format`, **retries with no constraint at all** — its own
  comment says so. Both intake pipelines write the result straight to `Ticket.type` from text an
  unauthenticated stranger wrote. `priority` was already pinned by a Zod enum and `moduleName` by a
  name-to-id lookup that yields null on a miss; `type` was the one field nothing checked. Now
  `coerceToConfiguredType` forces it back into the project's real rows after the response comes
  back, falling back to the first configured type rather than throwing — an inbound email should
  stay a ticket. The model-authored chat title is capped at the column's 255 in the same place.
- [x] **A model-invented ticket key was a remote 500.** `findDuplicateTickets` mapped its answer
  through `params.candidates.find(...)!.id` — a non-null assertion on a lookup that can miss. The
  candidate list embedded in that prompt is itself untrusted (email-sourced tickets supply their own
  title and description), so "return key ADMIN-999" was a TypeError anyone able to email support@
  could trigger on demand. Unknown keys are now dropped.
- [x] **Raw model output was stored as HTML.** `git-webhook.controller.ts` interpolated
  `result.summary` and `result.reviewFocus` — answers to a prompt made of a PR's own title,
  description and diff — into a ticket comment's markup. Both sibling AI comment paths
  (`security-report.service.ts`'s CI-failure and finding triage) had escaped all along; this one
  never did. Now `git-provider.service.ts#renderPrReviewSummaryComment`, a pure function with a
  test, using a single `escapeHtmlText` exported from `utils/sanitize.ts` instead of the third
  private copy. **Stated honestly: this was not a live XSS** — the web client re-sanitizes comment
  bodies with DOMPurify (`lib/safe-html.ts`) on render. It was stored third-party markup with one
  layer standing alone in front of it, and any non-browser consumer had no layer at all.
- [x] **One ingest request could spend the whole month's AI budget, and defeat the cap while doing
  it.** `POST /devops/:orgSlug/findings` takes up to 500 findings and ran `maybeTriageFindingWithAI`
  for every one inside the same `Promise.all` as the row creation — one model call each, from a CI
  ingestion token, counted by the per-IP limiter as a single request. The cost was the smaller half.
  `preflight` reads the month's spend and compares it to the ceiling; `logAIUsage` writes the row
  that moves that number. Fired concurrently, **all 500 read the same total before any had written
  anything, so all 500 passed a cap only one of them should have.** The clamp was not skipped, it
  was raced. Now capped at 20 per batch and run sequentially, so each call's usage row lands before
  the next one's preflight reads it. Findings past the cap are still ingested and still
  auto-ticketed — the cap is on the AI opinion, which is the part that costs money and the part a
  scanner can trivially produce more of.
- [x] **The human step in "proposes, never applies" could be performed by someone who could not see
  the plan.** `POST /ai-proposals/:id/apply`, `/reject` and `PATCH /:id/decisions` were gated on
  `plan:write` alone — a permission every lead and manager holds tenant-wide, which is exactly the
  argument the `GET` route in the same file already makes about `tickets:view`. Given an id, a lead
  on an unrelated project could apply an AI-authored change set to a project they cannot open. All
  three now go through `loadReviewableProposal`, which applies `assertTicketVisible` for a scoped
  proposal and falls back to authorship for a workspace-wide one — so what you can apply is exactly
  what you could see. `/decisions` additionally binds the body-supplied change ids to the proposal
  in the URL, which was the outstanding half of the "fetch-then-don't-check" item above.
- [x] **Ids inside a proposal are checked before they are written.** `TICKET_WRITABLE` already
  permits `assigneeId`, and `ProposalKind` already declares `ASSIGNMENT_REBALANCE` — so the first
  feature to emit a model-chosen person would have had it applied unverified. `applyProposal` now
  requires an `assigneeId` to be a live ACTIVE user and a `parentId` to be a work item in the same
  project, and a CREATE row's project comes from the proposal's own `scopeProjectId` (the thing
  authorization was checked against) in preference to `after.projectId` (part of the change set).
  Not a tenant-isolation fix — the `prisma` proxy already prevents that — a liveness one.
- [x] **Two `/api/ai` routes took a project id and used it.** `suggest-triage` and `duplicates` are
  gated on `tickets:write`, which answers "may you create tickets at all", not "in which projects";
  `POST /tickets/:id/summarize` and `POST /ask` in the same router already ran the caller's scope.
  `duplicates` in particular answered with the ticket keys, titles and model reasoning of a project
  the caller cannot open. Both now call `assertTicketVisible` first, before any spend.
- [x] **The AI throttle counted addresses, not spenders.** `express-rate-limit` defaults to `req.ip`
  and no limiter in the repo overrode it, so one NAT'd office shared a single 20/min allowance while
  one person with a phone and a laptop had two. Spend is attributed to a user (`AIUsageLog.userId`
  is what the usage panel breaks down by), so the bucket now is too — `middleware/ai-rate-limit.ts`,
  with IP as the fallback for a request that somehow arrives unauthenticated, collapsed to a /64 for
  IPv6. The same limiter is now also mounted on `aiProposalRouter`, whose `POST /plan-breakdown`
  reaches a model and had only the global 900/min.
- [x] **`summarizeComments` was the one capability handed an unbounded collection.** Every other one
  truncates — CI logs at 6000 chars, PR diffs at 6000, `ask_ai` at 150 tickets x 200 chars. Comment
  count and comment length are both chosen by whoever is posting (10 000 chars each is all the
  comment route enforces), so a long thread was one authenticated request sending megabytes to a
  model. Now the newest 60 comments, 1000 chars each.

Tests: `tests/unit/ai.service.test.ts` (+4 cases, all 4 fail pre-fix), `ai-proposal-scope.test.ts`
(+7, 6 fail pre-fix), and three new files — `ai-route-hardening.test.ts` (3 of 5 fail pre-fix),
`ai-write-path.test.ts` (4 of 5), `devops-ingest-ai-fanout.test.ts` (2 of 2). Suite: 62 files /
698 tests, up from 59 / 675.

#### Checked and found clean — recorded because the negative result is the point

- **Every capability goes through `preflight`.** All 22 model-calling functions in `ai.service.ts`
  call it as their first statement, and `callChat` is module-private, so there is no path to a model
  that skips the master switch, the per-feature toggle or the plan-clamped budget. The one export
  that reaches a provider without it — `listAvailableOpenAICompatibleModels` — lists model ids and
  consumes no tokens.
- **No prompt can be built outside tenant context.** `preflight` calls `requireTenantContext()`,
  which throws when absent, and `assertWithinBudget` aggregates through the tenant-scoped `prisma`
  proxy. A cross-tenant prompt would require a tenant client that does not exist.
- **The 22 per-feature toggles already ARE the kill switch** the brief asked whether to add, and
  `GlobalAISettings.aiEnabled` is the master. Nothing added: a 23rd boolean that always moved with
  an existing one would be a settings column pretending to be a choice.
- **Biometrics stay out of prompts.** `summarizeFaceReviewAttempt` sends attempt metadata only, and
  `CONTENT_CAPTURE_DENYLIST` covers both face features so no text of theirs is ever stored — already
  pinned by `ai-capture.test.ts`. No password hash, token, API key or encrypted DSN is reachable
  from any prompt builder or from `logAIUsage`'s captured params.
- **Model output never reaches SQL, a shell, a file path, or a fetched URL.** Every DB write from a
  model's answer goes through Prisma's parameterised client; there is no `$executeRawUnsafe` on any
  AI path, no child process, and no model-supplied URL is fetched. The only outbound URL a model can
  influence is the PR review post, whose `(path, line)` pairs are validated against the actual diff
  hunks first (`validNewFileLines`).
- **AI text rendered in the web app is text.** Only `AiRefine`'s preview passes model output to
  `dangerouslySetInnerHTML`, through `safeHtml`; the risk narrative, status report, Ask AI answer
  and comment summary are all rendered as plain strings.
- **Email templates escape.** The stale-ticket nudge puts a model sentence into an email;
  `templates.ticketStaleNudge` runs it through `escape()` like every other variable.
- **Input caps on the authenticated HTTP surface are real** — Zod bounds every AI route's body
  (title 255, description/text 20 000, question 500, goal 2000, context 4000) under a global 2 MB
  `express.json` limit. The gap was the two places nothing bounded a *collection*, both fixed above.
- **The narrate-don't-decide split holds.** `explainThresholdRecommendation`, `narrateProjectRisk`
  and `explainAssigneeSuggestion` all receive a number computed arithmetically elsewhere and are
  asked only to explain it; none of the three can change what it narrates.

#### Open — reported, not fixed

- [ ] **`isLikelyFlaky` lets CI-log content suppress a ticket.** `maybeAutoCreateTicketForCiFailure`
  skips creating a first ticket when AI triage calls the failure flaky, and the failure text is
  external CI output. The output is already a delimited boolean — there is no tighter structural
  constraint available — so the residual risk is inherent to the feature, not a defect. Two things
  bound it: the deterministic 24-hour repeat check runs regardless of what AI says, and the whole
  behaviour is behind its own opt-in. **What is missing is a trace**: a suppressed ticket leaves no
  audit row at all, so "the AI decided not to file this" is invisible. Worth an
  `audit(undefined, "ticket.ci_failure_suppressed_as_flaky", ...)`, deferred only because there is
  no entity id to hang it on and inventing one is a schema decision.
- [ ] **AI-influenced writes are audited unevenly.** Email intake, chat intake, auto-reopen,
  auto-create-from-CI and proposal application all stamp an audit row. `maybeTriageFindingWithAI`
  writes four fields onto `SecurityFinding` and the PR summary posts a comment, neither audited.
  Both are visible in the UI, so this is completeness rather than a hole — but "every automated
  decision is auditable" is the principle this codebase states, and these two do not meet it.
- [x] **`POST /settings/ai/available-models` fetches a caller-supplied `baseUrl`** — closed as a
  RECORDED DECISION (2026-08-09), with the code deliberately unchanged. SSRF-shaped, and `callChat`
  sends prompts to that same stored URL — but the shape is the feature: BYOK explicitly supports
  Ollama and LM Studio on localhost, so blocking private ranges would break a documented
  deployment. It is super-admin-only, and a super-admin already configures the provider every
  prompt is sent to. Ticked because there is no pending work behind this box — only a trigger:
  if a deployment ever needs the tightening, it is an allow-list per deployment, never a blocklist
  of address ranges.
- [x] **Secret-bearing scanner findings and CI logs — resolved 2026-08-09 with the middle path
  neither option offered.** The binary was denylist (breaking dataset replay for exactly the
  capabilities that most need a golden set) or store raw secrets. `redactSecrets` in ai.service.ts
  is the third option: capture stays on for `ci_failure_triage`/`security_finding_triage`, and
  every stored prompt, output and params blob is masked first — PEM blocks, JWTs,
  provider-prefixed tokens, bearer headers, secret-looking assignments. Structure survives (evals
  still replay), the credential does not. Agent step traces pass through the same screen. A secret
  with no recognisable shape still passes — the capabilities' ceilingReasons already price that.
- [x] **The budget cap race — resolved 2026-08-09 with the serialised reservation.** `AiSpendMonth`
  (one row per calendar month) turns admission into an atomic conditional increment
  (`UPDATE … WHERE committedUsd < budget`) placed inside `callChat` — the one function that
  reaches a provider — so a capability that skips preflight still cannot skip the gate. Seeded
  from the reporting aggregate (no fresh budget on a mid-month upgrade), reconciled periodically
  (a crash-leaked provision cannot shrink the month forever), overshoot bounded by ONE in-flight
  reservation rather than by the number of concurrent callers.

## The agentic backlog closes (2026-08-09)

The five items open since the autonomy phases landed together in one change set — the loop, the
reservation, the three producers, the quality-loop join, and the capture middle path above.

- **The model-driven loop is real.** `planAgentStep` (ai.service.ts) asks for one JSON decision
  per call — provider-agnostic on purpose, because native function-calling differs across every
  BYOK backend and the bounds/abort/taint controls must live in the loop
  (`runModelDrivenLoop`, agent-run.service.ts), not a provider SDK callback. The envelope's
  promised bounds are now enforced: step/cost ceilings → PARTIAL, unparseable decision → FAILED,
  disallowed tool → refused as data and fed back, untrusted tool results → taint via
  `callToolForRun`, the only door. Routing is the registry itself: a capability becomes
  loop-runnable by declaring `tools` + a `featureToggle`, not by a new branch.
  `status_report` went first (read-only tools) and PAID the honest price: reading ticket text
  moved it into the untrusted-input class, the invariant test refused AUTONOMOUS, and its ceiling
  dropped to AUTO_APPLY. `/api/agent-runs` (super admin) queues, traces, aborts.
- **All four declared ProposalKinds produce.** `SCHEDULE_ADJUSTMENT` re-solves the plan with the
  violating items' dates stripped, so the solver itself names the correction (ai-schedule-adjust);
  `RISK_MITIGATION` realigns a committed end date with measured overrun — SUGGEST-capped, a
  promise is a conversation — and writes `ProjectRiskSnapshot.aiProposalId` for the first time
  (ai-risk-mitigation); `BLUEPRINT_SUGGESTION` stamps a blueprint out as reviewable rows, item
  indexes aligned with change orders so parent/dependency references resolve at apply
  (ai-blueprint-propose). Timeline grew "Fix N conflicts"; Portfolio grew a per-row mitigation
  action on amber/red scores.
- **The quality loop is joined.** `AiProposal.sourceInteractionId` (no FK — provenance outlives
  the retention sweep) lets `listPromotableInteractions` surface interactions whose proposal a
  human rejected, undid, or declined rows of. Undo — a person explicitly reversing the machine —
  finally reaches the eval harness instead of being admired in a comment.
- [x] **The two remaining affordances shipped 2026-08-09, and the blueprint one was bigger than
  recorded.** There was no Blueprints surface to add an action to — `blueprintApi` (list, get,
  create, update, remove, preview, instantiate, derive) had **no caller anywhere in the web app**,
  the same unreachable-feature shape `copilotApi.planBreakdown` had. `/app/blueprints` now exists:
  cards per blueprint, a live preview that runs the same expander the real instantiation runs
  (writing nothing), and both paths offered side by side with the difference stated at the point
  of decision — "Propose for review" through the envelope, "Create directly" for a known-good
  template landing in an empty project. Plus "Learn from a project" for `derive`.
  `AgentRunsCard` sits under the autonomy ladder in the AI tab: queue a run, watch it live
  (polling only while something is in flight), read the full step trace, stop it mid-flight.

### The first live runs found a real bug the unit tests could not (2026-08-09)

Two `status_report` runs against the dev workspace. **Every safety control fired exactly as
designed** — the taint clamp engaged the moment `search_tickets` returned, a failed `get_ticket`
surfaced as data and the run recovered, the step ceiling produced PARTIAL (not FAILED), cost was
tracked to $0.058, and a doubled queue collapsed to one run on the `triggerKey`.

**What only a live run could show: the model spent NINE of its twelve steps re-issuing identical
`search_tickets` calls that returned nothing, and opened by calling `list_projects` twice in a
row.** The prompt already said "do not re-fetch what you already have". It ignored it — because an
instruction is not a bound. Every one of those steps was a paid model call that bought no
information, and the run hit its ceiling without answering.

Fixed by refusing a repeated `(tool, args)` signature the same way a disallowed tool is refused:
recorded, fed back as data *carrying the answer it already got*, charged as a step so a model that
insists on looping still runs out — but costing no tool invocation. Argument key order is
normalised, or the check would be defeated by `{a,b}` vs `{b,a}`. Verified live: the second run's
trace shows two refusals and real work done (25 tickets found, one fetched).

- [x] **Closed 2026-08-09, and the diagnosis was half wrong: it was a bounds problem after all.**
  "Prompt work" alone would have repeated the original mistake — the prompt already forbade
  re-fetching and was ignored, because an instruction is not a bound. Three changes, third run
  proved them: (1) the prompt now *teaches* what an empty result means ("an EMPTY result is an
  answer: that avenue has nothing"); (2) the loop tracks RESULT identity — a call whose answer is
  byte-identical to one already seen bought nothing, whatever its arguments — two consecutive
  no-new results earn one steering note in the transcript, three forfeit the remaining tool
  budget; (3) **the last step is always reserved for the answer**, because runs 1 and 2 spent
  their whole budget searching and hit the ceiling *silent*, which wastes every step taken. A run
  demanded its answer that reaches for a tool anyway lands PARTIAL with the trace saying exactly
  that. Live run 3: repeat guard fired twice, steering note fired, the model changed course and
  found real data, and finished COMPLETED at step 8 of 12 with a genuine stakeholder summary —
  the first of the three pilot runs to end with an answer. What remains for the eval harness is
  tuning, not correctness.
- [x] **And the harness itself now measures the loop (2026-08-09).** Each agent step is captured
  as its own feature, `agent_step`, with its COMPLETE decision input — capability, goal, tools,
  transcript, stepsRemaining, mustFinish — so a step is promotable into a golden dataset and the
  eval runner can replay it ("given this state, the right decision was X", scored EXACT_FIELDS).
  Deliberately its own feature rather than the capability's: dataset replay dispatches per
  feature, so an agent step filed under `status_report` would collide with the one-shot report's
  replayer; and the loop is honestly its own cost centre in "where the tokens go". The replayer
  re-resolves the feature toggle (replay respects the workspace's switches) but replays the TOOLS
  as captured — the decision being judged was made against the list the model actually saw.
  `agent_step` is NOT in the prompt-template allowlist, by that allowlist's own two rules: its
  output must parse (an unparseable decision fails the run) and its transcript delimiters are a
  prompt-injection control an admin must not be able to edit away. Tuning happens through
  code-shipped prompt changes measured by eval runs, not through admin edits. Captured content
  passes the same secret redaction the triage features and step traces do. Verified end to end
  live: run 4 finished COMPLETED at 6 steps (the pilots' arc: 12 silent → 8 → 6), its steps
  landed as replayable candidates — including the mustFinish step, the exact material the "did it
  answer well when demanded" question needs. AgentRunsCard shows the outcome numbers ("Answered
  N of M" as the headline) with a pointer into the dataset flow.
## Dependency advisories: one open, and why the suggested fix is worse (2026-08-08)

Pushing 2.3.0 tripped a Dependabot alert on the default branch. Recording the analysis here rather
than leaving a bare "1 moderate" for the next person to re-derive.

- [x] **`uuid` < 11.1.1 via `exceljs` — closed 2026-08-08 with a scoped override.**
  [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) is a missing buffer
  bounds check in uuid's **v3/v5/v6** generators, and only when the caller passes a `buf` argument.
  `exceljs@4.4.0` is the only consumer in the tree, it imports `{v4: uuidv4}` alone, and it calls
  `uuidv4()` with no arguments — the affected generators are never constructed, let alone with a
  buffer. Not exploitable as shipped; fixed anyway because a scoped override turned out to be cheap
  (see below). `npm audit` now reports zero vulnerabilities, and the full API suite plus a direct
  workbook-write smoke test confirm exceljs is unbothered by uuid 11.
- **`npm audit fix --force` would have made this worse, so do not run it.** Its proposed remedy is
  `exceljs@3.4.0` — a major *downgrade* from 4.4.0, against which
  `services/timesheet-report-xlsx.service.ts` is written. Trading a non-reachable advisory for a
  broken Excel export is not a fix.
- **CORRECTION to the earlier "overrides are inert here" finding: they work — the missing step was
  `npm update uuid` after adding the override.** A plain `npm install` (and
  `--package-lock-only`) never reconciles a transitive dependency the lockfile already pins; npm
  registers the constraint (`npm ls` shows `invalid: "^11.1.1"`) but leaves the installed copy
  alone until an `npm update <pkg>` forces re-resolution. After that step the tree holds
  `uuid@11.1.1` under the scoped root override (`"exceljs": { "uuid": "^11.1.1" }`), and the
  `form-data` override is confirmed live too (4.0.6 installed). The earlier conclusion — reverted
  as a no-op — was reading the symptom of the missing update step, not an npm limitation. Worth
  keeping: any future root-override change needs `npm update <that-package>` to actually land.
## AI cost: pricing the mechanical work separately from the judgement (2026-08-08)

Two changes aimed at the same thing — paying for the model you actually need — plus one proposal
withdrawn after reading the code that already did it.

- [x] **Mechanical features no longer ride the workspace's expensive model.** `GlobalAISettings.model`
  is a single workspace-wide choice and all 45 call sites in `ai.service.ts` read it directly, so a
  workspace that raised its model to get better answers out of Ask AI silently re-priced every
  ticket triage and stale-ticket nudge at the same rate — the highest-VOLUME features paying the
  highest-JUDGEMENT feature's bill. `economyModelFor()` routes triage, duplicate detection, text
  refine, the stale nudge and the assignee explanation to Haiku. It **never upgrades**, does nothing
  for non-Anthropic providers, and does nothing for a model it has no price for — an unrecognised
  name is a deployment pinning something on purpose. Ask AI, both face assessments, plan breakdown,
  the risk narrative and the PR reviews deliberately keep the workspace's model; `eval_judge` most
  deliberately of all, since it grades the others and cheapening it would move the measuring stick
  along with the thing being measured. The usage row records the model that *ran*, not the one
  configured — logging the wrong one would overstate spend and trip the monthly cap early.
- [x] **The face review summary sends a summary, not the whole log.** It was the most expensive call
  in the product (~2.1k input tokens against 143 out) because it shipped 60 attempt rows of which
  ~50 were indistinguishable `PASSED sim=0.9xx` lines — while *also* sending the `outcomeCounts`
  aggregate it had already computed. Routine passes now collapse to a count and a similarity range.
  Everything the assessment asks about is kept verbatim: every non-pass, every virtual-camera or
  unfamiliar-network flag **including on a PASS** (the prompt asks about exactly that coincidence,
  and an aggregate would erase it), and the lowest-scoring passes, which are the lookalike signal.
  Measured on one fixture: 5,760 chars → 1,838, 60 attempt lines → 7, a 68% cut. The cost was the
  smaller half of the problem — asking a model to find four rows that matter inside fifty that do
  not is how you get a confident answer about the wrong attempt.
- **Withdrawn: "rules-based capture-failure coaching".** Proposed before reading `face.service.ts`.
  `scoreQuality()` already returns a hint for no-face, too-dark, washed-out and too-far, with hard
  per-dimension floors rather than a weighted sum, and `face.controller.ts` already returns it
  *before* falling through to NO_MATCH — the exact "we don't believe you're you when the truth was
  we couldn't see you" problem it would have solved. Recorded so it is not proposed a third time.

Still open, and deliberately not built yet:

- [ ] **No response cache, though the key already exists.** `AIInteraction.promptHash` is stored on
  every call, so replaying a stored `outputText` for an identical prompt is mostly wiring. Not built
  because the cache key must include the tenant and anything that varies per user, and in a
  database-per-org product a subtly wrong key is a cross-tenant disclosure rather than a stale
  answer. Worth doing under real traffic, with that as the first test.
- [ ] **Prompt caching is not wired, and may not fire if it were.** Every call ships one
  concatenated `user` string with no `system` block, and the variable data is placed FIRST — caching
  works on a stable prefix, so as written there is nothing cacheable. Reordering is cheap; the open
  question is whether these prompts clear the provider's minimum cacheable prefix at all on the
  economy model, which needs checking against current provider docs before any work is planned on it.
- [ ] **Cache-token usage is not captured.** `CallChatResult.usage` records input and output only.
  The providers return cache-read and cache-creation counts separately, and without them there is no
  way to show whether either item above actually worked. This is the prerequisite for the two, not
  a follow-up to them.
## The agentic layer — an envelope before a loop (2026-08-09)

Nine phases turning "AI that suggests" into "AI that can act, inside something that bounds it". The
shape of the work is the finding: almost none of it was the loop. `ai-proposal.service.ts` was
already a human-in-the-loop write envelope with per-row review, a field allowlist, referential
validation of model-authored ids and — the load-bearing part — a staleness check that refuses any
row moved since the proposal was computed. What was missing was everything around it.

- [x] **Every automated actor has a name.** `AuditLog` gained `actorType`/`actorLabel`,
  `before`/`after` and `aiInteractionId`/`agentRunId`; the eight sites writing `actorId: NULL` now
  say who they were. `ipAddress` had existed since the first migration and had never been written.
- [x] **Autonomy is a ceiling the code sets and an administrator lowers.** `AiCapabilityPolicy` +
  `ai-capability.registry.ts`. Effective level is `min(stored, maxLevel)`, recomputed on every read,
  so a row edited by hand cannot outrank the code. `applyProposal` — the single function that writes
  an AI-authored change — asks the policy itself rather than trusting its caller.
- [x] **Undo, with the staleness check pointed the other way.** A row is reverted only while it
  still holds what the assistant wrote; anything edited since is left alone, because reverting it
  would erase that person's change exactly as invisibly as applying a stale row would have.
- [x] **PROJECT and BOOKING targets**, declared since the envelope was written and previously
  throwing "unsupported change type", plus link types and lag.
- [x] **AUTO_APPLY**, which is not a second write path — it is `applyProposal` with every row
  accepted and an agent as the applier, so a tainted or stale row is still refused. Guardrails
  degrade to review rather than failing.
- [x] **A domain-event seam.** The "a status change to CLOSED also fires ticket.closed" rule had
  been written out three times, once per write path. It is now written once.
- [x] **MCP hardened**: per-credential throttling, credentials that expire, credentials narrower
  than their holder (an intersection, never a union), and at-most-once writes with the key claimed
  BEFORE the handler runs.
- [x] **An agent run envelope** — `AgentRun`/`AgentRunStep`, a worker on the eval worker's pattern,
  a unique `triggerKey` so a doubled tick collapses to one run, a level frozen at queue time so
  policy edits cannot escalate a run in flight, an abort that survives a restart, and the taint
  clamp: once a tool carrying externally-authored text returns, the run cannot write again.

Still open when this section was written; all three closed since (see "The agentic backlog
closes", below, for the full write-ups — these entries are ticked here so nobody re-derives work
from a stale list):

- [x] **The model-driven tool loop** — closed 2026-08-09. `planAgentStep` + `runModelDrivenLoop`,
  one JSON decision per call, every bound enforced between steps, verified against a live model
  four times. `callToolForRun` is indeed the loop's only door, exactly as this entry predicted.
- [x] **Producers for SCHEDULE_ADJUSTMENT, RISK_MITIGATION and BLUEPRINT_SUGGESTION** — closed
  2026-08-09, all three model-free on the rebalance pattern, each with a UI entry point (Timeline,
  Portfolio, /app/blueprints).
- [x] **Per-row accept/reject now feeds the quality screen** (2026-08-09) —
  `ai-quality.service.ts#getProposalDecisionStats`, reported in its own bucket beside the thumbs
  because it counts change ROWS rather than model calls and adding them would produce a figure that
  means nothing. Four states kept apart deliberately: an undecided row is not a rejection (or every
  unreviewed proposal would look like a failure), a row refused at apply time is the staleness check
  working rather than the model being wrong, and an UNDONE row is counted apart from a rejected one
  because "I let it happen and took it back" is a worse outcome than "I read it and disagreed".
  The promotion question this entry left open was answered by `AiProposal.sourceInteractionId`:
  a refused proposal names its captured interaction, the interaction is what gets promoted, and
  the "expected output" is whatever the human corrects it to at promotion time — the same
  correct-don't-author flow every other dataset item uses.
- [x] **The budget cap became a serialised reservation** — closed 2026-08-09, `AiSpendMonth`'s
  atomic conditional increment inside `callChat`; the request-path race this entry describes is
  gone. Full write-up under "Dependency advisories"' neighbouring section.
## Three bugs found by looking for them (2026-08-09)

Written up because two of the three are the same shape — something declared, documented and wired
into a UI, that could never actually happen. That shape does not announce itself: the code reads
correctly, the tests pass, and the feature is simply absent.

- [x] **`AgentRun.status = BLOCKED` was unreachable.** The state was designed, documented in the
  schema, and had its own domain event — and the ternary choosing it could only produce it when two
  values were both null, which could not occur. Root cause was one field meaning two things:
  `RebalanceOutcome.reason` carried both "there was nothing to do" and "a guardrail held this back",
  so the runner could not tell a completed run from a blocked one and every run reported COMPLETED.
  Split into `reason` and `heldForReview`; both cases now have a test.
- [x] **`maxRunsPerDay` was enforced nowhere.** The settings route validated it, the policy table
  stored it, `describeAutonomyCatalogue` surfaced it — and no code read it. An administrator could
  set "at most 3 runs a day" and get unlimited runs. Enforced in `queueAgentRun`, counted after the
  `triggerKey` check so re-asking for an existing run does not eat the day's allowance.
- [x] **An update was invisible until somebody wrote release notes.** `update-check.service.ts` read
  GitHub *Releases*, but the CD pipeline publishes on a *tag* — creating the Release object is a
  separate manual step. At the time of writing this repo had four version tags and zero releases, so
  **every installation in existence was being told it was up to date**. That is the worst direction
  for an update check to fail in: silent, and reassuring. It now falls back to the tags endpoint,
  with notes still coming from the bundled CHANGELOG. Tagging is sufficient; a Release adds the
  written notes and nothing else.

Two things left deliberately unenforced, and now stated in the code rather than left to be found:
`AgentRun.maxSteps` and `maxCostUsd` are recorded but not checked, because there is no multi-step
loop yet to check them between steps — and `status = PARTIAL` is in the same position. The comment
now says so, since a bound that looks enforced and is not is worse than no bound.

## The load campaign: three stacks, nine findings, every ceiling a knob (2026-08-08)

Windows-native, Compose (prod images) and Kubernetes (kind) were each brought up for real,
load-tested with autocannon, profiled, optimized from the measurements, and re-tested. The full
interactive report — every number, before/after, and what was deliberately NOT run — lives in
`reports/quality-load-report.html` and is linked from the README.

- [x] **391 KB ticket-list payload → 150 KB** (`omit: description`; the detail endpoint still
  carries it; the client's own `TicketRow` never declared it). 129→163 req/s, p50 −21%, at 50
  connections on the same database. Found by pairing autocannon with the app's OWN telemetry —
  25 ms of DB time under 383 ms responses is a serialization bill, not a database problem.
- [x] **`RATE_LIMIT_PER_MINUTE`** — the blanket limiter is per *egress* IP and was hardcoded at
  900/min; one office NAT is one bucket. Env-tunable through every shape, default unchanged.
  The knob validated itself: set to 200k, exactly 199,998 requests passed before the cut.
- [x] **`TENANT_DB_CONNECTION_LIMIT`** — the 5-connection tenant pool (multi-tenant arithmetic)
  pinned single-org authed throughput near 90 req/s at every concurrency while p50 scaled with
  queue depth alone. Default 5 kept; Compose and the chart ship 20 for Shape 1.
- [x] **First-install seed deadlock** — an unseeded API `process.exit(1)`'d, the supervisor
  restarted it too fast for `exec` to land a seed, and install.sh's wait-for-health-then-seed
  order could never see health. Boot now waits (15 s polls, loud log, health serving).
- [x] Boot guards *proven* against deliberate misconfiguration during the campaign: repetitive
  encryption key refused, short JWT secrets refused, unseeded install held safely.
- [ ] **Honest limits of this harness, and the next measurements:** every load connection shared
  ONE session token (real users don't — a distinct-token rerun will lift the plateau);
  Kubernetes numbers traverse `kubectl port-forward`; container-stack ticket lists were empty
  (fresh seeds), so their authed numbers are path floors, not payload tests. DAST (ZAP) against
  the Compose stack is the natural next security step — its findings flow into this product's
  own ingestion webhook.

## Four screenshots and a follow-up: the review-screen batch pass (2026-08-10)

A user-driven round, every item traced to a screenshot of the running product. All shipped same
day (`9d02435`, `7b53446`, `9d6b738` on V7 + main), each behind the full gate (API suite, web
build, desktop + responsive e2e).

- [x] **"Unrecognized key(s): projectRiskAgentEnabled"** - the strict AI settings schema was
  missing three toggles the capability registry already shipped. The fix that matters is the
  guard test: every registry `featureToggle` must parse through `aiSettingsSchema`, so this
  drift class is now a failing build. (The new `emailFailureTriageEnabled` toggle was added
  under that guard the same day - the test did its job on its first outing.)
- [x] **Bulk review verbs where reviewers batch** - face verification log (`review-bulk`,
  ids-XOR-refiltered, always scoped to flagged rows) and Timesheet Approvals (`decide-bulk`,
  per-row independence, ONE identity check per batch, single/bulk sharing one extracted core so
  the payroll path cannot fork). Approvals table went 11 -> 8 columns; downloads moved into the
  entry dialog; the export e2e followed them.
- [x] **The Dashboard day timeline lanes by person** - identity color per lane from the fixed
  categorical palette, status moved off color onto icons, inner scroll, and a full-width expand
  dialog with filter/sort. The admin list endpoint returns everyone the approver can see; that
  was the overlap.
- [x] **Slim sidebar** (icon rail, tooltips, persisted, toggle in the brand row after a
  follow-up screenshot called the bottom placement out) and **calendar day-annotations** - both
  pickers can carry per-day status-colored hover counts; Dashboard and Approvals feed them.
- [x] **Email deliverability became a triage desk** - grouped SMTP failures translated by ten
  deterministic rules (lib/email-failure-triage.ts) into title/meaning/verdict/actions; the
  normalizer collapses compound session tokens WITH ordinals (one Gmail throttle no longer
  reads as six errors, pinned by test); a per-group AI diagnosis behind a new registry
  capability (`email_failure_triage`, untrusted-input, SUGGEST ceiling, off by default; group
  re-derived server-side, domains only, SMTP text fenced as data); and "Delivery by domain"
  with per-domain top failures, stuck in-flight age, and a needs-attention strip.
- [x] **BorderGlow** (reactbits pattern, rebuilt in-tree on theme tokens) now frames every AI
  invoke/answer surface; grammar recorded in the component: frame = AI surface, `.ai-glow` =
  working now, strands = waiting.
- [x] **A phone-overflow class fixed at its mechanism, not its symptom.** Two related traps: a
  `truncate` (nowrap) line inside a grid item with visible overflow makes the UNWRAPPED text
  the item's automatic minimum width; and recharts stamps pixel widths its ancestors then
  cannot shrink under after a viewport narrows (the DevTools device-toggle path), deadlocking
  the ResizeObserver. Fixes are `min-w-0` + `overflow-hidden` at the item, guards on the chart
  wrappers. The responsive suite now sweeps `/app/email-templates` INCLUDING the analytics tab,
  walks a render-wide-then-shrink pass that reproduces the deadlock deterministically, and
  `assertNoOverflow` names the widest elements sorted by extent - the failure message is now a
  diagnosis instead of a number.

## Seven asks from a working session: labels, alignment, and the product wearing its owner's name (2026-08-11)

- [x] **Field alignment fixed at its cause, not per-form.** A grid item's rows STRETCH by default,
  so any FormItem sharing a row with a taller sibling (one carrying a FormDescription) had its
  label and control pushed apart by half the height difference. `content-start` on the shared
  `FormItem` fixes every current and future form at once; the Profile page's hand-rolled
  phone/timezone pair got the same treatment.
- [x] **"SLA breaches" -> "Approval SLA breaches"** on My team, Reports and the latency panel.
  Verified the source first: it is `Timesheet.slaBreachAt`, set by `sla.service.ts`'s sweep when a
  SUBMITTED entry passes its approval deadline - nothing to do with ticket SLAs, which live in
  `ticket-sla.service.ts` and were already labeled "Ticket SLA". One bare "SLA" across two systems
  was the ambiguity; three words is a cheaper fix than a metric people mistrust.
- [x] **Bar charts print their values** (Dashboard utilization, Reports project hours, Insights SLA
  compliance / cycle time / module hotspot, Security findings). The stacked chart labels the STACK
  TOTAL on its top segment - labeling each segment puts two numbers in a 64px-tall chart.
- [x] **Project charts axis on `projectCode`**, full name in the tooltip; `/reports/admin-summary`
  now returns the code alongside the name. Two long names had been eating the whole axis.
- [x] **Per-template email breakdown rebuilt** as a working table: search, scope filter, sort,
  per-template delivery-health bar (in-flight excluded from the rate, same rule as the domain
  table), and a today-vs-yesterday trend arrow.
- [x] **Resend welcome email investigated and found working.** Both recorded resends
  (`user.welcome_resent`) have matching `EmailLog` rows with status SENT and no error - SMTP
  accepted them. The route already 502s with the SMTP text on refusal rather than reporting a
  false success, so a delivery problem beyond the handoff is a provider/inbox question, not an
  app one. Recorded rather than "fixed" because there was nothing in the app to fix.
- [x] **Workspace logo upload.** New `WorkspaceBranding` singleton + migration, reusing the avatar
  uploader's allow-list and sharp re-encode. The one interesting decision: `/uploads` now requires
  a signed, expiring, org-bound grant, and the login page needs the logo BEFORE anyone can hold
  one - so branding gets its own storage subtree that `isInsideNonPublicSubtree` refuses, and one
  public tenant-resolved route (`GET /api/branding/logo`) as its only reader. Logos scale to fit
  (never a cover crop - that is right for an avatar, disfiguring for a designed mark) and are
  always PNG (a JPEG re-encode paints a transparent logo black on dark themes). Both properties
  pinned by `tests/unit/branding-storage.test.ts`.

## 2026-08-14 — the team's bug list, and two panels that needed to be windows

Ten asks from the team in one pass. Grouped by what they turned out to actually be, because
several of them shared a root cause.

### Dialogs that could not be finished

- [x] **The New-ticket dialog walked off both edges of the screen.** Reported as "the description
  has no scroll", and it did not — but the deeper cause was that the dialog is centre-anchored
  (`translate(-50%, -50%)`) with **no height cap**, so it grew in both directions as the editor
  did. Around fifteen lines the title left the top of the window and Cancel/Create left the
  bottom, with no scrollbar to bring them back: the dialog is `position: fixed` over a
  scroll-locked page. You could keep typing and could no longer submit. Fixed at three levels:
  `DialogContent` now caps at `max-h-[calc(100dvh-2rem)]` with internal scroll (which closes this
  whole class of bug for every dialog in the app at once), the ticket dialog pins its header and
  footer and scrolls only the middle, and `RichTextEditor` gained a `maxHeight` so it stops
  growing and starts scrolling on its own — with the **toolbar outside the scroll box**, because a
  toolbar that scrolls away is one you have to scroll back to. `dvh` not `vh`: mobile browsers
  measure `vh` against the viewport with the URL bar hidden.

### Text that arrives as code and used to be flattened into prose

- [x] **Pasting a stack trace, SQL, YAML or a shell session now produces a code block.** The
  code-block node has shipped since the first version and nothing ever reached for it, because
  doing so meant noticing the toolbar button first. A paste handler classifies the clipboard text
  and picks the node; markdown-ish structure (headings, lists, quotes, fences) becomes real nodes
  too.

  **Deterministic, not a model call**, and that is the interesting decision. It has to run between
  Ctrl+V and the caret moving, offline, and identically every time; "sometimes it reformats your
  paste" is worse than never doing it. The heuristic is deliberately narrow — a **majority** of
  non-blank lines must trip a code signal, so a paragraph mentioning `git bisect` stays a
  paragraph, and a single line is never a block. Pinned by an e2e test that pastes prose and
  asserts no `pre` element appears.

- [x] **AI refine stopped destroying code blocks.** The other half of the same ask, and a real bug:
  `htmlToPlainText` flattened `pre` to a paragraph on the way out and the whitespace normalisation
  stripped its indentation on the way back, so "refine this description" reliably ruined any
  snippet in it. The pair is now a genuine round trip via fenced blocks, headings and quotes — and
  the refine prompt gained the rule that code is never prose and never spell-corrected. Eight
  round-trip cases in `tests/unit/sanitize.test.ts`.

- [x] **Ticket attachments can be chosen before the ticket exists.** The upload route needs an id,
  so the screenshot on the reporter's clipboard had no home: file the ticket, find it again, open
  the Files tab. Most people simply did not. Now a dropzone in the create dialog, uploaded
  immediately after creation as a **separate, non-fatal step** — a failed upload reports as a
  warning naming the created ticket, never as "the ticket wasn't created".

### One entry, three screens, no way to open it

- [x] **`GET /timesheets/:id` and a shared `TimesheetEntryDialog`.** Approvals had a bespoke
  read-only dialog that listed attachments as a **count** — "2 file(s)", nothing to click — so an
  approver was asked to sign off hours on the strength of evidence the screen could see and they
  could not. History had no detail view at all, which mattered because an approved entry leaves the
  approvals queue and this table becomes the only remaining record of it. The dashboard's day
  timeline linked every block to `/app/history`: you clicked a specific 3.5h block on a specific
  person's lane and arrived at a list of everything. All three now open the same component;
  attachments are plain download links, because the API already signs every `/uploads` path it
  emits, so the URL *is* the capability.

- [x] **`PATCH /timesheets/:id` — correcting an entry, with the audit trail that makes it
  defensible.** Two rules: the author while it is still `DRAFT`/`REJECTED` (the window `DELETE`
  already allows), or `TIMESHEETS_APPROVE` in any status. Broader than the delete rule on purpose —
  **erasure and correction are different acts**. Every edit records a field-by-field diff, the
  submitter is notified when someone else edits their row, and an approved entry's **frozen rate is
  never re-resolved**: if the hours change, `billedAmount` is recomputed from the already-frozen
  rate, so the stored total can never disagree with its own hours and last quarter's work is never
  silently repriced at today's rate.

### A password change that changed nothing

- [x] **The new password could be the current one.** It mattered most exactly where it was most
  likely: first sign-in. `mustChangePassword` is set *because* an administrator knows the current
  password — typing it into both boxes cleared the flag, revoked the other sessions, and reported
  success, leaving the account as exposed as before with the prompt gone. Refused now in three
  places: a zod refinement for the free case, a hash comparison in `changePassword` (against the
  **stored hash**, so `resetPassword` — which has no `currentPassword` — is covered by the same
  rule), and a client-side guard so the user is told while still looking at the field. Seven unit
  tests, including that a refused attempt writes nothing, revokes nothing, and leaves an emailed
  reset link unburnt.

### A table that was seeded and never read

- [x] **Activity types are editable.** `ActivityType` has existed since the first migration and
  **nothing ever queried it** — both apps imported a frozen twelve-item array from
  `@timesheet/shared`, so a workspace running "Incident response" or "Client call" had no way to
  say so short of a redeploy. New CRUD router, a management card on the Projects screen (add,
  rename, enable, disable, delete), and the logging picker plus the report filter now read the
  workspace's own catalog. `Timesheet.activityType` stays a **string, not a foreign key**, for the
  reason `ticket-type.controller.ts` already records: an entry is a record of what someone said at
  the time, and a rename a year later must not rewrite it. Deleting an activity that history uses
  is refused with the entry count and a pointer at disabling.

### Email that hit the provider's rate limit

- [x] **The rate limits were self-inflicted, and the queue was a status column nobody drained.**
  Every send built its own SMTP connection and fired immediately, and notifications dispatch
  detached (for a good reason — awaiting four SMTP round trips made one notify take 8.7s). So a
  bulk approval, or the daily reminder sweep across fifty people, opened that many **simultaneous**
  connections in one tick. Office 365 permits three.

  Two mechanisms, solving different halves. The transport is now **pooled and rate-limited**
  (`maxConnections` / `rateLimit` / `rateDelta`, admin-editable per workspace, clamped server-side,
  defaults under Office 365's caps) so a burst is *paced* rather than refused. And `EmailLog`
  became the queue it always claimed to be: `attempts`, `nextAttemptAt`, `payload`, drained every
  minute by `mail-queue.worker.ts` with 1m/5m/15m/30m jittered backoff and five attempts before
  `FAILED` as the dead letter. `classifyFailure` distinguishes transient from permanent — a 4xx is
  transient by RFC 5321, which is exactly what a rate limit is; a 5xx is not, *unless* its text
  says "quota exceeded", which several providers answer 550 for. Unrecognised failures default to
  retryable, because the attempt cap bounds the cost of being wrong at four extra tries while the
  opposite default silently drops mail.

### The ticket panel became a window

- [x] **Maximize/restore, drag-to-resize, and a remembered width.** This is the most-used surface
  in the product, and it is where a description, a comment thread, pasted code, a proofing image
  and a twelve-column activity log all have to be read *and* edited. At a fixed 576px a stack trace
  wrapped into unreadable ribbon and the person triaging it could do nothing about it. Built into
  the `Sheet` primitive rather than the page: `useSheetResize` + `SheetResizeHandle` +
  `SheetMaximizeButton`, pointer events (so mouse, pen and touch are one path) with
  `setPointerCapture` so the drag survives the pointer outrunning the 6px handle. The handle is the
  WAI-ARIA **window splitter** pattern — a focusable `separator` with arrow-key resizing, because a
  drag-only control is one a keyboard user does not have. Inert below `sm`, where the sheet is
  already the whole screen and both controls would be unable to do anything.
- [x] **Files moved to second, immediately after Comments.** The two are read together — a comment
  almost always refers to a file — and Files sat eighth, past four conditional tabs, far enough
  right to be off the end of the strip on a laptop.

### 2026-08-14 (follow-up) — the author's own window, and who touched an entry

- [x] **An author could not fix their own SUBMITTED entry.** Reported as "unable to view and edit
  when in draft and submitted stage". Viewing always worked; editing stopped at DRAFT/REJECTED,
  because the edit rule had been copied from the DELETE rule. That conflated two different acts:
  deleting a submitted entry erases a request somebody is being asked to decide on, but fixing a
  typo in it does not. The narrow rule sent the author to their approver to change one word — and
  an approver's only "send it back" tool is a **rejection**, so a spelling mistake cost a
  rejection, a notification and a re-submission.

  The author's window now runs to APPROVED. It stops there because approved hours carry a frozen
  rate and feed cost reports and Verified Work Attestations — a record a client may already have
  been shown, so changing it is a reviewer's call. The counterpart of the wider window: editing a
  SUBMITTED entry **notifies the approver**, since they may have read it already and must not
  decide on something that changed behind them. Ten unit tests pin both edges (each status the
  author may edit, the one they may not, the reviewer reaching past it) and four e2e tests drive
  it as the `employee` role — the one that holds none of the manage rights, so testing it as an
  admin would have proven nothing.

- [x] **History says who logged an entry, and who last changed it.** Two gaps, both invisible
  until the edit feature made them matter. The list route returns *everybody's* entries to a
  `reports:view` holder and carried no author name at all, so an admin's History was a pile of
  rows with no answer to "whose is this?" — a **Logged by** column now appears exactly when the
  page spans more than one person, and stays out of an employee's way, whose every row would
  otherwise repeat their own name. And an entry somebody had corrected looked identical to one
  nobody had touched: rows now carry an **Edited** badge naming the editor, styled more loudly
  when it was not the author, plus the reviewer where there is one.

  `lastEditedById` / `lastEditedAt` are new columns rather than a derivation from `AuditLog` —
  the audit row stays the authoritative field-by-field record, but answering "who touched this?"
  from it for a whole page of history is a scan per row. Both it and the existing `reviewedById`
  are bare id columns with no foreign key (a second Prisma `Timesheet`↔`User` relation would
  force both to be named), so the display names resolve for the whole page in **one** batched
  query. Not backfilled, deliberately: NULL means "nobody has edited this since the column
  existed", which is the honest answer — inventing an editor from the audit log would attribute
  edits made before anyone was told they were recorded.

### 2026-08-14 (follow-up 2) — deciding where you are reading, and the draft that could not be sent

- [x] **"Save draft" was a one-way door.** Found while narrowing the edit window: `saveTimesheet`
  only ever CREATES a row, so nothing in the product could promote an existing DRAFT to SUBMITTED.
  A saved draft could be edited forever and never actually sent — the only escapes were to delete
  it and re-type the whole entry into the logging form, or to leave it in History as permanently
  unsubmitted work. That also made the edit feature half of something: correcting a draft is
  pointless if the corrected draft cannot go anywhere. New `POST /timesheets/:id/submit` runs
  *everything* a fresh submit runs — identity gate, `submittedAt`, the SLA deadline from the
  project's own setting, both notifications, the domain event — because it is the same event, and a
  second half-copy of it is how one of them drifts.

- [x] **The entry dialog can decide, wherever it was opened.** Approve/Reject were props only the
  approvals page passed, so opening the same entry from the dashboard's day timeline gave you the
  full record and nothing to do about it: you read it, agreed with it, and navigated to a different
  screen to find the same row and click Approve there. Extracted into `useTimesheetDecision` — the
  mutations, the identity gate, the reject-reason prompt and the cache invalidation — rather than
  copied into the second caller, because approving is face-gated on some workspaces, freezes a
  billing rate and notifies the submitter, and two copies of that is two things to keep in step.
  The approvals page's BULK path deliberately stays where it is: it has its own per-row-independence
  and one-verification-covers-the-batch semantics, and folding it in would make the hook the union
  of two problems instead of one shared answer to the smaller one.

- [x] **The edit form had a scrollbar inside a scrollbar.** The dialog body scrolled AND each
  rich-text editor scrolled within it, so there was no way to tell which one a wheel gesture was
  about to move. Worse, Save and Discard sat INSIDE the scrolling body while a separate "Cancel
  edit" sat in the pinned footer — two places to look for the control that finishes the job, one of
  which could scroll out of sight. The editors are now unbounded inside the dialog
  (`maxHeight="max-h-none"`), the body is the single scroll region, and the form submits by `form`
  id from the footer so there is exactly one set of actions and it is always visible. Pinned by an
  e2e test that counts the elements in the dialog which actually overflow.

- [x] **The author's edit window narrowed to UNDECIDED.** Previously DRAFT, SUBMITTED and REJECTED;
  now DRAFT and SUBMITTED. Both decided states are out for the same reason: a reviewer has recorded
  something against the entry. Approved hours carry a frozen rate and feed cost reports and
  attestations; a rejected entry carries the reviewer's stated reason, and rewriting the text that
  reason refers to leaves it attached to something it was never about. `TIMESHEETS_APPROVE` still
  reaches any status — that was an explicit earlier request, and it is the reviewer's own record.

- [x] **History filters by activity and by person.** Both derived from the ROWS IN HAND rather than
  a second query: the list is one capped page, so an option built from the full catalog could match
  nothing on screen — a filter that looks broken the moment you pick it. The Person filter appears
  only when the page actually spans more than one person, which also means it needs no separate
  permission check: the list route already scopes what a viewer can see, so the options can only
  ever contain people they are allowed to know about.

- [x] **A rejected entry is neither editable nor deletable by its author** — it is the record of a
  decision with the reviewer's reason attached, and erasing it erases that. The interesting part is
  what had to change with it: `REJECTED` rows used to hold their time slot in the overlap check, so
  "can't edit, can't delete, can't re-log" would have stranded the author with hours they actually
  worked and no way to record them. Refused entries are now excluded from that check in both the
  create and the edit paths — a refusal is the reviewer saying "this should not stand", not a
  reservation on the clock. Every other status still counts, so real double-booking is still caught.
  Approvers keep delete on `REJECTED` for the tidy-up case.

- [x] **The reviewer's edit exemption is gone.** `TIMESHEETS_APPROVE` reached any status, on the
  argument that whoever decides whether hours are payable can also correct them. Withdrawn on
  request, and it is the better rule: the exemption undoes precisely what the decision is FOR, and
  it did so under the same audit entry a routine typo fix produces. Both roles now share one
  window — `assertUndecided`, called by PATCH and by both attachment routes, so no route can grow
  its own definition of "decided".
- [x] **Refused hours stop costing the author anything.** The overlap check already ignored them;
  History's "Logged hours" total (and its week-over-week trend) now does too. The flow is
  deliberately "a rejection is replaced by a fresh entry for the same hours", and counting both
  copies made a rejection silently double the day — work 8h, get refused, re-log 8h, read 16h. The
  refused figure stays visible on its own; `StatCard` gained a `hint` so a tile that excludes
  something can say so, rather than leaving the rule discoverable only by noticing the arithmetic.

### 2026-08-17 — the project-utilization chart

- [x] **Both dashboard charts are full width, stacked.** They were a 1.3fr/0.7fr split, and the
  narrow half is where the label collision came from: a categorical x-axis gives each project
  `width / n` pixels, so eight project codes in a third of the page drew on top of each other.
  Neither chart gains anything from sharing a row — both read left-to-right across their full
  range — so the split was cost without benefit.
- [x] **Utilization turned on its side.** Widening the card buys headroom without fixing the
  mechanism: the same collision returns at fifteen projects. A horizontal bar chart inverts it —
  names in a fixed gutter, one per row, at full length, unable to collide however many there are,
  and the chart grows downward. The gutter is sized from the longest name (a fixed 168px silently
  ate the first character of "HICS Learnings & Certifications"; a clipped label is the same
  failure as an overlapping one, just quieter) and anything past the ceiling truncates with an
  ellipsis rather than a hard crop.
- [x] **A doughnut below `md`,** where even a gutter is too expensive. Legitimate because this
  genuinely is part-to-whole, and shipped with the mitigation the form needs: a legend printing
  hours and share per slice, so no comparison depends on eyeballing an arc. The tail folds into a
  gray "Other" past eight rather than inventing a ninth hue.
- [x] **The palette moved into theme tokens** (`--chart-1..8`, `--chart-other`, both modes), so a
  chart never detects the theme in JS — an SVG `fill="var(--chart-3)"` re-resolves itself when the
  `dark` class flips. Validated against both chart surfaces before use: every slot inside the
  lightness band and over the chroma floor, worst adjacent CVD ΔE 9.1 light / 8.4 dark, worst
  adjacent normal-vision ΔE 19.6 / 19.3. Hue follows the PROJECT (position in a code-sorted list),
  never its rank by hours, so a busier month does not repaint the chart.
- [x] **A bug that only a screenshot could catch.** Recharts spreads a `<Cell>`'s presentation
  props onto the same `<Bar>`'s `<LabelList>` text — so the 2px surface-coloured ring added as a
  mark separator became a 2px white outline around 11px digits and erased every value to a single
  faint dot. The DOM reported the right string, at the right size, with a readable fill the whole
  time; `getBBox()` reported a sane width. Only rendering the chart and looking at it showed it.
  The e2e test now asserts on the painted result (stroke width and rendered width), not on
  `textContent`.

- [x] **The maintenance window's time pickers respect "now".** `minValue` already stopped the
  CALENDAR offering an earlier day; the slot list offered all forty-eight half-hours regardless,
  so on an afternoon an admin could pick 9 AM, read a wholly valid-looking form, press Save, and
  only then meet the server's "the window can't start in the past". The rule existed and was
  invisible until after the mistake.

  `DateTimePicker` gained one prop, `minDateTime` — the earliest moment it may express — applied
  only on the floor's own date, since a later day has no earlier moment to be before. Past slots
  are DISABLED rather than hidden, matching how the calendar treats past dates: a greyed row says
  "not that one", a missing row says nothing and quietly renumbers the list. The value the picker
  was HANDED is always allowed even when below the floor — an already-running window legitimately
  started in the past, and a picker that cannot re-express what it was opened on would make
  editing that window's end impossible.

  Two details that came out of actually looking at it: the list now scrolls to the first
  selectable slot on open (without that, the floor made the picker *worse* — at 3pm it opened on
  12:00 AM and you scrolled past thirty dead rows), and the END picker's floor is the START plus
  one minute rather than the clock, so the start's own slot is blocked too — a window that ends
  when it begins is zero-length, which the server already refuses.

### 2026-08-17 (later) — "active sessions" was a sign-in log wearing a device list's clothes

- [x] **7,486 live sessions for one user.** Reported as "why does one machine show so many
  devices?" — and the number was worse than the report suggested: measured on the development
  workspace, a single account held 7,486 unrevoked, unexpired sessions, 6,952 of them carrying the
  identical Chrome-on-Windows user-agent string.

  The mechanism was one line: `establishSession` called `session.create` unconditionally, and
  nothing anywhere ever collapsed, capped or reaped the result. Refresh was innocent — it rotates
  in place — so every row was a genuine sign-in, accumulated over the life of the workspace and
  kept for up to thirty days each. Both surfaces that read the table (Profile's session list, the
  admin who's-online panel) exist to answer "is there a session here that shouldn't be?", which is
  unanswerable in a list of seven thousand identical rows. "Sign out this device" was, in
  practice, a button nobody could aim.

  Two mechanisms, doing deliberately different jobs. `Session.deviceId` — an opaque id in a
  long-lived httpOnly cookie — lets a repeat sign-in REPLACE its own row, which handles the
  browser case, i.e. the actual complaint. `MAX_ACTIVE_SESSIONS_PER_USER` bounds everything a
  cookie cannot: cookie-less clients, rows predating the column, and anyone genuinely on a dozen
  machines. Eviction is least-recently-used and explicitly pins the session just issued, because a
  brand-new row has no `lastSeenAt` and a naive sweep would have signed the caller out at the exact
  moment they signed in.

  **The cookie is not an authenticator**, and the design leans on that rather than apologising for
  it: it carries no claim about identity, the lookup pairs it with the user-agent string, and it
  only ever runs after credentials are verified — so forging, copying or clearing it buys nothing.
  A bad value simply misses and falls back to the old behaviour. That is also why it is unsigned; a
  signature would imply a trust that does not exist.

  Reuse clears `previousRefreshHash`/`refreshRotatedAt`. Signing in is a fresh credential, not a
  rotation, and a pre-login secret still valid inside the grace window is exactly what `refresh`'s
  reuse detection exists to catch.

- [x] **The migration cleans up what is already there** — every live session beyond each user's ten
  most recently active. Without it the fix only stops the bleeding: existing installations would
  render thousands of stale rows forever, since nothing else deletes them. Ordered by `lastSeenAt`
  with a `createdAt` fallback, so the session the person is holding right now is the one kept and
  an upgrade does not sign a workspace out mid-shift.

- [x] **The list says what it means.** `GET /auth/sessions` returned the verbatim user-agent string
  for the page to parse; the answer to "which session is this?" was a wall of `Mozilla/5.0 (Windows
  NT 10.0; Win64; x64) AppleWebKit/537.36…`. `parseUserAgent` already existed — the admin panel had
  the same problem and solved it — so this route stopped being the exception. Rows now carry a
  decoded label, form factor, a private-network hint and `lastSeenAt`, are ordered by last activity
  ("which is stale?" is the question; creation time answers a different one), and the raw string is
  no longer sent at all: it is a fingerprinting surface with no remaining purpose. The web's
  duplicate copy of the parser was deleted with it.

- [x] **The cap learned not to evict sessions people are using.** First cut revoked purely by rank,
  and the e2e suite failed it within one run: `withAdminRequest` caches a superadmin token for five
  minutes, the suite signs in as superadmin far more than ten times in that window, and the cached
  session was evicted as "least recently used" — surfacing as a 401 on a token minted minutes
  earlier. That is not a test artifact; it is the same shape as a script polling `/auth/login` and
  quietly signing a person out of the browser they are sitting in front of.

  Eviction is now conditioned on IDLENESS, not rank: nothing used in the last fifteen minutes is
  ever revoked, whatever the count. The cap became a target rather than a ceiling, which is the
  honest reading — "you have too many devices" is only ever a reason to drop the ones nobody is
  using. Fifteen minutes is `maintenance.service.ts`'s existing ONLINE_WINDOW_MS, so the app has
  one definition of "in use" rather than two.

- [x] **`npm run setup` failed on a clean machine, and the doctor would not say why.** It reported
  `migration failed: Command failed: npx prisma migrate deploy` — which is `execSync`'s own first
  line and never the diagnosis. The helpers run with `stdio: "pipe"` so a healthy run stays quiet,
  and the catch blocks were printing `error.message.split("
")[0]` while Prisma's actual output —
  the failing migration, the SQL, the MySQL error code — sat unread on the error object's
  `stdout`/`stderr`. A `--heal` tool whose failure mode is "run this yourself to find out" is not
  doing the one job it exists for. `childOutput()` now prints what the child actually said.

- [x] **And the migration it was failing on had a real portability bug.** The session cleanup has
  to rank rows in `Session` and then update `Session`, which MySQL refuses with error 1093. The
  derived-table workaround materialises on MariaDB — which is what this machine runs, so every
  local test passed — but MySQL 8.0.14+ can MERGE a derived table back into the outer query and
  re-raise 1093. A `TEMPORARY` table was the obvious fix and silently is not one: they are
  connection-scoped and Prisma does not guarantee one connection per migration file, so the
  `CREATE` succeeds and the join fails with an error naming only "query number 5". Settled on an
  ordinary scratch table, dropped either side. Both traps are now written up in DATABASE.md.

  Re-verified properly this time: full replay into an empty database, AND a replay stopped before
  this migration, seeded with 120 sessions across two users, then applied — 120 to 10 per user,
  scratch table gone. The empty-database replay the docs already mandate proves the schema applies
  and says nothing about a DATA migration; that gap is now called out there too.

## 2026-08-17 — What's-new stopped waiting for a git tag

A screenshot: `This installation` correctly read **v2.4.0 · Up to date · built August 17**, and the
Release history directly beneath it stopped at **2.3.0, dated August 8**. Both halves of that page
were reading the same server response, and both were doing exactly what they had been told to.

- [x] **The release history was GitHub's list, not the product's.** `withBundledFallback` mapped
  over the versions the GitHub API returned and filled in missing notes per version from the
  bundled `CHANGELOG.md`. A version GitHub had never heard of therefore did not appear at all. This
  repo has four tags — 1.0.0, 1.1.0, 2.0.0, 2.3.0 — against seven released versions, and
  `git ls-remote --tags` confirms the remote has exactly those four. **2.1.0, 2.2.0 and the running
  2.4.0 were invisible on the page, notes and all, while those notes sat inside the build that was
  serving it.**

  Worse, the same list decided the badge: `latestVersion` was GitHub's newest (2.3.0), which is not
  greater than 2.4.0, so the page also said **Up to date** — correct by its own logic, while the
  one version it could not show you was the one you were running.

  Inverted: the bundled changelog is now the BASE list and GitHub is merged over it
  (`withBundledHistory`), so cutting a release cannot leave the page stale whatever anyone forgets
  to push afterwards. GitHub still contributes the one thing a bundle cannot know — versions NEWER
  than this build — plus real release links, publish timestamps, and notes an author edited after
  shipping. `updateAvailable`/`latestVersion` stay GitHub-only on purpose: a build's own changelog
  cannot prove you are current.

  No release data was hand-written to fix this, which is the point. Every recovered version — 2.1.0,
  2.2.0, 2.4.0 — and every date came out of `CHANGELOG.md`, whose headings match the real commit
  dates (`f60c683` 2026-08-07, `c6c9ef7` 2026-08-07, `318c516` 2026-08-17).

- [x] **`latestVersion` was `releases[0]`.** Fine for `/releases`, which is newest-first; `/tags` —
  the fallback that exists precisely because tags are what always exist — promises no ordering
  whatsoever. It is the highest semver in the answer now, which is what the word means.

- [x] **The bundled-changelog cache ignored its `repo` argument.** `repo` decides the `url` on every
  parsed release, and the cache was one module-level list, so the first caller's repo would have
  silently become every later caller's. Invisible with a single caller; a landmine the moment the
  release announcer became the second. Keyed by repo now.

### Every section of every release wears a real category

- [x] **The taxonomy matched almost nothing this changelog actually writes.** 2.3.0 rendered as a
  single grey `Changes 20` chip because all four of its sections fell through: `hardening` does not
  match "Also **hardened**", and nothing in the list knew "MCP", "guardrails" or "AI refine".
  Headings here are sentences — "Active sessions is a list of devices again" — so a keyword list
  alone was never going to carry it.

  **The emoji was already the answer.** Every heading carries one, chosen by whoever wrote it, and
  the lock/shield family has meant security for fifty-nine headings straight. Classification reads
  the emoji first and falls back to keywords, with ordered priority: Security before Fixes so a
  password fix files as security, Performance before Fixes so "measured, then fixed" is not a bug,
  Fixes before Infrastructure so "Setup no longer strands a database" reads as the bug story it is.

  Measured over the real file: **58 of 59 headings classify**, against roughly a dozen before.
  Categories grew to Upgrading / Security / Performance / Fixes / Infrastructure / Interface /
  Internal / Dependencies / Features, each with a lucide icon the app already ships and a tone from
  the existing token set — tones form families rather than nine unrelated hues, because the icon
  and the word already carry the distinction.

### The upgrade tells you it happened

- [x] **Nobody was told a new version had arrived.** The only signal was a dot on a profile-menu
  item, and it was keyed on `latestVersion` — GitHub's newest — so after an upgrade to an untagged
  2.4.0 it never re-armed. It keys on the version the workspace is RUNNING now, which is the
  version whose notes the page can actually show.

- [x] **And there is a real notification.** `release-announce.service.ts` writes one
  `release.published` bell row per active user at boot, titled with the version and linking to
  `/app/whats-new?release=X.Y.Z` — which the page reads and expands on arrival. It clears the way
  every other bell item clears, and it reaches everyone rather than only admins, matching the
  What's-new page's own split: the notes are for everyone, only the upgrade command is admin-only.

  **In-app only, and structurally so:** the category is registered with `null` in notify.service's
  `SETTINGS_FIELD`, and the bulk helper it uses throws if handed a category that has an email leg.
  Emailing every user of every tenant on every release is how a sending domain gets filtered, and
  no category in the email role matrix covers product announcements.

  **Dedupe with no new table:** the notification rows are the record. The link carries the version,
  so "has this workspace been told about this one" is a lookup for that exact link — an answer that
  survives restarts, redeploys and rollbacks for free. Boots are cheap and can loop under a
  supervisor; announcements cannot.

- [x] **Documented where the next person will look.** CONTRIBUTING.md's release process now says
  that VERSION + CHANGELOG.md are the release as far as the product is concerned, that a section's
  emoji is a category tag rather than decoration, and that the guard test
  (`changelog-releases.service.test.ts`) fails the build when VERSION has no changelog heading.
  DEPLOYMENT.md's update section says what users see when a version lands.

## 2026-08-17 — the deployment paths that never ran what they claimed

A completeness audit of every file that installs, upgrades, containerises or CI-checks this product,
prompted by the observation that the release history in the app had not moved since 8 August. The
What's-new fix is the entry above; this is what the audit underneath it found. Ten defects, and the
common shape is that **none of them failed loudly** — each one either warned where it should have
errored, or reported success for work it had not done.

### Fixed

- [x] **The API image never contained `apps/api/scripts/`.** The runtime stage cherry-picks
  directories and that one was absent, so `npm run migrate:tenants -w apps/api` exited "file not
  found" in every container. That is the multi-org schema fan-out `update.sh` runs on *every*
  update, and the command the Kubernetes runbook says to `kubectl exec`. Its failure is deliberately
  a warning rather than an error (one bad tenant must not roll back everyone), so the warning was the
  only thing that ever happened: **every non-default tenant database has been silently staying on its
  old schema.** The same omission disabled `doctor:heal`, which is the documented P3009 repair.
  Multi-org installations should run the fan-out once after upgrading to 2.5.0.
- [x] **Uploads over 1MB were rejected before the API saw them.** `middleware/upload.ts` accepts
  25MB x 8 files; nginx's `client_max_body_size` and ingress-nginx's `proxy-body-size` both default
  to 1MB. The proxy refused the body, so the app's own readable size/type errors could never fire and
  the user got a bare 413. Both now carry the app's own arithmetic (210m), scoped to `/api/` so the
  SPA keeps the tight default.
- [x] **Enabling face verification OOMKilled Kubernetes pods.** The models need ~500MB resident per
  API process against a `512Mi` limit. Now `1280Mi`, requests left at `256Mi` because most
  installations leave the feature off.
- [x] **Outbound mail had no Helm configuration at all** — no SMTP keys in the ConfigMap, no
  `SMTP_PASS` in the Secret example. It did not fail loudly either: `mail.service.ts` logs messages
  to stdout when no host is set, so password-reset links were "sent" into `kubectl logs`.
- [x] **A migration stranded mid-apply (Prisma P3009) deadlocked every deployment path.** MySQL DDL
  is not transactional and Prisma does not roll back, so a half-failed migration leaves its DDL
  applied while `_prisma_migrations` says FAILED — and every later `migrate deploy` refuses,
  including the corrected version of the migration that broke. `update.sh` made it worse by rolling
  the code back into the same wall. `install.sh`, `update.sh`, `update.ps1` and the Helm migration
  Job now attempt the doctor's repair as a fallback *after* a normal `migrate deploy`, preserving
  exit status so a genuinely failing hook still blocks the rollout. Only migrations declaring
  themselves `@rerunnable` are cleared, and `prisma migrate reset` is never run.
- [x] **Two CI gates had never executed once.** Both the security-scan dogfooding job and the
  test-run reporting step were gated on `if: secrets.X != ''`. GitHub does not expose the `secrets`
  context to **any** `if:` key, so the expression was `'' != ''` — permanently false, token
  configured or not. Replaced with a job-level `env` for the step gate and a preflight job whose
  *output* a job-level `if:` may legally read.
- [x] **`Chart.yaml`'s appVersion had drifted to 2.1.0 while the repo shipped 2.4.0**, so
  `kubectl get deploy -L app.kubernetes.io/version` answered wrongly and nothing failed. Corrected,
  and CI now asserts appVersion against the repo `VERSION` file on every run — which is why cutting
  2.5.0 moved both.
- [x] **Six documented environment variables never reached the container.**
  `TENANT_DB_PROVISION_BASE_URL`, `SLA_CRON_SCHEDULE`, `SLA_DEFAULT_APPROVAL_HOURS` and the three
  `UPDATE_CHECK*` variables were in `.env.example` and read by code but absent from the compose
  service definitions, and Compose does not pass the host environment through. The audit computed
  the coverage matrix rather than eyeballing it: 59 operator-relevant variables x 4 surfaces
  (`.env.example`, three compose shapes, Helm ConfigMap/values, docs), now with zero gaps and
  nothing documented-but-unread.
- [x] **Face enrollment could not accept the frame count its own route allowed.** The route passed
  `maxCount` 8 while the shared multer instance capped `files` at 5, so a six-to-eight-frame
  enrollment died with `LIMIT_FILE_COUNT` — an unreadable 500 — instead of the route's own limit
  answering. Today's guided wizard sends four, so nothing broke in practice; a fifth pose would
  have. Both ends now derive from `FACE_ENROLL_MAX_FRAMES` / `FACE_VERIFY_MAX_FRAMES`.
- [x] **Emailed dashboard links contained the literal word "auto".**
  `report-subscription.worker.ts` read `process.env.APP_BASE_URL` directly, bypassing the resolution
  in `config/env.ts` that turns `auto` or a `{lan-ip}` token into a real address.
- [x] **The Windows updater re-encoded its own database backup.** `update.ps1` piped `mysqldump`
  through `Out-File -Encoding utf8`; PowerShell decodes a native command's stdout into strings using
  the console encoding and re-emits it with its own line endings, so the "backup" was a rewritten
  copy — CRLFs, a possible BOM, any byte the codepage could not round-trip replaced — and nothing
  says so until restore day. The dump is now written inside the container and copied out with
  `docker compose cp`, gzipped and named `.sql.gz` to match `update.sh`, with a size floor because
  the container-side pipe reports gzip's exit status rather than mysqldump's.

### Added

- [x] **`validate-deployment-manifests` CI job** — `helm lint`, three `helm template` renders
  (bundled MySQL, external database with hooks disabled, telemetry and VPA enabled) each
  strict-YAML-parsed, `docker compose config` across all three compose shapes, and the
  Chart.yaml/VERSION assertion. Entirely offline: no cluster, no registry, no push.
- [x] **A committed way to drive the running app.** `.claude/skills/run-timesphere/` holds a
  Playwright driver (`driver.mjs`) with `health` / `shot` / `text` / `eval` / `bell` commands and a
  SKILL.md of the traps found while writing it — the dev server being HTTPS-only, `/api/notifications`
  answering 401 to a cookie-only client because the SPA holds its token in memory, and `/app/dashboard`
  not being a route. It is how the 2.5.0 What's-new page and the release notification were verified
  in the real UI rather than only in tests.

### Open — reported, not fixed

- [ ] **`update.ps1` omits the platform-admin login check** that `update.sh` performs, and
  **`install.ps1` has no Kubernetes branch** at all. Parity gaps rather than defects, but the
  Windows path is quietly the weaker one and that should be a decision, not an accident.
- [ ] **`api-pvc.yaml` offers no `storageClassName`** (the MySQL StatefulSet does), so an uploads
  PVC lands on whatever the cluster defaults to.
- [ ] **`helm lint` and `docker build` could not be run on this machine** — helm is not installed
  and the Docker daemon was not running. Substituted: every `.Values` reference resolved against
  `values.yaml`, all 14 templates checked for balanced `if/with/range`, and the compose files
  validated with `docker compose config` (client-side, which is why it worked). The new CI job is
  what will actually exercise helm; until it runs on a real push, treat the chart changes as
  reviewed rather than rendered.
- [ ] **The `tests/e2e` Playwright suite was not run** against this release. It is configured
  `workers: 1` because every spec shares one seeded MySQL database, and the unit suite (999 tests)
  plus the driven-app verification stood in for it.

## V8 — Agentic Work Management: the research, and what not to rebuild (2026-08-17)

Full plan: [AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md). Research only — nothing built.
Branch V8 opened at 2.5.0.

**The finding that shaped the plan.** Measured against asana.com/features, this product is at or
ahead of parity on nearly everything: tickets-as-work-items with hierarchy and four dependency
types, all four project views, custom fields, forms, blueprints-as-bundles, portfolios, dashboards,
capacity/workload, rules, admin/audit/guests, plus timesheets and budgets Asana structurally cannot
match because it holds estimates where this holds approved hours with a rate snapshot. Four things
are genuinely missing, and only one of them is a feature:

- [ ] **Goals / OKRs** — no `Goal`, `Objective` or `KeyResult` model exists. The real gap.
- [ ] **A work Inbox and a per-person daily brief** — `Notification` rows and a bell exist; nothing
  assembles "what needs me today".
- [ ] **An agent roster** ("AI Teammates") — 16+ capabilities already run with autonomy levels; what
  is missing is a name, a scope, an identity and a budget around them. Packaging, not authority.
- [ ] **A workflow builder** ("AI Studio") — `TicketRule` is deterministic and fires only at ticket
  creation. No multi-step flows, no human-input gate.

**Why phases 3-5 are weeks rather than quarters.** The dangerous machinery is built and is listed by
name in the plan: `AgentRun`'s `triggerKey` idempotency, its level copied at queue time so a policy
edit cannot escalate a run in flight, its `taintedAt` clamp that drops effective autonomy to SUGGEST
the moment externally-authored text enters the context, `AiCapabilityPolicy`'s code-set ceilings an
admin may only lower, and the `AiProposal` envelope with its per-row diffs, writable-field allowlist
and stale-state refusal. A builder that composes these must inherit all of it — the plan states the
three inviolable rules (authority is the MINIMUM of composed steps, taint propagates, everything
above SUGGEST writes through a proposal) precisely because a no-code surface is where those
guarantees would otherwise quietly be lost.

**The differentiator, and it is not having agents.** Every competitor's agent story ends at "it
ran". `AgentWorkEntry` puts agent work on the same ledger as human work — attributed to a project
and activity, priced from `AIUsageLog`, with displaced human minutes stated only where this
workspace's own timesheets provide a baseline and `NULL` (shown as *not measurable*) where they do
not. Workload then reads human load beside agent load, burn separates human cost from agent cost,
and an attestation can itemise "240 approved hours, 12 agent-assisted" and prove it, because every
agent write already has an audit row and a proposal diff. Never billable to a client by default.

**Deferred deliberately**: TimeSphere as an MCP *client* (the StackAI-style reach into other
systems) is written down as phase 6 so it cannot be smuggled into the builder phase, since outbound
credentials plus by-definition-tainted input is a security surface of its own.

**Four decisions needed before phase 1 starts** — phase order (Goals first is recommended), whether
an agent is a dedicated non-login `AGENT` user (recommended, with a hard flag excluding it from seat
counts and every auth path), whether agent time is ever client-billable (recommended never by
default), and whether a measured goal may be manually overridden (recommended yes, with the override
and the measurement both recorded).

## V8 phase 1 — Goals, and progress that measures itself (2026-08-17)

Plan: [AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md) §5 phase 1, built to the four
decisions recorded in §7. The V6 constraint carried over verbatim and held: every table new, the one
added column defaulted, inert until an admin opts in, and the whole unit suite green.

- [x] **`Goal` / `GoalLink` / `GoalProgressOverride`, plus `GlobalPlanningSettings.enableGoals`.**
  Objective → key result via `parentId`, two levels enforced in the service because a database
  cannot express "no grandchildren" without a maintained depth column. Soft-deleted like
  `Portfolio`: a goal that shaped a quarter's decisions is audit trail.
- [x] **`progressSource` is the whole feature.** `MANUAL` behaves like every competitor's OKR; the
  six measured sources each name a number the product already computes — approved hours, billed
  spend from the rate snapshots an attestation reads, tickets closed, on-time rate, SLA escalations,
  average project risk. A goal wired that way cannot be talked up in a review, which is the entire
  point of an OKR and the thing spreadsheet OKRs always lose.
- [x] **The catalogue is CLOSED**, for the two reasons the dashboard widget catalogue is closed: a
  metric two goals can define differently will be defined differently, and a user-supplied metric is
  a query surface. A new source costs a server change; that is the right price for a number somebody
  is judged against.
- [x] **Direction is a property of the source, not of the goal.** Spend, breaches and risk are
  AT_MOST and deliberately return **no percentage at all** — "62% of the way to your spending
  ceiling" reads as an achievement. The UI shows the raw amount against the ceiling instead.
- [x] **`unavailable` is a first-class result, never 0.** No period, no target, or no data in scope
  returns a reason the page prints verbatim. "No data yet" and "nothing achieved" are opposite
  messages that look identical as a zero — the dashboard-widget rule, applied to the number that
  matters most.
- [x] **Nothing is stored.** Every figure is derived on read from the same tables the portfolio
  roll-up and the client-facing attestation read, so a goals page and a signed document cannot
  disagree. A stored figure would need a recompute worker, and a stale one is the failure mode.
- [x] **Overrides keep the receipt** (decision 4). Append-only, note required, and each row stores
  what the measurement said *at that moment*. The page shows both numbers side by side rather than
  replacing one with the other, and there is no PATCH or DELETE — a correction is another row.
- [x] **Two gates, two messages.** `enableGoals` AND the tier's `goalsEnabled`, ANDed server-side.
  Deliberately NOT behind `enablePlanning`: goals align work whether or not the Gantt is in use.
  Team gets 25 active goals, Enterprise unlimited, Starter none. The quota counts ACTIVE goals only
  — counting closed ones would push people to delete the record of what they were aiming at.
- [x] **Reading needs no permission; `goals:manage` gates writing**, and it goes to MANAGER and
  TEAM_LEAD as well as the two admin roles. A manager who cannot write the goals their team is
  measured against has nothing to manage.

**What the replay check caught, and why it is worth running every time.** `migrate deploy` into a
genuinely empty database (the check DATABASE.md mandates) showed the permission row present and
**zero role grants** — because on a fresh database the migration's `RolePermission` insert matches
nothing: roles do not exist until the seed runs. A migration-only change would therefore have
shipped `goals:manage` to every new install with no role holding it, while every *existing* install
was correct. Both paths are now covered and were verified to produce identical grants
(SUPER_ADMIN, ADMIN, MANAGER, TEAM_LEAD). The V6 entry warned about the mirror image of this bug;
this is the other half of the same lesson.

**Two more things the repo's own guards caught**, both before any human review: the
migration-portability test rejected an unguarded `ALTER` in a file that ends in DML (fixed with the
`information_schema` + `PREPARE` pattern, and the same test objected to the words "@rerunnable"
appearing even inside a comment), and `plan-tier-claims.test.ts` failed until the new entitlement
was stated in the pricing contract — which is exactly what that test exists to force.

Verified: 1028 unit tests (+29, including 21 that pin what a measurement MEANS — direction, pace
thresholds, the clamps, and unavailable-is-not-zero); `npm run lint` clean; all 79 migrations
replayed into an empty database, then seeded, then the backfill re-run to prove idempotence; live
data untouched throughout (1,718 tickets, 237 timesheets, 346 users, 31 projects before and after);
and the page driven in the real browser at 390 / 768 / 1366 in both themes with zero horizontal
overflow — the `overflow-x: clip` trap from the V6 phase-2 entry.

**Not done in this phase:** goals are not yet surfaced on the Portfolio page or the dashboard, and
there is no goal-level e2e spec (the Playwright suite was not run — see the 2026-08-17 deployment
entry, which records the same gap).

## V8 phase 2 — an Inbox, and a brief that counts rather than guesses (2026-08-17)

Plan: [AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md) §5 phase 2 — Asana's Inbox and Dash,
built deterministically first. Additive: two nullable columns and one index on `Notification`,
nothing else touched.

- [x] **`Notification.handledAt` / `snoozedUntil`, and the distinction that justifies them.** `readAt`
  is about attention; `handledAt` is about work. Collapsing the two means every glance at the bell
  empties the queue, which is why an inbox built on "read" alone is never trusted. `snoozedUntil` is a
  timestamp rather than a boolean because a snooze with no wake-up is a delete that pretends
  otherwise — hidden from the queue until its time passes, then back with nobody re-filing it.
- [x] **`handle-all` marks handled; nothing is ever deleted.** The row is the record that a person was
  told, and it is what answers a support question a month later.
- [x] **Ownership IS the authorisation.** Every write is an `updateMany` filtered on `{ id, userId }`,
  so a guessed id matches zero rows and answers 404. There is deliberately no id-lookup-then-check
  path and no admin view of somebody else's inbox — which is exactly the shape a later "simplification"
  to `update({ where: { id } })` would break, hence the test that pins it.
- [x] **The brief is arithmetic.** Eight sections, each calling a definition that already existed:
  the my-work buckets, the UTC-midnight `workDate` check `/daily-status` performs, the SUBMITTED
  predicate the approvals page acts on, `ApprovalStep` PENDING, the latest-snapshot-per-project RED
  count, unread notifications. No model writes any of it. A narration layer is still available later
  (`daily_brief`, ceiling AUTONOMOUS, explaining figures it cannot change) but the figures are true
  on their own first — a fluent paragraph whose numbers cannot be reconciled against the pages they
  came from is worse than no paragraph, because the first disagreement discredits both.
- [x] **`computeMyWork` extracted to `services/my-work.service.ts`.** The bucketing was inline in
  `/plan/my-work`; the moment the brief needed the same numbers, inline became two definitions, and
  "overdue" is precisely the word that must not mean two things in one product. The route's response
  is byte-identical — a move, not a redesign — and the full suite passing unedited is the evidence.
- [x] **Discretion, not just arithmetic.** The approval and risk sections appear only for people
  holding the rights that already grant those pages, and are **not queried at all** otherwise: a
  cross-user aggregate shown to somebody who cannot act on it is both a leak and an uncleanable
  to-do. And `allClear` ignores informational rows — if "3 things due today" could raise the alarm,
  nobody would ever see an all-clear and the signal would be worthless.
- [x] **Asana-shaped UI**: two panes on desktop (list beside a sticky detail, so triage is
  read-decide-next rather than navigate-and-back), one list below `lg`, filter tabs carrying their
  own counts, in-row actions rather than a menu (triage is a two-click loop; a menu makes it three),
  and a genuine per-filter empty state rather than one generic "nothing here".

**The bug the browser found that no test would have.** The first render of this workspace's inbox was
**24,299 pixels tall** — 200 rows, no windowing, and the sticky detail pane lost somewhere in the
middle of its own layout. That is not a queue, it is a log. Fixed with a 25-row reveal and a
scrolling list pane; the same page is now 1,016px at laptop size. Also corrected: the category label
map had been written from guessed keys, so real categories like `ticket.escalation` and
`face.verification_flagged` rendered raw — it now keys on the categories producers actually write,
with a family prefix fallback so a NEW producer still reads sensibly instead of being pooled into
"Other" and hidden.

Verified: 1053 unit tests (+25 — the ownership boundary, the snooze semantics, and the brief's
discretion); lint clean; the triage loop driven against the live API end to end (mark done → leaves
the to-do list and appears under Done → reopen → snooze → hidden → **a past-dated snooze returns by
itself** → restored, counts 311 → 310 → 311 throughout); and the page checked at 390 / 1366 / 1600 in
both themes with zero horizontal overflow.

**Not done in this phase:** the optional AI narration of the brief, and there is still no e2e spec
(unchanged from phase 1). The bell itself is untouched — it remains the glance, and the inbox is the
queue.
