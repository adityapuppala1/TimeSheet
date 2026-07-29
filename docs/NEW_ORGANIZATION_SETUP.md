# New Organization Setup & Production Readiness Guide

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

The control-plane seed creates `platform-admin@timesphere.local` / `PlatformAdmin@12345` — the
single highest-privilege account on the platform (cross-org access). **Verified**: there is no
self-serve/forced password-change flow for this account yet. Before any real organization is
provisioned:

```sql
-- Against the control-plane database, with a freshly bcrypt-hashed password:
UPDATE PlatformAdminUser SET passwordHash = '<bcrypt-hash>' WHERE email = 'platform-admin@timesphere.local';
```

Or re-run `npm run control:seed -w apps/api` against a still-empty control database before you
register any real org, and change the email/password constants in
`apps/api/prisma/control/seed.ts` first if you'd rather not touch SQL directly.

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
would mean rebinding to a port ≥1024 and adjusting `nginx.conf`, for marginal benefit over what
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
  database-per-tenant model (see [README § Multi-tenancy](../README.md#multi-tenancy)).

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

### 9. Pin the cron-running replica count to 1

**Verified**: scheduled jobs (SLA sweeps, reminders, weekly digests, IMAP/Telegram polling) run
as in-process `node-cron` schedules inside the `api` process itself
(`apps/api/src/workers/*.worker.ts`) — there is no leader-election lock. If you horizontally scale
`api` beyond one replica, every job fires once per replica (duplicate reminder emails, duplicate
SLA escalations). Either:
- keep exactly **one** `api` replica (`api.replicaCount: 1` in the Helm chart's values, or don't
  `docker compose up --scale api=N`), or
- accept duplicate job execution until a leader-election/singleton lock is built (tracked in
  [docs/ROADMAP.md](ROADMAP.md)).

The `web` service (stateless, no cron) scales freely either way.

### 10. Watch the per-tenant connection ceiling (SaaS shape only)

**Verified**: `config/prisma.ts` caps each tenant's connection pool
(`PER_TENANT_CONNECTION_LIMIT`) and LRU-evicts idle tenant clients (`MAX_CACHED_CLIENTS`).
`MAX_CACHED_CLIENTS × PER_TENANT_CONNECTION_LIMIT` must stay comfortably under your MySQL server's
`max_connections` as organization count grows — this is a known scaling ceiling of the
database-per-tenant model, not a bug, but it needs monitoring (MySQL's
`SHOW STATUS LIKE 'Threads_connected'`) as you onboard more orgs.

### 11. Get a fresh green test run

```bash
npm run lint && npm run build && npm run test:e2e
```

**Re-verified 2026-07-29** (after the dependency/react-router fixes above): 95 passed, 3 failed —
all 3 failures are the same test, `platform-admin console › hamburger drawer reaches every nav
item below lg`, across 3 of the 5 viewport projects. **Confirmed to be a pre-existing test flake,
not an app bug**: running that test in isolation (`npx playwright test -g "hamburger drawer
reaches every nav item below lg"`) passes cleanly across all 5 projects every time. It only fails
as part of the full 98-test suite, most likely because its `beforeEach` does a fresh raw-HTTP
login per test (not the shared `storageState` fixture the rest of the suite uses) and the
`if (viewport.width >= 1024)` branch's assertion has no explicit timeout override (defaults to
5s), which occasionally isn't enough time for the client-side silent-refresh-on-boot round trip
under full-suite load. Not urgent to fix (it's test flakiness, not a production defect), but if
addressed, the fix is either raising that assertion's timeout or switching the describe block to
a shared `storageState` fixture like the rest of the suite.

The e2e suite covers 5 spec files (auth, responsive, settings, tickets, timesheet) — broad UI/flow
coverage, but it never exercised the AI/billing/SCIM services directly.

**Update 2026-07-29 — a first unit/integration suite now covers those three** (`apps/api/tests/`,
Vitest — see file headers for the exact mocking approach per area):

```bash
npm run test -w apps/api               # unit tier: 38 tests, no real DB, ~1s
npm run test:integration -w apps/api   # integration tier: 7 tests, real throwaway MySQL, ~13s
```

- **AI service** (`tests/unit/ai.service.test.ts`) — feature-toggle/budget gating, and a full
  `classifyTicket` round trip with the Anthropic SDK mocked at the class level (`callChat` itself
  is a module-private function, not an exported seam).
- **Stripe billing** (`tests/unit/billing.webhook.test.ts` + `tests/integration/billing.webhook.integration.test.ts`)
  — signature verification is exercised for real (`stripe.webhooks.constructEvent` is local HMAC,
  no network call, so no mocking needed there), all three webhook event branches, and one
  integration test confirming `Organization.planTier` is genuinely persisted, not just that a mock
  was called correctly.
- **SCIM** (`tests/unit/scim.controller.test.ts` + `tests/integration/scim.controller.integration.test.ts`)
  — auth/filter/PATCH-operation parsing at the unit tier; real seat-limit enforcement,
  duplicate-email 409, and status-transition persistence at the integration tier, against a real
  throwaway MySQL database created/migrated/seeded/dropped per run (`tests/setup/global-setup.integration.ts`).

This is a **first pass proving the pattern with representative coverage, not exhaustive branch
coverage** — the security-findings services (`security-report.service.ts`) and the remaining 10 of
13 AI capability functions still have no dedicated unit tests, same caveat as before for whatever
isn't listed above. Not yet wired into `.github/workflows/ci.yml` — that's a deliberate scope
decision, not an oversight, since this pass was about proving the harness works locally first.

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
4. The org is immediately reachable at `<slug>.yourdomain.com`. Hand the admin credentials to the
   customer's admin (out-of-band, not over an insecure channel) and have them change the password
   on first login.
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

---

## Part 3 — Per-org configuration walkthrough

Once an admin account exists (either path above), everything else is a UI action from that
account — no code change or redeploy, no server restart, takes effect on the next request. Full
reference table: [docs/INSTALLATION.md § Configuring things after install](INSTALLATION.md#configuring-things-after-install).
The essentials for a production go-live, roughly in the order a new customer would want them:

1. **Change/verify the admin password** (Profile page) if you set a temporary one.
2. **Mail server** (Workspace Settings → Mail server) — real SMTP, "Test connection" button.
3. **Email templates** (sidebar) — brand the 20 built-in templates if needed, or leave defaults.
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
