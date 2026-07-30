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
