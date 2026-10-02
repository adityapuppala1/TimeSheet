# New Organization Setup & Production Readiness Guide

> **Audience:** platform operators · **Type:** runbook · [Documentation index](README.md)

This is the "day 2" runbook: the platform is already deployed (see
[docs/DEPLOYMENT.md](DEPLOYMENT.md) / [docs/INSTALLATION.md](INSTALLATION.md) for that part), and
now you need to (1) actually harden that deployment for real customer data, and (2) bring a real
organization onto it from scratch. Part 1 is a one-time checklist. Part 2 is the repeatable
runbook you follow every time a new organization/customer needs to go live.

Every item below was verified against this codebase directly (typecheck, build, `npm audit`,
reading the actual middleware/config), not copied from aspirational docs — see the "Verified"
notes inline.

---

## Part 1 — One-time production hardening checklist

Do this once, before the first real (non-demo) organization goes live. Re-check items 3–5
periodically (dependency advisories change even when your code doesn't).

### 1. Generate real secrets

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 48   # PLATFORM_ADMIN_JWT_SECRET  — must differ from the two above
openssl rand -hex 32      # ENCRYPTION_KEY — 64 hex chars exactly
```

Set `NODE_ENV=production`. **Verified**: `apps/api/src/server.ts`'s `assertProductionSafety()`
actively refuses to boot in production with a weak/placeholder `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, or `ENCRYPTION_KEY` (entropy-checked, not just a denylist) — this is a real
fail-fast guard, not just a doc recommendation. It also warns at boot (in any mode) if
`WEB_ORIGIN` looks like a real public domain while `NODE_ENV` isn't `"production"`, since that
combination silently skips the cookie `Secure` flag and CORS strictness — don't ignore that
warning if you see it.

### 2. Put TLS in front of both services

Neither `docker-compose.yml` nor the Helm chart terminates TLS itself. Put a reverse proxy
(nginx/Caddy) or your ingress controller's TLS termination (cert-manager + Let's Encrypt is the
standard Kubernetes pattern — the Helm chart's `ingress.tls` values wire straight into it) in
front of `web` (port 80 internally) and `api` (port 4000 internally). Point `WEB_ORIGIN` and
`APP_BASE_URL` at the real `https://` domain, not the internal HTTP ports.

### 3. Patch dependency vulnerabilities

**Status as of 2026-07-29: done, verified, `npm audit` reports 0 vulnerabilities.** The
12 originally found (6 high, 4 moderate, 2 low — newer than the README's earlier "0
vulnerabilities" note, since advisories publish against already-pinned versions over time) were
resolved as follows. Re-run `npm audit` periodically going forward — this isn't a one-time fix.

- `morgan`, `linkify-it`/`dompurify` (via `mailparser`), `postcss`, and the initial `uuid` (via
  `ldapts`) advisories: fixed via plain `npm audit fix`.
- `sharp` (used in `middleware/upload.ts` to re-encode avatar uploads) needed a major-version
  bump (`0.34.x` → `0.35.3`, libvips CVEs). Applied, then **functionally verified** with a script
  exercising `processAvatar()` directly against synthetic PNG (alpha-channel) and JPEG inputs with
  injected EXIF/orientation data — confirmed resize-to-512px, correct PNG/JPEG format selection,
  and EXIF stripping all still work identically post-upgrade.
- `ldapts` needed bumping past `^7.3.1` (root `package.json` already declared `^8.1.8` but
  `apps/api/package.json`'s own range was stale, so the workspace was still resolving the
  vulnerable 7.4.0) — aligned to `^8.2.0`, which also carries the fixed `uuid`.
- `react-router` (`react-router-dom` v7's CSRF-bypass advisory) needed a full migration, not a
  patch — see the next section.

After any dependency change:

```bash
npm run lint && npm run build && npm run test:e2e
```

### 3a. The react-router migration (done 2026-07-29 — for reference if repeating elsewhere)

`react-router-dom` was discontinued at v7.18.2 — its replacement's fix ships only in
`react-router` v8 directly (the `react-router-dom` package was removed, not just deprecated).
Migrating required, in order:
1. `npm install react-router@^8.3.0 vite@^8.1.5 @vitejs/plugin-react@^5.2.0 react@^19.2.8 react-dom@^19.2.8 -w apps/web` (`react-router` v8's floor: Vite 7+, React 19.2.7+) and `npm uninstall react-router-dom -w apps/web`.
2. Replace every `from "react-router-dom"` with `from "react-router"` — confirmed via the
   installed package's actual export map that every symbol this app uses
   (`createBrowserRouter`, `RouterProvider`, `Navigate`, `Outlet`, `Link`, `NavLink`,
   `useNavigate`, `useSearchParams`) lives in the main `react-router` entry point for a plain
   `createBrowserRouter`/`RouterProvider` SPA like this one — the `react-router/dom` subpath is
   only needed for `HydratedRouter`/SSR-hydration setups, which this app doesn't use.
3. **Clear the stale Vite dependency pre-bundling cache** (`rm -rf apps/web/node_modules/.vite`)
   and restart the dev server. Skipping this produced a hard runtime failure (`require_react is
   not a function`, blank white page) purely from Vite serving an old cached pre-bundle of
   `react-router` compiled against the previous dependency graph — not a real incompatibility.
   `npm run build`/`npm run lint` both passed throughout and gave no signal of this; it only
   showed up as a browser-side `pageerror`, which is why the e2e suite (not just typecheck) is
   the real verification step here. A fresh production Docker build never hits this, since it
   never has a pre-existing `.vite` cache to begin with.
4. Re-ran the full Playwright suite before and after: identical 95 passed / 3 failed (same
   pre-existing platform-admin hamburger-nav flake, confirmed unrelated — see below) both times,
   confirming the migration didn't change runtime behavior.

### 4. Rotate the seeded platform-admin credentials

The control-plane seed creates `platform-admin@timesphere.local` — the single highest-privilege
account on the platform (cross-org access). **Since 2026-10 it no longer has a fixed password:**

- `install.sh` / `install.ps1` generate a strong password, pass it to the seed as
  `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD`, prove a sign-in with it, and print it **once**. Copy it then.
- A manual `npm run control:seed -w apps/api` uses `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD` if you set it;
  otherwise it generates a 24-character password and prints it once.
- An account on a generated password is held at **Change password** — every other console route
  answers `403 PASSWORD_ROTATION_REQUIRED` — until it is rotated (current password re-verified, at
  least 12 characters, every *other* console session signed out). The public dev value
  (`PlatformAdmin@12345`, which `.env.example` passes for dev and CI) is held the same way under
  `NODE_ENV=production`, and an older install still on it keeps the amber **"seeded bootstrap
  password"** banner.
- In production an OWNER or OPERATOR without a second factor is then held at MFA enrolment
  (`PLATFORM_ADMIN_REQUIRE_MFA`, on by default under `NODE_ENV=production`).

Re-running the seed never changes an existing account's password. A lone owner who needs a second
one (two-person approvals need two owners) can add it from the shell — audited, with a generated
password that must be changed:

```bash
npm run control:create-owner -w apps/api -- --email=ops2@example.com --name="Second Owner" --reason="Second approver for two-person actions"
```

It refuses once two active owners exist; after that, owners are added through **Access**, with a
second owner's approval.

### 5. Harden the container images

**Status: done for `apps/api`.** It now creates and runs as an unprivileged `app` user (added
2026-07-29), with `--chown` on every `COPY` and the `/app/uploads` directory pre-created with
correct ownership before `docker-compose.yml`'s `api-uploads` volume ever mounts over it. This
couldn't be built-and-run-verified in the environment this fix was made in (no Docker available
there) — verify with a real `docker compose up --build` before relying on it, in particular that
avatar/attachment uploads still write successfully as the non-root user.

`apps/web`'s Dockerfile was left as-is — it's nginx-based (`nginx:1.27-alpine`), and the official
image already drops its worker processes to an unprivileged `nginx` user by default (only the
master process binds port 80 as root, which is standard/expected). Forcing full non-root there
would mean rebinding to a port ≥1024 and adjusting `nginx.conf.template`, for marginal benefit over what
the base image already does.

### 6. Configure real outbound email

Set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` in `apps/api/.env` (or later,
per-org, from Workspace Settings → Mail server — that takes precedence and needs no restart).
Verify with:

```bash
npm run send-test -w apps/api
```

Without SMTP configured, every email-sending feature still runs but logs to console and records
`FAILED` in `EmailLog` instead of delivering — fine for a trial, not for production.

### 7. Set up database backups

**Not automated by this codebase** — no backup script exists in the repo; this is on you to wire
into your infrastructure. Two databases need independent backup:

- **Control-plane database** (`CONTROL_DATABASE_URL`) — small, but losing it loses the map of
  which physical database belongs to which organization.
- **Every tenant database** — one per organization, physically separate under the
  database-per-tenant model (see [ARCHITECTURE.md § 3.1](ARCHITECTURE.md#31-database-per-tenant-multi-tenancy)).

A minimal cron-based example (adapt paths/retention to your infra):

```bash
# /etc/cron.d/timesphere-backup — nightly dump of every known tenant DB + control plane
0 2 * * * mysqldump --single-transaction -h "$DB_HOST" -u backup_user -p"$BACKUP_PW" timesphere_control | gzip > /backups/control-$(date +\%F).sql.gz
```

For the SaaS shape, drive the tenant list from the control plane itself (`Organization` +
`OrgDatabase.databaseName`) rather than hand-listing databases, so a newly provisioned org is
backed up automatically:

```bash
# scripts/backup-tenants.sh (write this once, adapt to your dump target — S3, local disk, etc.)
mysql -h "$DB_HOST" -u backup_user -p"$BACKUP_PW" timesphere_control -N \
  -e "SELECT databaseName FROM OrgDatabase" | while read -r db; do
    mysqldump --single-transaction -h "$DB_HOST" -u backup_user -p"$BACKUP_PW" "$db" \
      | gzip > "/backups/${db}-$(date +%F).sql.gz"
  done
```

Test a restore before you need one for real.

### 8. Wire real log/error aggregation

**Verified**: `server.ts` catches `unhandledRejection`/`uncaughtException` and every 5xx error
path in `middleware/error.ts` logs via `console.error` — that's the floor, not a production
monitoring solution. Point your container/process stdout at a real aggregator (CloudWatch Logs,
Loki, Datadog, ELK — whatever your infra already uses) and consider wiring a real error tracker
(Sentry, Bugsnag) at the two `process.on(...)` handlers in `server.ts` and in
`middleware/error.ts`'s 5xx branch.

### 9. Scheduled jobs and the API replica count

**No action needed since 2026-10.** Scheduled jobs (SLA sweeps, reminders, digests, IMAP/Telegram
polling) still run as in-process `node-cron` schedules inside every `api` replica, but each tick is
claimed in the control plane first, so it runs **once per deployment** however many replicas there
are (`services/job-claim.service.ts`; [DEPLOYMENT.md § Worker/background processing](DEPLOYMENT.md)).
Before this, every replica ran every job and the Helm defaults (two replicas plus an autoscaler) sent
duplicate reminders, reports and escalations — pinning `api.replicaCount: 1` was the workaround, and
the autoscaler silently overrode it. Scale `api` and `web` as traffic needs.

### 10. Watch the per-tenant connection ceiling (SaaS shape only)

Before onboarding orgs in volume, compare the worst case — 50 cached tenant clients ×
`TENANT_DB_CONNECTION_LIMIT` × API replicas — with your MySQL server's `max_connections`, and add
`SHOW STATUS LIKE 'Threads_connected'` to your monitoring. The arithmetic and why the ceiling exists:
[DEPLOYMENT.md § Operational notes specific to this shape](DEPLOYMENT.md#operational-notes-specific-to-this-shape).

### 11. Get a fresh green test run

Run the gates against the exact commit you are about to deploy:

```bash
npm run lint && npm run build          # typecheck + SonarJS rules (0 errors, ratchet holds), then a production build
npm test                               # both unit suites (api, then web) — no database needed
npm run test:integration -w apps/api   # a real throwaway MySQL, created, migrated, seeded and dropped per run
npm run test:e2e                       # Playwright, every project (it starts the dev servers if none are running)
```

CI runs the same gates on every push, so a green run on `main` for that commit is normally the
evidence; run them yourself when deploying a commit CI has not tested. What each tier covers, which
pushes get which Playwright projects, and the traps that make a failure look like something else —
the face-verification gate answering 428, the login rate limiter, a host machine that slept
mid-run — are in [CONTRIBUTING.md § Testing](../CONTRIBUTING.md#testing). The history of how the
suites reached their current shape is in [ENGINEERING_LOG.md](ENGINEERING_LOG.md).

---

## Part 2 — Bringing a new organization online

Which path applies depends on which shape you deployed (see
[docs/DEPLOYMENT.md](DEPLOYMENT.md) for the full explanation of both):

### Shape 1 — On-prem / single-org (this deployment IS the one organization)

There's no separate "provision an org" step — `DEFAULT_ORG_SLUG` is the only organization there
will ever be. To get a clean production org instead of the seeded demo data:

1. **Don't run the plain `npm run seed`** if you want zero demo data — it always creates the
   demo admin (`superadmin@timesheet.local` / `Admin@12345`) plus a demo manager, employee, and
   sample project (`includeDemoData` defaults to `true`, and the CLI entry point takes no flags
   to override that). Instead, write a tiny one-off script that calls the same reusable function
   directly with your real admin's details:

   ```ts
   // scripts/seed-production.ts (adapt paths, run once with tsx)
   import { PrismaClient } from "@prisma/client";
   import { seedTenant } from "../prisma/seed.js";

   const prisma = new PrismaClient();
   await seedTenant(prisma, {
     adminEmail: "admin@yourcompany.com",
     adminName: "Real Admin Name",
     adminPassword: "<a real generated password, changed on first login>",
     includeDemoData: false
   });
   await prisma.$disconnect();
   ```

   Run it once against the production `DATABASE_URL`, after `npm run db:migrate` /
   `npm run control:migrate` and `npm run control:seed` (the control-plane seed is org-agnostic —
   run it as-is).

2. Log in as the real admin you just created and configure everything from the UI — see
   [docs/INSTALLATION.md § Configuring things after install](INSTALLATION.md#configuring-things-after-install)
   for the full table (SMTP, AI, SSO, ticketing, integrations). Continue to
   [Part 3 — per-org configuration](#part-3--per-org-configuration-walkthrough) below.

3. If you already ran the default seed and have demo data live: delete the demo manager/employee
   users and sample project from the Users/Projects pages, and change the seeded admin's email +
   password from the Profile page (or create your real admin fresh and deactivate the demo one).

### Shape 2 — SaaS multi-org (adding one more organization to a live platform)

Prerequisite: the platform itself is already set up per
[docs/DEPLOYMENT.md § Shape 2 one-time platform setup](DEPLOYMENT.md#shape-2--saas-multi-org) —
control plane migrated/seeded, DNS wildcard routing working, `TENANT_DB_PROVISION_BASE_URL` set
if you want in-console automation.

1. **Log into `/platform-admin`** with your (already-rotated, per Part 1 step 4) platform-admin
   credentials.
2. **Organizations → New organization** — this calls `POST /api/platform-admin/organizations`,
   creating a control-plane row in `PROVISIONING` status with a name, subdomain slug, and plan
   tier (`STARTER`/`TEAM`/`ENTERPRISE`). No physical database exists yet.
3. **Provision** (the button appears on any `PROVISIONING` org) — calls
   `POST /api/platform-admin/organizations/:id/provision`, which (see
   `services/provisioning.service.ts`):
   - physically creates the tenant's MySQL database (`CREATE DATABASE IF NOT EXISTS`),
   - runs every pending migration against it (`prisma migrate deploy`),
   - seeds baseline roles/permissions/ticket-types/settings **with no demo data**
     (`includeDemoData: false` is hardcoded on this path — you get a clean org automatically,
     unlike Shape 1's default seed),
   - creates the one real admin account you specify (email/name/password in the provision form),
   - flips the org to `ACTIVE`.

   Every step is safe to retry — if it fails partway (bad DSN, transient connection issue), fix
   the underlying problem and click Provision again; the org stays visibly `PROVISIONING` until
   every step succeeds.
4. The org is immediately reachable at `<slug>.<ROOT_DOMAIN>` — **provided `ROOT_DOMAIN` is set**
   (forwarded by both compose files and the Helm chart's `env.rootDomain`) and DNS has a wildcard
   `*.<ROOT_DOMAIN>` record pointing at the platform with a wildcard TLS certificate. Without
   `ROOT_DOMAIN`, every subdomain resolves to `DEFAULT_ORG_SLUG` and the new customer sees the
   wrong workspace's login page. **And the `Host` header has to reach the API unchanged** — the
   workspace is derived from it and from nothing else, so a reverse proxy that rewrites it (nginx's
   `proxy_pass` does by default; so do CloudFront and Azure Front Door) sends every customer to
   `DEFAULT_ORG_SLUG` without any error appearing anywhere. Verify with one authenticated request
   rather than by reading a config file: `GET /api/platform-admin/routing` reports, under
   `observed.resolvedSlug`, the workspace the header that actually arrived resolves to. See
   [DEPLOYMENT.md § The Host header has to survive every hop](DEPLOYMENT.md#the-host-header-has-to-survive-every-hop). On success the console shows the workspace URL and **the new
   admin receives the welcome email** (the same one self-serve signup sends) with that link — so
   hand over only the initial password, out-of-band, and have them change it on first login.
   Outbound mail must be working for that email to arrive (Part 1 step 6); the tenant's own
   Forgot-password flow depends on the same SMTP.
5. If `TENANT_DB_PROVISION_BASE_URL` isn't configured (deliberate for infra that provisions tenant
   databases via a separate ops process — e.g. per-customer servers for data residency), follow
   [docs/DEPLOYMENT.md § Provisioning without the automation](DEPLOYMENT.md#provisioning-without-the-automation)
   instead — same steps, done by hand.
6. **Set the org's plan tier limits** if this customer needs something other than the tier
   default — `/platform-admin` → Plan tiers (seat count, AI monthly budget, allowed SSO
   providers, allowed chat platforms). This is also where you'd configure Stripe self-serve
   billing (`billing.controller.ts`) if the customer is upgrading via checkout rather than a
   manually assigned tier — note (per `docs/ROADMAP.md`) the billing flow's live-Stripe path has
   only been tested via signature simulation, not a real Stripe account; do a real test purchase
   in Stripe's test mode before relying on it for a paying customer.

### Letting customers create their own workspace (self-serve signup)

Off until you turn it on: **Platform admin → Settings → Signup → Allow self-serve signup**. It also
needs `ROOT_DOMAIN` (each workspace gets its own address) and `TENANT_DB_PROVISION_BASE_URL` (the
server new databases are created on); the card says plainly when the first is missing.

- **Who may sign up:** company addresses only. Personal and throwaway providers are refused already;
  add any others (a regional provider, a competitor) in **Also refuse these email domains**.
- **What you hear:** by default **one summary a day** (08:15) listing new workspaces, failed signups
  and join requests — or one email per signup, or nothing (**Notify** on the same card). It goes to the
  alert recipients on the Alerts page, or every active platform admin if none are set. Whatever the
  setting except Off, a second provisioning failure inside an hour emails at once. Everything also
  appears in Overview → Recent activity and on **Growth → Signups**. A **failed** signup means a person
  proved their address, filled in the form and was shown an error: write to them the same day.
- **One workspace per company.** The second person from a company whose domain a workspace already
  holds is offered a **request to join** it instead of a new workspace; that workspace's admins decide on
  User management → Requests. Requests expire after **Join requests expire after** days (14 by
  default) and are only taken while the workspace is ACTIVE.

#### Company domains

**Tenants → Company domains** lists which workspace each company's people are sent to. A self-serve
signup claims its domain; a workspace you provision in the console does not, until you assign one.

- **After upgrading to the release that introduced this, run *Backfill from signup emails* once.**
  Preview first: it claims each domain that exactly one workspace's owner address implies, and lists
  every domain two workspaces share as a **conflict**. Nothing picks a side — a wrong guess sends the
  next person from that company into the other company's workspace. Settle each conflict with
  **Assign a domain** once you know which workspace is whose.
- **Reassign** and **Release** ask for a reason; the audit row keeps it and the previous holder.
  Release when a company leaves, or when a domain was claimed by the wrong workspace.
- Claims are on the company domain only: `eng.acme.com` is covered by `acme.com`. Personal providers
  can never be claimed. Proving a domain by DNS is a later phase; until then every claim reads
  *Unverified*.

---

## Part 3 — Per-org configuration walkthrough

Once an admin account exists (either path above), everything else is a UI action from that
account — no code change or redeploy, no server restart, takes effect on the next request. Full
reference table: [docs/INSTALLATION.md § Configuring things after install](INSTALLATION.md#configuring-things-after-install).
The essentials for a production go-live, roughly in the order a new customer would want them:

1. **Change/verify the admin password** (Profile page) if you set a temporary one.
2. **Mail server** (Workspace Settings → Mail server) — real SMTP, "Test connection" button.
3. **Email templates** (sidebar) — brand the 35 built-in templates if needed, or leave defaults.
4. **Ticketing** (Workspace Settings → Ticketing) — ticket types, labels, SLA hours per priority.
5. **Users** — invite the real team (or bulk-upload CSV), set roles/managers.
6. **Single sign-on** (Workspace Settings → Single sign-on), if the customer wants
   Google/Microsoft/SAML/LDAP instead of local passwords — capped by plan tier
   (`PlanTierLimit.allowedSsoProviders`).
7. **AI** (Workspace Settings → AI) — BYOK: their own Anthropic or OpenAI-compatible key, budget
   ceiling, which AI features are on. Everything stays off/inert with no key configured.
8. **Integrations** as needed — Email intake (IMAP), Chat integrations (Slack/Teams/Google
   Chat/Telegram), Security & DevOps ingestion (SAST/DAST/SSAT/SSCT webhooks + Git provider
   OAuth), Public API keys/webhooks. Each is independently opt-in; skip what the customer doesn't
   use.
9. **Plan tier / billing**, if not already set during provisioning above.

---

## Go-live verification checklist

Run through this for the specific organization before calling it live:

- [ ] `curl https://<your-domain>/health` returns `{"ok":true}`
- [ ] Login works for the real admin account (not the demo/seed one)
- [ ] `npm run send-test -w apps/api` (or the in-UI "Test connection") confirms real email delivery
- [ ] A test ticket/timesheet round-trips end-to-end (create → notify → approve/resolve)
- [ ] TLS certificate is valid and auto-renewing (cert-manager, or your reverse proxy's renewal)
- [ ] **Multi-workspace only:** the API booted with no `[config]` ERROR lines — they name the exact
      variable to change, and one of them catches a hostname that would 404 every request
- [ ] **Multi-workspace only:** `GET /api/platform-admin/routing` through the real load balancer
      shows `observed.resolvedSlug` equal to the workspace you aimed the request at (proves no proxy
      rewrote `Host`), and a second workspace's subdomain resolves to *its* slug, not the default
- [ ] Backups are actually running and a test restore has been performed at least once
- [ ] Platform-admin credentials have been rotated from the seeded defaults
- [ ] `npm audit` has been re-run and reviewed since the last dependency update
- [ ] Only one `api` replica is running cron workers (or you've accepted the duplicate-job
      tradeoff of running more)
- [ ] Log output is flowing into your aggregator, not just container stdout nobody reads

---

## Ongoing operations

- **New migrations reaching every tenant** (SaaS shape) — after merging a schema migration:
  `npm run migrate:tenants -w apps/api` (see `scripts/migrate-all-tenants.ts`) fans it out across
  every `ACTIVE`/`SUSPENDED` org's own database, isolating one org's failure from the rest.
- **Re-check `npm audit`** on a recurring cadence (monthly is reasonable) — advisories publish
  against already-pinned versions even without you changing code.
- **Re-run `npm run test:e2e`** before any production deploy that touches auth, tickets,
  timesheets, or settings — the suite covers those flows for Shape 1; it does not exercise
  multi-org isolation/SSO routing/provisioning (verified manually per `docs/DEPLOYMENT.md`'s own
  note).
- **Monitor MySQL `max_connections`** against `MAX_CACHED_CLIENTS × PER_TENANT_CONNECTION_LIMIT`
  as organization count grows (SaaS shape).
- **The trial retention programme** (SaaS shape, 3.12.0) — `/platform-admin` → **Trial retention**.
  A self-serve trial that lapses is written to on day 10 of the trial (a check-in with a feedback
  form), the day it ends, and then 30, 60, 80 and 90 days later; after the retention window
  (90 days by default) the workspace and its database are **deleted permanently** unless the
  customer converted, restored it from one of those emails, or a platform admin put it on hold.
  Before you let it run against real customers:
  - Configure the platform relay under **Settings → Mail server** (or `SMTP_*` in `apps/api/.env`).
    Without one, every retention email is recorded as SKIPPED and nobody is warned before deletion.
  - Decide the window and set **Snapshot directory** if you want a `mysqldump` taken before each
    drop. It is best-effort: a missing `mysqldump` binary is recorded, never fatal, and never blocks
    the deletion. Set `MYSQLDUMP_PATH` if the binary is not on the API host's `PATH`.
  - **Auto-delete after the window** is the kill switch. Off means reminders still go and nothing is
    ever dropped automatically — a reasonable first posture for a new deployment.
  - Use **Dry run now** and the simulated-date control to see what the 09:30 pass would do before
    trusting it. A simulated date can never send or delete.
  - A paying customer is never deleted, whatever the clock says: converting nulls `trialTier`, and
    the schedule stops. Deletion also refuses any workspace that is not GRACE or SUSPENDED.
- **Managed backups** (3.14.0) — `/platform-admin` → **Backups → Scheduled backups**. Per-tier
  ceilings (Starter none, Team weekly, Enterprise daily), per-workspace schedules, destinations
  (S3-compatible, Azure Blob, Google Drive, OneDrive/SharePoint, SFTP, or a local directory),
  retention by count, age or GFS rotation, alerts by email/Slack/webhook, and Enterprise test
  restores. Prerequisites on the API host: `mysqldump` for backups and `mysql` for restores — set
  `MYSQLDUMP_PATH` / `MYSQL_PATH` when they are not on `PATH`; the page probes for both and says
  which is missing. The scheduler runs at five past every hour and clamps every policy to its tier
  on each pass, so a downgraded customer's cadence lowers itself without an edit. Nothing is ever
  deleted before a newer backup has succeeded, and the newest is never pruned.
- **Retention snapshots, and restoring one** (SaaS shape, 3.13.0) — `/platform-admin` → **Backups**.
  Every snapshot the retention programme took before deleting a workspace, with its size, its
  workspace and whether it can be restored; the page also probes the API host for `mysqldump` and
  `mysql` and says so, because a snapshot is best-effort and an empty directory usually means a
  missing binary rather than a quiet policy. **Download** hands over the `.sql`; **Restore**
  recreates the database, imports the dump, re-registers an encrypted DSN and reopens the workspace
  in `GRACE` with its deletion held. A restore is refused where the organization still has a
  database, so a live tenant can never be overwritten. Run `npm run db:migrate:tenants` after a
  restore if the platform has moved on since the dump was taken. Nothing prunes the directory:
  deleting the last copy of a customer's data is never automatic.
- **Rescuing a locked-out workspace administrator** (SaaS shape) — when a customer's only super
  admin cannot sign in and their `/forgot-password` is no use (their SMTP is broken, or the mailbox
  is what they lost): `/platform-admin` → Organizations → **Rescue admin** on the ACTIVE row →
  enter the super admin's email. A one-time password is generated (never chosen by you), shown
  **once**, stored only as a hash, and never mailed or logged; every session of that account is
  revoked and the tenant app asks them to choose their own password at sign-in. The reset is
  written to the customer's own audit log attributed to your platform-admin account. Only an
  existing `SUPER_ADMIN` of that workspace can be reset this way — employees are reset by their
  own admins. Confirm who is asking through a channel you trust before you do it. If the lockout
  is an SSO misconfiguration instead, **Restore password login** (`POST
  /organizations/:id/restore-password-login`) turns password sign-in back on without touching
  anyone's password.
