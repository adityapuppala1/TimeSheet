# TimeSphere — Timesheet + AI-Powered Ticketing Portal

A full-stack workspace platform that combines **timesheet management** (daily work logging,
approvals, SLA-driven escalation, reporting) with a **Jira-like ticketing system**, a full
**project-planning layer** (Gantt timelines, dependencies, portfolios, capacity and budgets),
**change management** (risk-scored, approved, scheduled and reviewed releases), a
**bring-your-own-key AI layer** (Anthropic or any OpenAI-compatible provider), and an
**analytics/insights dashboard** — all under one roof, one login, and one admin-configurable
settings surface.

The unifying idea, and the thing that is genuinely hard to copy: this app already owns both *the
work* (tickets) and *the time actually spent on it* (approved, rate-snapshotted timesheets). A
dedicated project tool has to **estimate** effort, because estimates are all it holds; here the
workload board can put planned hours, real logged hours and contracted capacity on the same axis,
and a budget forecast is priced from the same approved rates a client-facing attestation reads. A
timesheet tool cannot plan and a planning tool cannot measure — the whole product is the argument
that those should not be two systems.

Change management extends the same argument one step further. A change request here **is** a ticket
plus a governance record, so the thing you asked approval for and the work that delivered it are the
same row — which is why a closed change can name the tickets it shipped, price the hours against
them, and hand an auditor a register that reconciles with the timesheets underneath it. A standalone
CAB tool holds none of that.

> **v2.0.0 — the planning layer.** Everything in it ships **off by default**: upgrading changes
> nothing a user can see until an admin turns it on. See [CHANGELOG.md](CHANGELOG.md).
>
> **v2.2.0 — one thing you must set.** `TRUST_PROXY_HOPS` defaults to `0`, which preserves the
> previous behaviour. If anything sits in front of this API — nginx, a load balancer, Cloudflare,
> or the Docker Compose stack as shipped — set it to the real number of hops, or every per-IP
> rate limit stays one shared global bucket. See
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#reverse-proxies-and-client-ip-attribution-trust_proxy_hops).
>
> **v2.3.0 — TimeSphere is now an MCP server, and nothing turns it on but you.** Point an AI
> assistant at `POST /api/mcp` and it can read (and, if you allow it, act on) a workspace as one
> specific user. It ships **disabled**, its write tools ship disabled *individually*, and upgrading
> changes nothing until a super admin opens Workspace Settings → MCP server. One additive
> migration, **no new environment variable in any deployment shape**. See
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#operating-the-mcp-server) before enabling it.
>
> **v2.4.0 — multi-org deployments: run the tenant fan-out once after upgrading.** The API image
> did not previously ship `apps/api/scripts/`, so `npm run migrate:tenants -w apps/api` — the
> command that brings every *additional* organization's database up to the latest schema, which
> `update.sh` runs on every update and the Kubernetes runbook tells you to `kubectl exec` — could
> not run inside a container at all. It is treated as a warning rather than an error (correctly:
> one bad tenant must not roll back everyone's upgrade), so the failure was quiet. Single-org
> installs are unaffected. Everyone else:
> `docker compose exec -T api npm run migrate:tenants -w apps/api`.
>
> Also new: all four deployment paths now recover automatically from a migration stranded mid-apply
> (Prisma **P3009**) instead of retrying into it forever, and this release's one migration revokes
> surplus sessions beyond each user's 10 most recent. See
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#what-240-adds-to-that-dance-session-device-identity--and-the-first-migration-that-can-strand-a-database).
>
> **v2.5.0 — multi-org deployments, again: the fan-out is the step people miss.** The tenant schema
> fan-out has never been able to run inside a container, so every organization beyond the default
> one has been sitting on its old schema without any update saying so. After upgrading:
> `docker compose exec api npm run migrate:tenants -w apps/api`.
>
> **v3.3.0 — the week you can read, and a workspace that installs itself.** Scheduled email now
> answers to the RECIPIENT's clock: reminders were being judged against the server's timezone, so
> anything after ~2:30pm on a New York Friday looked like Saturday to an IST server and was dropped
> until Monday. The Monday digest reaches managers and admins for the first time (the activity gate
> was filtering out exactly the people it exists to inform), gains a manager's team view and
> change-management figures, and the security digest no longer refuses to send when the AI is
> unavailable. Both moved to 10:00 / 10:30. Plus: an app loader, a dashboard "This week" card that
> fills its own space, closable notices, an n8n-style Workflow canvas, and the org chart for
> everyone. **Nothing to configure** — and `npm run dev` / `npm run build` now install new
> dependencies for you after a pull, so a release that adds one no longer greets you with
> `Cannot find package`.
>
> > **v3.2.0 — the requests this server makes on your behalf.** A security pass over the places where
> TimeSphere acts as a *client*: the four admin-typed URLs the server fetches (outbound webhooks, the
> Google Chat webhook, Bot Framework replies, the BYOK AI base URL) now go through one guard that
> resolves DNS and refuses private, loopback and cloud-metadata targets. The SPA finally carries its
> own security headers — CSP with `frame-ancestors 'none'`, `Referrer-Policy`, `Permissions-Policy` —
> which nginx was serving without. Public API keys can expire. **Two configuration notes:** set
> `ALLOW_PRIVATE_NETWORK_EGRESS=true` only if this box's webhook receivers genuinely live on your LAN
> (the installers now ask, and `npm run doctor` flags the risky combination), and a *split* deployment
> — SPA on a different origin from the API — must set `CSP_CONNECT_SRC` to that API origin or the
> browser will block every call. One migration, additive and NULL-defaulted: no key that works today
> stops working.
>
> **v3.1.0 — the assistant can act, on a short leash.** Ask AI gained three actions beyond drafting
> time: raising a ticket, commenting on one, and drafting a change request. Each is offered only to
> someone holding the permission the matching button requires, and each re-checks that they can see
> the project or ticket before it writes. Raising a ticket and commenting **publish** — neither has a
> draft state — and the assistant says so rather than calling them drafts; a change request is raised
> as a DRAFT and stops there. **Nothing can start or settle an approval, at any autonomy level.** No
> migrations, no new environment variables, nothing to switch on.
>
> **v3.0.0 — change management, and nothing breaks.** A major version for an *additive* release: no
> route changed shape, no column was dropped, no default moved, and an installation that never turns
> the module on behaves exactly as 2.5.0 did. The number moved because the product gained a
> governance surface it did not have. Six tenant migrations and one control-plane migration ship
> with it — run the fan-out above for multi-org installs. It is **off after upgrading**; a super
> admin enables it in Workspace Settings → Change management, and the org's tier must include it.
> Set `managerId` on your users first: approval routes to the requester's manager, and with none set
> it falls back to every active super admin. **No new environment variables.**

## Feature areas

| Area | What it does |
|---|---|
| **Timesheets** | Daily time entry against project/module/submodule/activity, manager approval workflow, SLA-driven escalation up the reporting chain, daily reminder + next-morning escalation emails, filterable CSV/PDF/Excel export (next row). The **approvals queue** is a full working surface rather than a list: free-text search across notes and descriptions, status/project/activity/work-date filters (defaulting to the pending queue, widened to review what you decided last week), sortable and paginated, a stacked card + detail dialog below the `sm` breakpoint, and a **per-entry CSV export** using the same columns as the workspace-wide report — so the record behind one decision can be filed alongside it. |
| **Reports & analytics on the entries** | Every export format — 22-column CSV, PDF, a real Excel workbook with a summary sheet, and the on-screen grouped report (by person, project, activity or day, with share-of-total columns that sum to exactly 100) — is fed by **one shared query builder**, so no two formats can disagree about which rows a filter matches. The PDF and the Excel workbook are real documents rather than dumps: an attributable header block (who ran it, over what period, for which workspace), grouped subtotals so "how many hours did this person bill" isn't a question answered with a calculator, descriptions that wrap instead of being silently cut mid-sentence, `Page N of M`, and a summary sheet built from the same capped row set as its own detail sheet so a truncated export can never ship a summary that doesn't add up. All four PDF exports in the product — this one, the requirements document, the verified work attestation and the security assessment report — render through **one shared house style** (`apps/api/src/services/pdf-kit.ts`): the same watermark, running header, measured tables and status pills, so two documents from the same product cannot look like two products. The PDF states its row cap in the header *and* footer instead of silently truncating, and every export returns `X-Report-Truncated` / `X-Report-Rows-Included` / `X-Report-Total-Matching` headers. An analytics panel derives **utilisation** (logged hours vs each person's *contracted* capacity), **approval latency** (submitted→decided, from a real `submittedAt` timestamp — not `updatedAt`, which moves for other reasons) and **activity mix** from the same filters. The rule throughout is *null, never zero*: no capacity on file means no utilisation figure rather than an alarming 0%, and a cost without a rate snapshot is absent rather than free. |
| **Ticketing** | Bugs/tasks/improvements with admin-editable types & labels, priority/status workflow (with a Kanban board and drag-and-drop, optional **"Group by manager" swimlanes**), assignment, comments, attachments, watchers, cross-ticket links (Blocks/Duplicate of/Relates to), sub-task checklists, SLA due-dates with automatic breach escalation, and a **Dev tab** for linking a repository/branch/PR (open/merged/closed status) to a ticket — manually, or picked live from a connected GitHub account. An optional **CI gate** (off by default) blocks a ticket from moving to Resolved while its latest ingested CI test run is failing, and the Kanban card shows a red badge for the same reason. |
| **Live git integration (GitHub)** | Each org connects its own GitHub account via OAuth (bring your own GitHub OAuth App — same model as Google/Microsoft SSO below, no TimeSphere-operated client ever touches your repos). The ticket Dev tab lists live repos/branches/open PRs to pick from, and a per-repo GitHub webhook auto-syncs `TicketBranch` rows as commits land and PRs open/merge/close (matched to a ticket by a ticket-key-shaped token in the branch name, e.g. `WEB-123-fix-login`) — plus, opt-in, an AI-authored PR-review summary comment when a linked PR opens. GitLab/Bitbucket remain unbuilt — see [docs/ROADMAP.md](docs/ROADMAP.md). |
| **Public REST API + outbound webhooks** | Bearer-API-key access to `GET/POST/PATCH /api/public/v1/*` (list/get/create tickets, change ticket status, add a comment, list timesheets) for external integrations — generate named, revocable, READ- or WRITE-scoped keys from Workspace Settings. Status changes enforce the exact same transition-legality and CI-gate rules the UI does. Outbound webhooks POST an HMAC-SHA256-signed JSON payload (same trust model as GitHub/Stripe webhooks) when a ticket is created, changes status, or closes, or a timesheet is submitted/approved. See [docs/API.md](docs/API.md#public-api). |
| **MCP server (opt-in, off by default)** | TimeSphere exposes **itself** as a [Model Context Protocol](https://modelcontextprotocol.io) server at `POST /api/mcp` — JSON-RPC over Streamable HTTP, so Claude Desktop, Claude Code or a hosted agent can read and act on a workspace without opening the app ("what's in my approval queue?", "log two hours against WEB for the payment refactor"). Eleven tools today: seven read (identity, ticket search and detail, projects, your own timesheets, your direct reports, the timesheet report) and four write (log time, create ticket, comment, transition). **The credential is a person, not a key**: it is bound to exactly one user, and every tool enforces the same permission that user would need in the app — an assistant connected with an employee's credential sees what that employee sees and no more. **Three closed defaults**: the server, a workspace-wide write latch, and each individual write tool all start off, so a write tool added by a *future* release arrives disabled rather than switching itself on during an upgrade. The workspace comes from the connection URL, never from anything the model can be talked into saying, and results that can contain externally-authored ticket text (inbound email, chat) are marked as data-not-instructions. Logging time creates a **draft**, never a submission. Enabled and credentialed by a super admin from Workspace Settings → MCP server; every call and every refusal is audited. See [docs/API.md](docs/API.md#mcp-server) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#operating-the-mcp-server). |
| **AI, BYOK multi-provider (opt-in)** | Auto-triage suggestions on ticket creation, duplicate-ticket detection, an **AI refine** button beside the fields you write for other people to read, AI comment-thread summaries, natural-language "Ask AI" search over the ticket backlog (command palette), a Monday-morning AI-authored weekly digest email, and the consolidated **Weekly AI/ML Practice Update** for leadership (next row). **Refine is a suggestion, never a replacement**: offered on timesheet task descriptions and notes, ticket titles and descriptions, ticket comments, and every written section of the weekly practice update (next row), it shows your text and the suggestion side by side, changes nothing until you press *Use this*, and keeps the original so Undo is real. It is also deliberately unable to embellish — refining is constrained to grammar and clarity, and may not add a fact, change a number, date or ticket reference, or make a claim stronger, because a timesheet description is a record an approver signs and an auditor may read. AI throttling is **per person** (20 requests/minute keyed on the account rather than the network address, so a shared office isn't one allowance between everybody and one person on three devices isn't three). Every capability is gated behind a master switch **and** its own per-feature toggle in Workspace Settings — nothing calls out to any provider until an admin explicitly turns it on and a key is configured. **Bring-your-own-key, as a ranked list, not one provider**: add as many as you like — Anthropic (native) or any OpenAI-compatible provider (OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, a local Ollama/LM Studio install, or a custom endpoint) — from Workspace Settings → AI, each with its own key, model and on/off switch, reordered with ↑/↓. Every call tries the top enabled provider and falls through the list on a rejected key, a rate limit or an empty answer, using each provider's own configured model rather than the primary's. A **live status dot** per provider (Healthy/Degraded/Down, from the last 15 minutes of real traffic) plus an on-demand **Test** button that fires a real, tiny request against the row's own configured model — not just a reachability ping. An opt-in **circuit breaker** auto-demotes a provider to the back of the line after three failures in a row (never auto-promotes, to avoid flapping between two flaky providers), and a data-driven **Suggest order** ranks the list by each provider's own last-30-day success rate, latency and cost. Mechanical tasks (triage, duplicate detection) additionally route to whichever *healthy* provider is cheapest, while judgment tasks keep the admin's exact order. The key is encrypted at rest and never returned to the client. Every AI call is cost-estimated and logged (`AIUsageLog`, with a sortable usage table and Excel export) against a configurable monthly budget cap. |
| **Weekly AI/ML Practice Update (opt-in)** | One consolidated weekly view for a leadership audience, in the shape they ask for: an executive summary, then Products / Features, POCs / Innovation, Bugs / Stability, Security and Training / Capability Building — each initiative with **Owner, a 🟢/🟡/🔴 status, this period's progress, next steps and risks** — then releases, key metrics with week-on-week movement, risks and blockers, next week's priorities, and the decisions leadership is being asked to make. **Nobody fills in a form**: initiatives are the workspace's own active projects, sorted into those areas from the project's name and from what its people actually logged against it, with the owner derived from who logged the most hours. **The status colour is arithmetic, never a model's opinion** — red means a breached SLA or more than a third of the open work already late, so a red is reproducible in the meeting where somebody asks why. **The figures are counted and the prose is drafted**: AI writes the summary, risks, priorities and asks and is allowed to fail — with the model off or unreachable every section still renders from the facts it would have been written from, and the reviewer is told which happened. **Generate → review → send**, with every written section editable (and refinable) before it leaves and the counted figures deliberately read-only. **Only a super admin sets the distribution list**, which takes plain email addresses rather than accounts — the people who most need it often have neither. An optional Monday 07:30 send is off by default. Registers like every other email, so it appears in Email templates and Email analytics with no special-casing. |
| **Requirements Studio (opt-in)** | An AI-guided interview (Plan → Requirements Studio) that turns a project idea into a structured PRD/BRD before any project exists: one question at a time — problem, users, scope, features, tech stack, architecture, timeline, risks, success metrics — with quick-reply suggestions and a "skip — assume and flag it" option so the interview never stalls, and anything left uncovered becomes a stated **assumption** in the finished document rather than a silent guess. **Or start from a document you already have**: optionally upload an existing PRD/BRD (PDF, Word, or text) instead — the AI proposes which interview answers it already covers, every proposed answer is editable or removable before anything is saved, and the interview then asks only about what's left, exactly as if nothing had been uploaded. Generates a real navigable section-by-section document, including an AI-drawn architecture diagram (rendered live via Mermaid, falling back to raw source rather than the page if a weaker model draws something unparseable), and exports to PDF and Markdown. Turning it into real work stays human-reviewed at every step: "Create project from this document" prefills the New Project form, "Propose tickets" turns every feature into a draft change set accepted row-by-row through the same trusted pipeline `plan_breakdown` already uses, and "Create goals" turns success metrics into goals after a one-screen confirm — nothing is ever created silently. |
| **Email-to-ticket intake** | Point an IMAP mailbox at the app; inbound bug-report emails (including screenshot attachments, read directly by the configured model's vision input) are auto-classified into a properly-typed, prioritized, project/module-routed ticket, auto-assigned via admin-configured rules, and the sender gets an automatic confirmation reply. Untrusted email content is delimited and instructed as data-not-instructions before it reaches the model, and its self-reported confidence is capped before it can suppress human review. Low-confidence classifications are flagged **needs review** instead of silently mis-assigned. An **AI Activity Log** page shows every AI-touched ticket with a thumbs up/down feedback control. |
| **Insights & analytics** | Ticket velocity, SLA compliance trend, cycle-time distribution, bug hotspots by module, a per-assignee workload heatmap, estimate-vs-actual variance, reopen rate, and first-response time — plus two opt-in-and-off-by-default panels (cost-per-ticket, team leaderboard) since they touch compensation-adjacent or individually-ranked data. |
| **Admin configurability** | Nearly everything above is editable from **Workspace Settings** without a server restart: notification channels & reminder schedule, ticket SLA hours per priority, ticket types, labels, AI provider/toggles/model/budget, and email-intake mailbox connection + routing rules + module-assignee rules. **Email channels** is a category × role grid — every gateable category on a row, grouped into Timesheets/Tickets/Changes/Digests/Identity/Workspace, with a per-role cell for each. Unticking one suppresses only the *email* leg: the in-app bell notification always fires, so muting Manager on an escalation removes the inbox copy without hiding the escalation, and the super-admin audit BCC honours the same grid rather than re-delivering what a super admin just muted. `welcome`, `reset` and the intake auto-reply are listed as **Always sent** and deliberately have no row — they go to one person as the direct result of an action, and a role filter over a password reset is an account lockout waiting to happen. The **Email templates** page adds per-template send volume with a day-over-day trend, the success-vs-failure split, and a failure **triage desk**: identical SMTP rejections are grouped, translated into plain language (what it means, whether it clears on its own, first steps), searchable and category-filterable, with the exact SMTP text, affected recipients and domains one click away — plus an opt-in per-group **AI diagnosis** and a **Delivery by domain** view (per-domain success rates over a date range, each domain's top failure reasons, and stuck in-flight mail flagged by age). |
| **Workspace branding** | Upload your company's logo (and optionally the name shown beside it) from **Workspace Settings → Branding**. It renders in the sidebar and on the sign-in page — the login screen included, which needs it before anyone has authenticated. Uploads are re-encoded through sharp (EXIF/ICC/XMP stripped, polyglot files broken), scaled to **fit** 512×160 rather than cropped square, and stored as PNG so a transparent mark doesn't turn black in dark mode; the settings card previews it on both light and dark surfaces at once. The bytes live in their own storage subtree that the signed-grant `/uploads` gate refuses outright, with one public read route (`GET /api/branding/logo`, tenant-resolved by host) as their only reader — see [docs/API.md](docs/API.md#workspace-branding). |
| **RBAC & audit** | Role-based permissions (`SUPER_ADMIN` / `ADMIN` / `MANAGER` / `TEAM_LEAD` / `EMPLOYEE`), a tamper-evident audit log of every administrative/approval/AI action, and a per-ticket Activity tab that's just that same audit log filtered to one entity. |
| **Session management & security** | httpOnly, `SameSite=Lax` refresh-token cookie (never exposed to page JS) with rotation-and-reuse-detection, a per-user active-sessions list with per-device or "sign out everywhere" revocation, per-account login lockout on top of per-IP rate limiting, a real hashed/expiring/single-use password-reset flow, AES-256-GCM encryption at rest for stored secrets (IMAP password, BYOK API keys, OIDC client secrets), and a fully responsive layout (phone through 4K) — wide tables (Tickets list, Team page) fall back to a stacked card view below the `sm` breakpoint instead of a horizontal scroll — verified by an automated Playwright suite covering every route and every settings/ticket-sheet tab. See [Security](#security) below for the full VAPT assessment. |
| **Face (identity) verification (opt-in, Enterprise)** | Optional live camera check confirming the person submitting a timesheet, progressing a ticket, or **approving** a timesheet is the account holder — closing the "buddy punching" gap where one employee acts on a colleague's behalf. **All matching happens server-side** (the browser is a dumb camera; a client that decides its own verification outcome is not a security control), with anti-spoof + liveness scoring so a printed photo or phone screen can't defeat it, and a **challenge–response movement step** (a server-chosen random head movement, measured between two frames) so a virtual camera replaying recorded video can't either. Off by default and Enterprise-tier gated — enabling/enrolling fail closed without the entitlement while enforcement fails open, so a billing lapse can never lock a workforce out. Workspace master switch plus per-user opt-in, admin-tunable thresholds with a real match-score histogram to tune against, verified badges on submissions and approvals, enrollment notifications before the first blocked submit, a review log with virtual-camera/network signals plus optional AI review briefs, **outcome analytics** over a 7/30/90-day window (what checks actually returned — passed, no match, no face, liveness/challenge failures — as a trend and a breakdown, with colour bound to the outcome rather than to its rank so a bad week can't reshuffle what green means, alongside enrollment coverage and the pending/human-reviewed/auto-triaged review split), and a weekly identity digest. Because this stores **biometric data** (GDPR Art.9 / Illinois BIPA / India DPDP), enrollment is consent-gated with the exact wording stored verbatim, templates are encrypted at rest, captured images are org-scoped, served only through an authenticated route and auto-purged on a retention schedule, and users can export or delete their own face data at any time — with a 30-day-grace purge if the plan entitlement lapses. See [docs/FACE_VERIFICATION.md](docs/FACE_VERIFICATION.md). |
| **Security & DevOps ingestion (SAST/DAST/SSAT/SSCT/VAPT/QUALITY/LINT)** | Ingest-only, tool-agnostic: your own CI (GitHub Actions, GitLab CI, Jenkins, Bitbucket, or anything else) POSTs findings/test-run results to a per-org bearer-token-protected webhook — this app never runs a scanner itself. **SonarQube and ESLint are accepted verbatim**: Sonar's own webhook payload on `/quality-gate`, its issues-API response on `/findings/sonar`, and `eslint --format json` on `/findings/eslint`, with no translation script in between. VAPT (a periodic, human-led pentest, not a per-PR check) uploads as a structured JSON report instead, from Workspace Settings. Every finding carries a **fingerprint** (tool + rule identity + normalised path + a 50-line bucket), so a nightly scan reporting the same 200 issues raises an occurrence count instead of inserting 200 more rows, and every scan — including one that found nothing — is recorded as a `ScanRun`. Findings roll up into a per-ticket **Security** tab (risk verdict, PDF export) and, if enabled, a ticket-close digest email to the closer, their manager, and the org's admins. See [docs/SECURITY_DEVOPS_INTEGRATIONS.md](docs/SECURITY_DEVOPS_INTEGRATIONS.md). |
| **Verified remediation** | Resolving a ticket that carries findings records a **claim**, not a conclusion: those findings move to `PENDING_VERIFICATION` and the next scan decides. A scan **by the same tool, on the same repository and branch, of the same type** that no longer reports the fingerprint marks it fixed and stamps the run and commit that proved it; one that still reports it marks the finding refuted and — if you asked for that — reopens the ticket with the evidence attached, restarts the SLA clock and emails everyone who touched it. No qualifying scan inside the grace window (7/14/30/60 days) marks the finding *unverified* and nudges the assignee, and never reopens: absence of proof is not proof of failure. The two switches form a ladder, so "tell me, don't move my tickets" is a supported configuration rather than a half-installed feature. |
| **Findings routed to project, module and submodule** | Repository-pattern → project maps and path-glob → module/submodule rules, ordered, first match wins — the same semantics ticket routing already uses. A finding under `apps/api/src/services/billing-*` opens its ticket in the billing project, with that project's own key prefix, assigned through that module's owner rather than through whichever module happened to be created first. The path matcher **never compiles to a RegExp**: it simulates the pattern as an automaton over a boolean array, so backtracking blowup is impossible rather than merely mitigated. A "Test a path" box runs the real resolver against a path you type. |
| **Code quality, kept apart from security** | A finding's *discipline* is derived from its type and compile-enforced: `SAST/DAST/SSAT/SSCT/VAPT` are security, `QUALITY/LINT` are not. A thousand code smells therefore cannot move the org's security risk score, fill the by-severity chart, or crowd out one critical SQL injection — a regression test asserts the risk score moves by exactly zero. A failing SonarQube quality gate can optionally block **Resolved**, the sibling of the existing failing-tests gate. |
| **Billing & subscriptions (multi-org SaaS)** | Stripe Checkout for a first subscription; an **existing** subscription is changed in place with proration rather than replaced, so upgrading a paying customer cannot leave two live subscriptions behind. A Stripe Customer Portal session covers card, invoices and cancellation, and the last twelve invoices list in Workspace Settings linking out to Stripe's own hosted pages. A plan-change receipt emails the workspace's super admins on a real tier change and stays quiet on a quantity-only seat sync. Seat and AI-budget ceilings are enforced live on every request, not at renewal. |
| **Reporting-line views** | An interactive, pan/zoomable **org-chart tree** on the Team page (D3-hierarchy layout, built from the existing `User.managerId` relation, no new schema — privileged roles see the whole company, everyone else their own subtree), color/icon-coded per role (Super Admin/Admin/Manager/Team Lead/Employee) with each person's **designation** shown alongside their name, and matching **Kanban swimlanes** ("Group by manager") on the ticket board. A manager can also open any one direct report's **logged-hours trend** — week-by-week across the current month plus the trailing 12 months, counting all logged hours rather than only approved ones, since an entry still sitting in draft is work that was done. |
| **Live trend analytics** | **One date filter drives the entire home page** — pick today, a week, a month or any custom range and the hero cards, daily rhythm, progress, the workforce snapshot, productivity, project utilization, the day timeline and the project rollup all answer for that period, each naming the period it is actually showing. It is a server-side filter, not a client-side one, because the timesheet list truncates newest-first and filtering a range in the browser silently under-reports any period outside the newest page. Every KPI stat card across Dashboard, History, My team, and Reports shows a trend badge against the **previous equal-length period** (a fortnight compared against a single day read as a collapse every time) — an up/down/flat arrow, colored green/red based on whether that direction is actually good for that metric — computed server-side (or client-side for History) and auto-refreshed every 30s, no configuration needed. |
| **SSO (Google, Microsoft, SAML, LDAP)** | Each organization's own admin turns on exactly the sign-in methods their team uses — password, Google, Microsoft/Azure AD, any SAML 2.0 IdP (Okta, OneLogin, ADFS...), or LDAP/Active Directory — independently of every other organization, down to requiring SSO-only. One fixed callback URL works for every OIDC/SAML org: identity travels through a signed state parameter, not a per-org redirect URI. LDAP is a direct bind (no redirect), rendered as an inline login form instead. |
| **Chat-to-ticket connectors (Slack, Microsoft Teams, Google Chat, Telegram)** | The same "message arrives, AI-triaged ticket appears" pipeline as email intake, generalized across four chat platforms. Slack/Teams/Google Chat are push-only APIs (a webhook URL, signature-verified per platform); Telegram is polled, avoiding the need for a public endpoint. The bot replies back into the originating chat once a ticket's created. Which platforms an org may connect is capped by plan tier, same as SSO providers. |
| **Maintenance mode** | A super admin schedules a maintenance window (with an optional message) from Workspace Settings → Maintenance; while it's active every non-super-admin is locked out — active sessions land on a branded full-page maintenance screen with a live countdown, and every sign-in method (password and all four SSO flavors) is refused at the same choke point. Super admins stay signed in to do the work. The tab also shows **who's online right now** (15-minute activity window, deduped to people), a one-click **warning notification** (in-app + email, quoting the window) to everyone online, and a confirmed **force-log-out of all non-admin sessions** — server-side revocation, so it needs zero client cooperation. Users inside the app see an advance-warning banner during the scheduled phase. The enforcement check is cached and **fails open**: a broken settings lookup degrades to "app works normally", never "everyone locked out". The tab also carries a **live server-health panel** (CPU, memory, disk, DB ping/event-loop latency, and a per-component checklist, refreshed every 10s and measured honestly on the instance answering), and the same presence machinery gives **User management** a live online dot, first/latest login times, and a per-user *sign out everywhere* action. |
| **API performance (opt-in, off by default)** | Per-request telemetry answering the question the two panels above it can't: *which* endpoint got slow at 14:20 yesterday, and was it one pod or all of them. Latency percentiles over time (p50/p95/p99 — an average is the one number that reliably hides the problem), a per-endpoint breakdown, an ok/4xx/5xx split, a per-host/pod/cluster view, and a capped drill-down of individual requests. Route patterns, never raw URLs — request bodies, query strings, headers, cookies, IPs and user-agents are not collected at all, and `userId` is resolved to a name only at read time. Off by default and switched on in the environment rather than the UI, because it sits in the hot path of every request: nothing awaits it, the buffer drops (and counts) rather than growing unbounded, rows are pruned on a retention schedule, and the panel says whether an empty chart means "recording is off" or "nothing was served". See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#operating-api-request-telemetry). |
| **Planning & delivery (V6, opt-in)** | Work items gain a hierarchy (epic → story → task), planned start/end dates distinct from the SLA due date, four kinds of scheduling dependency with working-day lag, milestones and frozen baselines. A hand-built **Gantt timeline** (zoomable, drag to move, drag an edge to resize) shows the critical path, baseline slip and any dates that contradict a dependency — reported, never silently corrected, because there is no undo for a tool that reschedules behind your back. Plus a **calendar** that distinguishes work you actually scheduled from work that only has an SLA date, **My work** (a personal cross-project queue where blocked items are listed separately rather than pretending to be startable), and **portfolios** that roll schedule, progress and budget up across projects. Every figure is derived — nothing is entered twice. |
| **Resourcing & budget (V6, opt-in)** | Per-person contracted capacity and expected utilisation, time bookings (per *working* day, so a five-day booking at 4h/day is 20 hours and not 28), leave that reduces availability rather than counting as load, and a **workload board** showing each person's planned hours, their real logged hours and their capacity on one axis. That third column is the thing a pure PM tool cannot show: everything else in this category compares a plan against another plan, because estimates are all they hold. Overlapping bookings are reported, never refused — splitting somebody across two projects for a fortnight is sometimes exactly the plan. Plus project budgets with burn and forecast-at-completion (priced from the same approved rate snapshots a Verified Work Attestation reads, so the two can never disagree) and estimate-vs-actual accuracy reported as a median. |
| **Intake, blueprints & approvals (V6, opt-in)** | **Request forms** with conditional questions, publishable to a link that needs no account; a hidden question is neither required nor accepted, so a submitter is never blocked by a branch they were routed away from and nobody can POST past one. **Blueprints** save a project's shape as relative day offsets and stamp it out against any start date, previewable before anything is created, or learned from a project that already ran. **Approval chains** on work items — sequential or parallel, colleagues or external reviewers, where a guest gets a single-use link rather than a half-real account that would sit in every permission check forever. One rejection settles the request and stops asking everybody else. **Proofing** pins comments to a spot on an attached image or PDF, anchored so they land correctly at any zoom. |
| **Delivery risk & the AI planning copilot (V6, opt-in)** | Every project gets a 0–100 **risk score** from six measured signals — schedule slip against baseline, budget forecast, blocked work, over-allocation, SLA breaches and rework — with stated weights and the full breakdown stored alongside, snapshotted nightly so trends are visible. It is **arithmetic and works with AI switched off entirely**; only the plain-English summary needs a model. When the assistant *does* propose work, it never writes: every change becomes a reviewable row you accept or reject individually, showing exactly what it would alter, and a row whose underlying value has changed since is refused rather than quietly reverting somebody else's edit. There is deliberately no apply-everything button. |
| **Custom dashboards & scheduled reports (V6, opt-in)** | Build a view from a fixed catalogue of tiles — closed on purpose, so "open items" has one definition and two dashboards cannot disagree. A shared dashboard stores a *layout*, never data: every tile resolves against the viewer's own projects, so publishing one can never publish a project somebody could not already see. Email a dashboard daily, weekly or monthly to stakeholders with no account; the report is built with the sender's access and stops itself if that person leaves. |
| **Change management (V8, opt-in)** | Raise, assess, approve, schedule, implement, validate and close a change — with the governance a ticket cannot express. **A change IS a ticket** plus an extension row, so comments, attachments, watchers, the audit trail and project-scoped visibility came free and there is no second visibility rule to keep in step. Keys read `HICS-TS-20260819-0001`. Four change types — Standard, Normal, Emergency, and **Major, which is Normal escalated rather than a fourth peer**: it forces a backout plan even when the matrix bands the change Low, and a post-implementation review even when it succeeded, because the matrix scores probability of harm and has no way to say *structurally significant*. A weighted **risk assessment** bands the change and the band decides whether a backout plan is mandatory — which is why a *complete* assessment is required to submit: an unanswered parameter contributes zero to a normalised score, so a half-filled form under-reports (measured: high impact + high data risk with nine blanks scored 27 and banded LOW), and leaving fields empty was a way to skip the module's central rule. Approval is **the requester's manager, or a super admin** — never the requester, and a rejection opens a new round rather than overwriting the first, so the objection survives the rework. A **runbook** of numbered implementation steps, test cases and dependencies stays editable *after* approval, because recording that step 4 failed is the work that happens then; an open predecessor refuses the move to Implementing with a 409 that names it. Per-stage **SLA clocks** judge a finished stage on how long it actually took rather than against the current time — the alternative is a dashboard that turns green the moment an overrun closes. A **calendar** shows scheduled work against the blackout periods it has to dodge, in one call. CSV, Excel and PDF export from one shared query, fetched as authenticated blobs and stating their own row caps. Two email templates live on the **Email templates** page with the same analytics and failure triage as every other mail, going to the requester, implementer, approvers and collaborators with super admins in BCC. Delivery-health figures are **null, never 0%**, when nothing has closed yet. See [docs/API.md](docs/API.md#change-management-v8). |
| **Multi-tenant SaaS platform** | Runs as either a single-org on-prem deployment or a true multi-org SaaS platform on the same codebase. Each organization gets its own physically separate MySQL database (never a shared table filtered by a tenant column) — see [Multi-tenancy](#multi-tenancy) below. |
| **Platform administration** | A separate `/platform-admin` console (its own auth, its own JWT secret, zero shared client state with the tenant app) for organization lifecycle, plan-tier limits (seat counts, AI budget ceilings, allowed SSO providers/chat platforms), managed backups, one maintenance window armed across the whole fleet, per-workspace database and API monitoring, and cross-org analytics — restricted by convention to aggregate numbers, never row-level tenant content. |
| **Console governance (5.0.0)** | The console is no longer one all-powerful role. **Five roles** — Owner, Operator, Support, Billing, Read only — over a five-capability matrix, where Support and Billing are *siblings rather than rungs*, because a ladder would hand finance the tenant-rescue routes and support the plan tiers. The role is read from the database row on **every request**, never from a JWT claim, so a demotion binds immediately. Optional TOTP two-factor (hand-rolled on `node:crypto`, pinned against RFC 6238's published vectors, bcrypt-hashed recovery codes) with the challenge sitting *before* a session row exists. Five irreversible actions need a **second pair of eyes** — deleting a workspace, restoring or deleting a snapshot, creating an admin, changing an admin's role — and the countersignature replays through the same handler, so every guard re-runs against live data rather than against what was true when the request was queued. Sensitive routes prompt for a reason, recorded on the audit row beside `before`, `after` and the caller's IP. |
| **Revenue, retention and account health (5.0.0)** | A nightly per-workspace usage snapshot — the thing that makes any trend, cohort or churn question askable at all, and which stops the analytics page opening a connection to every tenant database on every page load. An operator-editable **list price** per tier drives MRR, ARR, ARPA, revenue by tier, trial-to-paid conversion, logo and revenue churn, NRR/GRR and a signup-month cohort table. **Every money figure is list price, not billed revenue, and the screen says so**; a tier with no list price (Enterprise) is excluded from MRR with the exclusion count printed beside it rather than silently summed as zero. Account health names the signals that produced it — seat pressure, AI burn, dormancy, ticket velocity, mail and backup failures — and a clean workspace says what was checked instead of showing a bare score. |
| **Console operations (5.0.0)** | Fleet alerts leave the room: a six-hourly digest that reports only what **changed** — appeared, escalated, cleared — so a standing alert is never re-sent, plus an optional signed outbound webhook. Fleet schema drift is visible (which tenants are behind which migration, and the command that fixes it) and deliberately read-only, because a per-tenant migration fan-out needs a terminal and a human watching it. Database growth forecasting that refuses to extrapolate from too few or too noisy samples. Schema-shape findings — tables with no primary key, index-heavy tables — kept on the hourly sample instead of being computed and discarded, so "when did this start" is finally answerable; nullable rather than backfilled to zero, because a fake clean hour is worse than a gap. Per-org feature overrides beside the existing seat and AI-budget ones, where granting past the plan takes an explicit acknowledgement and is audited under the operator's name. CSV export of exactly what the filter is showing, a ⌘K command palette, and an incident timeline on each org's page. |

## By the numbers

Counted from the tree at v5.0.0, not estimated — regenerate any of these with the one-liners in
[CONTRIBUTING.md](CONTRIBUTING.md#regenerating-readmes-by-the-numbers) rather than trusting a figure
that looks stale.

| | |
|---|---|
| REST routes | **532** across 57 controllers |
| Prisma models / enums | **131** / 46, plus **114** tenant migrations and 21 control-plane migrations |
| Services / cron workers | **136** / 31 |
| Web pages | **97** |
| Unit tests | **2,820** across 188 files (`npm test -w apps/api`), plus **107** in `apps/web` |
| End-to-end specs | **29** Playwright specs, run across desktop, phone, tablet, laptop, 4K, Firefox and WebKit |
| Editable email templates | **41**, every one of them with preview, test send, revert and per-template delivery analytics |
| RBAC permissions | **20**, over 5 roles — plus **5** platform-console capabilities over 5 operator roles |
| Lint | **0 errors**, warnings tracked as a baseline rather than driven to zero — see below |

**On the two permission counts.** They are two separate authority models and adding them together
would describe a role nobody holds. The **20** are the tenant RBAC keys in `packages/shared`
(`permissions`) that gate what a person can do inside a workspace. The **5** are
`platformCapabilities` — `platform:read`, `:support`, `:billing`, `:operate`, `:owner` — which gate
the operator console in the control plane, and which no workspace user holds at all. This table said
**38** for four releases; the figure was never counted, and the one-liner meant to check it scanned
the whole file rather than the object, so it agreed with nothing. Both are counted now, separately.

**On the lint number.** The repo runs ESLint with `sonarjs` and sits at 687 warnings and
zero errors. That is the healthy state, not a backlog: the warnings are overwhelmingly
`no-nested-conditional` and `cognitive-complexity` on code where the nesting is the clearest form,
and "fixing" the count by mechanically extracting ternaries has previously made the code worse.
Errors are the gate; warnings are a signal to read, not a score to beat.

**On the test number.** Unit tests here deliberately favour *pure* functions over mocked databases —
the schedule solver, the risk score, the SLA clocks, the CSV escaper, the changelog parser. That is
why a suite this size runs in about 20 seconds and why its failures point at a rule rather than a
fixture. Anything needing a real database is an e2e spec instead.

## Stack

- **Frontend**: React 19, TypeScript, Vite, TailwindCSS, shadcn-style Radix components, `react-aria-components` + `@internationalized/date` (accessible calendar / date-picker / date-range / time-field primitives, styled with the app's own theme tokens), Zustand, TanStack Query, React Hook Form, Framer Motion, Recharts, `@dnd-kit` (Kanban drag-and-drop), Tiptap (rich text)
- **Backend**: Node.js, Express 5, TypeScript, JWT access/refresh auth (httpOnly-cookie rotation, session revocation), RBAC, Prisma ORM, MySQL (database-per-tenant multi-tenancy — a separate control-plane Prisma schema/client alongside the tenant one), `openid-client` + `@node-saml/node-saml` + `ldapts` (Google/Microsoft/SAML/LDAP SSO), `@anthropic-ai/sdk` + `openai` (BYOK multi-provider adapter), `@modelcontextprotocol/sdk` (TimeSphere *as* an MCP server — the opposite direction from the two above), `imapflow` + `mailparser` (email intake), `jwks-rsa` (Bot Framework JWT verification for Teams), `node-cron` (background workers), `@vladmandic/human` + pure-JS TensorFlow.js (server-side face matching / anti-spoof / liveness — no native build step), Nodemailer
- **Infra**: Docker Compose or Kubernetes (Helm chart with HPA/VPA autoscaling — see [Deploy](#deploy)), GitHub Actions CI/CD, environment config validation (Zod) with production-safety boot checks, secure headers (Helmet), rate limiting + per-account login lockout, request logging, centralized error middleware, AES-256-GCM encryption at rest for stored secrets
- **Testing**: Playwright across **seven projects** — Chromium at five viewport sizes (phone → 4K) plus **Firefox (Gecko) and WebKit (Safari/iOS)** engine projects — for end-to-end auth, tickets, timesheet, settings, reports, and responsive-layout coverage, including computed-style contrast checks in both color themes; Vitest (`apps/api/tests`) for unit tests of the AI/billing/SCIM/face-verification services plus integration tests against a real throwaway MySQL database

This is an npm-workspaces monorepo:

```text
apps/
  api/      Express API — controllers (one per resource), services (business logic +
            external integrations), workers (cron jobs: SLA sweeps, reminders, email
            intake polling, weekly digest), middleware, Prisma schema + migrations
  web/      React app — pages, layouts, reusable components, Zustand stores, the typed
            API client (services/api.ts)
packages/
  shared/   Shared TypeScript contracts/constants (permissions, status enums, shared
            interfaces) — built to dist/, imported by both api + web so the two never
            drift out of sync on a shape
docs/
  API.md
  DATABASE.md
  DEPLOYMENT.md
```

### Why the code is organized this way

- **Controllers stay thin; services own the logic.** A controller's job is auth/permission
  gates, request validation (Zod), and wiring a response — the actual business rules (SLA
  math, AI gating, email routing, access-control predicates) live in the matching
  `services/*.ts` file so they can't drift between the two or three routes that need them.
- **One choke point per external integration.** All Anthropic calls go through
  `ai.service.ts`; all outbound email goes through `mail.service.ts`/`notify.service.ts`. This
  is what makes admin toggles, budget caps, and per-category email opt-ins actually
  enforceable — every caller is forced through the same gate.
- **Workers are separate from the request/response cycle.** Anything that should happen on a
  schedule regardless of whether anyone is using the app right now (SLA sweeps, reminders,
  IMAP polling, the weekly digest) is a `node-cron` job in `apps/api/src/workers/`, started
  once from `server.ts` on boot — never something a request handler kicks off inline.

## Prerequisites

- Node.js 20+ (tested with Node v24.12.0 / npm 11.6.2)
- A running MySQL 8 server reachable from your machine (XAMPP's bundled MySQL works fine — default install listens on `localhost:3306` with user `root` and an **empty password**)
- Optional, only if you want AI features live: an API key for whichever provider you choose (Anthropic, OpenAI, Groq, etc. — see **Turning on AI features (BYOK)** below), or a local Ollama/LM Studio install with no key at all
- Optional, only if you want email-to-ticket intake live: IMAP access to a mailbox (an app password works fine, same pattern as the existing SMTP setup)

## Installation (local, no Docker)

1. **Install dependencies** (this also builds `packages/shared`, which both the API and web app import at runtime):

   ```bash
   npm install
   ```

2. **Create the API's env file.** The API loads `.env` from its own working directory (`apps/api/`), not the repo root, so copy the template there (`npm run setup` in step 3 does this for you, and never overwrites an existing one):

   ```bash
   cp .env.example apps/api/.env
   ```

   Then edit `apps/api/.env` and set at minimum:
   - `DATABASE_URL` — must match a MySQL server you actually control. For XAMPP's default MySQL: `mysql://root:@localhost:3306/timesheet_portal` (empty password). If your MySQL root user has a password, URL-encode any special characters in it (e.g. `@` → `%40`).
   - `CONTROL_DATABASE_URL` — a second, much smaller database (org registry, SSO config, plan tiers, platform-admin accounts — see [Multi-tenancy](#multi-tenancy)). Required even for a single local org; a database on the same server works fine, e.g. `mysql://root:@localhost:3306/timesphere_control`.
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `PLATFORM_ADMIN_JWT_SECRET` — three distinct long random strings for local dev (production deployments get a boot-time entropy/charset check on the first two — see [Security](#security)). `PLATFORM_ADMIN_JWT_SECRET` must differ from the other two.
   - `ENCRYPTION_KEY` — 64 hex characters (32 bytes), used for AES-256-GCM encryption of stored secrets (IMAP password, BYOK API keys, OIDC client secrets). Generate one with `openssl rand -hex 32`.
   - `SMTP_*` — optional; leave `SMTP_HOST` empty to have emails logged to the console instead of actually sent.
   - `ANTHROPIC_API_KEY` — optional; leave empty to keep the default (Anthropic-provider) AI path inert until either this env var or a BYOK key saved in Workspace Settings is available. AI also needs an admin to flip its master switch on — it never turns itself on. See **Turning on AI features** below for the full BYOK picture.

3. **Make sure MySQL is running** (start it from the XAMPP Control Panel if you're using XAMPP's MySQL).

   **One-liner for everything below** (generate both Prisma clients, self-heal-create both
   databases, apply every migration, seed control plane + tenant demo data):

   ```bash
   npm run setup
   ```

   This runs `npm install` (which builds `packages/shared`), `npm run bootstrap` (creates
   `apps/api/.env` from `.env.example` if it doesn't exist, and mints this machine's dev TLS
   certificate if it has none — step 8), `npm run db:generate` (both Prisma clients),
   `npm run doctor:heal` (validates `.env`, auto-creates `timesheet_portal`/`timesphere_control`
   if they don't exist, then runs `prisma migrate deploy` for both schemas), `npm run seed`, and
   finally `npm run db:migrate:tenants` — the tenant fan-out, which brings **every** organization's
   own database to the newest migration. That last step is a fast no-op on a clean clone (one org,
   already migrated) and matters only once you have provisioned a second organization from
   `/platform-admin`, whose separate database `doctor:heal` never touches.
   Safe to re-run — creating an already-existing database or re-running a migration that already
   applied is a no-op, and seeding is idempotent. It never overwrites an `apps/api/.env` you
   already have; on an **upgrade** it instead lists any variable added to `.env.example` since
   yours was written, so a new feature reads as unconfigured rather than broken
   (`npm run bootstrap:sync` appends them, commented out). If you'd rather run each step yourself
   (or just want to see what `setup` is doing), the equivalent steps are below.

   **Run the doctor script before going any further:**

   ```bash
   npm run doctor -w apps/api
   # or, to auto-create missing databases and apply pending migrations:
   npm run doctor:heal -w apps/api
   ```

   This is the single highest-value step in this whole guide. It validates `.env` against the
   same schema the server boots with, then actually opens a TCP connection to `DATABASE_URL`
   and `CONTROL_DATABASE_URL` and runs a test query — catching the #1 first-run failure (the
   DB host/port/password in `.env` pointing at nothing, or at the wrong MySQL instance) with one
   specific, actionable message instead of a cryptic Prisma error three steps later. The
   `doctor:heal` variant goes further and actually fixes the two most common blockers — creating
   the databases if the server's reachable but they don't exist yet, and running
   `prisma migrate deploy` for both schemas — instead of just diagnosing them. See
   [Preventing setup issues](#preventing-setup-issues) for why this exists and what it checks.

4. **Generate the Prisma clients** (tenant schema + the separate control-plane schema):

   ```bash
   npm run db:generate
   ```

5. **Create the databases and apply migrations:**

   ```bash
   npm run db:migrate
   ```

   This creates the `timesheet_portal` and `timesphere_control` databases (if they don't exist)
   and applies every migration for each.

6. **Seed the control plane, then the tenant's demo data:**

   ```bash
   npm run seed
   ```

   This seeds the control plane first, then the tenant: `control:seed` registers one
   `Organization` (slug from `DEFAULT_ORG_SLUG`, default `default`) pointing at `DATABASE_URL`,
   seeds the three plan tiers' default limits, and creates one `PlatformAdminUser` (credentials
   below); the tenant seed then fills in roles/permissions, three demo users (below), a demo
   project, default ticket types (Bug/Task/Improvement), and every notification/ticketing/AI
   settings singleton at its safe default (AI **off** until you opt in). The MCP server needs no
   seed row at all — its settings singleton is created the first time an admin opens the page, and
   every column of it defaults to off.

   Then, once the org registry exists, fan the schema out to every organization's own database:

   ```bash
   npm run db:migrate:tenants
   ```

   A no-op with one organization. Required the moment there are two, since only the org named by
   `DATABASE_URL` is migrated by the step above.

7. **Run the app:**

   ```bash
   npm run dev
   ```

   - Frontend: http://localhost:5173
   - API: http://localhost:4000/api (health check at http://localhost:4000/health)
   - Platform-admin console: http://localhost:5173/platform-admin/login (see [Multi-tenancy](#multi-tenancy))

   The web dev server proxies `/api` and `/uploads` to the API, so there's no separate URL/CORS config to manage in dev.

8. **(Optional) HTTPS on the LAN — required for the camera from other devices.** The TLS
   certificates are per-machine private keys, deliberately git-ignored, so a clone can never
   bring them along — `npm run setup` mints this machine's own pair for you when there isn't one
   (and never regenerates one you have already trusted on your devices). It needs
   [mkcert](https://github.com/FiloSottile/mkcert) (e.g. `winget install FiloSottile.mkcert`); if
   that's missing, setup warns and carries on serving http, and you can generate the pair later
   with:

   ```bash
   npm run certs        # dispatches to scripts/make-lan-certs.{ps1,sh} for your OS
   ```

   Restart `npm run dev` and it serves `https://localhost:5173` + `https://<lan-ip>:5173`
   automatically — the presence of `apps/web/certs/` is the switch. The script prints the
   one-time root-CA trust step for phones. Details: DEPLOYMENT.md § *Serving over HTTPS*.

9. **(Optional) Point this checkout at UAT or production config** instead of local:
   `APP_ENV=uat npm run dev -w apps/api` (PowerShell: `$env:APP_ENV = "uat"`), after copying
   `apps/api/.env.uat.example` → `.env.uat`. Profiles layer over `.env`, real ones are
   git-ignored, and a missing profile refuses to boot rather than silently running local
   config. Full runbook: DEPLOYMENT.md § *Environment profiles*.

### Demo credentials (after seeding)

- Super Admin: `superadmin@timesheet.local` / `Admin@12345`
- Manager: `manager@timesheet.local` / `Admin@12345`
- Employee: `employee@timesheet.local` / `Admin@12345`
- Platform Admin (after `npm run control:seed -w apps/api` — see [Multi-tenancy](#multi-tenancy)): `platform-admin@timesphere.local` / `PlatformAdmin@12345` at `/platform-admin/login`

### Turning on AI features (BYOK)

AI is off by default, and the underlying model provider is admin-chosen per workspace — bring
your own key for whichever vendor you already have an account with. To try it:

1. Log in as Super Admin → **Workspace Settings → AI**.
2. Pick a **Provider**: Anthropic (native), or any OpenAI-compatible vendor — OpenAI, Groq,
   Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, a local Ollama/LM Studio
   install (no key needed), or **Custom endpoint** for anything else that speaks the same
   protocol. Picking a preset fills in its base URL; you can still override it.
3. Paste an **API key** and click Save (skip this for a local Ollama/LM Studio install). The key
   is encrypted at rest (AES-256-GCM) and never sent back to the browser once saved — only an
   "is a key saved" flag is. Anthropic alone also honors `ANTHROPIC_API_KEY` in `apps/api/.env`
   as a fallback, so existing deployments keep working unconfigured.
4. Set the **Model** — a dropdown of Claude models for the Anthropic provider, or a free-text
   field for OpenAI-compatible providers (model names vary per vendor, e.g. `gpt-4o-mini`,
   `llama3.1`, `mixtral-8x7b`).
5. Flip the master switch, then whichever per-feature toggles you want (auto-triage, duplicate
   detection, writing assistant, comment summary, "Ask AI", email intake, weekly digest, email
   failure diagnosis), and
   optionally set a monthly budget cap. **AI refine** (the tidy-up button beside timesheet and
   ticket text) rides the *writing assistant* toggle and this same budget — it has no settings of
   its own, and its button tells the user which of the two is stopping it rather than failing on
   click.
6. For email-to-ticket intake specifically, also fill in the mailbox connection under
   **Workspace Settings → Email intake** and add at least one routing rule (or a fallback
   project) so inbound mail has somewhere to land.

Not every OpenAI-compatible endpoint supports the same structured-output request shape (local
runtimes like Ollama/LM Studio in particular often don't) — triage and duplicate-detection ask
for JSON via the prompt itself when needed and validate the response locally either way, so a
provider that lacks native structured output degrades gracefully instead of hard-failing.

## Preventing setup issues

Every first-run failure this project has actually hit traces back to one pattern: a config
value that's *well-formed* (right shape, passes validation) but *wrong* (points at a server,
port, or key that doesn't match what's actually running). Zod catches the first kind at boot;
it cannot catch the second. Two things close that gap:

- **`npm run doctor -w apps/api`** — run this before `db:migrate`/`dev` on any fresh checkout or
  new environment (local, CI, staging, a new prod host). It (1) loads and validates `.env`
  through the real schema, (2) opens an actual TCP connection to `DATABASE_URL` and
  `CONTROL_DATABASE_URL` — not just "is the string non-empty" — and (3) runs a real `SELECT 1`
  through Prisma to confirm the credentials are also correct, not just the host/port. Each check
  fails fast with the specific fix, not a stack trace. **`npm run doctor:heal -w apps/api`** runs
  the same checks and then auto-fixes what it can: creates `DATABASE_URL`/`CONTROL_DATABASE_URL`'s
  databases if the server's reachable but they don't exist, and runs `prisma migrate deploy` for
  both schemas. It never touches `.env` or connection settings — only DB-side state — so it's
  safe to run repeatedly and safe to wire into a CI/setup step.
- **`.env.example`'s defaults match the primary documented path** (local/no-Docker against
  XAMPP: port `3306`, empty password), with an explicit callout that Docker Compose's MySQL
  container is a *different* server on a *different* port (`3307`, password `password`). The
  historical bug this fixes: the template used to default to Compose's port/password pair, so
  copying it verbatim for a local install produced exactly the failure `doctor` above now
  catches in one command — the API would boot far enough to look alive, then fail confusingly
  the first time it actually touched the database.

Two narrower defaults worth knowing about for the same reason:

- **`ENCRYPTION_KEY` has no working default on purpose.** The schema requires an exact
  64-character hex string (`/^[0-9a-f]{64}$/i`) and the template ships an obviously-invalid
  placeholder — so `.env.example` copied without editing fails loudly at boot instead of
  encrypting real secrets (IMAP passwords, BYOK API keys) under a key nobody wrote down. Always
  generate a fresh one per environment with `openssl rand -hex 32` and never reuse one across
  local/staging/prod.
- **Never copy a live `.env` between environments.** Every secret in it
  (`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`PLATFORM_ADMIN_JWT_SECRET`/`ENCRYPTION_KEY`) should
  be freshly generated per environment. Production additionally gets a boot-time
  entropy/charset check on the JWT secrets (`server.ts#assertProductionSafety`) that rejects
  weak or template-looking values — see [Security](#security).

If you ever do end up with data encrypted under the wrong `ENCRYPTION_KEY` (for example, a key
was rotated without re-encrypting existing rows), every AES-256-GCM `decryptSecret()` call
against that data throws `Unsupported state or unable to authenticate data` — that specific
error message means "this ciphertext was not encrypted with the key currently in `.env`", not a
corrupted database. The one row this matters for at boot time is
`OrgDatabase.encryptedDsn` in the control-plane database (checked by `server.ts` when it warms
the default tenant's Prisma client) — if you rotate `ENCRYPTION_KEY` after tenant DSNs have
already been provisioned, re-encrypt every `OrgDatabase.encryptedDsn` row under the new key
(read the old plaintext DSN out of your deploy records, or reconstruct it from `host` +
`databaseName` on that same row, then `encryptSecret()` it again) — there's no automated
migration for this because the plaintext DSN is intentionally never stored anywhere to migrate
from.

## Deploy

Three ways to run this in a container/orchestrator, from fastest to most production-grade:

**1. One-click install** (Docker required, nothing else):

```bash
./install.sh        # Linux/macOS
.\install.cmd        # Windows (launcher that sidesteps PowerShell's script-execution policy)
```

Checks for Docker + Compose, generates a root `.env` with strong random secrets (never touching
one that already exists), brings the stack up, waits for the health check, and runs the one-time
seed. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for exactly what it does and doesn't do.

**2. Manual Docker Compose**:

```bash
docker compose up --build
```

Docker Compose passes environment variables directly (see `docker-compose.yml`) rather than reading `apps/api/.env`, so export `DATABASE_URL`, `CONTROL_DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PLATFORM_ADMIN_JWT_SECRET`, `ENCRYPTION_KEY`, `WEB_ORIGIN`, and `APP_BASE_URL` in your shell (or a `.env` file next to `docker-compose.yml`, which Compose reads automatically) before running it. MySQL runs in its own container on host port `3307`. Migrations for both the tenant and control-plane schemas run automatically on every boot; seeding is a one-time step you run separately afterward — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

This `docker-compose.yml` is the **on-prem/single-org** deployment shape — see [Multi-tenancy](#multi-tenancy) below for what changes running this as a multi-org SaaS platform. Compose has no orchestrator to autoscale with — `docker compose up --scale api=N` is its one manual lever.

**3. Kubernetes (Helm chart, real autoscaling)**:

```bash
helm install my-release deploy/helm/timesphere -f my-values.yaml
```

`deploy/helm/timesphere/` covers both deployment shapes via chart values (`mysql.enabled` for
self-hosted vs. managed database, `ingress.wildcardHost` for SaaS subdomain routing), and is the
only path here with real `HorizontalPodAutoscaler`/`VerticalPodAutoscaler`-driven autoscaling —
see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)'s "Kubernetes deployment" section for the full
walkthrough, including a first-install ordering caveat with the chart's own MySQL StatefulSet.

Images for the chart are built and published by `.github/workflows/cd.yml` to
`ghcr.io/<owner>/<repo>-api` / `-web` on every push to `main` and version tag — swap the
registry by editing that workflow's `env.REGISTRY`. `.github/workflows/ci.yml` runs typecheck,
build, and the full Playwright suite (against a real MySQL service container) on every push/PR.

## Multi-tenancy

This app runs as **one codebase, two deployment shapes**: a single-org on-prem deployment (the
`docker-compose.yml` above), or a true multi-org SaaS platform — many organizations, each with
its own **physically separate MySQL database**, never a shared table filtered by a tenant
column. Both shapes share every controller/service/UI page; what differs is whether more than
one `Organization` row exists in a small second **control-plane database** (org registry,
per-org database connections, SSO config, plan tiers, platform-admin accounts — see
`apps/api/prisma/control/schema.prisma`).

Highlights of the SaaS shape:

- **Subdomain-based routing** — `middleware/tenant.ts` resolves which org (and therefore which
  physical database) a request belongs to purely from the `Host` header, before authentication
  even runs. A request with no real subdomain (localhost, a bare on-prem domain) falls back to
  `DEFAULT_ORG_SLUG` — which is exactly what makes the on-prem shape a special case of the SaaS
  one, not a separate code path.
- **A `Proxy`-backed `prisma` import** — every one of the ~30 existing `import { prisma } from
  "../config/prisma.js"` call sites across controllers/services/workers keeps working completely
  unchanged; the proxy transparently forwards to whichever tenant's `PrismaClient` is active for
  the current request (`AsyncLocalStorage`), never a fixed one.
- **SSO configured per organization** — Google, Microsoft, SAML, and LDAP, each independently
  turned on/off per org by that org's own admin, with one fixed callback URL shared by every OIDC/
  SAML org (org identity travels in a signed state parameter instead of a per-org redirect URI).
- **Chat-to-ticket connectors configured per organization** — Slack, Microsoft Teams, Google
  Chat, and Telegram, same per-org enable/configure pattern as SSO, gated by the same plan-tier
  allow-list mechanism (`PlanTierLimit.allowedChatPlatforms`).
- **A separate `/platform-admin` console** — its own auth path, its own JWT secret
  (`PLATFORM_ADMIN_JWT_SECRET`), zero shared client-side state with any tenant session. Organization
  lifecycle (create → provision → active → suspend/archive), plan-tier limits (seat counts, AI
  budget ceilings, allowed SSO providers/chat platforms), and cross-org analytics restricted by
  convention to aggregate numbers — never row-level tenant content.
- **One-command provisioning** — `services/provisioning.service.ts`, triggered from the console,
  physically creates a new org's database, migrates it, seeds baseline data plus the one real
  admin account requested (no demo data), and flips the org active. Every step is safe to retry.
- **Plan-tier enforcement, live, not just at signup** — seat limits and AI budget ceilings are
  checked on every relevant request (`services/plan-limits.service.ts`), re-read every time
  rather than cached, so a platform admin lowering a limit takes effect immediately.

Full setup instructions for both shapes (env vars, control-plane migration/seed, provisioning a
second organization, keeping every tenant's schema current via `npm run migrate:tenants`) live in
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### How a tenant's login actually resolves to their own org

Concretely, step by step, for a user at `acme.timesphere.app`:

1. **The browser sends the `Host` header before any credential does.** `resolveOrgSlug()`
   (`apps/api/src/middleware/tenant.ts`) reads `req.headers.host`, takes the first label
   (`acme`), and that's the org slug — no login has happened yet, and none needs to for this
   step. A bare local/on-prem host (`localhost`, an IP, a domain with no subdomain) falls back
   to `DEFAULT_ORG_SLUG` instead — this is the entire mechanism that makes a single-org on-prem
   deployment "just" a SaaS deployment with one org in it, not a separate code path.
2. **That slug is looked up in the control-plane database**, a small, separate MySQL database
   (`CONTROL_DATABASE_URL`) holding the `Organization` registry, each org's `OrgDatabase`
   connection record (its physical DSN, AES-256-GCM encrypted), SSO config, and plan-tier
   limits. `resolveActiveOrgBySlug()` also rejects the request here if the org is suspended or
   not yet provisioned — before any DB query against tenant data is even attempted.
3. **The org's own database connection is decrypted and opened** (or reused from a small
   per-org connection pool — `getTenantClient()` in `apps/api/src/config/prisma.ts`), and the
   rest of the request runs inside an `AsyncLocalStorage` context carrying that org's Prisma
   client. Every controller/service in the codebase just does `import { prisma } from
   "../config/prisma.js"` and queries normally — that import is a `Proxy` that transparently
   forwards to whichever tenant's client is active for the current request. There is no
   `WHERE organizationId = ?` anywhere in tenant-facing queries, because there's no other
   tenant's rows in that database connection to accidentally query.
4. **Login itself then runs entirely inside that org's context.** Password auth checks
   `User` rows in *that* org's database only — the same email can exist as a completely
   different account in another org's database, and there's no collision because they're
   different databases, not different rows in a shared `User` table. SSO (Google/Microsoft/SAML)
   and LDAP work the same way: each org's admin independently turns on and configures its own
   providers (`OrgSsoConfig`/`OrgAuthMethod` in the control-plane DB) under
   **Workspace Settings → Security**, so `acme`'s "Google SSO" and `beta`'s "Google SSO" are
   two unrelated OAuth client configs that happen to use the same protocol.
5. **The resulting JWT is org-bound, not just user-bound.** `signAccessToken`/`signRefreshToken`
   embed the resolving org's ID in the token payload, and every subsequent request re-resolves
   the org from the `Host` header and checks `payload.org !== orgId` before trusting the token
   (`auth.service.ts`) — so a token minted while talking to `acme.timesphere.app` is rejected
   outright if replayed against `beta.timesphere.app`, even before any per-user permission check
   runs.

### AI, and every other per-org setting, cannot leak across tenants — by construction, not by filter

This is worth being explicit about because it's a materially stronger guarantee than the usual
"multi-tenant SaaS" pattern: **`GlobalAISettings` — provider, model, the BYOK API key, which
per-feature toggles are on, the monthly budget cap, the confidence threshold — is a table in the
tenant's own schema** (`apps/api/prisma/schema.prisma`), not a row in a shared settings table
keyed by `organizationId`. The same is true of every other admin-configurable surface: ticket
types, labels, SLA hours, email-intake routing rules, chat-connector config, notification
settings. There is structurally no shared table for any of this to leak through — reading
`beta`'s AI config while a request is scoped to `acme` isn't a permission check that could have
a bug in it, it's a different physical MySQL connection that `acme`'s request never opens.
Concretely, this means:

- Org A's Anthropic/OpenAI/Groq/etc. API key is encrypted at rest in Org A's own database, under
  the deployment-wide `ENCRYPTION_KEY` — but even with that key, there is nothing to decrypt in
  Org B's database, because Org B's key (if any) is a separate encrypted value in a separate
  database with its own connection credentials.
- Org A's AI usage/spend (`AIUsageLog`, checked against `GlobalAISettings.monthlyBudgetUsd`) is
  entirely Org A's own data — one org's usage can never push another org's budget cap.
- Turning AI (or SSO, or a chat connector) on/off, choosing a provider, or hitting a plan-tier
  seat/AI-budget ceiling (`PlanTierLimit`, enforced live on every relevant request via
  `services/plan-limits.service.ts`, not just at signup) is entirely per-org — one org's
  admin has no code path that reaches another org's settings, because there's no org-selector
  parameter to that code path at all; the active tenant is fixed for the lifetime of the
  request by step 3 above.

The one place that legitimately sees across every org is the separate `/platform-admin`
console — its own login, its own JWT secret (`PLATFORM_ADMIN_JWT_SECRET`, deliberately distinct
from the two tenant JWT secrets so a leaked tenant secret can't mint a platform-admin token), and
by convention its endpoints return aggregate numbers (seat counts, plan tier, suspend/archive
status) rather than row-level tenant content like ticket bodies or timesheet entries.

## Troubleshooting

**First step for any of these: run `npm run doctor -w apps/api` (or `npm run doctor:heal -w apps/api`
to also auto-create missing databases and apply pending migrations).** It catches the most common
root cause (wrong DB host/port/password in `.env`, usually Docker Compose's values used against
a local server or vice versa — see [Preventing setup issues](#preventing-setup-issues)) with one
specific message instead of you working backward from one of the errors below.

- **`Error: Cannot find package '...packages/shared/dist/index.js'`** — `packages/shared` hasn't been built. Run `npm install` (which now runs this automatically via `postinstall`) or manually: `npm run build -w packages/shared`.
- **`Environment variable not found: DATABASE_URL` / zod "Required" errors on boot** — your `.env` is in the wrong place. It must be at `apps/api/.env`, not the repo root.
- **`Authentication failed against database server, the provided database credentials for 'root' are not valid.`** — `DATABASE_URL` in `apps/api/.env` doesn't match your MySQL server's actual root password. For a stock XAMPP install this password is empty.
- **`ENCRYPTION_KEY must be a 64-character hex string` on boot** — generate one with `openssl rand -hex 32` and set it in `apps/api/.env`; this key encrypts stored secrets (IMAP password, BYOK API keys) at rest and has no safe default.
- **Port already in use (4000 or 5173)** — another process is already listening; stop it or change `API_PORT` / the web `--port` flag.
- **AI features show "No API key configured"** — for the Anthropic provider, set `ANTHROPIC_API_KEY` in `apps/api/.env` (or save a key in Workspace Settings → AI); for any other provider, save a key there directly (or leave it blank for a keyless local provider like Ollama/LM Studio). The master switch in Workspace Settings still needs to be turned on separately.
- **Email intake isn't picking anything up** — check three things: the master AI switch **and** the "Email-to-ticket intake" toggle are both on, the mailbox connection test in Workspace Settings → Email intake succeeds, and at least one routing rule or a fallback project is configured (otherwise matched-but-unrouted mail is intentionally dropped, logged as a warning).
- **Logged in but immediately bounced back to `/login` after a refresh** — the refresh token is an httpOnly cookie scoped to `/api/auth`; if you're serving the API and web app from different origins in a custom setup, confirm the API's CORS config allows your origin with `credentials: true` and that the cookie's `Secure` flag (production-only) matches your protocol (HTTPS in production).

## Testing

Two suites, and they answer different questions. **Unit tests** check the rules — the schedule
solver, the change risk score, the SLA clocks, the CSV escaper, the changelog parser — and run
against no database at all, which is why 1,380 of them finish in about twenty seconds and why a
failure points at a rule rather than a fixture. **End-to-end specs** drive a real browser against a
real seeded database, and are where anything needing one belongs.

```bash
npm test -w apps/api         # the unit suite (~35s): 1,758 tests across 153 files
npm run test:coverage -w apps/api
npm run lint                 # typecheck both apps + eslint/sonarjs across the monorepo
```

```bash
npm run test:e2e             # everything (~22 min): 7 projects — 5 viewports + Firefox + WebKit
npm run test:e2e:quick       # day-to-day loop (~7 min): every FUNCTIONAL spec once, desktop only
npm run test:e2e:responsive  # layout-only matrix (~5 min): the four viewport projects, 2 workers in parallel
npm run test:e2e:browsers    # engine coverage (~5 min): Firefox (Gecko) + WebKit (Safari/iOS)
npm run test:e2e:report      # open the last run's HTML report
```

**Cross-browser needs a one-time download:** `npx playwright install firefox webkit`. Three engines
cover every browser this product gets asked about — Chrome, Edge, Opera, Brave and Arc are all
Chromium; Firefox is Gecko; Safari is WebKit, **as is every browser on iOS**, whatever its icon
says. Testing "Chrome on iPhone" is testing WebKit.

**Which one to run:** `test:e2e:quick` while iterating (it exercises every feature spec once —
the viewport projects only re-run `responsive.spec.ts` at other sizes); `test:e2e` before a push.
Three things keep the clock down and are worth knowing:

- **Keep `npm run dev` running between test runs.** `webServer.reuseExistingServer` is on, so a
  live dev stack skips the ~40s server boot every invocation.
- **The responsive matrix is parallel (2 workers) on purpose, and the functional suite is
  serial on purpose.** `responsive.spec.ts` is read-mostly, so its four viewport projects can
  overlap safely. The functional specs CANNOT be parallelised: they share one seeded MySQL
  database, one login rate-limiter, and several deliberately mutate workspace-wide state
  (maintenance mode locks the workspace; force-logout revokes sessions) — two of those running
  at once would fail each other in ways that look nothing like their cause.
- **Never run `quick` and `responsive` at the same time** for the same reason: the maintenance
  spec's lockout window would 503 every page the layout sweep is measuring.

A one-time `setup` project logs in as each demo role and saves the resulting session for the
other specs to reuse — see `tests/e2e/auth.setup.ts` for why some specs deliberately log in
fresh instead (it comes down to the refresh-token rotation described in Security below).

**Unit/integration tests** (`apps/api/tests/`, Vitest) cover the three services with the least
end-to-end UI surface to exercise them through — AI (feature-toggle/budget gating, a mocked-SDK
`classifyTicket` round trip), Stripe billing (webhook signature verification + all three event
branches), and SCIM provisioning (auth, request parsing, seat-limit/duplicate-email/status-transition
enforcement):

```bash
npm run test -w apps/api               # unit tier — mocked, no real DB, ~1s
npm run test:integration -w apps/api   # integration tier — real throwaway MySQL, created/migrated/seeded/dropped per run, ~13s
```

Face verification has its own two-layer verification, because the ML half can't be unit-tested
(it needs the real ~10MB models and real face images):

```bash
npm run verify:face -w apps/api       # ML layer: embeddings, anti-spoof/liveness, encryption round-trip
npm run verify:face:e2e -w apps/api   # full HTTP flow against a running API (39 checks, incl. challenge–response + approval gate)
```

Not yet exhaustive (10 of 14 AI capability functions and the security-findings services have no
dedicated tests yet) — see each test file's header comment for the mocking approach used per
area, and `docs/NEW_ORGANIZATION_SETUP.md` for the fuller writeup.

## Security

This app has gone through an internal VAPT (Vulnerability Assessment + Penetration Test) pass —
SAST via full source review, DAST via live scripted HTTP probes, plus dependency scanning
(`npm audit`). The full report, with severity ratings, how each issue was found, evidence, and
remediation status, is published as a shareable report:

**[VAPT Assessment Report — TimeSphere Portal](https://claude.ai/code/artifact/068d1cbf-1b5a-4e16-ae9c-c3ca2a1647e1)**

Headline points if you don't read the full report:

- Session handling: httpOnly/`SameSite=Lax` refresh-token cookie, rotation with reuse detection
  (grace-windowed against benign concurrent-tab races), per-session and "sign out everywhere"
  revocation, per-account login lockout, JWTs pinned to `HS256` + issuer/audience.
- File uploads: `.html`/`.svg`/`.js` blocked at the allow-list; every `/uploads` response is
  forced to download (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`) as
  defense-in-depth even for allowed types.
- Secrets: AES-256-GCM encryption at rest for the IMAP password and BYOK API keys; a boot-time
  entropy/charset check rejects weak or placeholder `JWT_*`/`ENCRYPTION_KEY` values in production.
- AI input handling: untrusted, unauthenticated email content is explicitly delimited and framed
  as data (not instructions) before reaching the model, and its self-reported confidence is
  capped before it can suppress the human-review gate.
- Dependencies: `npm audit` clean (0 vulnerabilities) as of 2026-07-29. Re-check on a regular
  cadence — advisories are published against already-pinned versions, so "clean" decays without
  any code changing.
- Biometric data (optional face verification, off by default): face templates are AES-256-GCM
  encrypted at rest, captured images are served **only** through an authenticated API route
  (never the unauthenticated `/uploads` static mount) and auto-purged on a configurable retention
  schedule, and enrollment is consent-gated with the shown wording stored verbatim. See
  [docs/FACE_VERIFICATION.md](docs/FACE_VERIFICATION.md) — including the regulatory obligations
  (GDPR Art.9, Illinois BIPA, India DPDP) this feature carries before you enable it for real staff.

## Architecture

```mermaid
flowchart LR
  Browser["React SPA"] --> API["Express REST API"]
  Browser -.->|"/platform-admin"| API
  API --> Tenant["Tenant Resolution\n(Host header -> org)"]
  Tenant --> Control[("Control-plane DB\norgs, SSO config, plan tiers")]
  Tenant --> Auth["JWT + RBAC Guards"]
  Auth --> Prisma["Prisma Service Layer\n(Proxy -> active tenant client)"]
  Prisma --> MySQL[("This org's own MySQL database")]
  API --> Mail["Email Templates + SMTP"]
  API --> AI["ai.service.ts (BYOK)"] --> LLM["Anthropic or OpenAI-compatible provider"]
  API --> IMAP["IMAP Poll Worker"] --> Mailbox[("Inbound Mailbox")]
  API --> Workers["node-cron Workers\n(SLA sweeps, reminders, weekly digest — per org)"]
  API --> Audit["Audit Log"]
```

Every org's `MySQL` box above is a physically separate database — see [Multi-tenancy](#multi-tenancy).

## Key workflows

### A change, from raised to closed

The lifecycle is its own state machine. Two things are deliberately **not** states: `FAILED` and
`ROLLED_BACK` are **outcomes**, because a change that failed still has to be validated, reviewed and
closed — modelling failure as a state strands it outside the process that exists to learn from it.

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> AWAITING_APPROVAL: submit (gated)
  DRAFT --> CANCELLED
  AWAITING_APPROVAL --> APPROVED: manager or super admin
  AWAITING_APPROVAL --> REJECTED: with comments
  REJECTED --> DRAFT: rework opens a NEW round
  APPROVED --> SCHEDULED
  SCHEDULED --> IMPLEMENTING: refused while a predecessor is OPEN
  IMPLEMENTING --> VALIDATION
  VALIDATION --> PIR: outcome required
  PIR --> CLOSED
  CLOSED --> [*]
  REJECTED --> [*]
  CANCELLED --> [*]
```

The gate on `submit` is the module's whole point, so it is enforced by the API at the moment
approval is asked for — not by a hopeful placeholder in a form:

```mermaid
flowchart TD
  S["Submit for approval"] --> R{"Risk assessment<br/>COMPLETE?"}
  R -- "no" --> X["422 — names every gap at once"]
  R -- "yes" --> J{"Justification,<br/>implementation plan,<br/>planned window?"}
  J -- "missing" --> X
  J -- "yes" --> B{"Risk band needs<br/>a backout plan?"}
  B -- "yes, and absent" --> X
  B -- "satisfied" --> T{"Above LOW risk<br/>without a test plan?"}
  T -- "yes" --> X
  T -- "no" --> D{"Downtime declared<br/>without a comms plan<br/>or a duration?"}
  D -- "yes" --> X
  D -- "no" --> A["AWAITING_APPROVAL<br/>→ routed, mailed, clock started"]
```

**Why a *complete* risk assessment is required, and not merely encouraged.** The score normalises
across every active parameter, so an unanswered one contributes zero. That is correct in itself — a
blank is not "low" — but it means a half-filled assessment *under-reports*. Measured during the
build: high business impact plus high data risk, with the other nine parameters left blank, scored
**27 and banded LOW** — and the band is exactly what decides whether a backout plan is mandatory.
Leaving fields empty was therefore a way to skip the module's central rule. A draft still saves with
any subset; only submission demands the full set.

```mermaid
sequenceDiagram
  actor Requester
  participant UI as Change page
  participant API as REST API
  participant Rules as change.service.ts
  participant DB as MySQL
  participant Mail as SMTP
  actor Approver as Manager / Super admin

  Requester->>UI: Fill the twelve sections, add a runbook
  UI->>API: POST /changes/:id/transition {to: AWAITING_APPROVAL}
  API->>Rules: missingForSubmit(change, activeRiskKeys)
  alt anything missing
    Rules-->>API: ["Backout plan", "Test plan"]
    API-->>UI: 422 — every gap in one response
  else complete
    API->>Rules: resolveChangeApprovers(requesterId)
    Rules-->>API: the requester's manager, else all active super admins
    API->>DB: open approval round N, write state + Ticket.status together
    API->>Mail: to requester + implementer + approvers, BCC every super admin
  end

  Approver->>API: POST /changes/:id/decision {APPROVED, comments}
  API->>API: canDecideChange — never the requester, even as super admin
  API->>DB: settle the round, stamp approvedAt (starts the next SLA clock)
  API->>Mail: decision mail, adding who decided and why
```

**Why every state write also writes `Ticket.status`.** A change *is* a ticket plus an extension row,
so about forty existing readers already query `Ticket.status`. `CHANGE_STATE_TO_TICKET_STATUS` is the
same compatibility hinge `WorkflowStatus.legacyStatus` provides for custom ticket statuses — the pair
is never written apart, which is what lets comments, attachments, watchers, links, the audit trail,
search and project-scoped visibility keep working with no second implementation to keep in step.

### Logging time

```mermaid
sequenceDiagram
  actor Employee
  participant UI as Timesheet UI
  participant API as REST API
  participant DB as MySQL
  Employee->>UI: Select project/module/activity and time
  UI->>UI: Validate overlap, future date, max hours
  UI->>API: Submit timesheet
  API->>API: RBAC + DTO validation
  API->>DB: Persist entry and audit log
  API-->>UI: Submitted status + totals
```

### Email → ticket intake

```mermaid
sequenceDiagram
  actor Sender as External sender
  participant Mailbox
  participant Worker as IMAP poll worker
  participant AI as ai.service.ts (BYOK)
  participant DB as MySQL

  Sender->>Mailbox: Emails a bug report + screenshot
  Worker->>Mailbox: Poll unseen messages
  Worker->>Worker: Match EmailRoutingRule -> project/module
  Worker->>AI: classifyTicket(subject, body, screenshot)
  AI-->>Worker: type, priority, module, confidence, reasoning
  alt confidence >= threshold
    Worker->>DB: Create ticket, auto-assign via ModuleAssigneeRule
  else confidence < threshold
    Worker->>DB: Create ticket, flag needsReview, notify admins/managers
  end
  Worker-->>Sender: Confirmation email with ticket key
```

## Environment

See `.env.example` for all supported variables. Remember: the actual file the API reads must live at `apps/api/.env` (see Installation step 2 above). Notable groups:

- **Core**: `DATABASE_URL`, `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `WEB_ORIGIN`, `APP_BASE_URL`
- **Multi-tenancy**: `CONTROL_DATABASE_URL` (the control-plane database, required in both deployment shapes), `DEFAULT_ORG_SLUG` (which org a request with no real subdomain resolves to), `PLATFORM_ADMIN_JWT_SECRET` (signs `/platform-admin` tokens — must differ from the two `JWT_*` secrets above), `TENANT_DB_PROVISION_BASE_URL` (optional — enables in-console org provisioning; see [Multi-tenancy](#multi-tenancy) / [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
- **Mail**: `MAIL_FROM`, `SMTP_*` — leave `SMTP_HOST` empty to log emails to the console instead of sending
- **Timesheet SLA**: `SLA_*` — approval-window defaults, seeded into `GlobalNotificationSettings`/project rows, editable per-project after that
- **Ticket SLA**: `TICKET_SLA_*` — resolution-hour defaults per priority, seeded into `GlobalTicketSettings`, editable at runtime from Workspace Settings after that
- **AI**: `ANTHROPIC_API_KEY` — an Anthropic-only fallback key; everything else about AI (which provider, which features are on, model, base URL, BYOK key, budget, confidence threshold) lives in the DB via `GlobalAISettings` and is admin-editable at runtime from Workspace Settings → AI
- **MCP server**: *nothing*. The endpoint at `POST /api/mcp` is configured entirely from the database (`GlobalMcpSettings`, `McpCredential`) and edited at runtime from Workspace Settings → MCP server — there is no environment variable to set, and nothing an operator can switch on from outside the app. Same for AI refine and the per-user AI throttle (a fixed 20/min, not tunable). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#operating-the-mcp-server)
- **API telemetry**: `API_TELEMETRY_ENABLED` (off by default), `API_TELEMETRY_SAMPLE_RATE`, `API_TELEMETRY_FLUSH_MS`, `API_TELEMETRY_MAX_BUFFER`, `API_TELEMETRY_RETENTION_DAYS`, and `POD_NAME`/`POD_NAMESPACE`/`CLUSTER_NAME` for host identity. Deliberately env-only rather than an admin toggle — it runs on every request, so an operator has to ask for that cost. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#operating-api-request-telemetry)
- **Capacity tuning**: `RATE_LIMIT_PER_MINUTE` (default `900` — the blanket per-IP budget; per *egress* IP, so an office NAT is one bucket: raise it for NAT-heavy deployments) and `TENANT_DB_CONNECTION_LIMIT` (default `5` in code — multi-tenant arithmetic; the Compose files and Helm chart ship `20` because a single-org install has one live tenant and load testing measured 5 capping the authed path near 90 req/s on pool queueing alone). Both knobs exist because a measurement said so — the numbers are in [reports/quality-load-report.html](reports/quality-load-report.html)
- **Reverse proxies**: `TRUST_PROXY_HOPS` — the number of proxies in front of this API, `0` by default. **Set it if anything sits in front**, including the Docker Compose stack as shipped (the web container's nginx proxies `/api` to the API): every per-IP rate limit reads `req.ip`, and at `0` behind a proxy that is the proxy's address for every caller, so the login limiter becomes one shared global bucket — silently. A hop *count* rather than a boolean because trusting `X-Forwarded-For` wholesale lets anyone forge `req.ip`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#reverse-proxies-and-client-ip-attribution-trust_proxy_hops)
- **Outbound requests**: `ALLOW_PRIVATE_NETWORK_EGRESS` (default `false`) — whether this server may fetch **private, loopback or link-local** addresses. Four features let a workspace admin type a URL the *server* then requests (outbound webhooks, the Google Chat webhook, Bot Framework replies, the BYOK AI base URL), and the API sits inside your network — so leaving those unrestricted lets an admin aim one at cloud instance metadata (`169.254.169.254`, which issues IAM credentials to anything that asks) or an internal service. The guard resolves DNS and requires every resolved address to be public, because a hostname's text proves nothing. Set it `true` **only** on a self-hosted box whose webhook receivers genuinely live on the LAN, or whose BYOK model runs on `localhost`; development permits private targets regardless, so local testing needs no configuration. `npm run doctor` warns when it is on and the deployment looks internet-facing. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#outbound-request-restrictions-allow_private_network_egress)
- **Browser security headers**: `CSP_CONNECT_SRC` (default empty) — extra origins appended to the SPA's `connect-src` policy, read by the **web** container's nginx, not the API. Empty is correct for every topology this repo ships (nginx fronts the API, so `'self'` covers it). A **split** deployment — SPA on a CDN or a different hostname from the API — must set it to the same origin passed as `VITE_API_URL` at build time, or the browser blocks every API call. Everything else in the policy (CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`) is fixed in `apps/web/nginx.conf.template`; HSTS is set by the TLS terminator in `deploy/caddy/Caddyfile.domain`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#browser-security-headers)
- **File storage**: `STORAGE_ROOT`, `STORAGE_DOCUMENTS_DIR`, `STORAGE_AVATARS_DIR`, `STORAGE_FACE_DIR` — all empty by default, which keeps uploads exactly where they are today (under `UPLOAD_DIR`, relative to the API's working directory). Set them to move storage onto its own volume, segregated into documents / avatars / face subtrees you can back up and encrypt separately. Absolute paths only, and changing one affects new files only — nothing is moved for you, and reads fall back to the previous root. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#relocating-file-storage)
- **Log files**: `LOG_DIR` (empty = off), `LOG_ROTATE_HOURS`, `LOG_RETENTION_DAYS`, `LOG_COMPRESS_ON_ROLLOVER` — mirrors everything the process prints into rotating, date-bucketed files. Console output is never taken away, and an unwritable directory degrades to console-only with one warning rather than stopping the app. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#log-files)
- **Update checks**: `UPDATE_CHECK` (`off` disables the hourly GitHub release call — the air-gapped posture; the **What's new** page then lists the history bundled in this build's own `CHANGELOG.md`), `UPDATE_CHECK_REPO` (override for forks), `UPDATE_CHECK_TOKEN` (a read-only Contents PAT, needed only when the repo is **private**, where anonymous release lookups 404). Note that only the literal `off` disables the check — any other value, `false` included, leaves it on
- **Token lifetimes**: `ACCESS_TOKEN_TTL` (default `15m`) and `REFRESH_TOKEN_TTL_DAYS` (default `14`). Also surfaced as `env.accessTokenTtl` / `env.refreshTokenTtlDays` in the Helm chart, since shortening the access-token TTL is a standard security-review request

## Further docs

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the structured, continuously-maintained
  architecture reference: what every module is for, why it exists, what it depends on, and how
  data flows through the system (with embedded Mermaid diagrams). Written for both a human
  onboarding onto the project and an AI coding assistant that needs to understand the system
  before changing it — read this before re-deriving architecture from scratch by grepping
  through every file. **Keep it current**: when you add a service/controller/worker or change a
  data flow, update the relevant section in the same change.
- [docs/API.md](docs/API.md) — endpoint reference.
- [docs/DATABASE.md](docs/DATABASE.md) — schema reference.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — on-prem vs. SaaS deployment shapes, CI/CD, one-click install, Kubernetes.
- [docs/INSTALLATION.md](docs/INSTALLATION.md) — the complete step-by-step install guide (one-click Docker, manual local, Kubernetes), self-diagnosis, a FAQ, and how to configure everything after install without a code change.
- [docs/NEW_ORGANIZATION_SETUP.md](docs/NEW_ORGANIZATION_SETUP.md) — the "day 2" runbook: a one-time production-hardening checklist (secrets, TLS, dependency patching, backups, log aggregation), then the repeatable steps to bring a brand-new organization online and verify it's ready to go live.
- [CONTRIBUTING.md](CONTRIBUTING.md) — getting a working checkout, what to run before a PR, and the "extend the existing choke point, don't add a parallel system" conventions this codebase is built on.
- [.github/SECURITY.md](.github/SECURITY.md) — how to report a vulnerability privately, what protections already exist, and two deliberate design points worth understanding before you deploy.
- [docs/FACE_VERIFICATION.md](docs/FACE_VERIFICATION.md) — face (identity) verification: how the server-side check works, the biometric-privacy obligations it carries, calibrating the match threshold, retention and deletion.
- [docs/AI_AND_AUTOMATION_FOR_CHANGE.md](docs/AI_AND_AUTOMATION_FOR_CHANGE.md) — **a proposal, not shipped code**: how AI, agents and Workflow Studio could serve tickets and change management, written against the seams that already exist. Opens with the distinction the rest depends on — most of what looks like "let AI fill this in" is derivable from the linked tickets' branches, PRs and CI runs, and a derived value is auditable and free where a generated one has to be checked.
- [docs/ROADMAP.md](docs/ROADMAP.md) — what differentiates this product today, next-feature themes (AI workflow automation, conversational analytics, integrations, billing), and how each maps to plan tiers.
- [docs/SECURITY_DEVOPS_INTEGRATIONS.md](docs/SECURITY_DEVOPS_INTEGRATIONS.md) — connect GitHub Actions, GitLab CI, Jenkins, Bitbucket, or any internal git/CI system to the security-findings ingestion webhook (SAST/DAST/SSAT/SSCT), with copy-pasteable pipeline examples.
- [CHANGELOG.md](CHANGELOG.md) — what each release changed; the source for GitHub release bodies and the in-app What's-new page. The release process itself is in CONTRIBUTING.md's "Releasing a version".
- [reports/quality-load-report.html](reports/quality-load-report.html) — the interactive quality &amp; load report: all three deployment shapes run and load-tested for real, the measured before/after for every optimization, the security posture inventory, and — labeled as such — what still needs an external engagement (VAPT, SonarQube server, DAST). Open it in a browser; charts are hoverable, dark mode follows the OS.
- [docs/ONBOARDING_AND_TOUR.md](docs/ONBOARDING_AND_TOUR.md) — the first-run gate and the role-aware product tour: why the gate's "already onboarded" flag is stored rather than derived (and how the migration's backfill stops it locking out existing users), how the tour derives its itinerary from the sidebar's own permission rules, and the session-rotation trap that makes multi-test specs sign in per test.
- [docs/MARKETING_PAGES.md](docs/MARKETING_PAGES.md) — the public pages (`/`, `/pitch`, `/login`): the "every claim maps to shipped code" rule that governs them, how the product screenshots are regenerated from the running app, and the layout constraints (tab order, reduced-motion, gradient ramps) that are easy to undo by accident.

### A note on code comments in this repo

Every non-trivial file carries a header comment answering **what** it does, **why** it exists
(the actual reason, not a restatement of the filename), **how** it fits into the surrounding
system, and **who** calls it. Individual functions get inline comments only where the logic
itself is genuinely non-obvious — clear naming and the file header cover the rest, so a
function-by-function narration doesn't rot into noise as the code changes around it. Match this
convention in new files rather than leaving them undocumented or over-commenting every line.
