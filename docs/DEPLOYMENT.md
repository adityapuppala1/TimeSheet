# Deployment Guide

TimeSphere runs as **one codebase, two deployment shapes**:

1. **On-prem / single-org** — one company, one database, no subdomain routing to think about.
   This is `docker-compose.yml` as-is.
2. **SaaS multi-org** — many organizations on one platform, each with its own physically
   separate database, its own SSO configuration, and its own plan tier — administered from a
   separate `/platform-admin` console.

Both shapes share every controller, service, and UI page in `apps/api`/`apps/web`. What differs
is the **control plane** (a small second database — org registry, per-org database connections,
SSO config, plan tiers, platform-admin accounts — see `apps/api/prisma/control/schema.prisma`)
and whether more than one `Organization` row exists in it. Pick the section below that matches
what you're deploying.

Once the platform itself is deployed, see
[docs/NEW_ORGANIZATION_SETUP.md](NEW_ORGANIZATION_SETUP.md) for the production-hardening
checklist and the repeatable runbook for bringing a real organization online.

## Three ways to run it

Fastest first. Each is a complete deployment rather than a stepping stone, and each has its own
section below.

| | Command | What you get |
|---|---|---|
| **1. One-click installer** (Docker is the only prerequisite) | `./install.sh` (Linux/macOS) · `.\install.cmd` (Windows) | The Compose stack with a generated root `.env`, a health-checked boot and the one-time seed. [One-click install](#one-click-install-fastest-path--docker-required) |
| **2. Docker Compose by hand** | `docker compose up --build` | The same stack with every value under your control. [Manual setup](#manual-setup), step 5, and the variables under [Required at boot](#required-at-boot) |
| **3. Kubernetes (Helm chart)** | `helm install my-release deploy/helm/timesphere -f my-values.yaml` | Both deployment shapes through chart values, and the only path with real autoscaling. [Kubernetes deployment](#kubernetes-deployment) |

---

## Shape 1 — On-prem / single-org

The simplest possible deployment: one company, one MySQL database, `DEFAULT_ORG_SLUG` as the
only organization there will ever be. No subdomain routing, no platform-admin console, no
SSO-per-org configuration needed (though SSO still works if you want it — it's just one org's
worth of it).

### One-click install (fastest path — Docker required)

`install.sh` (Linux/macOS) / `install.ps1` (Windows) automate everything below: they check for
Docker + the Compose plugin, generate a root `.env` with strong random secrets (never
overwriting one that already exists), run `docker compose up -d --build`, wait for the API's
health check, then run the one-time seed.

```bash
./install.sh          # Linux/macOS (a ZIP download loses the +x bit; a clone keeps it)
```

```powershell
.\install.cmd          # Windows — the .cmd launcher runs install.ps1 with a process-scoped
                       # execution-policy bypass, so the default Restricted policy can't block it
```

Both scripts are read-only about anything outside this repo — they never install Docker itself,
just tell you where to get it if it's missing. Re-running either script against an
already-configured deployment just brings the stack up again; it won't regenerate secrets or
touch an existing `.env`. Falls back to the manual steps below if you'd rather control each step
(a real production rollout, a non-Docker deploy target, etc.).

### Bringing your own MySQL server

If you don't want the bundled `mysql` container — you already run a real MySQL server (an
on-prem box, RDS, Cloud SQL, PlanetScale, etc.) and want the app containers to use it instead —
both installers ask about this up front:

```
Where should the database live?
  [1] Set one up for me in Docker (default — fastest for a trial, nothing else to configure)
  [2] I already have a MySQL server I want to use (a real on-prem box, RDS, Cloud SQL, etc.)
```

Choosing **[2]** prompts for host, port, username, password, and the two database names (tenant +
control-plane), then:

- Writes `DATABASE_URL`/`CONTROL_DATABASE_URL` in `.env` pointing at your server instead of the
  bundled container — the username/password are URL-encoded automatically, so a password
  containing `@`, `:`, `/`, `#`, or `%` won't corrupt the connection string.
- Uses `docker-compose.external-db.yml` instead of `docker-compose.yml` — the same `api`/`web`
  services, minus the `mysql` service and its `depends_on` (there's nothing bundled to depend on).
  The installer tracks this choice and keeps using the right file on every subsequent step
  (health check, restart, seed) automatically.
- Re-running the installer later against that same `.env` recognizes the choice automatically
  (by checking whether `MYSQL_ROOT_PASSWORD` — only ever written by the bundled-MySQL path — is
  present) and keeps using `docker-compose.external-db.yml` without re-prompting.

Two things this doesn't do for you, on purpose: it doesn't create the databases on your server if
your account lacks `CREATE DATABASE` privileges (the app's own migration step tries
`CREATE DATABASE IF NOT EXISTS` and will fail clearly if it can't — pre-create the two databases
yourself in that case), and it doesn't touch your server's own backup/networking/firewall
configuration — that's on you, same as any other production database you already operate.

If you'd rather skip Docker for the app containers too, the [manual install](#manual-setup)
section below already works with any MySQL server by design — this installer prompt exists
specifically for "I want Docker for the app, but my own database."

### Manual setup

1. Provision one MySQL 8 server, reachable from wherever the API runs.
2. Copy `.env.example` to `apps/api/.env` and fill in:
   - `DATABASE_URL` — this org's one tenant database.
   - `CONTROL_DATABASE_URL` — yes, still required even for a single org (see "Why a control
     plane exists even here" below) — a second, much smaller database on the same server works fine.
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `PLATFORM_ADMIN_JWT_SECRET` — three distinct
     long random strings. Production boot refuses weak/placeholder values for the first two;
     generate all three properly (`openssl rand -base64 48`).
   - `ENCRYPTION_KEY` — 64 hex chars (`openssl rand -hex 32`).
   - `WEB_ORIGIN` / `APP_BASE_URL` — your real domain.
   - Leave `TENANT_DB_PROVISION_BASE_URL` unset — this deployment shape never provisions a
     second organization, so in-app provisioning isn't relevant. The template ships it *set* (for
     local development), so blank it here. Self-serve signup is also refused on this shape
     regardless — it needs `ROOT_DOMAIN` and the console's switch — but a provisioning server that
     is not needed is still one credential fewer (see the
     [reference row](#core-settings-with-defaults)).
3. `npm ci && npm run build`.
4. Run migrations + seed the control plane and the one tenant:
   ```bash
   npm run db:generate -w apps/api
   npm run db:migrate -w apps/api        # or: prisma migrate deploy in production
   npm run control:generate -w apps/api
   npm run control:migrate -w apps/api
   npm run control:seed -w apps/api      # registers DEFAULT_ORG_SLUG pointing at DATABASE_URL
   npm run seed -w apps/api              # seeds roles/permissions/demo data into that one tenant DB
   ```
5. Deploy `apps/api/dist` behind HTTPS, `apps/web/dist` behind a static host/Nginx, or just run
   `docker compose up --build` — its `api` service already runs both schemas' `prisma migrate
   deploy` automatically on every boot (see `docker-compose.yml`'s `command:`). Compose does
   **not** read `apps/api/.env`: it takes values from your shell or a `.env` file next to
   `docker-compose.yml`, and refuses to start without the variables listed under
   [Required at boot](#required-at-boot).
6. **Seed once, after first boot** — migrations run automatically every restart, but seeding
   (roles/permissions, the control-plane plan tiers + platform-admin account, this org's demo
   data) is a one-time bootstrap step, run from your own machine against the database directly
   rather than baked into the container's startup command (so it never re-runs against live
   data). `docker-compose.yml` exposes MySQL on host port `3307`, so point `DATABASE_URL`/
   `CONTROL_DATABASE_URL` at `localhost:3307` locally and run the same `control:seed`/`seed`
   commands from step 4.
7. Configure SMTP (`SMTP_*`) for real email delivery, enable MySQL backups, and point your log
   aggregator at the container/process output.
8. If you plan to enable **face verification**, note that it writes to `UPLOAD_DIR/face/` — the
   same volume as other uploads, so back it up (or deliberately don't, since it's biometric
   data with its own retention policy) and make sure the deployment is served over HTTPS, as
   browsers refuse camera access on an insecure origin. See
   [docs/FACE_VERIFICATION.md](FACE_VERIFICATION.md).

### Turning on multi-org routing (`ROOT_DOMAIN`)

This is the one environment variable whose consequences are invisible until traffic arrives, so it
has a read-only dry run: **Platform admin → Organizations** calls `GET /api/platform-admin/routing`,
which reports the mode this deployment is in, what the bare domain currently serves, the URL each
workspace would be reachable at if `ROOT_DOMAIN` were set, and — under `observed` — what the `Host`
header of *that request* actually resolved to after passing through your proxies.

> **Leaving it unset can 404 your entire deployment.** With no `ROOT_DOMAIN`, the workspace is taken
> from the **first DNS label** of the hostname. That is right for `acme.example.com` and wrong for
> `timesheet.company.com`, which is what a real deployment's hostname looks like: it searches for a
> workspace called `timesheet`, finds none, and answers `404 Unknown workspace.` to **every request,
> including the login page**. Measured against a running server:
>
> ```
> Host: timesheet.company.com  ->  404 Unknown workspace.
> Host: hics.com.sg            ->  404 Unknown workspace.     # three labels, no subdomain at all
> Host: localhost              ->  200
> ```
>
> Nothing in the logs explains it, because from the router's point of view nothing went wrong — it
> was asked for a workspace that does not exist. Two hostnames are safe: anything with **two labels**
> (`example.com`), and a bare IP. Everything else needs `ROOT_DOMAIN` set, or an organization whose
> slug happens to equal that first label.
>
> The API now says so at boot rather than letting you find out. `config/deployment-check.ts`
> prints an `ERROR` naming the exact value to set, and it also catches the other three ways this goes
> wrong: more than one `ACTIVE` organization with no `ROOT_DOMAIN` (the extra workspaces have no
> address anyone can reach), a `ROOT_DOMAIN` carrying a scheme/port/path (it matches nothing while
> the readout reports multi-org mode), and an `APP_BASE_URL` that is not under the root at all.

Two things change the moment it is set, and both are correct and both surprise people:

1. **The slug is derived by stripping the suffix**, not by counting DNS labels. This is the fix for
   `example.co.uk` being read as a workspace called `example` — but it also means every workspace
   must already resolve under that root. Check the readout before, not after.
2. **The bare domain stops serving `DEFAULT_ORG_SLUG`** and starts serving the workspace finder.
   Until now `timesphere.app` quietly served one specific customer's branded login page to anybody
   who typed the domain without a subdomain; afterwards it serves a "find your workspace" screen.
   If anyone has bookmarked the apex expecting a particular workspace, they will notice.

Order of operations for an existing deployment:

```bash
# 1. Point DNS at this deployment first — a wildcard, so every existing slug resolves.
#    *.timesphere.app  ->  <this deployment>
# 2. Confirm the certificate covers the wildcard, or every workspace gets a TLS warning.
# 3. Read the dry run: Platform admin -> Organizations, and check every listed
#    `urlIfRootDomainSet` is a hostname that already answers.
# 4. Only then:
ROOT_DOMAIN="timesphere.app"
# 5. Restart, and re-read the routing page — `mode` should now say multi-org.
```

**Custom domains** are managed per workspace from the same page (**Domains** on any active
organization). Verification is a DNS TXT record at `_timesphere-verify.<domain>`; an unverified row
routes nothing, so adding one is safe. Note what verification does and does not prove: it confirms
the customer owns the domain. They still need a CNAME or A record pointing it at this deployment
before traffic arrives.

### Why a control plane exists even in this single-org shape

Every request still resolves "which organization" before touching `prisma` — see
`middleware/tenant.ts`. With no subdomain configured, it falls back to `DEFAULT_ORG_SLUG` every
time, which is a no-op in practice: one `Organization` row, one `OrgDatabase` row pointing at
`DATABASE_URL`, so this deployment behaves exactly like it always did pre-multi-tenancy. The
alternative — a special-cased "single-tenant mode" that skips resolution entirely — would mean
maintaining two different code paths through every controller instead of one, for a cost that's
already effectively zero (one extra `Organization`/`OrgDatabase` row lookup per request).

You never need the `/platform-admin` console for this shape — the `PlatformAdminUser` seeded by
`control:seed` exists, but there's only ever the one org to manage, and its plan tier defaults to
`ENTERPRISE` (unlimited seats, full AI budget, all three SSO providers) specifically so a
self-hosted deployment is never artificially capped by plan-tier logic meant for paying SaaS
customers.

---

## Environment profiles — local / UAT / production

One checkout can be pointed at different environments without ever editing `.env` back and
forth. `APP_ENV` selects which profile file configures the API:

| Profile | Command sets | File loaded | Falls back to |
|---|---|---|---|
| local (default) | *(nothing)* | `apps/api/.env` | — |
| UAT | `APP_ENV=uat` | `apps/api/.env.uat` | `.env` for unset keys |
| production | `APP_ENV=production` | `apps/api/.env.production` | `.env` for unset keys |

**Setup, once per profile:** copy the committed template and fill it in — the templates carry
per-environment guidance (why UAT gets its own databases and secrets, why production never uses
`APP_BASE_URL="auto"`):

```bash
cp apps/api/.env.uat.example        apps/api/.env.uat
cp apps/api/.env.production.example apps/api/.env.production
```

Real profile files are git-ignored by pattern (`.env.*` except `*.example`) — credentials can't
land in a commit. Only keys that DIFFER need to be in a profile; everything else falls back to
`.env`, and real shell environment variables still beat both.

**Running each profile:**

```bash
# Linux/macOS (dev server or built app)
npm run dev -w apps/api                      # local
APP_ENV=uat        npm run dev -w apps/api   # UAT
APP_ENV=production npm run dev -w apps/api   # production config, e.g. a config rehearsal
```

```powershell
# Windows PowerShell
npm run dev -w apps/api                                  # local
$env:APP_ENV = "uat";        npm run dev -w apps/api     # UAT
$env:APP_ENV = "production"; npm run dev -w apps/api     # production config
# ($env:APP_ENV lasts for the terminal session — Remove-Item Env:APP_ENV to go back to local)
```

A named profile whose file is missing is a **hard boot failure** naming the fix — an operator
who asked for UAT and silently got local database credentials would be debugging the wrong
universe. The boot log always states which profile loaded.

**Docker deployments are different on purpose:** a Compose stack installed via
`install.sh`/`install.cmd` reads the ROOT `.env` the installer generated on that machine —
each environment is its own machine (or its own checkout) with its own root `.env`, which is
already a complete environment profile. `APP_ENV` matters when running the API process directly
(manual/bare-metal deploys, or pointing a workstation at UAT to reproduce a bug). The web dev
server has its own equivalent if you ever need it: Vite's native modes (`vite --mode uat` loads
`apps/web/.env.uat`).

## Shape 2 — SaaS multi-org

One platform, many organizations, each with a fully separate physical database. New in this
shape: subdomain-based routing, the `/platform-admin` console, and (optionally) automated
provisioning of new organizations from that console.

### One-time platform setup

1. Provision the **control-plane database** (small — org metadata only, never ticket/timesheet
   content) and, if you want in-console provisioning automation, a MySQL server new tenant
   databases will be created on (this can be the same server or a pool of a few known servers —
   see `TENANT_DB_PROVISION_BASE_URL` below).
2. Set env vars (`apps/api/.env` for a single-process deployment, or your orchestrator's secret
   store):
   - `CONTROL_DATABASE_URL` — the control-plane database.
   - `DATABASE_URL` — still required by the Zod schema at boot, but functionally unused once
     more than one org exists; point it at any reachable database (e.g. the control-plane one).
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — shared across every tenant today. Every
     access/refresh token carries an `org` claim cross-checked against the tenant the request
     actually resolved to (`middleware/auth.ts`), so a token minted under one org is rejected if
     replayed against another even though the signing secret is shared — defense-in-depth, not
     the primary isolation boundary (the separate physical databases are).
   - `PLATFORM_ADMIN_JWT_SECRET` — **must differ** from the two above; it signs
     `/platform-admin` tokens, which can administer every organization on the platform.
   - `ENCRYPTION_KEY` — encrypts every org's stored secrets (BYOK AI keys, IMAP passwords, OIDC
     client secrets) at rest, one workspace-wide key.
   - `TENANT_DB_PROVISION_BASE_URL` — a DSN with credentials but **no database name**
     (`mysql://root:***@db-host:3306`) pointing at the server new tenant databases get
     physically created on. Leave unset to provision tenant databases some other way and
     register them directly (see "Provisioning without the automation" below).
   - `APP_BASE_URL` — the ONE fixed callback URL every org's OIDC/SAML redirect uses. Org
     identity travels in a signed `state`/RelayState parameter instead of the callback URL
     itself (see `services/sso.service.ts`), which is what lets every org share one callback
     without registering a distinct redirect URI per org with Google/Microsoft/their SAML IdP.
     This must be a stable, real domain before configuring any org's SSO.
3. Run migrations + seed the control plane (no tenant seed yet — there's no tenant until an org
   is provisioned):
   ```bash
   npm run control:generate -w apps/api
   npm run control:migrate -w apps/api
   npm run control:seed -w apps/api   # seeds PlanTierLimit rows + one PlatformAdminUser
   ```
4. Configure DNS/your reverse proxy so `<any-slug>.yourdomain.com` reaches the same running API
   — `middleware/tenant.ts` resolves the org purely from the `Host` header's subdomain, so no
   per-org DNS entry beyond a wildcard (`*.yourdomain.com`) is needed.
5. Log into `https://yourdomain.com/platform-admin/login` with the seeded credentials printed by
   `control:seed` (`platform-admin@timesphere.local` / `PlatformAdmin@12345` in dev — **rotate
   this immediately in any real deployment**: the console shows an amber banner while that
   password is still in use, and **Change password** in its sidebar rotates it).

### Provisioning a new organization

Two clicks in the `/platform-admin` console's Organizations page: **New organization** registers a
control-plane row in `PROVISIONING` status, and **Provision** — which needs
`TENANT_DB_PROVISION_BASE_URL` — creates and migrates the organization's own database, seeds it
without demo data, creates its first admin and flips it `ACTIVE`. Every step is safe to retry
(`services/provisioning.service.ts`). The org is then reachable at `<slug>.yourdomain.com`.

The step-by-step runbook, with what to check before and after, is
[NEW_ORGANIZATION_SETUP.md § Shape 2](NEW_ORGANIZATION_SETUP.md#shape-2--saas-multi-org-adding-one-more-organization-to-a-live-platform).

### Provisioning without the automation

If `TENANT_DB_PROVISION_BASE_URL` is unset (a deliberately supported choice — some deployments
provision tenant databases via a separate ops process, possibly on entirely different servers
per customer for data-residency reasons), provision manually:

1. Create the physical database however your infrastructure requires.
2. `DATABASE_URL=<new tenant dsn> npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma`
3. Seed it: `import { seedTenant } from "./prisma/seed.js"` and call
   `seedTenant(client, { adminEmail, adminName, adminPassword, includeDemoData: false })` against
   a `PrismaClient` pointed at the new DSN (or adapt `scripts/migrate-all-tenants.ts`'s pattern
   into a one-off script).
4. Register it: create the `Organization` row (or use the console's "New organization" step
   above) plus an `OrgDatabase` row with the encrypted DSN
   (`utils/encryption.ts#encryptSecret`), then flip `Organization.status` to `ACTIVE`.

### Keeping every tenant's schema current

A new migration under `apps/api/prisma/migrations/` needs to reach every tenant database, not
just one. After merging a migration:

```bash
npm run migrate:tenants -w apps/api
```

Fans the migration out across every `ACTIVE`/`SUSPENDED` org's own database, skipping any
already on the latest version, isolating one org's failure from the rest (a bad connection or a
hand-edited schema drift on one tenant doesn't block everyone else), and recording the applied
version on `OrgDatabase.schemaVersion` per success. Run this as its own deploy step for the SaaS
shape — it's the multi-org replacement for `docker-compose.yml`'s single `prisma migrate deploy`
command, which only ever migrates one database and is correct only for Shape 1.

The target is always the newest directory under `prisma/migrations` in the **checked-out** tree, so
no release requires editing this step: 2.3.0's `20260808120000_mcp_server` reaches every tenant
through the same command. `update.sh`/`update.ps1` already run it for the Compose shape, and
`npm run setup` runs it as its last step on a local checkout — see
[Updating a running deployment](#updating-a-running-deployment).

### Per-organization configuration

Everything below is already isolated per org by the database-per-tenant model — no extra setup
beyond what's documented elsewhere:

- **SSO** — each org's own admin configures Google/Microsoft/SAML/LDAP from that org's Workspace
  Settings → Single sign-on, independent of every other org. LDAP is a direct bind rather than a
  redirect (the org admin supplies a service-account bind DN/credential this app uses to look up
  and verify end users — see `services/sso.service.ts`'s LDAP section), so it renders as an
  inline username/password form on the login page instead of a "Continue with…" button. Which
  provider TYPES an org is even allowed to turn on is capped by its plan tier
  (`PlanTierLimit.allowedSsoProviders`), editable from `/platform-admin` → Plan tiers.
- **Chat-to-ticket connectors** — Slack, Microsoft Teams, Google Chat, and Telegram all turn
  inbound messages into AI-triaged tickets the same way inbound email does (Workspace Settings →
  Chat integrations), replying back into the originating chat once a ticket's created. Slack/
  Teams/Google Chat are push-only APIs, so each needs a webhook URL (shown in that settings tab)
  registered with the platform's own app/bot console; Telegram is polled instead, same
  no-public-endpoint-needed reasoning as the IMAP worker. Which platforms an org may connect is
  likewise capped by plan tier (`PlanTierLimit.allowedChatPlatforms`).
- **AI, email intake, feature toggles** — every `GlobalAISettings`/`EmailIntakeSettings`/etc. row
  lives in that org's own database, so nothing here needs multi-tenant-specific configuration at
  all — it already only ever affected one org.
- **Seat limits / AI budget ceilings** — enforced live on every user-creation and AI call against
  the org's plan tier (or its own override, settable from `/platform-admin` → Organizations →
  Manage) — see `services/plan-limits.service.ts`.

### Operational notes specific to this shape

- **Connection ceiling**: each tenant database connection pool is capped
  (`PER_TENANT_CONNECTION_LIMIT` in `config/prisma.ts`, set by `TENANT_DB_CONNECTION_LIMIT`,
  default 5) and idle clients are evicted after 10 minutes, with an LRU cap (`MAX_CACHED_CLIENTS`,
  50) on how many tenant clients stay warm at once — **per API process**. So one replica can hold
  up to 50 × 5 = 250 tenant connections, and N replicas N times that, while MySQL 8's default
  `max_connections` is 151. Keep the product comfortably under your server's
  `SHOW VARIABLES LIKE 'max_connections'`, and watch `SHOW STATUS LIKE 'Threads_connected'` as the
  organization count grows. This is a known scaling ceiling of the database-per-tenant model, not
  a bug. The 20 that the Compose files and the chart ship is sized for a single-org install, where
  only one tenant client is ever live — see the `TENANT_DB_CONNECTION_LIMIT` row in the
  [environment variable reference](#environment-variable-reference) before reusing it here.
- **Backups**: back up the control-plane database (small, but losing it means losing the map of
  which tenant database is which) and every tenant database independently.
- **The platform-admin console never loops over tenant content**: the only file in this codebase
  allowed to connect to every tenant database for reporting is
  `services/platform-admin-analytics.service.ts`, and it's restricted by convention to
  aggregate/count queries — seat counts, ticket counts by status, AI spend totals — never
  row-level ticket/comment/timesheet content. That's the concrete, auditable point where this
  app's cross-tenant data-isolation guarantee either holds or doesn't.

---

## Browser and OS support

**Verified by running the suite, not by inspection.** Three engines cover every browser this
product gets asked about, because the browser is not the thing that varies — the engine is:

| Engine | Browsers | How it is covered |
|---|---|---|
| Chromium | Chrome, Edge, Opera, Brave, Vivaldi, Arc | `desktop` + 4 responsive viewport projects |
| Gecko | Firefox | `firefox` project |
| WebKit | Safari on macOS **and every browser on iOS** | `webkit` project |

The last row is the one people get wrong: on iOS, Chrome/Edge/Firefox are all Safari's WebKit
wearing a different icon, because the platform requires it. Testing "Chrome on iPhone" is testing
WebKit.

```bash
npx playwright install firefox webkit    # once
npx playwright test --project=firefox --project=webkit
```

The cross-browser projects run a functional subset (auth, tickets, timesheets, dashboard,
settings, user management) rather than everything. The responsive projects are a *width* question
and pinning them to one engine is what makes a layout difference attributable to the viewport; the
face specs need a camera and a secure context, which is a device question rather than an engine
one.

### Operating systems

The server runs in Docker (Linux) regardless of the host, so **macOS, Windows and Ubuntu differ
only in how you start it** — `install.sh` for macOS/Linux, `install.ps1` for Windows, and CI
builds and typechecks on both Linux and Windows. There is no OS-specific application code. The
client is a browser, so client-side support is the engine table above.

Two host-level notes that have actually bitten:

- **Windows + `prisma generate`** — the running API holds `query_engine-windows.dll.node` open, so
  a regenerate fails with `EPERM`. Stop the API first. Linux and macOS do not care.
- **Line endings** — the repo is authored with LF and git normalises on checkout. Windows editors
  that rewrite files to CRLF produce diffs that look enormous and are not.

### Known limits, stated rather than implied

- **The camera needs HTTPS** on every browser and every OS. See the section below; it is not
  something the application can work around.
- **Hands-free face capture needs WebGL.** Where it is unavailable — locked-down enterprise
  browsers, some VMs — the camera falls back to a manual shutter button and everything still
  works, just with one more click.
- **Copy buttons fall back to a legacy path** on insecure origins and older Safari, and report
  honestly when even that fails rather than claiming success. See `lib/clipboard.ts`.

## Serving over HTTPS (required for the camera, and for Copy buttons)

**The symptom:** the face-verification screen says *"Your browser only allows camera access over
HTTPS, and this page was opened on http://…"*, and Copy buttons do nothing. Almost always on a
phone.

**Why it happens, and why it is invisible in development.** Browsers only expose `getUserMedia`
(camera), `navigator.clipboard`, and service workers in a **secure context**. `localhost` is
exempt — so a laptop opening `http://localhost:5173` has a working camera, and the same build
opened from a phone at `http://192.168.1.20:5173` has no camera at all. Nothing is misconfigured
in the app; the browser is refusing, and every browser refuses. This is not something the
application can work around, and any product that claims to has simply not been tested off
localhost.

Affected features: face enrollment and verification, every **Copy** button (share links, API
tokens, webhook URLs). Everything else works fine over plain HTTP.

### The shipped runbook (do this; the sections after it are the reasoning)

The repo carries everything pre-wired, so standing HTTPS up — on this machine or any future one —
is the same short sequence every time.

**A. LAN / no public domain (dev machine or an on-prem box):**

```bash
# 1. Install mkcert, once per machine:
winget install FiloSottile.mkcert        # Windows (then reopen the terminal)
sudo apt install mkcert libnss3-tools    # Debian/Ubuntu
brew install mkcert nss                  # macOS

# 2. Generate + install the certificate for every address this machine answers on:
powershell -ExecutionPolicy Bypass -File scripts\make-lan-certs.ps1   # Windows
bash scripts/make-lan-certs.sh                                        # Linux/macOS
```

The script drops the pair where **both** entry points already look — `apps/web/certs/` (picked up
automatically by `npm run dev`, which then serves `https://<lan-ip>:5173`) and
`deploy/caddy/certs/` (used by the Docker overlay below). It prints the exact per-device trust
steps for the `rootCA.pem`, and reminds you to point `APP_BASE_URL` at the `https://` address so
emailed links match. Windows note: the first `mkcert -install` pops a security-warning dialog that
needs a human click. Re-run the script whenever the machine's IP changes — the certificate names
addresses, not the machine.

**B. Docker, LAN mode** (after step A on the host):

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
# → https://<lan-ip>   (Caddy serves the mkcert pair; plain http redirects to https)
```

**C. Docker, public domain** (no mkcert, no device trust — real certificates, automatic renewal):

```bash
# In the .env next to docker-compose.yml:
#   HTTPS_DOMAIN=timesphere.yourcompany.com
#   CADDYFILE=Caddyfile.domain
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
# → https://timesphere.yourcompany.com  (Let's Encrypt; needs DNS → this box and ports 80/443 open)
```

In every mode, set `APP_BASE_URL` (and add the https origin to `WEB_ORIGIN` for production) to the
address people actually open. On an internet-exposed host, also restrict the base compose file's
plain-http ports (`5173`, `4000`) to localhost in an override so TLS is the only way in.

### How this product should be addressed — the decision

Four settings decide whether people can use a deployment, and they only fail as a combination. This
is the shape to aim for, and `reportDeploymentConfig` checks it at every boot — silent when it holds,
specific when it does not.

| | Decision | Why |
|---|---|---|
| **Public surface** | The production build behind a reverse proxy on 443. **Never `npm run dev` on 5173.** | Vite's dev server carries hot reload, source maps and none of the production hardening. It is a development tool that happens to answer HTTP. |
| **Address** | One **DNS name**, used by everyone, inside and outside. | Emails carry exactly one base URL. A name can resolve differently inside and out (split-horizon) or hairpin through the router; an IP cannot be moved, cannot be secured, and changes with the lease. |
| **`APP_BASE_URL`** | That same canonical `https://` origin. | Every password reset, invitation and digest link is built on it, and read by people who may be anywhere. Whatever address the *recipients* type is the right value. |
| **`WEB_ORIGIN`** | Must contain `APP_BASE_URL`'s origin. | A browser opening the base URL sends exactly that origin. Omit it and every sign-in from the only address users were given fails on CORS, while localhost keeps working perfectly for whoever is testing. |
| **Certificate** | Publicly issued, for the DNS name. | **No public CA issues certificates for bare IP addresses** — Let's Encrypt included. On an IP, every emailed link opens through a browser warning, which teaches people to click past the one thing protecting them. |

**One canonical URL is the whole trick.** Given a name (or a public address the router hairpins — test
it, many do), the same link works from the office and from a phone on mobile data, so there is nothing
to switch between and nothing to get wrong per audience. Two base URLs cannot be made to work: an
email carries one.

**On development machines, leave `APP_BASE_URL="auto"`.** A hardcoded address travels with the
checkout and is wrong on every machine except the one it was written on. `auto` resolves to that
machine's own LAN address at boot and logs what it chose, and because CORS auto-accepts private LAN
origins in development, a freshly cloned box works with no edit to either setting — which the boot
check knows, so it stays silent. Pin a real value only where it is genuinely fixed: production.

**Until a DNS name exists**, a LAN-only deployment is a coherent, honest position: keep `APP_BASE_URL`
on the LAN address, accept that emailed links only open inside the network, and do not expose the dev
server. That is a smaller promise, kept — better than a public address whose links land on warnings.

#### First: prove the address reaches THIS deployment

```bash
npm run check:public -- https://203.0.113.10:5173
```

Do this **before** changing any configuration. An address that answers on port 5173 with a TimeSphere
login page looks exactly like your own deployment, and may not be one — a port forward can point at a
different machine on the same LAN. That happened here: two rounds of CORS, certificate and base-URL
fixes were applied to a developer's machine while the public address was forwarded to a second box
running an older build, so every change was correct, verified against localhost, and irrelevant.

The check compares the **version and git sha** behind the address against the local server, then tests
whether that host accepts its own origin and whether the certificate it serves covers the address
people type. A "DIFFERENT deployment" line means configuration has to change on THAT machine, or the
forward has to be repointed — nothing you edit locally will help.

#### Reaching a development or self-hosted box over a public IP

Two settings, and missing either produces a failure that looks like something else:

- **`WEB_ORIGIN` must list the public origin explicitly** — exact scheme, host and port, no trailing
  slash. Development auto-allows private LAN ranges (`localhost`, `10.x`, `192.168.x`,
  `172.16–31.x`) because those are unroutable from the internet; a public address is never
  auto-allowed in any environment, because a pattern loose enough to match one is loose enough to
  match an attacker's. The symptom is a sign-in that fails with **"Origin … is not in this server's
  allow-list"** — and that message now carries the fix, with the exact string to paste.
  List `http://` and `https://` separately if you switch between them: to a browser they are
  different origins, and the dev server serves HTTPS only when `apps/web/certs` exists.
- **`APP_BASE_URL` decides what every EMAILED link points at.** Left on `"auto"` it resolves to the
  machine's own LAN IPv4, so the app works over the public address while every password reset,
  invitation and digest link it sends points somewhere the recipient cannot open. There is one base
  and it is baked into each message at send time, so choose the address the people who receive mail
  can actually reach. On a network without NAT hairpinning, a public base may not open from inside —
  send yourself one reset link from each side before settling on it.

**On the certificate, plainly:** a self-signed certificate (mkcert or otherwise) on a bare IP can
never be trusted by a browser that has not installed your local CA, and **no public CA issues
certificates for IP addresses** — Let's Encrypt included. So while an IP is the address people type,
outside users will meet a browser warning no matter what you configure, and password-reset links will
train them to click through it. Reissuing the dev certificate to cover every address you serve on
(`mkcert localhost 127.0.0.1 ::1 <lan-ip> <public-ip>`) removes the *name mismatch* error and gives a
real padlock on machines that have the local CA — it does not and cannot make the site trusted
elsewhere. The only standard fix is a DNS name in front of it with a publicly issued certificate; see
the reverse-proxy section below.

### Production, with a public domain — use a reverse proxy

The Compose stack does not terminate TLS itself, on purpose: certificate management belongs to
whatever already runs in front of it. Caddy is the least work because it obtains and renews
Let's Encrypt certificates with no extra configuration:

```caddy
# Caddyfile — put this in front of the Compose stack
timesheet.example.com {
    reverse_proxy localhost:5173     # the web container
    handle_path /api/* {
        reverse_proxy localhost:4000 # the API container
    }
}
```

nginx equivalent, if you already run one, terminating TLS with certbot-issued certs and proxying
the same two upstreams. **Whichever you use, forward `X-Forwarded-Proto`** — the API reads it to
build absolute URLs for share links and email, and without it those links come out as `http://`
and land users right back in the insecure context. **And on nginx you must also set
`proxy_set_header Host $host`** — see the next section, which is the one thing most likely to be
wrong about a multi-workspace deployment.

On Kubernetes there is nothing to add for TLS: set `ingress.host` and `ingress.tls` in the Helm chart
and let cert-manager or your cloud's managed certificate handle issuance (see *Kubernetes
deployment*).

### The Host header has to survive every hop

**This matters only for multi-workspace deployments, and for those it is the whole ball game.**
`middleware/tenant.ts` decides which organization a request belongs to from the `Host` header and
from nothing else — there is no org id in the body, no query parameter, and no header a client can
set, because the login page has to know whose SSO configuration to offer before it knows who is
asking. Every proxy between the browser and the API is therefore carrying the tenant, whether or not
whoever configured it knew that.

A proxy that rewrites `Host` does not fail, warn, or look wrong. Every request simply arrives
claiming to be for the proxy's own address, falls through to `DEFAULT_ORG_SLUG`, and serves the
default workspace to everybody. On a single-org install that is invisible, because the default
workspace is the right answer. It is discovered by a customer signing in and seeing somebody else's
data — or, more often, by nobody, for a long time.

This is not hypothetical. This repository's own Vite dev proxy shipped `changeOrigin: true`, which
does exactly that, so subdomain routing had never once worked through a browser on a developer
machine; a login sent to `localhost:5173` with `Host: acme.example.test` came back with the *default*
workspace's token. It is fixed, and `apps/web/tests/unit/vite-proxy-preserves-host.test.ts` now fails
if anyone sets it back.

**nginx — the default is wrong.** `proxy_pass` sends `Host: $proxy_host` (the upstream's address)
unless told otherwise. One line, and it is not optional here:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;               # THE TENANT. Without this, every workspace is the default one.
    proxy_set_header X-Forwarded-Host $host;   # lets the routing readout below detect a rewrite
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**What each platform does by default**, so you know whether you have anything to do:

| In front of the API | Preserves `Host`? | What to do |
| --- | --- | --- |
| **nginx** (`proxy_pass`) | **No** — sends the upstream's address | `proxy_set_header Host $host;` as above |
| **Caddy** (`reverse_proxy`) | Yes | Nothing. Do *not* add `header_up Host {upstream_hostport}` |
| **Traefik** | Yes | Nothing. Do not enable a `Host`-rewriting middleware |
| **HAProxy** | Yes | Nothing, unless you added an explicit `http-request set-header Host` |
| **AWS ALB / NLB** | Yes | Nothing. ALB preserves `Host` and adds `X-Forwarded-*` |
| **AWS CloudFront** | **No** by default — forwards the *origin's* domain | Forward the `Host` header: use the `AllViewer` origin request policy, or add `Host` to the policy's header list |
| **Cloudflare proxy** | Yes | Nothing. Wildcard proxying needs *Total TLS* or an uploaded wildcard certificate |
| **GCP external ALB** | Yes | Nothing. Use a wildcard Google-managed certificate |
| **Azure Front Door** | **No** by default — sends the backend host | Set *Origin host header* to blank/`Host`, or turn on "preserve incoming host name" |
| **Azure App Gateway** | Configurable | In the backend HTTP setting, do **not** "Override with new host name" |
| **K8s: ingress-nginx** | Yes | Nothing. Add the wildcard to `ingress.wildcardHost` and to the TLS cert |
| **Vercel / Netlify rewrites** | **No** — send the destination's host | Not usable in front of a multi-tenant API. Point DNS at the deployment instead |

The rule of thumb: anything that calls the setting *"origin host header"* or *"override host name"*
is the thing that breaks this, and its default is usually to override.

**Verify it, rather than believing the table.** One authenticated request through your real load
balancer, from anywhere:

```bash
curl -s https://acme.yourdomain.com/api/platform-admin/routing \
  -H "Authorization: Bearer <platform-admin token>" | jq .observed
```

```json
{
  "hostHeaderSeen": "acme.yourdomain.com",
  "forwardedHost": "acme.yourdomain.com",
  "resolvedSlug": "acme",          // ← if this is not the workspace you aimed at, Host was rewritten
  "isApex": false,
  "hostRewriteSuspected": false
}
```

`resolvedSlug` is the answer. It is what the header that actually reached the API resolves to, every
proxy included, so it cannot be fooled by a configuration file that looks correct.
`hostRewriteSuspected` compares `Host` against `X-Forwarded-Host` and is a *hint*: a proxy that
rewrites `Host` and sets no `X-Forwarded-Host` leaves nothing to compare, which is why the raw
values are reported beside it. The route is platform-admin-only on purpose — a public endpoint that
echoed a resolved slug would hand any anonymous caller a list of which workspaces exist.

### Multi-workspace on each deployment shape

What each way of running this needs before one deployment can serve several customers on their own
subdomains. The only two moving parts are **`ROOT_DOMAIN` reaching the API** and **`Host` reaching
the API unchanged**; everything below is those two, per shape.

| Shape | `ROOT_DOMAIN` gets there via | `Host` preserved? | What you still have to do |
| --- | --- | --- | --- |
| **Local dev** (`npm run dev`) | `apps/api/.env`, or `ROOT_DOMAIN=localhost npm run dev` for one run | Yes — the Vite proxy no longer rewrites it | Nothing. Browse `acme.localhost:5173`; see *Testing two workspaces on a development machine* |
| **One-click install** (`install.sh` / `install.ps1`) | **The installer asks for it**, and derives the right default from the API URL you typed | Yes — it writes the Compose stack, whose nginx sets `proxy_set_header Host $host` | Wildcard DNS + a certificate covering the wildcard |
| **Docker Compose** (`docker-compose.yml`) | Root `.env` → `ROOT_DOMAIN`, forwarded to the `api` service | Yes — `apps/web/nginx.conf.template` sets it explicitly on `/api/` and `/uploads/` | Put TLS in front; wildcard DNS + wildcard cert |
| **Compose + HTTPS** (`docker-compose.https.yml`) | Same root `.env` | Yes — Caddy's `reverse_proxy` passes Host through untouched | **Use `CADDYFILE=Caddyfile.domain-wildcard`.** The default `Caddyfile.domain` declares only the apex as a site address, so subdomains never reach the stack. Also `TRUST_PROXY_HOPS=2` |
| **Kubernetes / Helm** | `env.rootDomain` in `values.yaml` → the configmap → the `api` pods | Yes — ingress-nginx preserves `Host`; so do GKE/ALB ingress | Set `ingress.wildcardHost: "*.example.com"`, and a cert covering the wildcard (cert-manager DNS-01, or your cloud's managed wildcard) |
| **External MySQL** (`docker-compose.external-db.yml`) | Same root `.env` | Yes — same web container | Identical to Compose above; the database choice is unrelated to routing |
| **CI/CD** (`.github/workflows/cd.yml`) | Not applicable — **CD builds and publishes images, it does not deploy** | — | Routing is configured wherever you run the images, not in CI. Nothing in the pipeline needs to know |
| **Behind your own CDN/WAF** | However you already set env | **Check.** CloudFront and Azure Front Door override `Host` by default | See the table in the previous section, then verify with the one `curl` |

Three things are worth saying plainly, because each has been assumed the other way:

- **`ROOT_DOMAIN` is not only the multi-customer switch.** A *single*-workspace install on a
  three-label hostname (`timesheet.company.com`) needs it too, or it 404s. The installer now offers
  the correct value, and the API prints a startup `ERROR` if the configuration cannot work for the
  address it is serving.
- **CI/CD has nothing to do with this.** `cd.yml` publishes container images to GHCR. Where those
  images run — Compose on a VM, a Helm release, your own orchestrator — is where `ROOT_DOMAIN` and
  the proxy configuration live, so a pipeline change is never the fix for a routing problem.
- **The platform-admin console is not affected by any of it.** `/api/platform-admin/*` is mounted
  *before* tenant resolution, so one platform administrator serves every workspace and signs in at
  the deployment's own address regardless of `ROOT_DOMAIN`. Verified: the same platform-admin
  credentials authenticate over `Host: localhost`, `Host: acme.example.test` and even a hostname no
  workspace claims — all `200`, where a tenant user would get `404`.

### Workspace origins and `WEB_ORIGIN`

A browser treats every workspace hostname as a separate **origin**, and sends
`Origin: https://acme.example.com` on every POST — even though the request is same-origin from the
page's own point of view. `WEB_ORIGIN` is a fixed list written at deploy time, so it can never name
your customers.

**Setting `ROOT_DOMAIN` is what solves this**: every subdomain of it is accepted as one of this
deployment's own origins, without being listed. That grants no more trust than the router already
does — `middleware/tenant.ts` accepts exactly those hostnames as naming a workspace, and a name
under your domain is under your DNS control. The scheme and port must still match an entry you
actually wrote in `WEB_ORIGIN`, so an https deployment does not start trusting
`http://acme.example.com`.

The failure shape, if this is wrong, is distinctive and worth recognising: **the login page renders
perfectly and then cannot sign anybody in.** A same-origin `GET` sends no `Origin` header at all, so
branding and the SSO buttons load; the `POST` to `/api/auth/login` carries one and is refused with a
403 about an allow-list. If you see that, `ROOT_DOMAIN` is the variable to look at, not `WEB_ORIGIN`
— and the error message now says so.

**Verified custom domains are handled too, and need no configuration.** A workspace on
`time.acme.com` is not under `ROOT_DOMAIN`, so the API keeps a cached set of the domains the control
plane has *verified* and accepts those as origins as well. The cache refreshes every 60 seconds and
is refreshed immediately when a domain is verified or removed, so a customer's domain works the
moment the console says "verified" — no `WEB_ORIGIN` edit, no restart. Unverified rows are ignored,
and the scheme and port still have to match an entry you wrote.

### SSO across workspace subdomains

Google and Microsoft require the OAuth `redirect_uri` to be **one exact string**, registered in
advance — so every workspace's sign-in comes back to the single callback host built from
`APP_BASE_URL`. That is fine for working out *which* workspace: `finishSsoLogin` recovers the
organization from the signed `state`, never from the `Host` header.

The session was the problem. A refresh cookie written for the callback host cannot be read by
`acme.example.com`, so somebody who started at their workspace landed back on a login page having
just signed in successfully.

**It now hands off.** When the workspace's own address differs from the callback's, the API parks
the finished session behind a one-time code and redirects the browser to
`https://acme.example.com/sso/handoff?code=…`. That page redeems it against the workspace's own
origin, so the cookie is written by a request whose `Host` is the workspace. The code is 32 random
bytes, single-use, valid for **60 seconds**, hashed at rest, and **bound to the organization it was
minted for** — redeeming it at another workspace's origin fails and burns it. The SPA strips it from
the address bar before the request is even sent, so it does not linger in history or a `Referer`.

**Nothing changes for a single-org deployment.** With no `ROOT_DOMAIN` the callback host and the
workspace host are the same origin, so the API redirects straight to `/app` exactly as before.

You still register **one** `redirect_uri` at the IdP — the one your `APP_BASE_URL` produces. There is
no per-customer IdP configuration.

**It works across replicas and across restarts.** The codes live in the control plane
(`SsoHandoffCode`), not in a process's memory — an in-memory map works on exactly one pod, and behind
a round-robin balancer the code gets minted on one and redeemed on another, so the sign-in fails at
random. The row is claimed with a `DELETE` whose reported row count decides the winner, so two pods
redeeming simultaneously produce exactly one session and the loser is told the code expired. No
sticky sessions needed. The migration is applied automatically by `migrate deploy` on both the
Compose and Helm upgrade paths — there is no manual step.


**Set the Microsoft tenant ID.** With the Directory (tenant) ID left blank, sign-in goes through
Microsoft's `common` authority. That works — openid-client checks each ID token's issuer against the
tenant named *in the token itself* — and that is the problem: any Microsoft work account from any
organization, and personal accounts if the app registration allows them, can sign in and is matched
to an account here by email address. An administrator of any Entra directory can set a user's email
to any address, so a blank tenant ID lets an outsider sign in as a colleague. Enter the tenant ID
from the app registration's Overview page so only your own directory's accounts are accepted.
Existing blank configurations keep working: the Single sign-on settings card shows a warning, and
the API logs one `[sso]` warning per sign-in that takes this route. Google sign-ins now require a
verified email address.

### On-prem with no public domain — a private CA

Let's Encrypt cannot issue for `192.168.x.x` or an internal hostname, so the options are a
self-signed certificate or an internal CA. Self-signed works, but **every phone that will use the
camera has to trust the certificate**, or the browser blocks the page before the camera question
even arises. `mkcert` makes this tolerable:

```bash
mkcert -install                          # creates a local CA
mkcert timesheet.internal 192.168.1.20   # cert for the name AND the IP people actually type
```

Point the reverse proxy at the generated pair, then install the `mkcert -CAROOT` root certificate
on each device (iOS additionally requires enabling it under *Settings → General → About →
Certificate Trust Settings*, which is the step people miss). If that is more device management
than you want, giving the server a real hostname and a real certificate is genuinely less work in
the long run.

### Just testing on a phone for ten minutes

A tunnel gives you a trusted HTTPS URL without touching any configuration:

```bash
cloudflared tunnel --url http://localhost:5173
# or: ngrok http 5173
```

Open the printed `https://…` address on the phone. Fine for a demo or for checking the camera
flow; not a deployment.

### What NOT to do

- **Do not use Chrome's `--unsafely-treat-insecure-origin-as-secure` flag for anything real.** It
  is per-device and per-browser, it disables a security boundary for that origin, and it silently
  stops working after a browser update or profile reset — at which point the camera "breaks" for
  one person with no explanation anybody can find.
- **Do not conclude the camera is broken because it works on your laptop.** It will always work on
  `localhost`. Test from a phone on the real address before deciding anything.

## Reverse proxies and client IP attribution (`TRUST_PROXY_HOPS`)

**Set this. It is the one setting whose wrong value is completely silent.**

Every per-IP control in the app reads `req.ip`: the 20/min login limiter, the 900/min blanket
limiter, the tighter limits on the public share routes, and the IP hash the public request form
records. Express derives `req.ip` from the socket address unless `trust proxy` is set — so behind
a proxy, with `TRUST_PROXY_HOPS` at its default of `0`, **`req.ip` is the proxy's address for
every caller on earth**. Each of those limiters silently becomes one shared global bucket: a
single attacker exhausts the login budget for everybody, and one noisy tenant throttles the rest.
Nothing errors, nothing is logged, and every health check still passes.

**The Compose stack is already proxied, even without the HTTPS overlay.** The browser talks to the
`web` container, whose nginx (`apps/web/nginx.conf.template`) proxies `/api/` to the `api` container and
appends `X-Forwarded-For`. So a default install that never touched this setting is misattributing
every browser request.

| Deployment | Hops | Why |
|---|---|---|
| `docker-compose.yml` (or `.external-db.yml`) as shipped | **1** | the `web` container's nginx |
| …plus `docker-compose.https.yml` | **2** | Caddy in front of that nginx |
| …plus Cloudflare / a corporate LB in front of Caddy | **3** | add one per additional proxy |
| Helm chart with `ingress.enabled: true` | **1** | `templates/ingress.yaml` routes `/api` straight to the api Service, so the ingress controller is the single hop |
| Port 4000 exposed directly, nothing in front (`npm run dev` included) | **0** | `req.ip` is the socket address and always truthful |

**Why a hop COUNT and not `true`.** `trust proxy: true` tells Express to believe the *left-most*
`X-Forwarded-For` entry — which is supplied by the caller. Anyone could then forge `req.ip`,
bypass every per-IP limit, and poison the recorded IP hash. A number means "trust exactly the last
N entries", which is only correct when it matches the real topology; that is why it is an explicit
opt-in per deployment rather than a boolean anyone can wave at.

**The corollary: don't leave the API port publicly reachable once the count is above 0.** Both
compose files publish `4000:4000`. A caller who reaches port 4000 *directly* is not going through
the proxy the count describes, so their forged `X-Forwarded-For` is exactly the header the count
tells Express to trust. On an exposed host, bind it to loopback in an override
(`"127.0.0.1:4000:4000"`, and the same for `5173` when Caddy is fronting it) so the only route in
is the one you counted.

Where it goes:

- **Compose** — a line in the root `.env`: `TRUST_PROXY_HOPS=1`. Both compose files forward it
  (`TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-0}`). `install.sh` / `install.ps1` prompt for it on a
  fresh install, defaulting to `1`; `update.sh` / `update.ps1` warn on every run when an existing
  deployment has it unset or `0`, before and after the rebuild. Changing it needs an api restart —
  it is read once at boot by `config/env.ts`.
- **Helm** — `env.trustProxyHops` in `values.yaml` (default `1`), emitted by the ConfigMap.
- **Manual / systemd** — `TRUST_PROXY_HOPS` in `apps/api/.env`.

The valid range is `0`–`10`; anything else fails Zod validation at boot with a message naming the
variable.

## Outbound request restrictions (`ALLOW_PRIVATE_NETWORK_EGRESS`)

Four features let a **workspace admin** type a URL that the **API server** then fetches:

| Feature | Where it is set | Fetched by |
| --- | --- | --- |
| Outbound webhooks | Workspace Settings → Public API | `services/webhook-dispatch.service.ts` |
| Google Chat incoming webhook | Workspace Settings → Integrations | `services/chat-outbound.service.ts` |
| Bot Framework reply endpoint | the inbound Teams activity itself | `services/chat-outbound.service.ts` |
| BYOK OpenAI-compatible base URL | Workspace Settings → AI | `services/ai.service.ts` |

The API runs *inside* your trusted network, so an unrestricted URL in any of those is
server-side request forgery: a workspace admin could aim it at the cloud instance-metadata
service (`169.254.169.254`, which issues IAM credentials to anything that asks), a database on
`localhost`, or an internal admin panel — none of which they could reach directly. Two of the
four make it worse by handing the result back (`POST /settings/ai/available-models` returns the
fetched model list or the remote error text; the webhook test/retry routes return
`http_<status>`), which turns a blind request into an internal port scan with a readable answer.

`apps/api/src/utils/egress.ts` is the single choke point all four now pass through. It refuses
non-`http(s)` schemes, URLs with embedded credentials, and any target that resolves to a private,
loopback, link-local, CGNAT or reserved address. It **resolves DNS** and requires *every* returned
address to be public, because a hostname's text proves nothing — `internal.attacker.com` with an
`A` record of `127.0.0.1` passes any string check.

- **Default is `false` (closed).** Same posture as `TRUST_PROXY_HOPS`: the safe value ships and a
  deployment whose topology needs the other one opts in.
- **Set it `true` only** for a self-hosted install whose webhook receivers genuinely live on the
  LAN. That is a normal on-prem setup, which is why this is a switch and not a hard block.
- **Development ignores it** and permits private targets regardless, so testing against a local
  receiver — or running Ollama / LM Studio on `localhost` as the BYOK endpoint — keeps working
  with no configuration.

Set it via the root `.env` (Compose forwards `ALLOW_PRIVATE_NETWORK_EGRESS`), `env.allowPrivateNetworkEgress`
in `values.yaml` (Helm), or `apps/api/.env` for a manual/systemd install. Read once at boot, so
changing it needs an api restart. `install.sh` / `install.ps1` ask on a fresh install (default no),
and `npm run doctor` warns when it is on and the deployment looks internet-facing — a public
`WEB_ORIGIN`, or `NODE_ENV=production`.

> A rejected target surfaces as a readable 422 on the settings form, and for a live webhook as
> `blocked` in that webhook's delivery status with the reason attached — not a silent failure.

## Browser security headers

The **SPA** is served by the web container's nginx (`apps/web/nginx.conf.template`), not by the
API — so `helmet()` in `apps/api/src/app.ts` decorates JSON responses only, and cannot protect the
HTML document that actually runs the bundle. The document headers therefore live in the nginx
`location /` block, deliberately scoped there so they do not collide with helmet's own headers on
the proxied `/api/` and `/uploads/` responses (two `Content-Security-Policy` headers on one
response is not additive — the browser enforces the *intersection*).

What is set, and the two entries that are not boilerplate:

- `Content-Security-Policy` with `frame-ancestors 'none'` (plus `X-Frame-Options: DENY` for
  pre-CSP2 browsers) — this product's approve/reject/decide controls are one-click and
  irreversible, which is exactly what a clickjacking overlay aims at.
- `script-src 'self' 'wasm-unsafe-eval'` — **the `wasm-unsafe-eval` is required**: face
  verification runs `@vladmandic/human` in the browser to help the user aim the camera, and
  instantiating WebAssembly counts as script evaluation. It permits WASM compilation only; it does
  *not* re-enable `eval()`.
- `Permissions-Policy: camera=(self), …` — **removing `camera=(self)` disables face verification
  entirely.** Everything else is denied.
- `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin` (which protects the
  signed, expiring `/uploads` capability URLs from leaking through a Referer), and
  `Cross-Origin-Opener-Policy: same-origin`.

`connect-src` is templated as `${CSP_CONNECT_SRC}` and empty by default, which is correct for every
topology this repo ships (nginx fronts the API, so `'self'` covers it). A **split** deployment — SPA
on a CDN or a different hostname from the API — must set it to the same origin passed as
`VITE_API_URL`, e.g. `CSP_CONNECT_SRC="https://api.example.com"`, or the browser will block every
API call.

There is deliberately **no `upgrade-insecure-requests`** and no HSTS in nginx: this repo supports
plain-http LAN deployments on purpose (`APP_BASE_URL="auto"`), and both would break them. HSTS
belongs on the TLS terminator and is set in `deploy/caddy/Caddyfile.domain`, the only file here
guaranteed to be serving over TLS.

## CI/CD

`.github/workflows/ci.yml` runs in two tiers, because the repository is private and every job
minute is billed (Windows minutes twice over):

- **Every push to every branch, and every pull request — the cheap tier (~11 minutes).** On
  `ubuntu-latest` (GitHub Actions' `services:` containers only run on Linux runners): lint +
  typecheck, the production dependency audit, the build of all three packages, both unit suites,
  then a real MySQL service container, both schemas migrated and seeded, and the integration suite
  against it. Alongside: the changelog-tag check, the Helm/compose manifest validation, and
  `bash -n` over `install.sh` and `update.sh`.
- **`main`, a hand-started run, or `[full-ci]` — the full tier (~90 more minutes).** The whole
  Playwright suite (619 tests, every browser project) in four shards, each on its own runner with
  its own MySQL and seed; `install.sh` executed end to end (a real Docker build of both images);
  and — on `main` and `[full-ci]`, but not a hand-started run — the two Windows jobs: a
  `windows-latest` typecheck + build, because this codebase is developed on Windows day-to-day
  (see this doc's own history) and that job catches anything that happens to build on Linux but
  not Windows, and the PowerShell parse of `install.ps1`. To get the full tier on any other
  branch, put `[full-ci]` in the commit message or start the workflow by hand from the Actions tab
  (`workflow_dispatch`).
- **Pull requests get a lighter cut of it:** the installer run, and e2e over two shards on
  `desktop` + `responsive-phone` only (348 tests) — the body of the suite, and the width where this
  repo's layout bugs have actually been found. Firefox, WebKit and both Windows jobs wait for
  `main`; they answer a pre-release question, not a per-push one.

**Tag pushes run no CI at all**, on purpose. A release tag points at a commit `main` has already
tested, and re-running everything against it cost 120 billed minutes each for `v5.6.0` and
`v5.7.0` on 2026-09-28 — 58% of that day's 414 — for no new information. CD still runs on tags,
because publishing the images is what a tag is for. The trade, stated in `ci.yml`: a tag placed on
a commit that is *not* on `main` would ship without CI, which is one reason the release process
pushes the branch and the tag in one command (`git push origin main v1.2.0`).

A newer push to the same ref cancels the run still in flight (`concurrency`), **`main` included**:
releases arrive in bursts, and only the last run describes the code that shipped. A failing e2e
shard uploads its Playwright report for three days, traces rather than videos — the trace carries
the DOM, network and a screenshot per action at a tenth of the size.

`.github/workflows/cd.yml` builds and pushes `apps/api`/`apps/web`'s Docker images to GHCR
(`ghcr.io/<owner>/<repo>-api` / `-web`) on every push to `main` (as `latest`) and on version
tags (as their semver), using the repo's own `GITHUB_TOKEN` — no external registry account needed
to get started. There is deliberately no per-commit `sha-…` tag: on a private registry every one
of those was an image version nothing referenced and nothing removed, and the storage bill was
the sum of them. Swap to another registry
(ECR/GCR/ACR/Docker Hub) by changing `cd.yml`'s `env.REGISTRY` and its login step's credentials;
nothing else in the workflow assumes GHCR specifically.

No repo secrets are required for either workflow as written — `cd.yml`'s GHCR push uses the
automatically-provided `GITHUB_TOKEN`, and `ci.yml`'s test secrets are fixed placeholder strings
scoped to the ephemeral CI database, never real credentials.

### Never "delete untagged versions" on this registry

There is no prune job in `cd.yml`, and adding one back without reading this will destroy every
release image while reporting success.

**"Untagged" does not mean "unreferenced".** buildx pushes each release as an OCI *index*. That
index's children — the `linux/amd64` image itself, and the provenance attestation buildx attaches
by default — are separate package versions that carry **no tag of their own**; the tagged parent
points at them by digest. Every off-the-shelf "delete untagged versions" action, including
`actions/delete-package-versions` with `delete-only-untagged-versions: true`, sees those children
as garbage.

Measured against this registry on 2026-09-24: of **675** untagged versions across the two packages,
**558 were children of a tagged release**. Deleting the untagged set would have broken
`docker pull ghcr.io/<owner>/timesheet-api:<version>` for everything from 2.0.0 to 5.5.0 — the tags
would survive with nothing underneath them.

If a prune is ever needed, resolve the references first:

```bash
# 1. every version, with its digest and its tags
gh api "user/packages/container/<pkg>/versions?per_page=100" --paginate \
  --jq '.[] | [.id, .name, ((.metadata.container.tags // []) | join(","))] | @tsv'

# 2. for each TAGGED digest, the children it references — these are the untouchable ones
TOK=$(gh auth token); B64=$(printf '%s' "$TOK" | base64 -w0)
curl -s -H "Authorization: Bearer $B64" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     "https://ghcr.io/v2/<owner>/<pkg>/manifests/<digest>" \
  | jq -r '.manifests[].digest'
```

Anything untagged and absent from that set is genuinely orphaned. On 2026-09-24 that was 117
versions out of 675.

### The minutes budget, and what each run actually costs

The account's plan includes **2,000 Actions minutes a month**. Windows bills at **double**, so the
number that matters is billable-equivalent minutes, not wall-clock. Measured from real runs on
2026-09-24:

| What | Wall-clock | Billable-equivalent | When it runs |
|---|---|---|---|
| Cheap tier (build, typecheck, unit + integration, manifest checks) | ~11 min | **~11** | every push that touches code, every PR |
| e2e, 4 shards | 23 + 12 + 17 + 15 | **67** | full tier (pull requests run 2 shards of a narrower set) |
| `install.sh` end-to-end | 4 min | **4** | full tier and pull requests |
| Typecheck + build on Windows | 8 min | **16** (×2) | `main`, `[full-ci]` |
| **A full-tier run** | | **~97** | |

So a full run is **5% of the month's allowance**. Two dispatched runs in one afternoon is 10%, and
that is exactly how 90% got used with a week of the cycle left.

The month itself, measured the same way for 2026-09-01..28: **4,412 billed minutes against the
2,000 allowance**, 99% of it this repository. The four e2e shards were 2,350 (53%), the Windows
typecheck 714 (16%, from 415 wall-clock minutes), the ubuntu build/unit/integration job 464, the
installer run 179. Those numbers are what the tag, `main`-cancellation and pull-request changes
above were cut against. `node scripts/actions-usage.mjs [--since YYYY-MM-DD]` reproduces them: the
billing API needs a scope a normal `gh` login lacks, and the per-run `timing` endpoint answers zero
for this account, so the script sums each job's own start and finish, rounds each job up to the
minute and doubles Windows — the way GitHub bills.

**What keeps it down, in order of how much it saves:**

1. **Do not dispatch a full-tier run to "just check"** — ~82 minutes each by the table above (a
   dispatched run skips only the Windows jobs). Push and let the cheap tier answer; ask for the
   full tier when you are about to merge or tag.
2. **Documentation-only pushes are skipped entirely** (`paths-ignore` on the push trigger). A prose
   commit cannot break a build and no longer spends 11 minutes proving it. Pull requests are
   deliberately exempt — a PR with no checks at all reads worse than one that cost 11 minutes.
3. **Both Windows jobs run on `main` and `[full-ci]` only.** They are 8 and ~1 minutes, but
   they bill as 16 and 2. What they protect against — path handling, case sensitivity, line
   endings — reaches a user through a release, not through a branch push.
4. **`concurrency` cancels superseded runs on every ref, `main` included**, so three pushes ten
   minutes apart cost one run and not three.
5. **`[full-ci]` in a commit message** pulls the expensive jobs in on a branch when you genuinely
   need them, without dispatching a whole run.

**The one thing this repo cannot do for you:** set a spending limit. If the included minutes run
out, GitHub bills the overage unless a **$0 Actions budget** is set on the account (Settings →
Billing → Budgets and alerts). A $0 budget blocks further runs until the cycle resets instead of
charging — which for a solo account is almost always what you want. Re-sharding e2e was measured
and rejected as a lever: setup is only ~2.3 minutes per shard, so the 4 shards duplicate about 9
minutes, and the suite itself is ~58 minutes of genuine testing that no arrangement removes.

### The retention that keeps it that way

`.github/workflows/ghcr-retention.yml` runs `scripts/prune-ghcr.mjs` after every successful CD run
and weekly, keeping the **last two releases** plus whatever `latest` points at, plus every child
manifest of those. Run it by hand from the Actions tab — it defaults to a DRY RUN that prints the
plan and deletes nothing, so you can always see what a prune would do before it does it:

```bash
node scripts/prune-ghcr.mjs --owner <you> --package timesheet-api --keep 2
node scripts/prune-ghcr.mjs --owner <you> --package timesheet-api --keep 2 --apply
```

`latest` is kept whatever its age for a specific reason: `deploy/helm/timesphere/values.yaml` ships
`image.tag: latest`, so a default `helm install` pulls it. On 2026-09-24 `latest` pointed at 5.3.0
rather than 5.5.0 — the main-branch build that set it was older than the release tags — so a naive
"keep the two newest" would have deleted the tag every default install depends on.

**What this costs you:** rolling back further than two releases means rebuilding that tag from its
git tag rather than pulling it. That is the trade for not carrying a thousand versions.

**What actually filled the quota** was never the untagged versions: it was `type=sha,format=long`
tagging every commit as its own image — 193 of them, each with two children, 696 versions of pure
build residue. That tag is gone from the metadata step, so the growth stopped at source, and the
residue was removed by hand using the method above.

## Updating a running deployment

**Compose shape (installed via install.sh / install.ps1):** one command —

```bash
./update.sh              # newest release   (Windows: .\update.cmd)
./update.sh --to v1.2.3  # specific release (Windows: .\update.cmd -To v1.2.3)
```

What it does, in order: dumps both databases to `./backups/` (external-DB deployments are asked
to confirm their own snapshot instead — the script can't reach into your RDS), records the
current git ref, checks out the release tag, rebuilds and restarts (migrations run on container
boot as always), then runs the same verification suite the installer uses — health, the server
reporting the *target* version, both schemas fully migrated, a login round-trip. **If
verification fails it automatically rolls the code back to the previous ref and re-verifies**,
so a failed update ends with the old version running, not the new one broken. The database dump
is kept but never auto-restored: migrations are additive-only (docs/DATABASE.md), so old code on
a newer schema is safe by policy, and restoring a dump over a live database is a human decision.

Everyone with the app open when the server comes back is offered a refresh automatically — the
version rides on the health poll the client already makes. **Everyone also gets one in-app
notification** naming the new version and linking to the release notes, once per version per
workspace, written at boot by `release-announce.service.ts`; it clears when they read it, like any
other bell item, and it is never emailed. The **What's new** page (`/app/whats-new`) shows the full
release history to everyone from the changelog inside the build, plus — for super admins only —
this upgrade command whenever a newer release exists on GitHub (checked hourly; disable with
`UPDATE_CHECK=off`, which leaves the history intact and only stops the "newer version" check).

**Kubernetes shape:** don't use update.sh — the platform already owns this dance:

```bash
helm upgrade timesphere deploy/helm/timesphere --reuse-values --set image.tag=v1.2.0
kubectl rollout status deploy/timesphere-api     # and `helm rollback timesphere` to go back
```

### Version-specific upgrade notes

Most releases need nothing beyond the command above. This is the index of the ones that need an
operator to do something — or that look as though they might and don't — newest first. It is an
index of actions, not a second changelog: the release notes are in [CHANGELOG.md](../CHANGELOG.md).

One rule covers every release that carries a tenant migration, so it is not repeated per row: the
migration reaches organizations beyond the default one only through the fan-out
([Keeping every tenant's schema current](#keeping-every-tenants-schema-current)). `update.sh` /
`update.ps1` run it for you; manual and Kubernetes deployments run it themselves.

| Version | What to do | Detail |
|---|---|---|
| **Next release** (under `## Unreleased`) | **Self-serve signup is now off until you turn it on** — Platform admin → Settings → Signup. A multi-org deployment that sells through `/signup` must switch it on after upgrading; a single-org install refuses signup whatever the switch says. One additive control-plane migration (signup policy + verification codes). And in every workspace that uses Microsoft sign-in, set the **Directory (tenant) ID**: left blank, accounts from any Microsoft directory can sign in, matched by email. | [SIGNUP_AND_DOMAINS_PLAN.md](SIGNUP_AND_DOMAINS_PLAN.md), [SSO across workspace subdomains](#sso-across-workspace-subdomains) |
| **5.7.0** | Set `ROOT_DOMAIN` if the address people type has three or more labels (`timesheet.company.com`): unset, every request — the login page included — answers `404 Unknown workspace.`, and the API now says so with a boot `ERROR` naming the value. Multi-workspace deployments also need every proxy to preserve `Host`, and Compose + HTTPS needs `CADDYFILE=Caddyfile.domain-wildcard`. The SSO hand-off table arrives through `migrate deploy`; nothing to run for it. | [Turning on multi-org routing](#turning-on-multi-org-routing-root_domain), [per shape](#multi-workspace-on-each-deployment-shape), [the Host header](#the-host-header-has-to-survive-every-hop) |
| **5.6.0** | Upload virus scanning can now be configured in a container: `CLAMAV_HOST`/`CLAMAV_PORT` are forwarded by both compose files and the chart. Images are now published as `latest` and per version only — no `sha-…` tags — and retention keeps the last two releases plus `latest`, so pull by version and expect to rebuild anything older from its git tag. | [Operational settings](#operational-settings), [retention](#the-retention-that-keeps-it-that-way) |
| **5.4.0** | Nothing to run, one behaviour change: sprints now require the plan that includes timelines. A workspace on a plan without it sees sprints refuse with an upgrade message; its data is kept and returns on upgrade. | CHANGELOG 5.4.0 |
| **5.3.0** | Nothing switches on: sprints stay off until a super admin enables them under Workspace settings → Planning. Two visible defaults moved — a darker brand teal, and derived project colour marks until someone picks one. | CHANGELOG 5.3.0 |
| **5.1.1** | Manual and bare-metal installs need **Node 20 or newer** (nodemailer 10). The images and CI already run Node 22. | CHANGELOG 5.1.1 |
| **5.0.0** | Breaking: auto-created security-finding and CI-failure tickets are no longer assigned through the first module with a `ModuleAssigneeRule`. If you relied on that, add path rules under Workspace Settings → Security & DevOps → *Route findings by file path*; until then finding tickets fall through to CODEOWNERS or arrive unassigned, and CI-failure tickets arrive unassigned. Every existing platform admin is backfilled to OWNER — enrol two-factor before demoting anyone from Platform → Access. | CHANGELOG 5.0.0 |
| **4.0.0** | Nothing, despite the major: a maintenance window armed from the platform console is now read-only inside the workspace (`409 MAINTENANCE_PLATFORM_MANAGED`). No environment variable moved. | CHANGELOG 4.0.0 |
| **3.11.0** | If the console shows an amber banner, the bootstrap platform admin is still on the seeded password: rotate it with **Change password** in the console sidebar. | [One-time platform setup](#one-time-platform-setup), step 5 |
| **3.10.1** | Containerised multi-org deployments: `ROOT_DOMAIN` now actually reaches the container (both compose files; `env.rootDomain` in the chart). Before this every subdomain silently resolved to the default organization, so check the value is set where the container reads it. | [Per shape](#multi-workspace-on-each-deployment-shape) |
| **3.3.0** | Nothing to configure. Scheduled email is now judged on the recipient's clock, and the Monday digest (now also reaching managers and admins) and the security digest moved to 10:00 / 10:30 — expect different send times, not a fault. | CHANGELOG 3.3.0 |
| **3.2.0** | Set `ALLOW_PRIVATE_NETWORK_EGRESS=true` only if webhook receivers (or a BYOK model) genuinely live on your LAN — admin-typed URLs now refuse private targets. A split deployment (SPA on a different origin from the API) must set `CSP_CONNECT_SRC` to the API origin, or the browser blocks every call. Its one migration is additive and NULL-defaulted: no public API key stops working. | [Outbound requests](#outbound-request-restrictions-allow_private_network_egress), [security headers](#browser-security-headers) |
| **3.1.0** | Nothing: no migration, no environment variable, nothing to switch on. Ask AI can now raise tickets, comment, and draft change requests — each only for someone holding the matching permission — and nothing can start or settle an approval. | CHANGELOG 3.1.0 |
| **3.0.0** | Change management ships **off**: a super admin enables it in Workspace Settings → Change management, and the org's tier must include it. Set `managerId` on your users first — approval routes to the requester's manager and, with none set, to every active super admin. Six tenant migrations and one control-plane migration; no new environment variable. | CHANGELOG 3.0.0 |
| **2.5.0** | Multi-org: run the fan-out once after upgrading — `docker compose exec api npm run migrate:tenants -w apps/api`. It had never run inside a container, so organizations beyond the default one may still be on an old schema with no update having said so. | [Fan-out](#keeping-every-tenants-schema-current) |
| **2.4.0** | Multi-org: run the fan-out once by hand. Until this release the image lacked `apps/api/scripts/`, so the fan-out could not run in a container and failed quietly as a warning. Its one migration revokes each user's live sessions beyond their 10 most recent, and all four deployment paths now recover a migration stranded mid-apply (P3009). | [What 2.4.0 adds](#what-240-adds-to-that-dance-session-device-identity--and-the-first-migration-that-can-strand-a-database) |
| **2.3.0** | Nothing: an ordinary update, one additive migration (two new MCP tables), and no environment variable in any deployment shape. The MCP server ships disabled and its write tools disabled individually — read the operating notes before a super admin turns it on. | [What 2.3.0 adds](#what-230-adds-to-that-dance-the-mcp-server), [Operating the MCP server](#operating-the-mcp-server) |
| **2.2.0** | Set `TRUST_PROXY_HOPS` to the real number of proxies in front of the API — `1` for the Compose stack as shipped. At the default `0`, every per-IP rate limit is one shared global bucket. Its one migration hashes guest and public tokens and keeps the plaintext columns, so a rollback stays safe. | [`TRUST_PROXY_HOPS`](#reverse-proxies-and-client-ip-attribution-trust_proxy_hops), [the 2026-08-07 batch](#what-the-2026-08-07-batch-adds-to-that-dance-email-channel-matrix--api-telemetry--token-hashing) |
| **2.1.0** | Nothing beyond the update: two additive migrations, and request telemetry stays off in production until you set `API_TELEMETRY_ENABLED=true`. | [The 2026-08-07 batch](#what-the-2026-08-07-batch-adds-to-that-dance-email-channel-matrix--api-telemetry--token-hashing), [telemetry](#operating-api-request-telemetry) |
| **2.0.0** | Nothing: the planning layer ships off by default, so users see no change until an admin turns it on. | CHANGELOG 2.0.0 |

### What the 2026-08-07 batch adds to that dance (email channel matrix + API telemetry + token hashing)

Three migrations carry the recent releases, and **all three are additive**, which is the whole
reason the existing rollback policy above still holds:

| Migration | What it does | Shape |
|---|---|---|
| `20260807090000_email_role_mutes` | `ALTER TABLE GlobalNotificationSettings ADD COLUMN emailRoleMutes JSON NULL` | one nullable column |
| `20260807140000_api_request_telemetry` | `CREATE TABLE ApiRequestSample` (+ five indexes) | one brand-new table |
| `20260807170000_hash_guest_and_public_tokens` | Adds `ApprovalStep.guestTokenHash` / `guestTokenExpiresAt` and `RequestForm.publicTokenHash`, backfills the hashes from the existing plaintext with MySQL's own `SHA2(…, 256)`, then adds a unique index on each | three nullable columns + a backfill |

Nothing is dropped, renamed or narrowed. The third migration *does* write data — but only into
columns it just created, and it deliberately **leaves the plaintext `guestToken`/`publicToken`
columns in place** for exactly one release. That is what keeps `update.sh`'s auto-rollback honest:
the older code still finds the columns it reads, so a rollback does not strand every outstanding
guest approval link and every printed public form URL. Dropping them is a separate phase-2
migration, once no row needs the fallback. See [docs/DATABASE.md](DATABASE.md) for the policy and
[the token-hashing section](DATABASE.md#guest-and-public-link-tokens-are-stored-hashed) for the
two-phase detail.

**None of the three changes observable behaviour on its own.** `emailRoleMutes` reads back `NULL`
on every existing row, which the application treats as "no role is muted anywhere" — byte-for-byte
today's email delivery — until a super admin actually unticks a cell in Workspace settings → Email
channels. `ApiRequestSample` stays empty until an operator opts into telemetry (next section). The
token hashes are backfilled from links that already exist, so every guest approval and public form
URL already in somebody's inbox keeps working unchanged — no expiry is stamped retroactively onto
them either. An upgrade that changes nothing until somebody asks it to is the point, not an
oversight.

**Compose deployments: this is an ordinary `./update.sh`.** There is no manual step, no
pre-migration, and nothing to run by hand.

```bash
./update.sh              # Windows: .\update.cmd
```

**But remember this project is multi-tenant — a database per organization.** Container boot runs
`prisma migrate deploy` against `DATABASE_URL` only, which is the *default* org. Every additional
organization a platform admin provisioned after install has its own physical database that boot
never touches, and leaving one of those on the old schema while the new code runs against it is
precisely the drift the additive-only policy cannot excuse (the new code will `SELECT
emailRoleMutes` from a table that hasn't got it). The fan-out command is the one already
documented under [Keeping every tenant's schema current](#keeping-every-tenants-schema-current):

```bash
npm run migrate:tenants -w apps/api
```

Who runs it for you, and who doesn't:

- **`update.sh` / `update.cmd` — already automatic.** Its `migrate_extra_tenants` function waits
  for `/health` to answer, then runs `docker compose exec -T api npm run migrate:tenants -w apps/api`
  unconditionally, before the verification suite. In a plain single-org deployment that walk finds
  only the default org, sees it already migrated, and is a fast no-op — which is exactly why it is
  safe to run every time rather than gated behind "are you multi-org?". A failure there is a
  `warn`, not a `fail`: one tenant with a bad connection or hand-edited schema drift must not roll
  back an update that succeeded for everybody else, so read the warning and fix that org
  individually.
- **Manual / non-Docker deployments — you must run it yourself**, as its own deploy step after
  `prisma migrate deploy`. Nothing else will.
- **Kubernetes — you must run it yourself too.** The chart's `post-install,pre-upgrade` hook Job
  runs `prisma migrate deploy` against the tenant and control-plane *schemas* (i.e. `DATABASE_URL`
  and `CONTROL_DATABASE_URL`), which is not the same thing as every tenant database. (The install
  hook is deliberately `post-install`, not `pre-install`: a failed `pre-install` hook aborts before
  the chart's own MySQL StatefulSet is ever created, so with `mysql.enabled=true` there was nothing
  for the Job to connect to and no first install could succeed. Upgrades keep the stricter
  `pre-upgrade` ordering so the schema is migrated before new code serves traffic. The Job's own
  annotation block records this.) After the rollout completes:
  ```bash
  kubectl exec deploy/my-release-timesphere-api -- npm run migrate:tenants -w apps/api
  ```

Post-deploy, the two things worth actually looking at: Workspace settings → Email channels should
render the full category × role grid (every gateable category now has a row, including the six
`emailTicket*` ones that previously had no UI at all), and Workspace settings → Maintenance should
show an **API performance** panel stating that recording is switched off.

### What 2.3.0 adds to that dance (the MCP server)

**One migration, additive, and it inserts no rows:**

| Migration | What it does | Shape |
|---|---|---|
| `20260808120000_mcp_server` | `CREATE TABLE GlobalMcpSettings` and `CREATE TABLE McpCredential` (+ one unique index and two ordinary ones, plus two foreign keys onto `User`) | two brand-new tables |

Nothing is dropped, renamed or narrowed, and no existing table is touched — so `update.sh`'s
code-only auto-rollback is as honest here as it was for the 2026-08-07 batch. The rest of 2.3.0
(AI refine, the AI guardrails, the SSO/OAuth hardening) is code only: **no schema change and no new
environment variable anywhere.** Nothing to add to your `.env`, your compose file, or your Helm
values.

**No backfill row is written, deliberately.** The settings singleton is upserted the first time it
is read, and every column defaults to the closed position — so an upgraded workspace has **no live
MCP endpoint** until a super admin turns one on. An upgrade that changes nothing until somebody
asks it to is the point; see [Operating the MCP server](#operating-the-mcp-server) below for what
turning it on actually means.

**Compose deployments: an ordinary `./update.sh`** (Windows: `.\update.cmd`). No manual step.

**And, again, this is a database per organization.** `20260808120000_mcp_server` reaches the
default org on container boot and every *other* org through the same fan-out documented above —
`update.sh`/`update.ps1` run `npm run migrate:tenants -w apps/api` unconditionally before
verification, and neither script needed a line changed to pick this migration up: the target is
whatever `getLatestMigrationName()` reads off the checked-out `prisma/migrations` directory, so the
newest migration is always the one applied. Manual and Kubernetes deployments still run the fan-out
themselves.

A tenant that misses this migration does not merely lack the feature — `getGlobalMcpSettings()`
upserts the settings singleton on read, so Workspace settings → MCP server errors against a
database where the table does not exist. That is the one visible symptom to expect if a fan-out was
skipped.

Post-deploy check: Workspace settings → **MCP server** should render, showing the master switch
**off**, writes **off**, and no credentials.

### What 2.4.0 adds to that dance (session device identity — and the first migration that can strand a database)

**One tenant migration, and it is the first one in this project's history that does more than add
structure:**

| Migration | What it does | Shape |
|---|---|---|
| `20260817100000_session_device_identity` | Adds `Session.deviceId` + an index on `(userId, deviceId, revokedAt)`, then **revokes all but each user's 10 most-recently-active live sessions** | one nullable column, one index, one bounded data cleanup |

The column and index are additive as usual. The cleanup is not: it **writes to existing rows**,
setting `revokedAt` on surplus live sessions. That was the point — one person on one machine had
accumulated 7,486 "active devices", because every token refresh minted a new session row with
nothing tying it back to the device it came from. `deviceId` is what collapses them going forward;
the cleanup is what clears the backlog that already exists.

**What users see:** anyone with more than 10 live sessions is signed out of the oldest ones. In
practice that means stale sessions on devices they are not using; the 10 most recent survive, so the
device someone is actually working on is not signed out. No password reset, no re-enrolment.

**This migration is `@rerunnable`, and that marker is load-bearing.** It carries three
engine-portability fixes found by shipping it and having it fail on a reporter's MySQL 8.0.46 —
a dev machine running MariaDB had passed it cleanly:

1. **Error 1093** (can't read from the table being updated). The obvious
   `UPDATE t JOIN (SELECT … FROM t)` workaround forces materialisation on MariaDB but MySQL 8.0.14+
   may *merge* the derived table back and re-raise 1093. A `TEMPORARY` table is not an option either
   — it is connection-scoped, and Prisma does not promise one connection per migration file. The
   final form uses an ordinary scratch table, dropped at both ends.
2. **`ADD COLUMN IF NOT EXISTS` does not exist on MySQL** (MariaDB has it). The DDL is guarded by
   querying `information_schema` and `PREPARE`-ing either the real statement or a no-op — which is
   also what makes re-running the file over its own partial application safe.
3. **Error 1267** (illegal mix of collations). Default collations differ by engine — MySQL 8.0 uses
   `utf8mb4_0900_ai_ci`, MySQL 5.7 and MariaDB use `utf8mb4_general_ci` — so the scratch table is
   built with `CREATE TABLE … AS SELECT`, inheriting the source collation instead of declaring one.

**The failure mode to understand before upgrading.** MySQL DDL is not transactional and Prisma does
not roll back. A migration that fails *part way* therefore leaves its `ALTER` applied while
`_prisma_migrations` records the migration **FAILED**, and every later `migrate deploy` refuses with
**P3009** — including the deploy carrying the fixed version of that same migration. Rolling the code
back does not help: the old code's own boot migration hits the identical wall. That is a database
neither a re-run nor a rollback can free.

**All four deployment paths now clear this automatically**, which is new in 2.4.0:

| Path | What handles it |
|---|---|
| `./update.sh` / `.\update.cmd` | If the API does not become healthy, the script checks the logs for P3009 and runs the doctor's repair before falling back to its rollback |
| `./install.sh` | Same check in the first-boot retry path — a restart alone can never clear a stranded migration |
| Helm | The migration hook Job runs `migrate deploy` first, then `doctor:heal` as a recovery fallback; a still-failing Job blocks the rollout rather than letting pods onto a half-migrated schema |
| `npm run setup` (dev) | `doctor:heal` is already part of the sequence |

### Two more things that heal themselves

Both exist because they were real, repeatable ways for a routine command to stop on a machine where
nothing was actually wrong.

**Dependencies after a pull.** `npm run dev` and `npm run build` compare `node_modules` against
`package-lock.json` first (`scripts/ensure-deps.mjs`, on npm's own `predev`/`prebuild` hooks) and
run `npm install` when the lockfile has moved. Pulling a release that added a dependency previously
failed with `Cannot find package '…'`, a stack trace deep inside Vite naming a package the reader
had never heard of and never suggesting `npm install`. Silent when the tree is healthy; never fails
the command, so an offline machine gets a warning and still starts.

**A locked Prisma engine on Windows.** `prisma generate` writes the TypeScript client, then copies
the native `query_engine-windows.dll.node` into place — and Windows refuses to replace a file a
running process has mapped, which the API dev server does for as long as it runs. `npm run setup`
therefore aborted at step three of six for anyone whose dev server was up:

```
EPERM: operation not permitted, rename '…query_engine-windows.dll.node.tmp52360' -> '…node'
```

`apps/api/scripts/prisma-generate.mjs` now recognises that exact signature and continues with an
explanation. This is narrow on purpose: the types are written *before* the engine copy and had
already succeeded, and the engine is pinned to the installed Prisma version so a schema change never
changes it. **Only** an `EPERM`/`EBUSY` on a `query_engine*` path is tolerated — a schema error, a
bad datasource or a missing generator still exits non-zero and stops the chain. If you have just
changed the Prisma *version*, stop the dev server and re-run `npm run db:generate` so the new engine
can actually be copied.

The repair itself is `prisma migrate resolve --rolled-back <name>` followed by `migrate deploy`, and
it is applied **only** to a migration whose SQL carries the `@rerunnable` marker — replaying
arbitrary half-applied DDL is how data gets lost, so anything unmarked is reported to a human
instead. To run it by hand against a Compose deployment:

```bash
docker compose run --rm --no-deps --entrypoint sh api -c 'npm run doctor:heal -w apps/api'
# diagnose only, no changes:
docker compose run --rm --no-deps --entrypoint sh api -c 'npm run doctor -w apps/api'
```

> **Never run `prisma migrate reset`.** Prisma's own P3009 error text suggests it. It drops the
> database. The doctor never calls it.

**Also in 2.4.0, and relevant to every deployment shape:** the API image now ships
`apps/api/scripts/`, which it previously did not. Two commands the runbooks call routinely —
`npm run migrate:tenants -w apps/api` (the multi-tenant schema fan-out that `update.sh` runs on
every update, and that the Kubernetes section above tells you to `kubectl exec`) and
`npm run doctor:heal -w apps/api` — could not run inside a container at all before this, because
the files were not there. `update.sh` treats a `migrate:tenants` failure as a warning rather than an
error, correctly, so the breakage was quiet: **multi-org deployments should assume their non-default
tenant databases may be behind and run the fan-out explicitly once after upgrading to 2.4.0.**

```bash
docker compose exec -T api npm run migrate:tenants -w apps/api    # Compose
kubectl exec deploy/my-release-timesphere-api -- npm run migrate:tenants -w apps/api   # Kubernetes
```

Post-deploy checks: a signed-in user's own session list (`GET /api/auth/sessions`, surfaced in the
app's security/active-devices view) should show at most ten live sessions rather than thousands, and
`npm run migrate:tenants -w apps/api` should report every org as `up-to-date`.

## Operating API request telemetry

New in this release: per-request timings (latency percentiles, slowest endpoints, per-host/pod
split, and a capped drill-down of individual requests) behind Workspace Settings → Maintenance →
**API performance**. It is worth understanding what it costs before turning it on, because unlike
almost everything else in that tab it is *not* an admin toggle.

**It is off by default in production, and enabling it is an environment change plus a restart** — not a UI
switch. `API_TELEMETRY_ENABLED` is read at boot (`config/env.ts`), so the panel can tell you it is
off but cannot turn it on. The full variable list, with the wording those defaults were chosen
under, is in the root `.env.example`; the short version:

| Variable | Default | What it controls |
|---|---|---|
| `API_TELEMETRY_ENABLED` | `false` with `NODE_ENV=production` (as Compose and the chart run); `true` otherwise | Master switch. The disabled path is one boolean test and `next()`. Development defaults it on so the panel has something to show the person building it; setting it explicitly wins either way. |
| `API_TELEMETRY_SAMPLE_RATE` | `1` | Fraction of requests recorded, `0`–`1`. |
| `API_TELEMETRY_FLUSH_MS` | `5000` | How often the in-memory buffer drains to the database. |
| `API_TELEMETRY_MAX_BUFFER` | `5000` | Ceiling on buffered rows before new samples are dropped. |
| `API_TELEMETRY_RETENTION_DAYS` | `14` | Age past which rows are pruned nightly. |
| `POD_NAME` / `POD_NAMESPACE` / `CLUSTER_NAME` | unset | Host identity stamped on each row. |

**Compose and Helm now forward these.** Both compose files list `API_TELEMETRY_*` in the `api`
service's `environment:` block, so `API_TELEMETRY_ENABLED=true` in the root `.env` reaches the
container after a `docker compose up -d`; the chart emits the same set from `telemetry.*` in
`values.yaml` via `templates/configmap.yaml`. This matters because Compose passes an *explicit
list* of variables rather than the whole `.env` — a variable that is not named in that block
simply does not exist inside the container, which is why every optional setting has to be added
there deliberately. On Kubernetes, `POD_NAME`/`POD_NAMESPACE` are the exception to the ConfigMap:
`templates/api-deployment.yaml` maps them from the downward API (`fieldRef: metadata.name` /
`metadata.namespace`) when `telemetry.enabled` is true, because a ConfigMap is one object shared
by every replica and cannot know which pod is reading it. `CLUSTER_NAME` stays in the ConfigMap —
it is the one value Kubernetes cannot report about itself. Off-cluster, leave all three unset:
those columns are written `NULL` rather than filled with a guess, and the hostname still comes
from `os.hostname()`.

**On a busy deployment, turn the rate down rather than the feature off.** Percentiles computed
from a 10% sample are still percentiles; no data answers nothing. `API_TELEMETRY_SAMPLE_RATE=0.1`
is the lever that trades resolution for cost, and it is almost always the right one — the reason
you opened the panel was a p99, and a p99 survives sampling.

**Plan for row volume, because it grows with traffic, not with time.** This is the difference
between this table and every other bookkeeping table in the app: the service-health sampler writes
a fixed handful of rows per five minutes forever, whereas `ApiRequestSample` writes one row per
*sampled request*, so a moderately busy workspace produces more rows in an hour than the health
sampler does in a year — and it does that in **every tenant's** database independently. Retention
defaults to 14 days, pruned by a nightly worker at **04:10** (deliberately after the AI retention
sweep at 03:40, so the two never contend for the same tenant connections), deleting in bounded
batches so a fortnight's backlog never becomes one enormous locking transaction. The prune is
scheduled **even when collection is switched off**, so turning recording off never strands the
rows it already wrote.

**The buffer drops rather than grows.** Nothing in the request lifecycle waits on telemetry:
samples are pushed onto an in-memory array and flushed on a timer. If the database is slow or down
and the buffer reaches `API_TELEMETRY_MAX_BUFFER`, new samples are **discarded and counted** — the
count is reported back through the panel's status — rather than queued into a memory leak. Losing
telemetry beats losing the process, and the same reasoning applies to the middleware itself: a bug
in telemetry must be able to lose telemetry and must not be able to fail a user's request.

**The honest caveat about the CPU / memory / disk / event-loop columns.** They come from a host
snapshot refreshed on a ~15-second timer, not from a measurement taken during the request. The
server-health card can afford to sleep 250ms between two readings of the kernel's counters because
one human is waiting for one card; doing that on every request would be catastrophic, so the CPU
delta is taken between refreshes with no sleep at all and `eventLoopLagMs` is the mean loop delay
over the interval. Read those four columns as *"what the machine looked like **around** this
request, to within ~15 seconds"* — good enough to correlate a latency spike with a saturated box,
not evidence about what any individual request consumed. The per-request columns
(`apiResponseTime`, `dbResponseTime`, `dbQueryCount`) are measured on that request and carry no
such caveat.

Two smaller things worth knowing: `/api/health` and the panel's own endpoints are excluded from
collection (liveness probes and a self-polling observer would otherwise be the highest-volume
"endpoints" in the workspace), and paths are recorded as route patterns (`/api/tickets/:id`), with
id-shaped segments redacted if Express cannot supply one — never the raw URL. Request bodies,
query strings, headers, cookies, IPs and user-agents are not collected at all; `userId` is the
whole of the recorded identity and is resolved to a name only at read time.

## Operating the MCP server

New in 2.3.0: TimeSphere exposes **itself** as an MCP (Model Context Protocol) server at
`POST /api/mcp`, so an AI assistant — Claude Desktop, Claude Code, a hosted agent — can read and
act on a workspace from outside the app. It is **switched off in every deployment**, existing and
new, until a super admin turns it on.

**Read this before you do.** An enabled endpoint plus an issued credential means: *an external LLM
client can read this workspace's data as one specific named user, and — if you also enable writes —
act as them.* That is the whole of it, stated plainly. Everything below is about bounding it.

### What is and is not configured here

- **No environment variable. None.** The whole feature is database-backed
  (`GlobalMcpSettings`, `McpCredential`) and admin-edited at runtime. There is nothing to add to
  `.env`, `docker-compose.yml`, `docker-compose.external-db.yml`, or the Helm chart's
  `values.yaml`/`configmap.yaml`, and nothing an operator can accidentally switch on from the
  outside. The npm dependency `@modelcontextprotocol/sdk` needs no configuration.
- **No new port, no new process.** It is a route on the existing API, behind the same
  `resolveTenant` middleware, the same TLS and the same reverse proxy — so `TRUST_PROXY_HOPS`
  applies to it exactly as it does to everything else, and its own 120/min limiter buckets per IP.
- **It ships closed at three levels**: the server itself, the workspace-wide write latch, and each
  individual write tool. A workspace that never opens the settings tab has no endpoint listening —
  a request to `/api/mcp` on a disabled workspace answers `404` even with a valid credential.

### Turning it on

Workspace Settings → **MCP server** (SUPER_ADMIN only, like every other credential-issuing surface):

1. **Enable the server.** Read tools become live immediately; every write tool stays refused.
2. **Issue a credential.** Give it a name you will recognise later ("Priya's Claude Desktop") and
   pick the **user it acts as**. The token is displayed **once** — it is stored only as a SHA-256
   hash, exactly like a public API key, and cannot be shown again. Re-issue rather than recover.
3. **Configure the client** with the workspace URL and that token:
   `https://acme.timesphere.app/api/mcp`, `Authorization: Bearer tsm_…`. The URL *is* the
   workspace; no tool takes an org parameter, so a client cannot be talked into reaching another
   one.
4. **Only then, if you want writes:** flip the workspace write latch *and* enable the specific
   write tools you want. Both are required — leaving the latch off keeps every write tool refused
   regardless of its own setting, which is the switch to reach for if you ever need to stop an
   agent writing immediately.

### What to decide before issuing a credential

- **Which user it acts as is the entire permission model.** The credential inherits that person's
  role and permissions, re-read on every request, and nothing more: a credential bound to an
  employee sees exactly what that employee sees. Binding one to a SUPER_ADMIN hands a language
  model super-admin reach — occasionally what you want, rarely.
- **Prefer a real person over a shared service account.** Every tool call is audited against the
  bound user (`mcp.tool_called` / `mcp.tool_denied`, with the credential id), so a per-person
  credential keeps that trail meaningful.
- **Offboarding is covered, in two independent ways.** Deleting the account deletes its credentials
  (`ON DELETE CASCADE`), and simply *deactivating* the account stops them working on the next
  request, because the bound user is re-read every time. Neither depends on anyone remembering to
  revoke.
- **Revoking is instant and reversible in the audit sense**, not in the token sense: it stamps
  `revokedAt` so historic audit rows still resolve, and the token is dead from the next request.
- **Writes are visible to other people.** `transition_ticket` moves a ticket everyone else can see,
  fires your outbound webhooks and stops or restarts its SLA clock; `add_ticket_comment` posts a
  comment under the bound user's name.
  Logging time is the deliberate exception — it creates a **draft** and never submits, because
  submitting starts an approval clock and can require an identity check.
- **This workspace's ticket text is not all written by your people.** Inbound email and chat become
  tickets automatically, so an assistant reading a ticket may be reading a stranger's prose. The
  server marks that boundary on every result that can contain it, and the tool descriptions tell
  the model to treat it as data rather than instructions — a mitigation, not a guarantee. The
  controls that hold regardless are the ones above: read-only by default, per-tool opt-in, and one
  person's permissions.

### Verifying and monitoring it

- **Is it reachable?** From a machine that can see the deployment:
  ```bash
  curl -s -X POST https://acme.timesphere.app/api/mcp \
    -H "Authorization: Bearer tsm_…" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```
  A `401` means the credential is wrong, revoked, or its user is gone. A `404` means the server is
  switched off for that workspace. A `406` means that `Accept` header — the spec requires **both**
  content types, and it is the one thing a hand-rolled `curl` gets wrong that a real MCP client
  never does. A tool list means it works, and the list itself is the answer to "what did I actually
  expose", since it contains exactly the tools that are live right now.
- **Who used it?** The settings list shows each credential's `lastUsedAt`, the user it acts as, and
  the token's first 12 characters — enough to tell two credentials apart, and all that is kept.
  The audit log carries every call and every refusal.
- **AI budget is not involved.** The MCP server calls no model of its own — the model is the
  *client*. Nothing here spends the workspace's AI budget or touches `GlobalAISettings`.

Contract and tool list: [API.md](API.md#mcp-server). Design: [ARCHITECTURE.md
§3.11](ARCHITECTURE.md#311-mcp-server--a-second-inbound-surface-that-acts-as-a-person). Tables:
[DATABASE.md](DATABASE.md#mcp-server-tables-globalmcpsettings-mcpcredential).

## Relocating file storage

By default `UPLOAD_DIR` is the **relative** path `uploads`, which means every uploaded file lives
inside the working directory the API was started from — for a normal checkout, inside the repo
tree, where a `git checkout`, a `git clean` or a redeploy that replaces the directory destroys it.
Four variables move storage onto its own volume and split it into three subtrees an admin can back
up, encrypt and audit separately:

| Variable | Default when empty | Holds |
|---|---|---|
| `STORAGE_ROOT` | `UPLOAD_DIR` (`uploads`) | the parent of the three subtrees below |
| `STORAGE_DOCUMENTS_DIR` | `<root>` | ticket/timesheet attachments and email-intake attachments |
| `STORAGE_AVATARS_DIR` | `<root>/avatars` | profile pictures |
| `STORAGE_FACE_DIR` | `<root>/face` | face (biometric) imagery |

**Leaving all four empty changes nothing** — the resolved layout is byte-for-byte what the
deployment already uses. Setting only `STORAGE_ROOT` moves all three together keeping that shape
(`STORAGE_ROOT=/srv/timesphere/uploads` → `/srv/timesphere/uploads/{,avatars/,face/}`); the three
`*_DIR` overrides pin one subtree somewhere else entirely, which is how you put face imagery on an
encrypted volume while documents live on a NAS.

Rules, enforced at boot with a named error (`config/env.ts`):

- **Absolute paths only.** A relative path resolves against whatever directory the service happens
  to start in, which differs between `npm run dev`, `node dist/src/server.js`, a systemd unit and a
  container — and "a redeploy can't touch it" is precisely the promise a relative path cannot make.
- **No `..` segments.** Rejected outright rather than normalised.
- **The directory must already exist and be writable by the service account.** Create it and grant
  access *before* restarting.

**Changing a path affects new files only.** Nothing is moved, renamed or deleted for you. Reads of
existing documents fall back to the previous root automatically, so relocating never 404s an old
attachment; to finish the move, copy the old tree across yourself while the API is stopped.

**Containers: the path must be inside a mounted volume.** Both compose files forward all four
variables, but a path that isn't backed by a volume is written into the container's ephemeral
layer and disappears on the next `up --build`. The shipped mount is the `api-uploads` volume at
`/app/uploads`, which is what `UPLOAD_DIR` already points at — so on Compose you usually want a
new bind mount rather than a `STORAGE_ROOT` alone. The Helm chart is the same story with
`storage.*` in `values.yaml`: `api-deployment.yaml` mounts the uploads PVC at `/app/uploads` and
nothing else.

Workspace Settings → **Storage & logs** (SUPER_ADMIN) shows the resolved layout, which variable
set each path, and the live writability of each directory — and validates a candidate path for you
before you commit it to `.env`. It deliberately has **no save button**: the paths are process-wide
while a super admin is per-tenant, and an arbitrary absolute path the app then writes to is close
enough to arbitrary file write that compromising one admin account must not also yield a
filesystem foothold. Applying a new path is one `.env` line and a restart. See
[docs/API.md § Storage & log paths](API.md#storage--log-paths) for the endpoints.

## Log files

The API logs to stdout unconditionally — Docker, `npm run dev` and systemd journals all read it,
and nothing here takes that away. `LOG_DIR` **additionally** mirrors everything the process prints
into rotating files:

| Variable | Default | What it controls |
|---|---|---|
| `LOG_DIR` | *(empty — file logging OFF)* | Absolute directory to write files into. Same absolute-path rules as the storage variables above. |
| `LOG_ROTATE_HOURS` | `4` | Hours per file within a day. `4` → six files a day; `24` → one. Range 1–24. |
| `LOG_RETENTION_DAYS` | `30` | Whole day-directories older than this are deleted. Range 1–3650. |
| `LOG_COMPRESS_ON_ROLLOVER` | `true` | Gzip a day's files once the date rolls over. |

Layout — one directory per calendar date, `LOG_ROTATE_HOURS`-sized files inside it:

```
<LOG_DIR>/2026-08-07/app-2026-08-07_00-04.log      ← 00:00–03:59 local time, current
<LOG_DIR>/2026-08-06/app-2026-08-06_20-24.log.gz   ← previous day, gzipped on rollover
```

The date appears in both the directory and the filename on purpose: the directory makes "delete
everything older than N days" a directory operation, and the repeated date means a file copied out
of its directory — attached to a ticket, dropped into a chat — still says which day it is. Windows
are local-time and derived from the wall clock, so a restart mid-window appends to the file it was
already writing rather than starting a new one.

Retention runs on the first write after midnight: the previous day's files are gzipped, then
day-directories past `LOG_RETENTION_DAYS` are deleted. A process restarted after being down
overnight does the same catch-up at boot, so retention is honoured even by an instance that never
observes a rollover.

**An unwritable `LOG_DIR` degrades to console-only with one warning — it never stops the app.**
Workspace Settings → **Storage & logs** reports that degraded state, the current file, and the
effective rotation/retention values.

**On Kubernetes, leave `logging.dir` empty.** `kubectl logs` and every cluster log shipper already
collect stdout, and files inside a pod are lost on restart. The chart forwards `logging.*` for the
cases where the directory really is a mounted, retained volume; that is the exception, not the
default.

## Kubernetes deployment

`deploy/helm/timesphere/` is a Helm chart covering both deployment shapes — the same "one
codebase, two shapes" split as the rest of this doc, just expressed as chart values instead of
separate compose files:

- **Shape 1-equivalent**: `mysql.enabled: true` (the chart's own single-replica MySQL
  StatefulSet), one `ingress.host`, `env.defaultOrgSlug` doing the same fallback resolution it
  does everywhere else.
- **Shape 2-equivalent**: `mysql.enabled: false` pointing at a managed MySQL instance instead
  (strongly recommended for real multi-org SaaS — see the chart's `values.yaml` comment), plus
  `ingress.wildcardHost` for subdomain-per-org routing.

### Installing

1. Create the app's Secret yourself — **not** something `helm install` does, deliberately, so
   long-lived credentials never end up in a `helm history`/`helm get values` snapshot. Copy
   `deploy/helm/timesphere/secrets.example.yaml`, fill in real values (same generation commands
   as everywhere else in this doc — `openssl rand -base64 48` / `openssl rand -hex 32`), and
   `kubectl apply -f` it. A real production cluster should use an actual secret manager
   (sealed-secrets, External Secrets Operator, Vault) instead of a plain Secret, but the example
   file is the fastest path to a working first deployment.
2. `helm install my-release deploy/helm/timesphere -f my-values.yaml` (point `image.repository`
   at wherever `cd.yml` published your images, and set `ingress.host`/`ingress.tls` for your real
   domain).
3. A `post-install,pre-upgrade` Helm hook Job runs `prisma migrate deploy` against both schemas —
   the Kubernetes equivalent of `docker-compose.yml`'s inline migrate-then-start command, just as
   its own short-lived Job instead of baked into every container's startup. The asymmetric hook
   pair is deliberate: on a **first install** the Job runs *after* the chart's resources exist
   (so with `mysql.enabled: true` the bundled MySQL is actually there for its wait-loop to find —
   an earlier `pre-install` revision could never complete a first install on that path, because a
   failed pre-install hook aborts before MySQL is ever created); on **upgrades** it keeps the
   stricter `pre-upgrade` ordering, migrating the schema before the new code rolls out. During a
   first install the API pods restart until migrations land, then come up on their own — that is
   the readiness probe doing its job, not a failure to intervene in.
4. Run the one-time seed the same way `install.sh`/`install.ps1` do for Compose (not something
   the chart runs automatically, for the same "not idempotent the way migrations are" reason):
   ```bash
   kubectl exec deploy/my-release-timesphere-api -- npm run control:seed -w apps/api
   kubectl exec deploy/my-release-timesphere-api -- npm run seed -w apps/api
   ```

### Autoscaling

This is the one place real autoscaling exists in this project — `docker-compose.yml` has no
orchestrator to react to load with (`docker compose up --scale api=N` is its one manual lever).
The chart's `api.autoscaling`/`web.autoscaling` values each drive a `HorizontalPodAutoscaler`
(on by default: CPU + memory utilization targets, configurable min/max replicas). A
`VerticalPodAutoscaler` is also templated (`api.verticalAutoscaling`) but off by default, since
it needs the VPA CRDs installed (`kubectl get crd verticalpodautoscalers.autoscaling.k8s.io`)
and not every cluster has them — and running HPA + VPA against the same CPU metric on one
workload can fight itself, so read the chart's comment before turning both on together.

### Memory: face verification changes the sizing, not just the feature set

`api.resources.limits.memory` ships at **1280Mi**, and that number exists for face verification
specifically. `face.service.ts` loads the Human/TensorFlow models into the Node process — at boot if
any org has the feature enabled, otherwise on first use — and they cost roughly **500MB resident per
API process**. The chart previously shipped a 512Mi limit, which is under that on its own: switching
face verification on got pods **OOMKilled mid-verification**, and the symptom reads as a flaky camera
rather than as a resource limit, which is what makes it worth stating here.

Requests deliberately stay at 256Mi. The cost is only paid by deployments that actually use the
feature, and reserving 1Gi on every node for something most installs leave off is the wrong default
for the scheduler. If face verification is off and staying off, **512Mi is genuinely enough** and
lowering the limit back is a reasonable saving across a large fleet. If it is on, also budget the
same headroom per replica when sizing nodes and when setting HPA maximums — ten replicas at 1280Mi is
a different node pool than ten at 512Mi.

Face verification additionally requires a **secure origin** (browsers expose `getUserMedia` only over
HTTPS), which the chart's ingress provides via `ingress.tls`, and a writable face-image directory
that must resolve inside a mounted volume — on this chart the only mounted volume is the uploads PVC
at `/app/uploads`, so leave `storage.faceDir` empty unless you have added a volume for it.

### Verifying the chart without a live cluster

```bash
helm lint deploy/helm/timesphere
helm template my-release deploy/helm/timesphere            # default values
helm template my-release deploy/helm/timesphere --set mysql.enabled=false --set api.verticalAutoscaling.enabled=true
```

Neither command needs cluster access at all — useful for a quick sanity check before an actual
`helm install`/`helm upgrade`.

**CI already runs these on every push**, in the `Validate Helm chart + compose files` job: `helm
lint`, three `helm template` renders (bundled MySQL; external MySQL with the hook disabled; telemetry
and vertical autoscaling on), each piped through a strict YAML parse, plus `docker compose config`
against all three compose shapes — the default, the HTTPS overlay, and the external-DB file. Adding
the job immediately caught something no other check could: `Chart.yaml`'s `appVersion` had drifted to
`2.1.0` while the repo shipped `2.4.0`, which made `kubectl get deploy -L app.kubernetes.io/version`
report the wrong version with nothing failing anywhere. The job now asserts `appVersion` equals the
repo `VERSION` file, so **bump both together when cutting a release** (along with the chart's own
`version:`, which is the chart-package version and is separate).

## Cloud provider notes (AWS / GCP / on-prem)

Nothing in this codebase is cloud-specific — both the Docker Compose shape and the Helm chart
above are the actual deployment artifacts; "AWS" or "GCP" just means *where* those run and which
managed services back MySQL/ingress/secrets. There is no provider-specific code path to maintain.

| Concern | On-prem / bare metal | AWS | Google Cloud |
|---|---|---|---|
| Compute | `docker compose up` (Shape 1) directly on a VM, or your own Kubernetes | EKS + this Helm chart, or ECS Fargate with the same two container images | GKE + this Helm chart, or Cloud Run (one service per image; see caveat below) |
| Database | MySQL/MariaDB you already run (XAMPP for dev, a real MySQL server for prod) | RDS for MySQL / Aurora MySQL — set `mysql.enabled: false` in the chart, point `DATABASE_URL`/`CONTROL_DATABASE_URL` at the RDS endpoint | Cloud SQL for MySQL — same `mysql.enabled: false` pattern, point at the Cloud SQL connection string (via the Cloud SQL Auth Proxy sidecar, or a private IP) |
| Container registry | N/A (build locally) or a self-hosted registry | ECR — change `cd.yml`'s `env.REGISTRY` and login step to `aws-actions/amazon-ecr-login` | Artifact Registry — change `cd.yml`'s `env.REGISTRY` and login step to `google-github-actions/auth` + `docker login` against `*-docker.pkg.dev` |
| Secrets | `.env` file (Compose) / `secrets.example.yaml` → `kubectl apply` (K8s) | AWS Secrets Manager or SSM Parameter Store, synced into the cluster via External Secrets Operator, or injected as ECS task-definition secrets | Google Secret Manager, synced the same way via External Secrets Operator, or mounted directly in Cloud Run |
| Ingress/TLS | your own reverse proxy (nginx/Caddy) in front of Compose, or an ingress controller in K8s | ALB Ingress Controller (or the chart's own `ingress.*` values against any ingress controller you run on EKS) + ACM for TLS | GKE Ingress (or the same chart `ingress.*` values) + Google-managed certificates |
| Autoscaling | manual (`docker compose up --scale api=N`) | the chart's HPA (works identically on EKS — it's just Kubernetes) | same — HPA is portable, not GCP-specific |
| CI/CD | `.github/workflows/ci.yml` unchanged | same, `cd.yml` pushes to ECR instead of GHCR | same, `cd.yml` pushes to Artifact Registry instead of GHCR |

**Cloud Run caveat**: Cloud Run (and Fargate, similarly) works for the stateless `web` and `api`
images, but this app runs its own migration step (`prisma migrate deploy`) and one-time seed as
separate commands, not baked into request-serving startup — on Cloud Run/Fargate, run those as a
one-off Job/task (Cloud Run Jobs, or an ECS `RunTask` with the same image and `npm run` command)
before pointing traffic at a new revision, the same role the Helm chart's `post-install,pre-upgrade`
hook Job plays on Kubernetes.

**Worker/background processing**: there is currently no separate worker process — scheduled jobs
(daily reminder emails, deadline reminders, SLA escalation sweeps, inbound-email polling,
Telegram polling, the AI weekly digest, the optional Monday Weekly AI/ML Practice Update, the face
lifecycle sweep — retention purge, downgrade grace/purge, enrollment reminders, overdue-review
nudges — and the weekly identity digest) run
as in-process `node-cron` schedules inside the `api`
container/pod itself (see `apps/api/src/workers/*.worker.ts`). This means **exactly one replica
of `api` should run the cron
schedules** in a horizontally-scaled deployment, or jobs fire once per replica — set
`api.replicaCount: 1` (Compose: don't `--scale api=N`) if you scale beyond one instance, or gate
the cron registration behind a leader-election/singleton lock if you need both HA and >1 replica
(not implemented today — see [docs/ROADMAP.md](ROADMAP.md) for the relevant epic if you need this
split into a dedicated worker process/pod).

Every digest worker is nonetheless written to be **idempotent by re-reading what it already sent**
rather than by keeping state — the weekly digest counts its own `Notification` rows, the practice
update reads its own `EmailLog` rows for the period. That is a guard against a restart or a
double-fire, not a licence to scale past one replica: two replicas firing simultaneously can still
both pass the check before either writes.

## Sizing (measured, not guessed)

Baseline numbers, measured on a laptop-class CPU with the real face models over 40 consecutive
inferences: ~150ms median per verification frame, ~6/sec serial throughput per worker, models
holding ~350MB steady / ~650MB peak RSS once loaded. Cloud vCPUs are typically slower — budget
300–500ms per frame. Face demand is human-paced and bursty (one submission per user per day is
one check), so **CPU is essentially never the constraint; memory is**: the models load lazily
*per process* and stay resident, so every API process that ever serves a face request
permanently holds ~500MB. That is what drives the tiers below.

| Tier | Users | Shape | Notes |
|---|---|---|---|
| Pilot | < 25 | One VM, 2 vCPU / 4 GB — app + MySQL via Compose | Face verification is why 4 GB rather than 2. Single point of failure, accepted. |
| Small | ≤ 100 | App 2 vCPU / 8 GB + managed MySQL 2 vCPU / 4 GB | Splitting the DB off buys real backups/PITR and restarts that don't take the data with them. |
| Mid | ≤ 1,000 | 2× app (4 vCPU / 8 GB) behind an LB, managed MySQL 4 vCPU / 16 GB, **shared volume for `UPLOAD_DIR`**, Redis for sessions | The shared volume is not optional with >1 app node — an image written by node A is otherwise a 404 from node B. Remember the single-cron-replica rule above. |
| Large | 5,000+ | 4+ app nodes without face traffic + a separate 2-node pool serving `/api/face/*`, MySQL 8 vCPU / 32 GB + replica, S3-compatible object storage | Keeps the general API lean instead of every worker carrying 500MB of models, and a burst of captures can't starve ordinary requests. Not implemented as config today — it's an ingress-routing split. |

Face image storage is cheap enough to ignore: each stored capture is a ~50KB JPEG, so
`users × submissions/day × retentionDays × 50KB` — 200 users at 30-day retention is ~300MB.
Setting `imageRetentionDays: 0` stores templates only. **No GPU** — at these latencies against
human-paced demand it solves nothing, and it would reintroduce the native compiled dependency
the wasm build deliberately avoids.

## Running a model on your own server

The alternative to bringing an API key is bringing nothing. **Workspace Settings → AI → Run a
model on this server** fetches a `llama.cpp` build and a GGUF model, supervises it as a local
OpenAI-compatible endpoint, and registers it as one more provider in the same ranked list — same
fallback chain, same budget, same `AIUsageLog`. No key, no GPU, and no request leaving the machine.

The panel leads with what the machine *is* rather than asking you to guess: CPU model and physical
cores, the memory this process may actually use, free disk under the model directory, and the
environment it detected **with the evidence attached** — "Kubernetes, detected from
KUBERNETES_SERVICE_HOST is set" — because a label nobody can check is a label nobody should trust.

Everything below is about *where the pieces live*. The feature stays off until a workspace turns it
on, so an install that never touches the AI tab is unaffected by any of it.

### The variables

| Variable | Default | What it decides |
|---|---|---|
| `NATIVE_AI_RUNTIME_MODE` | `auto` | `embedded` — this process supervises its own `llama-server`. `external` — something else runs it and we only speak to it. `off`. `auto` asks the hardware probe: inside a Docker container or a Kubernetes pod it means `external`, anywhere else `embedded` (see [Containers](#containers-the-engine-runs-beside-the-api-not-inside-it)). |
| `NATIVE_AI_SERVER_BIN` | *(empty)* | Absolute path to `llama-server`. Empty searches the model directory, then `PATH`. |
| `NATIVE_AI_ENGINE_RELEASE` | *(empty)* | Which llama.cpp release the **Install the engine** button fetches. Empty uses the release this build pins — the one its checks were written against. |
| `NATIVE_AI_HOST` / `NATIVE_AI_PORT` | `127.0.0.1` / `8080` | Where the runtime listens, and in `external` mode where to find it. |
| `NATIVE_AI_MODEL_DIR` | beside the uploads tree | Where GGUF files land. **Must be on a mounted volume** — see below. |

### The one thing that will bite you: the model directory

A GGUF is measured in gigabytes. Left on a container's own filesystem it is re-downloaded on every
`up --build` and it inflates the writable layer by the size of the weights.

- **Compose** — both `docker-compose.yml` and `docker-compose.external-db.yml` already forward
  every variable above and mount a named `api-models` volume at `/app/models`. Nothing to do.
- **Helm** — see `nativeAi` in `values.yaml`. `embedded` provisions its own PVC
  (`nativeAi.modelsVolumeSize`, 20Gi by default) and mounts it; `external` provisions nothing.
- **Bare metal / systemd** — point `NATIVE_AI_MODEL_DIR` at a real directory on a disk with room,
  not at `/tmp`.

### Sizing, and why Kubernetes defaults to a sidecar

**A model is memory-resident, and it is resident per process** — so sizing is per machine, not per
workspace. The panel judges each model in a small curated catalogue before you download a gigabyte,
and shows the arithmetic — weights at the chosen quantisation, plus the KV cache for the chosen
context window, plus a reserve for the rest of the application — and reads a cgroup limit where one
exists, so a container capped at 4 GB is not told it has 32. That number is the one to trust; it is
arithmetic about your machine rather than a published minimum.

The consequence in a cluster is what `nativeAi.mode` defaults to `external` for: the api Deployment
runs two replicas and autoscales to ten, an embedded runtime is loaded once **per replica**, and a
3 GB model therefore costs 3 GB × replicas of resident memory while every replica downloads its own
copy of the weights into its own ReadWriteOnce PVC. Nothing warns you — it simply starts getting
pods OOMKilled as the cluster scales out.

So:

- **`mode: external`** (the default) — run `llama-server` as its own Deployment and Service, sized
  once, and set `nativeAi.host` to it. The api pods stay small and stateless and scale for free.
  **Keep it inside the cluster**: llama.cpp's server has no authentication of its own, so anything
  that can reach it can spend the machine. This chart deliberately does not expose it through the
  ingress.
- **`mode: embedded`** — honest at `api.replicaCount: 1` with `api.autoscaling.enabled: false`, and
  with memory limits that fit the model plus its cache. Fine for a single-node on-prem install,
  which is the shape most people asking for this actually have.

Compose has no replica arithmetic to worry about — one api container, one volume — but see the next
section for where the engine itself runs.

### Containers: the engine runs beside the API, not inside it

Under Docker or Kubernetes, `auto` resolves to `external`
(`services/native-runtime.service.ts#resolveNativeRuntimeMode`), and that is about more than
replicas: the API image is `node:22-alpine`, which is musl, and llama.cpp publishes only
glibc-linked Linux builds. **Install the engine** detects the libc
(`services/hardware-probe.service.ts`) and refuses inside the shipped image, with the sidecar
instructions attached, rather than handing over a binary that fails with the loader's misleading
"no such file or directory". Neither compose file ships that sidecar: run `llama-server` as its own
container on the compose network, point `NATIVE_AI_HOST` at its service name, and never publish its
port — the compose file's own comment says the same, for the same no-authentication reason as the
chart. `embedded` inside the shipped image would therefore need a musl-compatible `llama-server`
supplied through `NATIVE_AI_SERVER_BIN`.

### Verifying it

The panel tells you what it did rather than asking you to trust it — engine version, model file and
size on disk, and a **measured** tokens-per-second from a benchmark run on this hardware after the
download, not a figure from a spec sheet. If the runtime cannot start, the provider is marked down
and every AI call falls through to the next provider in the list exactly as it would for a rejected
API key; the application does not stop.

## Environment variable reference

`.env.example` is the complete list, with the reasoning behind each default inline; this section is
the operator's map of it, grouped by what a value decides. Where the values come from depends on how
the API runs: the process reads `apps/api/.env` — or an `APP_ENV` profile layered over it, see
[Environment profiles](#environment-profiles--local--uat--production) — while Compose reads the root
`.env` beside `docker-compose.yml`, and the Helm chart reads `values.yaml` plus the Secret you
create. Unless a row says otherwise, both compose files and the chart forward every variable below.

### Required at boot

Six variables have no default, and `config/env.ts` refuses to boot without them. Compose is stricter
still: its `${VAR:?}` guards also refuse to start without `WEB_ORIGIN` and `APP_BASE_URL`, and
`docker-compose.yml` without `MYSQL_ROOT_PASSWORD` for its bundled MySQL.

| Variable | Validated as | What it is |
|---|---|---|
| `DATABASE_URL` | non-empty | The default organization's tenant database — in Shape 1, the only one. Still required in Shape 2, where it is [functionally unused once more than one org exists](#one-time-platform-setup). |
| `CONTROL_DATABASE_URL` | non-empty | The control-plane database (org registry, SSO config, plan tiers, platform-admin accounts). Both shapes — see [why even a single org has one](#why-a-control-plane-exists-even-in-this-single-org-shape). |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ≥ 16 characters | Sign every tenant's access and refresh tokens. With `NODE_ENV=production`, a weak or template-looking value is also fatal at boot (`server.ts#assertProductionSafety`). |
| `PLATFORM_ADMIN_JWT_SECRET` | ≥ 16 characters | Signs `/platform-admin` tokens, which administer every organization — so it **must differ** from the two above. The production weak-secret check does not cover this one; generate it as carefully anyway. |
| `ENCRYPTION_KEY` | exactly 64 hex characters | The AES-256-GCM key for every stored secret, tenant DSNs included. The template's placeholder fails validation on purpose, so an unedited copy cannot encrypt anything under a key nobody wrote down. `openssl rand -hex 32`, fresh per environment; production applies the same weak-secret check as to the JWT secrets. |

### Core settings with defaults

| Variable | Default | What it decides |
|---|---|---|
| `NODE_ENV` | `development` | `production` switches on the production-only checks — secret strength (above), the cookie `Secure` flag, CORS strictness. Both compose files and the chart set it; a manual deployment must set it itself, and the API warns at boot when it is not `production` while `WEB_ORIGIN` looks public. |
| `WEB_ORIGIN` | `http://localhost:5173` (the template adds `http://127.0.0.1:5173`) | The comma-separated CORS allow-list; it must contain `APP_BASE_URL`'s origin. Development also accepts private-LAN origins, never a public one. With `ROOT_DOMAIN` set, its subdomains and verified custom domains are accepted without being listed — see [Workspace origins](#workspace-origins-and-web_origin). |
| `APP_BASE_URL` | `http://localhost:5173` (the template ships `"auto"`) | The base of every emailed link, and the one fixed OIDC/SAML callback URL every org's SSO uses. `"auto"` or a `{lan-ip}` token resolves to this machine's LAN address at boot — right for development, warned about in production. See [How this product should be addressed](#how-this-product-should-be-addressed--the-decision). |
| `DEFAULT_ORG_SLUG` | `default` | Which org a request with no real subdomain resolves to. |
| `ROOT_DOMAIN` | unset — required for multi-org, **and for any hostname with 3+ labels** | The domain subdomains hang off (`timesphere.app`). Setting it derives the slug by stripping this suffix instead of counting DNS labels, and makes the bare domain serve the workspace finder instead of `DEFAULT_ORG_SLUG`. Unset, the first DNS label IS the slug — so `timesheet.company.com` answers `404 Unknown workspace.` to every request. See [Turning on multi-org routing](#turning-on-multi-org-routing-root_domain); the API prints a boot ERROR naming the value to set. |
| `TENANT_DB_PROVISION_BASE_URL` | unset (the template sets a local one for development) | A DSN with credentials and **no database name** (`mysql://root:***@db-host:3306`) naming the MySQL server new tenant databases are physically created on. Read by the console's **Provision** action, by self-serve signup (`/api/signup`, which calls the same provisioning function), and by the console's backup snapshot restore and test restore. Unset, Provision answers `400` naming the variable — the button stays; [provision manually](#provisioning-without-the-automation) instead — signup answers `502` and removes the half-made registration, and both restores answer `409`. **Set, it arms public signup on any deployment whose outbound mail works**: anyone who can receive a code at a non-free-mail address can create a workspace on this server, which is why a single-org install leaves it blank. Compose forwards it (without that line it did not exist inside the container even when the host `.env` set it); the chart carries it in the Secret. |

### Operational settings

All optional, and all inert or safe when unset — except the first, whose default is wrong for most
real deployments.

| Variable | Default | What it decides |
|---|---|---|
| `TRUST_PROXY_HOPS` | `0` | [Reverse proxies and client IP attribution](#reverse-proxies-and-client-ip-attribution-trust_proxy_hops) — **the default is wrong for every proxied deployment, including the shipped Compose stack** |
| `ALLOW_PRIVATE_NETWORK_EGRESS` | `false` | Whether the server may fetch private, loopback or link-local addresses for the four URLs a workspace admin can type. `true` only for a self-hosted box whose webhook receivers (or BYOK model) genuinely live on the LAN; development permits private targets regardless. [Outbound request restrictions](#outbound-request-restrictions-allow_private_network_egress) |
| `CSP_CONNECT_SRC` | empty | Extra origins appended to the SPA's `connect-src`, read by the **web** container's nginx, not the API. Empty is right for every topology this repo ships; a **split** deployment (SPA on another origin) sets it to its `VITE_API_URL` origin or the browser blocks every API call. [Browser security headers](#browser-security-headers). **Neither compose file nor the chart forwards it** — it is a runtime `ENV` of the web image (`apps/web/Dockerfile`), so set it on the `web` service or container. |
| `RATE_LIMIT_PER_MINUTE` | `900` | The blanket per-IP request budget, validated 60–1,000,000 at boot. Per **egress** IP — an office NAT or corporate proxy is ONE bucket, and a 9 am rush across a hundred people behind it exceeds 900/min easily. Raise it for NAT-heavy deployments; the strict per-surface limiters (auth 20/min-failed, public share links, webhooks, AI) are deliberately not affected. Load-validated: the cut lands at exactly the configured budget. |
| `TENANT_DB_CONNECTION_LIMIT` | `5` (code) / `20` (shipped by Compose + chart) | Connections per tenant Prisma client. 5 is multi-tenant arithmetic — 50 cached tenant clients × 5 must stay under MySQL `max_connections` (151). A single-org install has ONE live tenant, and load testing measured what 5 costs it: the authed path pinned near 90 req/s at every concurrency while p50 scaled with queue depth alone (51 ms → 480 ms). SaaS fleets with many live tenant databases should set it back toward 5 and mind the ceiling arithmetic in `config/prisma.ts`. A `connection_limit` already present in the DSN still wins. Read outside the boot-time schema, so a value that is not an integer from 1 to 100 silently means 5 rather than failing. |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS` | `15m` / `14` | Token lifetimes. Surfaced in the chart as `env.accessTokenTtl` / `env.refreshTokenTtlDays` because shortening the access-token TTL is a standard security-review request. |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | empty / `587` / `false` | Outbound email. A **fallback only** — `GlobalMailSettings` in the tenant database (Workspace Settings → Mail server) wins whenever it is configured. With no `SMTP_HOST` anywhere, mail is written to the log instead of sent, which on Kubernetes means a password reset that only ever reached `kubectl logs`. Now carried by the Helm chart too (`mail.*` in values.yaml, `SMTP_PASS` in the Secret) — it previously was not, so a chart install had no way to configure mail at all. |
| `SLA_ENABLED`, `SLA_CRON_SCHEDULE`, `SLA_DEFAULT_APPROVAL_HOURS`, `TICKET_SLA_*` | on / `*/15 * * * *` / `48` / `168`·`72`·`24`·`4` h (low → critical) | Approval and ticket escalation. The `*_ENABLED` switches stop the workers, and the cron values are how often they scan. The hour values are where deadlines *start*, not live settings: `TICKET_SLA_*_HOURS` seed `GlobalTicketSettings` the first time a workspace reads it and are edited at runtime from Workspace Settings after that, while `SLA_DEFAULT_APPROVAL_HOURS` is only the fallback for a project with no positive approval window — new projects take the `slaApprovalHours` column's own default of 48, editable per project. Now forwarded by both compose files and the chart (`sla.*`). |
| `STORAGE_ROOT`, `STORAGE_DOCUMENTS_DIR`, `STORAGE_AVATARS_DIR`, `STORAGE_FACE_DIR` | empty (today's layout under `UPLOAD_DIR`) | [Relocating file storage](#relocating-file-storage) |
| `LOG_DIR`, `LOG_ROTATE_HOURS`, `LOG_RETENTION_DAYS`, `LOG_COMPRESS_ON_ROLLOVER` | empty / `4` / `30` / `true` | [Log files](#log-files) |
| `API_TELEMETRY_*`, `POD_NAME`, `POD_NAMESPACE`, `CLUSTER_NAME` | off in production (on when `NODE_ENV` is anything else) / unset | [Operating API request telemetry](#operating-api-request-telemetry) |
| `CLAMAV_HOST`, `CLAMAV_PORT` | unset (= `127.0.0.1`) / `3310` | Where clamd listens, for upload malware scanning. Consulted only once a workspace switches scanning on (`GlobalTicketSettings.virusScanEnabled`), and scanning then fails **closed**: uploads are refused while no scanner answers. Chart: `clamav.*`. |
| `UPDATE_CHECK`, `UPDATE_CHECK_REPO`, `UPDATE_CHECK_TOKEN` | `on` / this repo / unset | The hourly GitHub release check behind the **What's new** page. `UPDATE_CHECK=off` is the air-gapped posture — the page then lists the history bundled in the image's own `CHANGELOG.md`. **Only `off` disables it** (in any letter case); any other value, `false` included, leaves it on. The token (read-only Contents PAT) is needed only for a private repo. Chart equivalent: `updateCheck.enabled` / `updateCheck.repo`, with the token in the Secret. |

### AI

| Variable | Default | What it decides |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | A server-wide fallback for the **Anthropic provider only**: used when a workspace's Anthropic provider has no stored key, and as the implicit provider when a workspace has configured none (`services/ai.service.ts#resolveApiKey`). Everything else about AI — which providers, models, base URLs, BYOK keys, budget, confidence threshold — lives in each tenant's database and is edited at runtime from Workspace Settings → AI. |
| `NATIVE_AI_*` | nothing runs until a workspace enables a native provider | The managed llama.cpp runtime. [Running a model on your own server](#running-a-model-on-your-own-server) has its own table. |

**Not in this table, on purpose:** the MCP server has **no environment variable at all**. It is
configured entirely from the database and admin-edited at runtime — see
[Operating the MCP server](#operating-the-mcp-server). The same is true of AI refine and the AI
rate limiter (a fixed 20 requests/minute per user, not tunable): 2.3.0 introduced no new
environment variable in any deployment shape. (The post-2.3.0 load-testing campaign then added
exactly two — `RATE_LIMIT_PER_MINUTE` and `TENANT_DB_CONNECTION_LIMIT` above — each the direct
product of a measured ceiling, with the measurement recorded in
`reports/quality-load-report.html`.)

## Testing before you ship a change

```bash
npm run lint                          # typecheck both packages, then the SonarQube rules
npm run build                         # build both packages
npm run test -w apps/api              # unit tier — fully mocked, no DB/network, fastest signal
npm run test:integration -w apps/api  # integration tier — needs a real MySQL (see below)
npm run test:e2e                      # full Playwright suite
```

Run them in that order; it is the order CI runs them in, and it is cost-ordered so the cheapest
check is the first to tell you something is wrong. The unit tier mocks everything (no database, no
network, no LLM or Stripe calls). The integration tier derives its own throwaway `<db>_test`
databases from `DATABASE_URL`/`CONTROL_DATABASE_URL` and creates, migrates, seeds and drops them
itself — so it needs a reachable MySQL but never touches your development data. Set `KEEP_TEST_DB=1`
to keep those databases around for inspection after a failure.

To validate the deployment manifests without a cluster, see
[Verifying the chart without a live cluster](#verifying-the-chart-without-a-live-cluster) — CI runs
the same `helm lint` / `helm template` / `docker compose config` checks on every push.

The Playwright suite runs entirely against Shape 1 (one `DEFAULT_ORG_SLUG` org) — no browser test
drives a second tenant. **The routing itself is covered below Playwright**, by
`apps/api/tests/integration/multi-workspace-routing.integration.test.ts`, which runs the real
`cors()` and `resolveTenant` middleware over supertest against two workspaces and asserts what the
unit tests could not: that the pieces COMPOSE. Both defects that shipped were composition failures —
a proxy replacing `Host` before the router saw it, and CORS refusing the very origin the router had
just accepted — and every pure-function test passed throughout. It pins the confusing shape
explicitly (a same-origin GET carries no `Origin`, so the page renders and only the write is
refused), the wrong-workspace-on-a-rewritten-Host regression, custom-domain routing, and that
interleaved concurrent requests never leak one workspace's context into another.

Provisioning and SSO end-to-end against real second/third organizations are still checked by hand
during development, not by the automated suite.

### Testing two workspaces on a development machine

Worth doing before you enable multi-org routing in production, and it takes about a minute. The one
thing that used to make it impossible — the dev proxy rewriting `Host` — is fixed, so browser testing
now behaves the same way the deployed app does.

Chrome, Edge and Firefox resolve **any** `*.localhost` name to `127.0.0.1` with no hosts-file entry,
so `localhost` becomes a usable root domain:

```bash
# One variable, for this run only — no need to edit apps/api/.env.
cd apps/api && ROOT_DOMAIN=localhost npm run dev
```

Then, with the web dev server running as usual:

| Open | You get |
| --- | --- |
| `https://localhost:5173` | the **workspace finder** — the bare root is not a workspace |
| `https://acme.localhost:5173` | the `acme` workspace's own login page, logo and SSO buttons |
| `https://default.localhost:5173` | the `default` workspace |

**Two things to do once**, both of which announce themselves as confusing errors if you skip them:

```bash
# 1. Name each workspace in the dev certificate, or the address bar says "Not secure" and the
#    camera and Copy buttons stop working on exactly the pages you are testing.
npm run certs -- acme.localhost default.localhost
```

A `*.localhost` **wildcard does not work**, and it is worth knowing why before adding one back:
mkcert issues it happily and every verifier then refuses it, because a wildcard may not cover an
entire top-level label. Measured against a real handshake with `*.localhost` in the certificate,
`bob.localhost` was rejected by both OpenSSL and Windows schannel. Name the workspaces, or set
`ROOT_DOMAIN="dev.localhost"` and use `*.dev.localhost`, which is one level deeper and does match.

Nothing needs a hosts-file entry: browsers resolve every `*.localhost` name to loopback on their own
(RFC 6761). The OS resolver does **not**, which is why `curl` needs `--resolve acme.localhost:5173:127.0.0.1`
against these addresses and a browser needs nothing.

Confirm the API agrees, which is the part that cannot be faked by a redirect:

```bash
for h in localhost acme.localhost; do
  curl -s http://localhost:4000/api/auth/sso-methods -H "Host: $h"
done
# {"passwordEnabled":true,"providers":["GOOGLE","LDAP","MICROSOFT"],"apex":true}
# {"passwordEnabled":true,"providers":[],"apex":false}
```

Note the second line: `acme` returns *its own* (empty) provider list, not the default workspace's.
That is the per-workspace login configuration working end to end.

For API-only checks you don't even need the DNS names — `Host` is all that matters, so a forged
header reaches any workspace directly, which is also how to prove two tenants are isolated:

```bash
curl -X POST http://localhost:4000/api/auth/login -H "Host: acme.example.test" \
  -H "Content-Type: application/json" -d '{"email":"…","password":"…"}'
```

The same email and password in two workspaces returns two different `org` claims and two different
user ids, and a token minted for one workspace answers `401` against the other. Expect
`APP_BASE_URL` to be flagged at boot while `ROOT_DOMAIN=localhost` is set — with `APP_BASE_URL="auto"`
it resolves to your LAN IP, which is not under `localhost`, and the boot check is right to say so.
