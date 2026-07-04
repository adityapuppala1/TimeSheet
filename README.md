# TimeSphere — Timesheet + AI-Powered Ticketing Portal

A full-stack workspace platform that combines **timesheet management** (daily work logging,
approvals, SLA-driven escalation, reporting) with a **Jira-like ticketing system**, an
**AI layer** built on Anthropic Claude, and an **analytics/insights dashboard** — all under one
roof, one login, and one admin-configurable settings surface. The unifying idea: this app
already owns both *the work* (tickets) and *the time spent on it* (timesheets), so features
that fuse the two (workload heatmaps, AI weekly digests) are only possible because they live
in the same system.

## Feature areas

| Area | What it does |
|---|---|
| **Timesheets** | Daily time entry against project/module/submodule/activity, manager approval workflow, SLA-driven escalation up the reporting chain, daily reminder + next-morning escalation emails, CSV/PDF export. |
| **Ticketing** | Bugs/tasks/improvements with admin-editable types & labels, priority/status workflow (with a Kanban board and drag-and-drop), assignment, comments, attachments, watchers, cross-ticket links (Blocks/Duplicate of/Relates to), sub-task checklists, SLA due-dates with automatic breach escalation. Tickets and timesheets link to each other — time can be logged directly against a ticket. |
| **AI (Anthropic Claude, opt-in)** | Auto-triage suggestions on ticket creation, duplicate-ticket detection, a writing assistant ("Improve with AI") for descriptions/comments, AI comment-thread summaries, natural-language "Ask AI" search over the ticket backlog (command palette), and a Monday-morning AI-authored weekly digest email. Every capability is gated behind a master switch **and** its own per-feature toggle in Workspace Settings — nothing calls out to Anthropic until an admin explicitly turns it on and an API key is configured. Every AI call is cost-estimated and logged (`AIUsageLog`) against a configurable monthly budget cap. |
| **Email-to-ticket intake** | Point an IMAP mailbox at the app; inbound bug-report emails (including screenshot attachments, read directly by Claude's vision input) are auto-classified into a properly-typed, prioritized, project/module-routed ticket, auto-assigned via admin-configured rules, and the sender gets an automatic confirmation reply. Low-confidence classifications are flagged **needs review** instead of silently mis-assigned. An **AI Activity Log** page shows every AI-touched ticket with a thumbs up/down feedback control. |
| **Insights & analytics** | Ticket velocity, SLA compliance trend, cycle-time distribution, bug hotspots by module, a per-assignee workload heatmap, estimate-vs-actual variance, reopen rate, and first-response time — plus two opt-in-and-off-by-default panels (cost-per-ticket, team leaderboard) since they touch compensation-adjacent or individually-ranked data. |
| **Admin configurability** | Nearly everything above is editable from **Workspace Settings** without a server restart: notification channels & reminder schedule, ticket SLA hours per priority, ticket types, labels, AI toggles/model/budget, email-intake mailbox connection + routing rules + module-assignee rules, and per-notification-category email opt-ins. |
| **RBAC & audit** | Role-based permissions (`SUPER_ADMIN` / `ADMIN` / `MANAGER` / `TEAM_LEAD` / `EMPLOYEE`), a tamper-evident audit log of every administrative/approval/AI action, and a per-ticket Activity tab that's just that same audit log filtered to one entity. |

## Stack

- **Frontend**: React 19, TypeScript, Vite, TailwindCSS, shadcn-style Radix components, Zustand, TanStack Query, React Hook Form, Framer Motion, Recharts, `@dnd-kit` (Kanban drag-and-drop), Tiptap (rich text)
- **Backend**: Node.js, Express 5, TypeScript, JWT access/refresh auth, RBAC, Prisma ORM, MySQL, `@anthropic-ai/sdk`, `imapflow` + `mailparser` (email intake), `node-cron` (background workers), Nodemailer
- **Infra**: Docker Compose, environment config validation (Zod), secure headers (Helmet), rate limiting, request logging, centralized error middleware

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
- Optional, only if you want AI features live: an [Anthropic API key](https://console.anthropic.com/)
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
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — any long random strings for local dev.
   - `SMTP_*` — optional; leave `SMTP_HOST` empty to have emails logged to the console instead of actually sent.
   - `ANTHROPIC_API_KEY` — optional; leave empty to keep every AI feature inert. AI also needs an admin to flip its master switch on in Workspace Settings once a key is set — it never turns itself on.

3. **Make sure MySQL is running** (start it from the XAMPP Control Panel if you're using XAMPP's MySQL).

4. **Generate the Prisma client:**

   ```bash
   npm run db:generate
   ```

5. **Create the database and apply migrations:**

   ```bash
   npm run db:migrate
   ```

   This creates the `timesheet_portal` database (if it doesn't exist) and applies every migration in `apps/api/prisma/migrations`.

6. **Seed demo data:**

   ```bash
   npm run seed
   ```

   Seeds roles/permissions, three demo users (below), a demo project, default ticket types
   (Bug/Task/Improvement), and every notification/ticketing/AI settings singleton at its safe
   default (AI **off** until you opt in).

7. **Run the app:**

   ```bash
   npm run dev
   ```

   - Frontend: http://localhost:5173
   - API: http://localhost:4000/api (health check at http://localhost:4000/health)

   The web dev server proxies `/api` and `/uploads` to the API, so there's no separate URL/CORS config to manage in dev.

### Demo credentials (after seeding)

- Super Admin: `superadmin@timesheet.local` / `Admin@12345`
- Manager: `manager@timesheet.local` / `Admin@12345`
- Employee: `employee@timesheet.local` / `Admin@12345`

### Turning on AI features

AI is off by default. To try it:

1. Set `ANTHROPIC_API_KEY` in `apps/api/.env` and restart the API.
2. Log in as Super Admin → **Workspace Settings → AI** → flip the master switch, then whichever
   per-feature toggles you want (auto-triage, duplicate detection, writing assistant, comment
   summary, "Ask AI", email intake, weekly digest), pick a model, optionally set a monthly
   budget cap.
3. For email-to-ticket intake specifically, also fill in the mailbox connection under
   **Workspace Settings → Email intake** and add at least one routing rule (or a fallback
   project) so inbound mail has somewhere to land.

## Docker

```bash
docker compose up --build
```

Docker Compose passes environment variables directly (see `docker-compose.yml`) rather than reading `apps/api/.env`, so export `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `WEB_ORIGIN`, and `APP_BASE_URL` in your shell (or a `.env` file next to `docker-compose.yml`, which Compose reads automatically) before running it. MySQL runs in its own container on host port `3307`.

## Troubleshooting

- **`Error: Cannot find package '...packages/shared/dist/index.js'`** — `packages/shared` hasn't been built. Run `npm install` (which now runs this automatically via `postinstall`) or manually: `npm run build -w packages/shared`.
- **`Environment variable not found: DATABASE_URL` / zod "Required" errors on boot** — your `.env` is in the wrong place. It must be at `apps/api/.env`, not the repo root.
- **`Authentication failed against database server, the provided database credentials for 'root' are not valid.`** — `DATABASE_URL` in `apps/api/.env` doesn't match your MySQL server's actual root password. For a stock XAMPP install this password is empty.
- **Port already in use (4000 or 5173)** — another process is already listening; stop it or change `API_PORT` / the web `--port` flag.
- **AI features show "No API key configured"** — set `ANTHROPIC_API_KEY` in `apps/api/.env` and restart the API. The master switch in Workspace Settings still needs to be turned on separately.
- **Email intake isn't picking anything up** — check three things: the master AI switch **and** the "Email-to-ticket intake" toggle are both on, the mailbox connection test in Workspace Settings → Email intake succeeds, and at least one routing rule or a fallback project is configured (otherwise matched-but-unrouted mail is intentionally dropped, logged as a warning).

## Architecture

```mermaid
flowchart LR
  Browser["React SPA"] --> API["Express REST API"]
  API --> Auth["JWT + RBAC Guards"]
  API --> Prisma["Prisma Service Layer"]
  Prisma --> MySQL[("MySQL")]
  API --> Mail["Email Templates + SMTP"]
  API --> AI["ai.service.ts"] --> Claude["Anthropic Claude API"]
  API --> IMAP["IMAP Poll Worker"] --> Mailbox[("Inbound Mailbox")]
  API --> Workers["node-cron Workers\n(SLA sweeps, reminders, weekly digest)"]
  API --> Audit["Audit Log"]
```

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
  participant AI as ai.service.ts (Claude)
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

- **Core**: `DATABASE_URL`, `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`, `WEB_ORIGIN`, `APP_BASE_URL`
- **Mail**: `MAIL_FROM`, `SMTP_*` — leave `SMTP_HOST` empty to log emails to the console instead of sending
- **Timesheet SLA**: `SLA_*` — approval-window defaults, seeded into `GlobalNotificationSettings`/project rows, editable per-project after that
- **Ticket SLA**: `TICKET_SLA_*` — resolution-hour defaults per priority, seeded into `GlobalTicketSettings`, editable at runtime from Workspace Settings after that
- **AI**: `ANTHROPIC_API_KEY` — the only AI-related env var; every other AI setting (which features are on, model, budget, confidence threshold) lives in the DB and is admin-editable at runtime

## Further docs

- [docs/API.md](docs/API.md)
- [docs/DATABASE.md](docs/DATABASE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
