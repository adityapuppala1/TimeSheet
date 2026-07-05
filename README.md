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
| **Ticketing** | Bugs/tasks/improvements with admin-editable types & labels, priority/status workflow (with a Kanban board and drag-and-drop), assignment, comments, attachments, watchers, cross-ticket links (Blocks/Duplicate of/Relates to), sub-task checklists, SLA due-dates with automatic breach escalation. Tickets and timesheets link to each other — time can be logged directly against a ticket. |
| **AI, BYOK multi-provider (opt-in)** | Auto-triage suggestions on ticket creation, duplicate-ticket detection, a writing assistant ("Improve with AI") for descriptions/comments, AI comment-thread summaries, natural-language "Ask AI" search over the ticket backlog (command palette), and a Monday-morning AI-authored weekly digest email. Every capability is gated behind a master switch **and** its own per-feature toggle in Workspace Settings — nothing calls out to any provider until an admin explicitly turns it on and a key is configured. **Bring-your-own-key**: pick Anthropic (native) or any OpenAI-compatible provider — OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, a local Ollama/LM Studio install, or a custom endpoint — from Workspace Settings → AI; the key is encrypted at rest and never returned to the client. Every AI call is cost-estimated and logged (`AIUsageLog`) against a configurable monthly budget cap. |
| **Email-to-ticket intake** | Point an IMAP mailbox at the app; inbound bug-report emails (including screenshot attachments, read directly by the configured model's vision input) are auto-classified into a properly-typed, prioritized, project/module-routed ticket, auto-assigned via admin-configured rules, and the sender gets an automatic confirmation reply. Untrusted email content is delimited and instructed as data-not-instructions before it reaches the model, and its self-reported confidence is capped before it can suppress human review. Low-confidence classifications are flagged **needs review** instead of silently mis-assigned. An **AI Activity Log** page shows every AI-touched ticket with a thumbs up/down feedback control. |
| **Insights & analytics** | Ticket velocity, SLA compliance trend, cycle-time distribution, bug hotspots by module, a per-assignee workload heatmap, estimate-vs-actual variance, reopen rate, and first-response time — plus two opt-in-and-off-by-default panels (cost-per-ticket, team leaderboard) since they touch compensation-adjacent or individually-ranked data. |
| **Admin configurability** | Nearly everything above is editable from **Workspace Settings** without a server restart: notification channels & reminder schedule, ticket SLA hours per priority, ticket types, labels, AI provider/toggles/model/budget, email-intake mailbox connection + routing rules + module-assignee rules, and per-notification-category email opt-ins. |
| **RBAC & audit** | Role-based permissions (`SUPER_ADMIN` / `ADMIN` / `MANAGER` / `TEAM_LEAD` / `EMPLOYEE`), a tamper-evident audit log of every administrative/approval/AI action, and a per-ticket Activity tab that's just that same audit log filtered to one entity. |
| **Session management & security** | httpOnly, `SameSite=Lax` refresh-token cookie (never exposed to page JS) with rotation-and-reuse-detection, a per-user active-sessions list with per-device or "sign out everywhere" revocation, per-account login lockout on top of per-IP rate limiting, a real hashed/expiring/single-use password-reset flow, AES-256-GCM encryption at rest for stored secrets (IMAP password, BYOK API keys, OIDC client secrets), and a fully responsive layout (phone through 4K) verified by an automated Playwright suite. See [Security](#security) below for the full VAPT assessment. |
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

4. **Generate the Prisma clients** (tenant schema + the separate control-plane schema):

   ```bash
   npm run db:generate
   npm run control:generate -w apps/api
   ```

5. **Create the databases and apply migrations:**

   ```bash
   npm run db:migrate
   npm run control:migrate -w apps/api
   ```

   This creates the `timesheet_portal` and `timesphere_control` databases (if they don't exist)
   and applies every migration for each.

6. **Seed the control plane, then the tenant's demo data:**

   ```bash
   npm run control:seed -w apps/api
   npm run seed
   ```

   `control:seed` registers one `Organization` (slug from `DEFAULT_ORG_SLUG`, default `default`)
   pointing at `DATABASE_URL`, seeds the three plan tiers' default limits, and creates one
   `PlatformAdminUser` (credentials below). `seed` then seeds that org's own database: roles/permissions,
   three demo users (below), a demo project, default ticket types (Bug/Task/Improvement), and
   every notification/ticketing/AI settings singleton at its safe default (AI **off** until you
   opt in).

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

## Troubleshooting

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

### A note on code comments in this repo

Every non-trivial file carries a header comment answering **what** it does, **why** it exists
(the actual reason, not a restatement of the filename), **how** it fits into the surrounding
system, and **who** calls it. Individual functions get inline comments only where the logic
itself is genuinely non-obvious — clear naming and the file header cover the rest, so a
function-by-function narration doesn't rot into noise as the code changes around it. Match this
convention in new files rather than leaving them undocumented or over-commenting every line.
