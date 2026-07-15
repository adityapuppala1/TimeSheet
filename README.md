# TimeSphere — Timesheet + AI-Powered Ticketing Portal

A full-stack workspace platform that combines **timesheet management** (daily work logging,
approvals, SLA-driven escalation, reporting) with a **Jira-like ticketing system**, a
**bring-your-own-key AI layer** (Anthropic or any OpenAI-compatible provider), and an
**analytics/insights dashboard** — all under one roof, one login, and one admin-configurable
settings surface. The unifying idea: this app already owns both *the work* (tickets) and *the
time spent on it* (timesheets), so features that fuse the two (workload heatmaps, AI weekly
digests) are only possible because they live in the same system.

## Feature areas

| Area | What it does |
|---|---|
| **Timesheets** | Daily time entry against project/module/submodule/activity, manager approval workflow, SLA-driven escalation up the reporting chain, daily reminder + next-morning escalation emails, CSV/PDF export. |
| **Ticketing** | Bugs/tasks/improvements with admin-editable types & labels, priority/status workflow (with a Kanban board and drag-and-drop, optional **"Group by manager" swimlanes**), assignment, comments, attachments, watchers, cross-ticket links (Blocks/Duplicate of/Relates to), sub-task checklists, SLA due-dates with automatic breach escalation, and a **Dev tab** for linking a repository/branch/PR (open/merged/closed status) to a ticket — manually, or picked live from a connected GitHub account. An optional **CI gate** (off by default) blocks a ticket from moving to Resolved while its latest ingested CI test run is failing, and the Kanban card shows a red badge for the same reason. |
| **Live git integration (GitHub)** | Each org connects its own GitHub account via OAuth (bring your own GitHub OAuth App — same model as Google/Microsoft SSO below, no TimeSphere-operated client ever touches your repos). The ticket Dev tab lists live repos/branches/open PRs to pick from, and a per-repo GitHub webhook auto-syncs `TicketBranch` rows as commits land and PRs open/merge/close (matched to a ticket by a ticket-key-shaped token in the branch name, e.g. `WEB-123-fix-login`) — plus, opt-in, an AI-authored PR-review summary comment when a linked PR opens. GitLab/Bitbucket remain unbuilt — see [docs/ROADMAP.md](docs/ROADMAP.md). |
| **Public REST API + outbound webhooks** | Bearer-API-key access to `GET/POST/PATCH /api/public/v1/*` (list/get/create tickets, change ticket status, add a comment, list timesheets) for external integrations — generate named, revocable, READ- or WRITE-scoped keys from Workspace Settings. Status changes enforce the exact same transition-legality and CI-gate rules the UI does. Outbound webhooks POST an HMAC-SHA256-signed JSON payload (same trust model as GitHub/Stripe webhooks) when a ticket is created, changes status, or closes, or a timesheet is submitted/approved. See [docs/API.md](docs/API.md#public-api). |
| **AI, BYOK multi-provider (opt-in)** | Auto-triage suggestions on ticket creation, duplicate-ticket detection, a writing assistant ("Improve with AI") for descriptions/comments, AI comment-thread summaries, natural-language "Ask AI" search over the ticket backlog (command palette), and a Monday-morning AI-authored weekly digest email. Every capability is gated behind a master switch **and** its own per-feature toggle in Workspace Settings — nothing calls out to any provider until an admin explicitly turns it on and a key is configured. **Bring-your-own-key**: pick Anthropic (native) or any OpenAI-compatible provider — OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, a local Ollama/LM Studio install, or a custom endpoint — from Workspace Settings → AI; the key is encrypted at rest and never returned to the client. Every AI call is cost-estimated and logged (`AIUsageLog`) against a configurable monthly budget cap. |
| **Email-to-ticket intake** | Point an IMAP mailbox at the app; inbound bug-report emails (including screenshot attachments, read directly by the configured model's vision input) are auto-classified into a properly-typed, prioritized, project/module-routed ticket, auto-assigned via admin-configured rules, and the sender gets an automatic confirmation reply. Untrusted email content is delimited and instructed as data-not-instructions before it reaches the model, and its self-reported confidence is capped before it can suppress human review. Low-confidence classifications are flagged **needs review** instead of silently mis-assigned. An **AI Activity Log** page shows every AI-touched ticket with a thumbs up/down feedback control. |
| **Insights & analytics** | Ticket velocity, SLA compliance trend, cycle-time distribution, bug hotspots by module, a per-assignee workload heatmap, estimate-vs-actual variance, reopen rate, and first-response time — plus two opt-in-and-off-by-default panels (cost-per-ticket, team leaderboard) since they touch compensation-adjacent or individually-ranked data. |
| **Admin configurability** | Nearly everything above is editable from **Workspace Settings** without a server restart: notification channels & reminder schedule, ticket SLA hours per priority, ticket types, labels, AI provider/toggles/model/budget, email-intake mailbox connection + routing rules + module-assignee rules, and per-notification-category email opt-ins. |
| **RBAC & audit** | Role-based permissions (`SUPER_ADMIN` / `ADMIN` / `MANAGER` / `TEAM_LEAD` / `EMPLOYEE`), a tamper-evident audit log of every administrative/approval/AI action, and a per-ticket Activity tab that's just that same audit log filtered to one entity. |
| **Session management & security** | httpOnly, `SameSite=Lax` refresh-token cookie (never exposed to page JS) with rotation-and-reuse-detection, a per-user active-sessions list with per-device or "sign out everywhere" revocation, per-account login lockout on top of per-IP rate limiting, a real hashed/expiring/single-use password-reset flow, AES-256-GCM encryption at rest for stored secrets (IMAP password, BYOK API keys, OIDC client secrets), and a fully responsive layout (phone through 4K) — wide tables (Tickets list, Team page) fall back to a stacked card view below the `sm` breakpoint instead of a horizontal scroll — verified by an automated Playwright suite covering every route and every settings/ticket-sheet tab. See [Security](#security) below for the full VAPT assessment. |
| **Security & DevOps ingestion (SAST/DAST/SSAT/SSCT/VAPT)** | Ingest-only, tool-agnostic: your own CI (GitHub Actions, GitLab CI, Jenkins, Bitbucket, or anything else) POSTs findings/test-run results to a per-org bearer-token-protected webhook — this app never runs a scanner itself. VAPT (a periodic, human-led pentest, not a per-PR check) uploads as a structured JSON report instead, from Workspace Settings. Findings roll up into a per-ticket **Security** tab (risk verdict, PDF export) and, if enabled, a ticket-close digest email to the closer, their manager, and the org's admins. See [docs/SECURITY_DEVOPS_INTEGRATIONS.md](docs/SECURITY_DEVOPS_INTEGRATIONS.md). |
| **Reporting-line views** | An interactive, pan/zoomable **org-chart tree** on the Team page (D3-hierarchy layout, built from the existing `User.managerId` relation, no new schema — privileged roles see the whole company, everyone else their own subtree), color/icon-coded per role (Super Admin/Admin/Manager/Team Lead/Employee) with each person's **designation** shown alongside their name, and matching **Kanban swimlanes** ("Group by manager") on the ticket board. |
| **Live trend analytics** | Every KPI stat card across Dashboard, History, My team, and Reports shows a today-vs-yesterday (or this-week-vs-last-week, for weekly metrics) trend badge — an up/down/flat arrow, colored green/red based on whether that direction is actually good for that metric — computed server-side (or client-side for History) and auto-refreshed every 30s, no configuration needed. |
| **SSO (Google, Microsoft, SAML, LDAP)** | Each organization's own admin turns on exactly the sign-in methods their team uses — password, Google, Microsoft/Azure AD, any SAML 2.0 IdP (Okta, OneLogin, ADFS...), or LDAP/Active Directory — independently of every other organization, down to requiring SSO-only. One fixed callback URL works for every OIDC/SAML org: identity travels through a signed state parameter, not a per-org redirect URI. LDAP is a direct bind (no redirect), rendered as an inline login form instead. |
| **Chat-to-ticket connectors (Slack, Microsoft Teams, Google Chat, Telegram)** | The same "message arrives, AI-triaged ticket appears" pipeline as email intake, generalized across four chat platforms. Slack/Teams/Google Chat are push-only APIs (a webhook URL, signature-verified per platform); Telegram is polled, avoiding the need for a public endpoint. The bot replies back into the originating chat once a ticket's created. Which platforms an org may connect is capped by plan tier, same as SSO providers. |
| **Multi-tenant SaaS platform** | Runs as either a single-org on-prem deployment or a true multi-org SaaS platform on the same codebase. Each organization gets its own physically separate MySQL database (never a shared table filtered by a tenant column) — see [Multi-tenancy](#multi-tenancy) below. |
| **Platform administration** | A separate `/platform-admin` console (its own auth, its own JWT secret, zero shared client state with the tenant app) for organization lifecycle, plan-tier limits (seat counts, AI budget ceilings, allowed SSO providers/chat platforms), and cross-org analytics — restricted by convention to aggregate numbers, never row-level tenant content. |

## Stack

- **Frontend**: React 19, TypeScript, Vite, TailwindCSS, shadcn-style Radix components, Zustand, TanStack Query, React Hook Form, Framer Motion, Recharts, `@dnd-kit` (Kanban drag-and-drop), Tiptap (rich text)
- **Backend**: Node.js, Express 5, TypeScript, JWT access/refresh auth (httpOnly-cookie rotation, session revocation), RBAC, Prisma ORM, MySQL (database-per-tenant multi-tenancy — a separate control-plane Prisma schema/client alongside the tenant one), `openid-client` + `@node-saml/node-saml` + `ldapts` (Google/Microsoft/SAML/LDAP SSO), `@anthropic-ai/sdk` + `openai` (BYOK multi-provider adapter), `imapflow` + `mailparser` (email intake), `jwks-rsa` (Bot Framework JWT verification for Teams), `node-cron` (background workers), Nodemailer
- **Infra**: Docker Compose or Kubernetes (Helm chart with HPA/VPA autoscaling — see [Deploy](#deploy)), GitHub Actions CI/CD, environment config validation (Zod) with production-safety boot checks, secure headers (Helmet), rate limiting + per-account login lockout, request logging, centralized error middleware, AES-256-GCM encryption at rest for stored secrets
- **Testing**: Playwright (Chromium, custom phone/tablet/laptop/desktop/4K viewport projects) — end-to-end auth, tickets, timesheet, settings, and responsive-layout coverage

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

2. **Create the API's env file.** The API loads `.env` from its own working directory (`apps/api/`), not the repo root, so copy the template there:

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

   This runs `npm install`, `npm run db:generate`, `npm run doctor:heal` (validates `.env`,
   auto-creates `timesheet_portal`/`timesphere_control` if they don't exist, then runs
   `prisma migrate deploy` for both schemas), and `npm run seed`. Safe to re-run — creating an
   already-existing database or re-running a migration that already applied is a no-op, and
   seeding is idempotent. If you'd rather run each step yourself (or just want to see what
   `setup` is doing), the equivalent steps are below.

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
   settings singleton at its safe default (AI **off** until you opt in).

7. **Run the app:**

   ```bash
   npm run dev
   ```

   - Frontend: http://localhost:5173
   - API: http://localhost:4000/api (health check at http://localhost:4000/health)
   - Platform-admin console: http://localhost:5173/platform-admin/login (see [Multi-tenancy](#multi-tenancy))

   The web dev server proxies `/api` and `/uploads` to the API, so there's no separate URL/CORS config to manage in dev.

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
   detection, writing assistant, comment summary, "Ask AI", email intake, weekly digest), and
   optionally set a monthly budget cap.
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
.\install.ps1        # Windows PowerShell
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

```bash
npm run test:e2e          # full Playwright suite (Chromium; desktop + phone/tablet/laptop/4K viewport projects)
npm run test:e2e:report   # open the last run's HTML report
```

The suite boots the API and web dev servers itself (see `playwright.config.ts`'s `webServer`
config) if they aren't already running. A one-time `setup` project logs in as each demo role and
saves the resulting session for the other specs to reuse — see `tests/e2e/auth.setup.ts` for why
some specs deliberately log in fresh instead (it comes down to the refresh-token rotation
described in Security below).

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
- Dependencies: `npm audit` is clean (0 vulnerabilities) as of the last regression pass.

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
- [docs/ROADMAP.md](docs/ROADMAP.md) — what differentiates this product today, next-feature themes (AI workflow automation, conversational analytics, integrations, billing), and how each maps to plan tiers.
- [docs/SECURITY_DEVOPS_INTEGRATIONS.md](docs/SECURITY_DEVOPS_INTEGRATIONS.md) — connect GitHub Actions, GitLab CI, Jenkins, Bitbucket, or any internal git/CI system to the security-findings ingestion webhook (SAST/DAST/SSAT/SSCT), with copy-pasteable pipeline examples.

### A note on code comments in this repo

Every non-trivial file carries a header comment answering **what** it does, **why** it exists
(the actual reason, not a restatement of the filename), **how** it fits into the surrounding
system, and **who** calls it. Individual functions get inline comments only where the logic
itself is genuinely non-obvious — clear naming and the file header cover the rest, so a
function-by-function narration doesn't rot into noise as the code changes around it. Match this
convention in new files rather than leaving them undocumented or over-commenting every line.
